#!/usr/bin/env node
// upgrade-frontmatter.mjs — upgrade existing-but-old-schema frontmatter to canonical schema.
//
// Walks the vault, finds *.md files whose frontmatter uses legacy fields/values,
// and rewrites them to the canonical schema. Drops non-canonical fields. Moves
// `source:` and `related-source:` into a body `## Source files` section.
//
// Canonical schema:
//   title, type, status, scope, created, updated, audience, purpose, tags
//
// Status mapping:
//   stable        -> evergreen
//   wip           -> growing
//   in_progress   -> growing
//   in-progress   -> growing
//   deprecated    -> superseded
//   draft         -> seedling
//
// Usage:
//   node scripts/upgrade-frontmatter.mjs                # dry run
//   node scripts/upgrade-frontmatter.mjs --write        # actually modify
//   node scripts/upgrade-frontmatter.mjs --only PATH    # restrict to one path

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { homedir } from "node:os"

const VAULT = process.env.VAULT || join(homedir(), "notes")
const WRITE = process.argv.includes("--write")
const ONLY_IDX = process.argv.indexOf("--only")
const ONLY = ONLY_IDX >= 0 ? process.argv[ONLY_IDX + 1] : null
const TODAY = new Date().toISOString().slice(0, 10)

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

const STATUS_MAP = {
  stable: "evergreen",
  wip: "growing",
  in_progress: "growing",
  "in-progress": "growing",
  deprecated: "superseded",
  draft: "seedling",
}

const DROP_FIELDS = new Set([
  "owner",
  "verified",
  "project",
  "kind",
  "name",
  "related",
])

// ---------- Walk ----------

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    if (entry.startsWith(".")) continue // skip hidden dirs/files like .opencode
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".md")) out.push(full)
  }
  return out
}

// ---------- Type / scope inference ----------

function inferType(rel) {
  if (rel.startsWith("atomic/concept/")) return "concept"
  if (rel.startsWith("atomic/principle/")) return "principle"
  if (rel.startsWith("atomic/skill/")) return "skill"
  if (rel.startsWith("atomic/pattern/")) return "pattern"
  if (rel.startsWith("atomic/reference/")) return "reference"
  if (rel.startsWith("atomic/literature/")) return "literature"
  if (rel.startsWith("atomic/domain/")) return "concept"
  if (rel.includes("/architecture/")) return "architecture"
  if (rel.includes("/module/")) return "module"
  if (rel.includes("/derived/")) return "module"
  if (rel.includes("/data/schema/")) return "reference"
  if (rel.includes("/data/fixture/")) return "reference"
  if (rel.includes("/data/")) return "reference"
  if (rel.includes("/decision/")) return "decision"
  if (rel.includes("/diagram/")) return "reference"
  if (rel.includes("/skill/")) return "skill"
  if (rel.includes("/reference/")) return "reference"
  if (rel.includes("/task/")) return "task"
  if (rel.startsWith("inbox/")) return "reference"
  if (rel.startsWith("journal/")) return "log"
  return "reference"
}

function inferScope(rel) {
  if (rel.startsWith("atomic/domain/")) {
    const m = rel.match(/^atomic\/domain\/([^/]+)\//)
    return m ? `domain:${m[1]}` : "universal"
  }
  if (rel.startsWith("atomic/")) return "universal"
  if (rel.startsWith("project/software/")) {
    const m = rel.match(/^project\/software\/([^/]+)\//)
    return m ? `project:software/${m[1]}` : "project"
  }
  if (rel.startsWith("project/")) {
    const m = rel.match(/^project\/([^/]+)\/([^/]+)\//)
    return m ? `project:${m[1]}/${m[2]}` : "project"
  }
  return "personal"
}

// ---------- Frontmatter parser ----------
//
// Handles:
//   key: value                 (string)
//   key: "value"               (quoted string)
//   key: [a, b, c]             (inline list)
//   key:\n  - a\n  - b         (block list)
//
// Returns { fields: Map<key, value-or-array>, body: string }
// or { error: string } if no frontmatter / malformed.

function parseFrontmatter(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { error: "no frontmatter" }
  }
  const endIdx = content.indexOf("\n---", 4)
  if (endIdx < 0) return { error: "unterminated frontmatter" }
  const fmText = content.slice(4, endIdx)
  // body starts after the closing ---\n
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
      // possible block list
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
    // strip surrounding quotes
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      rest = rest.slice(1, -1)
    }
    // inline list?
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

// ---------- Detect needs upgrade ----------

function needsUpgrade(fields) {
  if (!fields.has("type")) return true
  const type = fields.get("type")
  if (typeof type === "string" && !VALID_TYPES.has(type)) return true
  if (fields.has("status")) {
    const s = fields.get("status")
    if (typeof s === "string" && !VALID_STATUSES.has(s)) return true
  }
  if (!fields.has("scope")) return true
  if (!fields.has("audience")) return true
  if (!fields.has("purpose")) return true
  for (const f of [
    "description",
    "owner",
    "verified",
    "project",
    "kind",
    "name",
    "source",
    "related-source",
    "related",
  ]) {
    if (fields.has(f)) return true
  }
  // tags-based legacy status detection
  const tags = fields.get("tags")
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (
        typeof t === "string" &&
        (t === "status/stable" || t === "status/wip" || t === "status/deprecated" ||
         t === "status/in_progress" || t === "status/draft")
      ) {
        return true
      }
    }
  }
  return false
}

