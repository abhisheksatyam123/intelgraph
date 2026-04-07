#!/usr/bin/env node
// retrofit-frontmatter.mjs — add minimal frontmatter to vault notes that lack it.
//
// Walks the vault, finds *.md files without YAML frontmatter, and prepends
// a minimal block. Type and scope are inferred from the file's path. Status
// defaults to "seedling" so weekly review surfaces them. created/updated
// default to today (we don't have reliable git mtime for files migrated from
// another repo).
//
// Usage:
//   node scripts/retrofit-frontmatter.mjs           # dry run, lists files
//   node scripts/retrofit-frontmatter.mjs --write   # actually modify

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { homedir } from "node:os"

const VAULT = process.env.VAULT || join(homedir(), "notes")
const WRITE = process.argv.includes("--write")
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

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".md")) out.push(full)
  }
  return out
}

function hasFrontmatter(content) {
  return content.startsWith("---\n") && content.indexOf("\n---", 4) > 0
}

function inferType(rel) {
  // path-based inference
  if (rel.startsWith("atomic/concept/")) return "concept"
  if (rel.startsWith("atomic/principle/")) return "principle"
  if (rel.startsWith("atomic/skill/")) return "skill"
  if (rel.startsWith("atomic/pattern/")) return "pattern"
  if (rel.startsWith("atomic/reference/")) return "reference"
  if (rel.startsWith("atomic/literature/")) return "literature"
  if (rel.startsWith("atomic/domain/")) return "concept"   // domain atoms default to concept
  if (rel.includes("/architecture/")) return "concept"
  if (rel.includes("/module/")) return "concept"
  if (rel.includes("/derived/")) return "concept"
  if (rel.includes("/data/schema/")) return "reference"
  if (rel.includes("/data/fixture/")) return "reference"
  if (rel.includes("/data/")) return "reference"
  if (rel.includes("/decision/")) return "decision"
  if (rel.includes("/diagram/")) return "reference"
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

function titleFromFilename(file) {
  const name = file.replace(/\.md$/, "").split("/").pop()
  return name
    .replace(/^module-/, "")
    .replace(/^todo-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function extractH1(content) {
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

function makeFrontmatter(file, rel) {
  const content = readFileSync(file, "utf8")
  const type = inferType(rel)
  const scope = inferScope(rel)
  const title = extractH1(content) || titleFromFilename(file)
  const status = type === "task" ? "growing" : "seedling"
  return [
    "---",
    `title: ${JSON.stringify(title).replace(/^"|"$/g, "")}`,
    `type: ${type}`,
    `status: ${status}`,
    `scope: ${scope}`,
    `created: ${TODAY}`,
    `updated: ${TODAY}`,
    "---",
    "",
  ].join("\n")
}

const files = walk(VAULT)
let added = 0
let skipped = 0

for (const file of files) {
  const rel = relative(VAULT, file)
  // Skip top-level vault docs that already have frontmatter or are special
  if (rel === "README.md" || rel === "_home.md") {
    skipped++
    continue
  }
  const content = readFileSync(file, "utf8")
  if (hasFrontmatter(content)) {
    skipped++
    continue
  }
  const fm = makeFrontmatter(file, rel)
  console.log(`${WRITE ? "ADD " : "DRY "} ${rel}  [${inferType(rel)} / ${inferScope(rel)}]`)
  if (WRITE) {
    writeFileSync(file, fm + content)
  }
  added++
}

console.log(`\n${WRITE ? "added" : "would add"}: ${added}, skipped (had frontmatter or excluded): ${skipped}, total: ${files.length}`)
