#!/usr/bin/env node
// dump-tags.mjs — extract every tag used in the vault, sorted by frequency.
//
// Usage:
//   node scripts/dump-tags.mjs            # human-readable table
//   node scripts/dump-tags.mjs --md       # markdown table for _tags.md

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const VAULT = process.env.VAULT || join(homedir(), "notes")
const MD = process.argv.includes("--md")

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
    if (entry.startsWith(".")) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".md")) out.push(full)
  }
  return out
}

function extractTags(content) {
  // Find tags: line in frontmatter and parse it.
  if (!content.startsWith("---\n")) return []
  const endIdx = content.indexOf("\n---", 4)
  if (endIdx < 0) return []
  const fm = content.slice(4, endIdx)
  const lines = fm.split("\n")
  const tags = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^tags:\s*(.*)$/)
    if (!m) continue
    const rest = m[1]
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim()
      if (inner === "") continue
      for (const t of inner.split(",")) {
        tags.push(t.trim().replace(/^["']|["']$/g, ""))
      }
    } else if (rest === "") {
      let j = i + 1
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        tags.push(lines[j].replace(/^\s+-\s+/, "").trim())
        j += 1
      }
    }
    break
  }
  return tags
}

const files = walk(VAULT)
const counts = new Map()
for (const f of files) {
  const content = readFileSync(f, "utf8")
  for (const t of extractTags(content)) {
    if (!t) continue
    counts.set(t, (counts.get(t) || 0) + 1)
  }
}

const sorted = [...counts.entries()].sort((a, b) => {
  if (b[1] !== a[1]) return b[1] - a[1]
  return a[0].localeCompare(b[0])
})

if (MD) {
  console.log("| Tag | Count | Since |")
  console.log("|---|---|---|")
  const today = new Date().toISOString().slice(0, 10)
  for (const [tag, count] of sorted) {
    console.log(`| \`${tag}\` | ${count} | ${today} |`)
  }
} else {
  for (const [tag, count] of sorted) {
    console.log(`${count.toString().padStart(4)}  ${tag}`)
  }
  console.log(`\n${sorted.length} distinct tags across ${files.length} files`)
}