// ---------- Build canonical frontmatter ----------

function extractH1(body) {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

function extractClaimOrSubsystem(body) {
  const m =
    body.match(/^\*\*(?:Claim|Subsystem|Purpose)\*\*:\s*(.+)$/m) ||
    body.match(/^\*\*([A-Z][A-Za-z]+)\*\*:\s*(.+)$/m)
  if (m) return (m[2] || m[1]).trim().replace(/\s+/g, " ")
  return null
}

function titleFromFilename(file) {
  const name = file.replace(/\.md$/, "").split("/").pop()
  return name
    .replace(/^module-/, "")
    .replace(/^todo-/, "")
    .replace(/-/g, " ")
}

function inferStatusFromTags(tags) {
  if (!Array.isArray(tags)) return null
  for (const t of tags) {
    if (t === "status/stable") return "evergreen"
    if (t === "status/wip") return "growing"
    if (t === "status/in_progress") return "growing"
    if (t === "status/deprecated") return "superseded"
    if (t === "status/draft") return "seedling"
  }
  return null
}

function buildCanonical(rel, fields, body) {
  const out = new Map()
  const notes = [] // human-readable change list

  // title
  const existingTitle = fields.get("title")
  out.set(
    "title",
    typeof existingTitle === "string" && existingTitle !== ""
      ? existingTitle
      : extractH1(body) || titleFromFilename(rel),
  )

  // type
  const existingType = fields.get("type")
  let type
  if (typeof existingType === "string" && VALID_TYPES.has(existingType)) {
    type = existingType
  } else {
    type = inferType(rel)
    if (existingType) notes.push(`type:${existingType}→${type}`)
    else notes.push(`type:+${type}`)
  }
  out.set("type", type)

  // status
  let status = fields.get("status")
  if (typeof status === "string" && STATUS_MAP[status]) {
    notes.push(`status:${status}→${STATUS_MAP[status]}`)
    status = STATUS_MAP[status]
  } else if (typeof status === "string" && VALID_STATUSES.has(status)) {
    // already canonical
  } else {
    const fromTags = inferStatusFromTags(fields.get("tags"))
    if (fromTags) {
      status = fromTags
      notes.push(`status:tag→${fromTags}`)
    } else if (type === "task") {
      status = "growing"
      notes.push(`status:+growing`)
    } else {
      status = "seedling"
      notes.push(`status:+seedling`)
    }
  }
  out.set("status", status)

  // scope
  if (fields.has("scope")) {
    out.set("scope", fields.get("scope"))
  } else {
    out.set("scope", inferScope(rel))
    notes.push(`scope:+`)
  }

  // created
  out.set(
    "created",
    fields.has("created") ? fields.get("created") : TODAY,
  )

  // updated
  out.set("updated", TODAY)

  // audience
  if (fields.has("audience")) {
    out.set("audience", fields.get("audience"))
  } else {
    out.set("audience", "agent")
    notes.push(`audience:+agent`)
  }

  // purpose — derive from description, then claim/subsystem, else empty
  let purpose = fields.get("purpose")
  if (purpose === undefined || purpose === "") {
    const desc = fields.get("description")
    if (typeof desc === "string" && desc !== "") {
      purpose = desc
      notes.push(`purpose←description`)
    } else {
      const claim = extractClaimOrSubsystem(body)
      if (claim) {
        purpose = claim
        notes.push(`purpose←body`)
      } else {
        purpose = ""
        notes.push(`purpose:empty`)
      }
    }
  }
  out.set("purpose", purpose)

  // tags — keep, drop legacy status tags, drop pseudo placeholders
  const rawTags = fields.get("tags")
  if (Array.isArray(rawTags)) {
    const cleaned = rawTags.filter((t) => {
      if (typeof t !== "string") return false
      if (t.startsWith("status/")) return false
      if (/^[a-z-]+\/<[A-Z]+>$/.test(t)) return false // pattern/<Z>
      return true
    })
    if (cleaned.length !== rawTags.length) {
      notes.push(`tags:-${rawTags.length - cleaned.length}`)
    }
    if (cleaned.length > 0) {
      out.set("tags", cleaned)
    }
  }

  // collect dropped fields for the change list
  for (const key of fields.keys()) {
    if (
      DROP_FIELDS.has(key) ||
      key === "description" ||
      key === "source" ||
      key === "related-source"
    ) {
      notes.push(`drop:${key}`)
    }
  }

  return { out, notes }
}

// ---------- Source files insertion ----------

function buildSourceFilesSection(fields) {
  const items = []
  const src = fields.get("source")
  if (typeof src === "string" && src !== "") {
    items.push(src)
  } else if (Array.isArray(src)) {
    for (const s of src) items.push(s)
  }
  const rel = fields.get("related-source")
  if (Array.isArray(rel)) {
    for (const s of rel) items.push(s)
  } else if (typeof rel === "string" && rel !== "") {
    items.push(rel)
  }
  if (items.length === 0) return null
  const lines = ["## Source files", ""]
  for (const it of items) lines.push(`- \`${it}\``)
  lines.push("")
  return lines.join("\n")
}

function insertSourceFiles(body, section) {
  if (section === null) return body
  if (body.includes("## Source files")) return body // already present
  // insert before the first H2 (other than ## Source files), or append at end
  const lines = body.split("\n")
  let insertAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      insertAt = i
      break
    }
  }
  if (insertAt < 0) {
    // append at end
    return body.replace(/\n*$/, "\n\n") + section + "\n"
  }
  return (
    lines.slice(0, insertAt).join("\n") +
    "\n" +
    section +
    "\n" +
    lines.slice(insertAt).join("\n")
  )
}

