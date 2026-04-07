#!/usr/bin/env node
// lint-vault.mjs — vault linter. Run during weekly review.
//
// Reads every .md in the vault and checks for schema/wikilink/tag drift.
// Errors block (exit 1). Warnings inform (exit 2 if no errors).
//
// Usage:
//   node scripts/lint-vault.mjs           # report errors and warnings, exit 1 on errors
//   node scripts/lint-vault.mjs --strict  # also exit non-zero on warnings
//   node scripts/lint-vault.mjs --json    # machine-readable output (for CI/scripts)

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, basename } from "node:path"
import { homedir } from "node:os"

const VAULT = process.env.VAULT || join(homedir(), "notes")
const STRICT = process.argv.includes("--strict")
const JSON_OUT = process.argv.includes("--json")

const SKIP_DIRS = new Set([
  ".git",
  "_attachments",
  "_private",
  "_templates",
  "node_modules",
  ".obsidian",
  ".trash",
])

const VALID_TYPES = new Set([
  "concept",
  "principle",
  "pattern",
  "skill",
  "reference",
  "literature",
  "module",
  "task",
  "decision",
  "log",
  "question",
  "moc",
  "architecture",
])

const VALID_STATUSES = new Set([
  "seedling",
  "growing",
  "evergreen",
  "superseded",
  "archived",
])

const REQUIRED_FIELDS = ["title", "type", "status", "scope", "created", "updated"]

// Note types where being orphan (no incoming wikilinks) is normal/expected.
const ORPHAN_OK_TYPES = new Set(["task", "log", "decision", "moc", "question"])

const STALE_DAYS = 90 // evergreen notes updated >90d ago get a warning

// ---------- Walk ----------

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    if (entry.startsWith(".")) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".md")) out.push(full)
  }
  return out
}

// ---------- Frontmatter parser (same as upgrade-frontmatter.mjs) ----------

function parseFrontmatter(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { error: "no frontmatter" }
  }
  const endIdx = content.indexOf("\n---", 4)
  if (endIdx < 0) return { error: "unterminated frontmatter" }
  const fmText = content.slice(4, endIdx)
  let bodyStart = endIdx + 4
  if (content[bodyStart] === "\n") bodyStart += 1
  const body = content.slice(bodyStart)

  const lines = fmText.split("\n")
  const fields = new Map()
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i += 1
      continue
    }
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!m) {
      i += 1
      continue
    }
    const key = m[1]
    let rest = m[2]
    if (rest === "") {
      const items = []
      let j = i + 1
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s+-\s+/, "").trim())
        j += 1
      }
      if (items.length > 0) {
        fields.set(key, items)
        i = j
        continue
      }
      fields.set(key, "")
      i += 1
      continue
    }
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      rest = rest.slice(1, -1)
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim()
      const items = inner === ""
        ? []
        : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
      fields.set(key, items)
      i += 1
      continue
    }
    fields.set(key, rest)
    i += 1
  }
  return { fields, body }
}

// ---------- Tag registry parser ----------

function loadRegisteredTags() {
  const path = join(VAULT, "atomic", "reference", "_tags.md")
  let content
  try {
    content = readFileSync(path, "utf8")
  } catch {
    return new Set()
  }
  // Match lines like: | `tag-name` | meaning | count | etc.
  // Tags may be wrapped in backticks; strip them.
  const tags = new Set()
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*([^\s|][^|]*?)\s*\|/)
    if (!m) continue
    let tag = m[1].trim()
    if (!tag) continue
    // Strip surrounding backticks
    if (tag.startsWith("`") && tag.endsWith("`")) tag = tag.slice(1, -1)
    if (tag.toLowerCase() === "tag") continue // header row
    if (tag === "---" || /^-+$/.test(tag)) continue // separator
    tags.add(tag)
  }
  return tags
}

// ---------- Wikilink scanning ----------
//
// Skip wikilinks inside fenced code blocks (```...```) and inline code spans
// (`...`). These are documentation examples, not real links.

const WIKILINK_RE = /\[\[([^\]|#]+)([#][^\]|]*)?(\|[^\]]*)?\]\]/g

function stripInlineCode(line) {
  // Replace inline code spans with placeholders so wikilinks inside don't match.
  // Handles single-backtick spans: `...` (not multi-backtick edge cases).
  return line.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length))
}

function scanWikilinks(content) {
  const out = []
  const lines = content.split("\n")
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const line = stripInlineCode(raw)
    let m
    WIKILINK_RE.lastIndex = 0
    while ((m = WIKILINK_RE.exec(line)) !== null) {
      out.push({ lineNo: i + 1, target: m[1], anchor: m[2] || "", alias: m[3] || "", raw: m[0] })
    }
  }
  return out
}

// ---------- Date helpers ----------

function daysSince(dateStr) {
  const d = Date.parse(dateStr)
  if (isNaN(d)) return null
  const now = Date.now()
  return Math.floor((now - d) / 86400000)
}

// ---------- Main ----------

