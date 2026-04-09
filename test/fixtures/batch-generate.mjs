// batch-generate.mjs — generate fixture JSONs from a pre-extracted SQLite db.
//
// Walks every graph_node of the given kind(s), queries every edge kind in
// both directions, and emits one JSON fixture per symbol into the target
// fixture directory organized by kind subfolder.
//
// Usage:
//   node test/fixtures/batch-generate.mjs \
//     --db /tmp/intelgraph-ts-intelgraph.db \
//     --snapshot 1 \
//     --kinds "function,class" \
//     --fixture-root test/fixtures/ts/intelgraph/api \
//     --limit 100
//
// Each generated fixture gets:
//   - canonical_name from graph_nodes
//   - kind from graph_nodes
//   - every edge in both directions, grouped by edge_kind
//   - source location from graph_nodes.location (JSON)
//   - category = the node kind

import Database from "/home/abhi/qprojects/intelgraph/node_modules/better-sqlite3/lib/index.js"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) { out[key] = next; i++ } else { out[key] = "true" }
    }
  }
  return out
}
const args = parseArgs(process.argv.slice(2))

const dbPath      = args.db
const snapshotId  = parseInt(args.snapshot ?? "1", 10)
const kinds       = (args.kinds ?? "").split(",").map((k) => k.trim()).filter(Boolean)
const fixtureRoot = args["fixture-root"]
const limit       = parseInt(args.limit ?? "200", 10)

if (!dbPath || !fixtureRoot || kinds.length === 0) {
  console.error("Usage: node batch-generate.mjs --db <path> --kinds <k1,k2> --fixture-root <dir> [--snapshot N] [--limit N]")
  process.exit(2)
}

const db = new Database(dbPath, { readonly: true })
const NODE_PREFIX = `graph_node:${snapshotId}:symbol:`

function strip(nodeId) {
  return typeof nodeId === "string" && nodeId.startsWith(NODE_PREFIX) ? nodeId.slice(NODE_PREFIX.length) : nodeId
}

function safeName(canonical) {
  // Turn "module:src/config/config.ts#readConfig" → "readConfig"
  // Turn "module:src/vault/core.rs#Vault" → "Vault"
  const hash = canonical.lastIndexOf("#")
  const dot  = canonical.lastIndexOf(".")
  const cut  = Math.max(hash, dot)
  const short = cut > 0 ? canonical.slice(cut + 1) : canonical
  // Filesystem-safe: replace non-alnum chars
  return short.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80)
}

function parseLocation(locJson) {
  if (!locJson) return null
  try {
    const loc = typeof locJson === "string" ? JSON.parse(locJson) : locJson
    return { file: loc.filePath, line: loc.line, character: loc.column }
  } catch { return null }
}

// Prepared queries
const stmtNodes = db.prepare(
  `SELECT canonical_name, kind, location, payload FROM graph_nodes
   WHERE snapshot_id = ? AND kind IN (${kinds.map(() => "?").join(",")})
   ORDER BY canonical_name
   LIMIT ?`,
)
const stmtOutgoing = db.prepare(
  `SELECT edge_kind, dst_node_id, confidence, metadata FROM graph_edges
   WHERE snapshot_id = ? AND src_node_id = ?`,
)
const stmtIncoming = db.prepare(
  `SELECT edge_kind, src_node_id, confidence, metadata FROM graph_edges
   WHERE snapshot_id = ? AND dst_node_id = ?`,
)

const nodes = stmtNodes.all(snapshotId, ...kinds, limit)
console.log(`[batch] ${nodes.length} nodes of kind [${kinds.join(",")}] (limit ${limit})`)

let written = 0
for (const node of nodes) {
  const nodeId = `${NODE_PREFIX}${node.canonical_name}`
  const outEdges = stmtOutgoing.all(snapshotId, nodeId)
  const inEdges  = stmtIncoming.all(snapshotId, nodeId)

  // Group edges by kind + direction
  const relations = {}

  // Outgoing
  for (const e of outEdges) {
    const key = `${e.edge_kind}_out`
    if (!relations[key]) relations[key] = []
    const entry = { dst: strip(e.dst_node_id), confidence: e.confidence }
    if (e.metadata) {
      try {
        const m = JSON.parse(e.metadata)
        if (m.resolutionKind) entry.resolution = m.resolutionKind
        if (m.source_location) entry.source_line = m.source_location.sourceLineNumber
      } catch {}
    }
    relations[key].push(entry)
  }
  // Incoming
  for (const e of inEdges) {
    const key = `${e.edge_kind}_in`
    if (!relations[key]) relations[key] = []
    const entry = { src: strip(e.src_node_id), confidence: e.confidence }
    if (e.metadata) {
      try {
        const m = JSON.parse(e.metadata)
        if (m.resolutionKind) entry.resolution = m.resolutionKind
        if (m.source_location) entry.source_line = m.source_location.sourceLineNumber
      } catch {}
    }
    relations[key].push(entry)
  }

  // Parse payload for extra metadata
  let exported = null
  let endLine = null
  let lineCount = null
  if (node.payload) {
    try {
      const p = JSON.parse(node.payload)
      if (p.metadata?.exported) exported = true
      if (p.metadata?.endLine) endLine = p.metadata.endLine
      if (p.metadata?.lineCount) lineCount = p.metadata.lineCount
    } catch {}
  }

  const source = parseLocation(node.location)

  const fixture = {
    kind: node.kind,
    canonical_name: node.canonical_name,
    category: node.kind,
    source,
    exported,
    line_count: lineCount,
    relations,
    contract: {
      required_node_kinds: [node.kind],
      total_outgoing_edges: outEdges.length,
      total_incoming_edges: inEdges.length,
    },
    ground_truth_metadata: {
      extracted_from: "batch-generate.mjs",
      method: "graph_edges_walk_from_pre-extracted_db",
      generated_at: new Date().toISOString(),
    },
  }

  // Write to <fixture-root>/<kind>/<safeName>.json
  const dir = join(fixtureRoot, node.kind)
  mkdirSync(dir, { recursive: true })
  const fileName = `${safeName(node.canonical_name)}.json`
  const outPath = join(dir, fileName)
  writeFileSync(outPath, JSON.stringify(fixture, null, 2))
  written++
}

console.log(`[batch] wrote ${written} fixture(s) to ${fixtureRoot}`)
db.close()