// ---------- Render ----------

function renderFrontmatter(out) {
  const lines = ["---"]
  for (const [key, val] of out.entries()) {
    if (Array.isArray(val)) {
      // inline form for tags (matches existing canonical notes)
      lines.push(`${key}: [${val.join(", ")}]`)
    } else if (typeof val === "string") {
      // quote if contains special chars
      const needsQuote = /[:#@`'"\[\]{}|>]/.test(val) && !val.startsWith('"')
      if (needsQuote) {
        // escape backslashes and double-quotes
        const esc = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        lines.push(`${key}: "${esc}"`)
      } else {
        lines.push(`${key}: ${val}`)
      }
    } else {
      lines.push(`${key}: ${val}`)
    }
  }
  lines.push("---")
  lines.push("")
  return lines.join("\n")
}

// ---------- Main ----------

function processFile(file) {
  const rel = relative(VAULT, file)
  const content = readFileSync(file, "utf8")
  const parsed = parseFrontmatter(content)
  if (parsed.error) {
    return { rel, action: "SKIP", reason: parsed.error }
  }
  if (!needsUpgrade(parsed.fields)) {
    return { rel, action: "OK", reason: "already canonical" }
  }
  const { out, notes } = buildCanonical(rel, parsed.fields, parsed.body)
  const srcSection = buildSourceFilesSection(parsed.fields)
  const newBody = insertSourceFiles(parsed.body, srcSection)
  if (srcSection) notes.push("body:+source-files")
  const newContent = renderFrontmatter(out) + newBody
  return { rel, action: WRITE ? "WRITE" : "DRY", notes, newContent, file }
}

const files = walk(VAULT)
let upgraded = 0
let alreadyOk = 0
let skipped = 0

for (const file of files) {
  const rel = relative(VAULT, file)
  if (ONLY && rel !== ONLY) continue
  if (rel.startsWith("atomic/")) {
    // Already-canonical atomic shelf — only sweep if explicitly invoked via --only
    if (!ONLY) {
      alreadyOk++
      continue
    }
  }
  const result = processFile(file)
  if (result.action === "OK") {
    alreadyOk++
    continue
  }
  if (result.action === "SKIP") {
    skipped++
    console.log(`SKIP  ${result.rel}  (${result.reason})`)
    continue
  }
  console.log(`${result.action}  ${result.rel}  [${(result.notes || []).join(", ")}]`)
  if (WRITE && result.newContent) {
    writeFileSync(result.file, result.newContent)
  }
  upgraded++
}

console.log(
  `\n${WRITE ? "upgraded" : "would upgrade"}: ${upgraded}, already canonical: ${alreadyOk}, skipped: ${skipped}, total scanned: ${files.length}`,
)