const files = walk(VAULT)
const basenameMap = new Map() // basename -> [files]
for (const f of files) {
  const b = basename(f, ".md")
  if (!basenameMap.has(b)) basenameMap.set(b, [])
  basenameMap.get(b).push(f)
}

const registeredTags = loadRegisteredTags()

// First pass: build incoming-link map for orphan detection
const incomingLinks = new Map() // basename -> count
for (const file of files) {
  const content = readFileSync(file, "utf8")
  const links = scanWikilinks(content)
  for (const link of links) {
    const base = link.target.includes("/")
      ? link.target.split("/").pop()
      : link.target
    if (!base) continue
    incomingLinks.set(base, (incomingLinks.get(base) || 0) + 1)
  }
}

const errors = []
const warnings = []

for (const file of files) {
  const rel = relative(VAULT, file)
  const content = readFileSync(file, "utf8")
  const parsed = parseFrontmatter(content)

  if (parsed.error) {
    errors.push({ file: rel, msg: `frontmatter: ${parsed.error}` })
    continue
  }
  const { fields, body } = parsed

  // E1: missing required fields
  for (const f of REQUIRED_FIELDS) {
    if (!fields.has(f)) {
      errors.push({ file: rel, msg: `missing required field: ${f}` })
    }
  }

  // E2: invalid type
  const type = fields.get("type")
  if (typeof type === "string" && !VALID_TYPES.has(type)) {
    errors.push({
      file: rel,
      msg: `invalid type: "${type}" (allowed: ${[...VALID_TYPES].join("|")})`,
    })
  }

  // E3: invalid status
  const status = fields.get("status")
  if (typeof status === "string" && !VALID_STATUSES.has(status)) {
    errors.push({
      file: rel,
      msg: `invalid status: "${status}" (allowed: ${[...VALID_STATUSES].join("|")})`,
    })
  }

  // Wikilink checks (errors)
  const links = scanWikilinks(content)
  for (const link of links) {
    // E4: path-shaped wikilink (after Phase B should be zero except templates)
    if (link.target.includes("/")) {
      // Allow placeholder targets like <name> or X (single uppercase)
      const last = link.target.split("/").pop()
      if (
        last !== last.toUpperCase() ||
        !/^[A-Z]$/.test(last)
      ) {
        if (!last.startsWith("<") && last !== "X" && !link.target.includes("README")) {
          errors.push({
            file: rel,
            line: link.lineNo,
            msg: `path-shaped wikilink: ${link.raw}`,
          })
        }
      }
    }
    // E5: target basename doesn't exist
    const base = link.target.includes("/")
      ? link.target.split("/").pop()
      : link.target
    if (!base.startsWith("<") && base !== "X") {
      // README path-shaped links resolve via folder hint in Obsidian; skip
      if (link.target.includes("README") && link.target.includes("/")) {
        // OK
      } else if (!basenameMap.has(base)) {
        errors.push({
          file: rel,
          line: link.lineNo,
          msg: `wikilink target not found: ${link.raw}`,
        })
      }
    }
  }

  // Warnings
  // W1: empty purpose
  const purpose = fields.get("purpose")
  if (purpose === "" || purpose === undefined) {
    if (fields.has("purpose")) {
      warnings.push({ file: rel, msg: `empty purpose:` })
    }
  }

  // W2: tags not in registry
  const tags = fields.get("tags")
  if (Array.isArray(tags) && registeredTags.size > 0) {
    for (const tag of tags) {
      if (!registeredTags.has(tag)) {
        warnings.push({ file: rel, msg: `tag not in registry: "${tag}"` })
      }
    }
  }

  // W3: stale evergreen
  if (status === "evergreen") {
    const updated = fields.get("updated")
    if (typeof updated === "string") {
      const days = daysSince(updated)
      if (days !== null && days > STALE_DAYS) {
        warnings.push({
          file: rel,
          msg: `evergreen but updated: ${updated} (${days} days ago, threshold ${STALE_DAYS})`,
        })
      }
    }
  }

  // W4: orphan note (no incoming wikilinks) for types that should be linked
  if (typeof type === "string" && !ORPHAN_OK_TYPES.has(type)) {
    const myBase = basename(file, ".md")
    const incoming = incomingLinks.get(myBase) || 0
    if (incoming === 0) {
      warnings.push({ file: rel, msg: `orphan: 0 incoming wikilinks` })
    }
  }
}

// ---------- Output ----------

if (JSON_OUT) {
  console.log(JSON.stringify({ files: files.length, errors, warnings }, null, 2))
} else {
  for (const e of errors) {
    const loc = e.line ? `:${e.line}` : ""
    console.log(`ERROR  ${e.file}${loc}  ${e.msg}`)
  }
  for (const w of warnings) {
    const loc = w.line ? `:${w.line}` : ""
    console.log(`WARN   ${w.file}${loc}  ${w.msg}`)
  }
  console.log(
    `\n${files.length} files checked: ${errors.length} error(s), ${warnings.length} warning(s)`,
  )
}

if (errors.length > 0) process.exit(1)
if (STRICT && warnings.length > 0) process.exit(2)
process.exit(0)
