#!/usr/bin/env node
// flatten-wikilinks.mjs — rewrite path-shaped wikilinks to bare basenames.
//
// In Obsidian, [[some/path/note]] resolves only by accident — the canonical
// form is [[note]] (basename only). This script walks the vault, finds every
// wikilink containing a `/` in the target portion, and rewrites it to the
// basename. Anchor (#section) and alias (|alias) suffixes are preserved.
//
// Safety: only flattens when the basename is unique in the vault. If two
// notes share a basename, the link is left alone with a SKIP warning.
//
// Usage:
//   node scripts/flatten-wikilinks.mjs              # dry run
//   node scripts/flatten-wikilinks.mjs --write      # actually modify

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join, relative, basename } from "node:path"
import { homedir } from "node:os"

const VAULT = process.env.VAULT || join(homedir(), "notes")
const WRITE = process.argv.includes("--write")

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

// Build basename -> count map. If count > 1, that basename is ambiguous and
// we won't flatten links targeting it.
function buildBasenameMap(files) {
  const counts = new Map()
  for (const f of files) {
    const b = basename(f, ".md")
    counts.set(b, (counts.get(b) || 0) + 1)
  }
  return counts
}

// Wikilink regex:
//   \[\[                opening
//   ([^\]|#]+)          target (no #, no |, no ])
//   ([#][^\]|]*)?       optional anchor
//   (\|[^\]]*)?         optional alias
//   \]\]                closing
const WIKILINK = /\[\[([^\]|#]+)([#][^\]|]*)?(\|[^\]]*)?\]\]/g

function flattenLine(line, lineNo, file, counts, edits) {
  return line.replace(WIKILINK, (match, target, anchor, alias) => {
    if (!target.includes("/")) return match
    const base = target.split("/").pop()
    if (!base) return match
    const count = counts.get(base) || 0
    if (count === 0) {
      edits.push({
        kind: "MISS",
        file,
        lineNo,
        from: match,
        reason: `target basename "${base}" not found in vault`,
      })
      return match
    }
    if (count > 1) {
      edits.push({
        kind: "SKIP",
        file,
        lineNo,
        from: match,
        reason: `basename "${base}" is ambiguous (${count} files)`,
      })
      return match
    }
    const replacement = `[[${base}${anchor || ""}${alias || ""}]]`
    edits.push({
      kind: "FLAT",
      file,
      lineNo,
      from: match,
      to: replacement,
    })
    return replacement
  })
}

function processFile(file, counts) {
  const content = readFileSync(file, "utf8")
  const lines = content.split("\n")
  const edits = []
  const newLines = lines.map((line, idx) => flattenLine(line, idx + 1, file, counts, edits))
  const newContent = newLines.join("\n")
  return { newContent, edits, changed: newContent !== content }
}

const files = walk(VAULT)
const counts = buildBasenameMap(files)

let totalFlat = 0
let totalSkip = 0
let totalMiss = 0
let filesChanged = 0

for (const file of files) {
  const { newContent, edits, changed } = processFile(file, counts)
  for (const e of edits) {
    const rel = relative(VAULT, e.file)
    if (e.kind === "FLAT") {
      console.log(`${WRITE ? "FLAT" : "DRY "}  ${rel}:${e.lineNo}  ${e.from} → ${e.to}`)
      totalFlat++
    } else if (e.kind === "SKIP") {
      console.log(`SKIP  ${rel}:${e.lineNo}  ${e.from}  (${e.reason})`)
      totalSkip++
    } else if (e.kind === "MISS") {
      console.log(`MISS  ${rel}:${e.lineNo}  ${e.from}  (${e.reason})`)
      totalMiss++
    }
  }
  if (WRITE && changed) {
    writeFileSync(file, newContent)
    filesChanged++
  } else if (changed) {
    filesChanged++
  }
}

console.log(
  `\n${WRITE ? "flattened" : "would flatten"}: ${totalFlat} link(s) across ${filesChanged} file(s); skipped (ambiguous): ${totalSkip}; missing target: ${totalMiss}`,
)
