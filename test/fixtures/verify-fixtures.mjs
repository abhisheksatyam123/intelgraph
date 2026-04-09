// verify-fixtures.mjs — deep field-by-field fixture verifier.
//
// Goes beyond run-multi-lang.mjs (which only checks "is the symbol's node
// in the DB?"). For each fixture, this verifier walks every relation field
// in the `relations` object, queries the SQLite graph_edges table directly
// for the matching edge_kind in the right direction, and reports per-
// relation PASS/FAIL with the specific missing entries.
//
// Pass criteria for a fixture:
//   1. The fixture's canonical_name resolves to a node in graph_nodes.
//   2. For every relation key listed in the fixture's relations.* block,
//      the SQLite graph contains at least the minimum expected entries.
//
// Reported per relation:
//   PASS              — every expected entry was found in the graph
//   PARTIAL           — at least one entry found, some missing
//   MISSING           — zero matching edges in the graph
//   N/A               — fixture key has no checker for this relation type
//
// The output is the "deep" pass rate the user actually wants — not just
// "did the symbol get extracted" but "is every relation we know about
// also captured."
//
// Usage:
//   node test/fixtures/verify-fixtures.mjs <lang> <project> <workspace_root>

import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join, dirname, relative, basename } from "node:path"
import { fileURLToPath } from "node:url"

import { openSqlite } from "../../src/intelligence/db/sqlite/client.ts"
import { SqliteDbFoundation } from "../../src/intelligence/db/sqlite/foundation.ts"
import { SqliteGraphStore } from "../../src/intelligence/db/sqlite/graph-store.ts"
import { ExtractorRunner } from "../../src/intelligence/extraction/runner.ts"
import { BUILT_IN_EXTRACTORS } from "../../src/plugins/index.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

// ── CLI ─────────────────────────────────────────────────────────────────────

const [lang, project, workspace] = process.argv.slice(2)
if (!lang || !project || !workspace) {
  console.error("Usage: node test/fixtures/verify-fixtures.mjs <lang> <project> <workspace_root>")
  process.exit(2)
}

const fixtureRoot = join(HERE, lang, project, "api")
const dbPath = `/tmp/intelgraph-verify-${lang}-${project}.db`

console.log(`╔══════════════════════════════════════════════════════════════════╗`)
console.log(`║  Deep fixture verifier                                           ║`)
console.log(`╠══════════════════════════════════════════════════════════════════╣`)
console.log(`║  language:  ${lang.padEnd(54)}║`)
console.log(`║  project:   ${project.padEnd(54)}║`)
console.log(`║  workspace: ${workspace.padEnd(54)}║`)
console.log(`╚══════════════════════════════════════════════════════════════════╝`)

// ── Step 1: extract into a fresh on-disk SQLite db ──────────────────────────

rmSync(dbPath, { force: true })

const stubLsp = {
  root: workspace,
  openFile: async () => false,
  documentSymbol: async () => [],
  outgoingCalls: async () => [],
  incomingCalls: async () => [],
  references: async () => [],
  definition: async () => [],
}

let lsp = stubLsp
if (lang === "c") {
  const { LspClient } = await import("../../src/lsp/index.ts")
  console.log("\n[c] spawning clangd...")
  lsp = await LspClient.create({
    root: workspace,
    clangdPath: "clangd",
    clangdArgs: ["--background-index", "--enable-config", "--log=error"],
  })
}

const client = openSqlite({ path: dbPath })
const foundation = new SqliteDbFoundation(client.db, client.raw)
await foundation.initSchema()
const store = new SqliteGraphStore(client.db)

const ref = await foundation.beginSnapshot({
  workspaceRoot: workspace,
  compileDbHash: `verify-${lang}-${project}`,
  parserVersion: "0.1.0",
})
const snapshotId = ref.snapshotId

console.log(`\n[extract] running BUILT_IN_EXTRACTORS...`)
const t0 = Date.now()
const runner = new ExtractorRunner({
  snapshotId, workspaceRoot: workspace, lsp, sink: store, plugins: BUILT_IN_EXTRACTORS,
})
const report = await runner.run()
await foundation.commitSnapshot(snapshotId)
console.log(`[extract] done in ${Date.now() - t0}ms`)
const totalNodes = client.raw.prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ?").get(snapshotId).n
const totalEdges = client.raw.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ?").get(snapshotId).n
console.log(`[extract] graph_nodes=${totalNodes}  graph_edges=${totalEdges}\n`)

// ── Prepared statements ─────────────────────────────────────────────────────

const NODE_ID_PREFIX = `graph_node:${snapshotId}:symbol:`

const stmtNodeByCanonical = client.raw.prepare(
  "SELECT canonical_name, kind, location FROM graph_nodes WHERE snapshot_id = ? AND canonical_name = ?",
)
const stmtNodeByLike = client.raw.prepare(
  "SELECT canonical_name, kind FROM graph_nodes WHERE snapshot_id = ? AND canonical_name LIKE ? LIMIT 5",
)
const stmtIncomingByKind = client.raw.prepare(
  `SELECT src_node_id FROM graph_edges
   WHERE snapshot_id = ? AND edge_kind = ? AND dst_node_id = ?`,
)
const stmtOutgoingByKind = client.raw.prepare(
  `SELECT dst_node_id FROM graph_edges
   WHERE snapshot_id = ? AND edge_kind = ? AND src_node_id = ?`,
)
const stmtContainedNodes = client.raw.prepare(
  `SELECT n.canonical_name, n.kind
   FROM graph_edges e
   JOIN graph_nodes n
     ON n.snapshot_id = e.snapshot_id AND ('graph_node:${snapshotId}:symbol:' || n.canonical_name) = e.dst_node_id
   WHERE e.snapshot_id = ?
     AND e.edge_kind = 'contains'
     AND e.src_node_id = ?`,
)

// ── Helpers to strip the node-id prefix and compare names ──────────────────

function nodeIdToCanonical(nodeId) {
  if (typeof nodeId !== "string") return nodeId
  return nodeId.startsWith(NODE_ID_PREFIX) ? nodeId.slice(NODE_ID_PREFIX.length) : nodeId
}

// Module-path needle = "module:<path>" ending in a source file extension.
// Used so a fixture can say "called from anywhere inside src/index.ts"
// without naming the specific enclosing function.
const MODULE_PATH_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|rs|c|h|cpp)$/
function isModulePathNeedle(needle) {
  return typeof needle === "string"
      && needle.startsWith("module:")
      && MODULE_PATH_EXT_RE.test(needle)
}

/**
 * Match an actual canonical_name from graph_edges against an expected needle
 * from a fixture. Tried in this order:
 *   1. exact match                       — "foo" vs "foo"
 *   2. suffix after '#'                  — "foo" vs "module:src/a.ts#foo"
 *   3. suffix after '.'                  — "bar" vs "Foo.bar"
 *   4. module-path prefix  (NEW)         — "module:src/a.ts" matches itself
 *                                          OR "module:src/a.ts#anySymbol"
 *                                          (only when the needle looks like a
 *                                          module path ending in .ts/.rs/etc.)
 *   5. plain substring                   — last-resort, loose fallback
 *
 * Sanity checks the module-path branch is meant to satisfy:
 *   nameMatches("module:src/index.ts#main", "module:src/index.ts") === true
 *   nameMatches("module:src/index.ts",      "module:src/index.ts") === true
 *   nameMatches("module:src/indexFoo.ts",   "module:src/index.ts") === false
 *   nameMatches("module:src/other.ts#main", "module:src/index.ts") === false
 */
function nameMatches(actualCanonical, expectedNeedle) {
  if (!actualCanonical || !expectedNeedle) return false
  if (actualCanonical === expectedNeedle) return true
  if (actualCanonical.endsWith("#" + expectedNeedle)) return true
  if (actualCanonical.endsWith("." + expectedNeedle)) return true
  if (isModulePathNeedle(expectedNeedle)) {
    // Strict module-path prefix: either identical, or followed immediately
    // by '#' introducing an in-module symbol. Disallows "src/index.ts" also
    // matching "src/indexFoo.ts".
    if (actualCanonical === expectedNeedle) return true
    if (actualCanonical.startsWith(expectedNeedle + "#")) return true
  }
  if (actualCanonical.includes(expectedNeedle)) return true
  return false
}

// ── Per-relation checkers ───────────────────────────────────────────────────

/**
 * Check that the node has at least N incoming edges of the given kind, and
 * that each expected referrer (by name) is present.
 */
function checkIncoming(targetNodeId, edgeKind, expectedList, expectedNamesField) {
  const edges = stmtIncomingByKind.all(snapshotId, edgeKind, targetNodeId)
  const actualSrcs = edges.map((e) => nodeIdToCanonical(e.src_node_id))
  const missing = []
  for (const expected of expectedList) {
    const needle = typeof expected === "string"
      ? expected
      : expected[expectedNamesField] ?? expected.caller ?? expected.referrer ?? expected.name
    if (!actualSrcs.some((a) => nameMatches(a, needle))) {
      missing.push(needle)
    }
  }
  return {
    expected: expectedList.length,
    found: edges.length,
    matched: expectedList.length - missing.length,
    missing,
  }
}

/**
 * Check that the node has at least N outgoing edges of the given kind, and
 * that each expected destination (by name) is present.
 */
function checkOutgoing(srcNodeId, edgeKind, expectedList, expectedNamesField) {
  const edges = stmtOutgoingByKind.all(snapshotId, edgeKind, srcNodeId)
  const actualDsts = edges.map((e) => nodeIdToCanonical(e.dst_node_id))
  const missing = []
  for (const expected of expectedList) {
    const needle = typeof expected === "string"
      ? expected
      : expected[expectedNamesField] ?? expected.callee ?? expected.type ?? expected.name ?? expected.to
    if (!actualDsts.some((a) => nameMatches(a, needle))) {
      missing.push(needle)
    }
  }
  return {
    expected: expectedList.length,
    found: edges.length,
    matched: expectedList.length - missing.length,
    missing,
  }
}

/**
 * Check that the node CONTAINS at least N children matching specific names
 * (e.g. methods on a class, variants on an enum).
 */
function checkContains(srcNodeId, expectedNames, allowedKinds) {
  const rows = stmtContainedNodes.all(snapshotId, srcNodeId)
  const filtered = allowedKinds
    ? rows.filter((r) => allowedKinds.includes(r.kind))
    : rows
  const actualShortNames = filtered.map((r) => {
    // Strip the prefix path: "module:src/foo.ts#X.Y" → "Y"
    const c = r.canonical_name
    const lastDot = c.lastIndexOf(".")
    const lastHash = c.lastIndexOf("#")
    const cut = Math.max(lastDot, lastHash)
    return cut > 0 ? c.slice(cut + 1) : c
  })
  const missing = []
  for (const name of expectedNames) {
    if (!actualShortNames.includes(name)) {
      missing.push(name)
    }
  }
  return {
    expected: expectedNames.length,
    found: filtered.length,
    matched: expectedNames.length - missing.length,
    missing,
  }
}

// Map from fixture relation key → check function. Each entry returns
// { kind, status, expected, found, matched, missing }.
//
// Two naming conventions are supported:
//   1. Hand-authored: calls_in_direct, calls_out, references_type_in, etc.
//   2. Batch-generated: <edge_kind>_out, <edge_kind>_in (e.g. calls_out,
//      calls_in, contains_out, contains_in, references_type_out, etc.)
//
// The batch-generated entries use "src"/"dst" fields; the hand-authored
// use "caller"/"callee"/"referrer"/"type"/"to". The nameExtractor params
// below handle both forms.
const RELATION_CHECKERS = {
  // ── Hand-authored convention ──────────────────────────────────────────
  calls_in_direct:    (target, value) => ({ kind: "calls (incoming)",         ...checkIncoming(target, "calls",           value, "caller") }),
  // ── Batch-generated convention: <edge_kind>_out / <edge_kind>_in ──────
  // Incoming edges (suffix _in)
  calls_in:                  (target, value) => ({ kind: "calls (in)",              ...checkIncoming(target, "calls",           value, "src") }),
  contains_in:               (target, value) => ({ kind: "contains (in)",           ...checkIncoming(target, "contains",        value, "src") }),
  references_type_in:        (target, value) => ({ kind: "references_type (in)",    ...checkIncoming(target, "references_type", value, "src") }),
  implements_in:             (target, value) => ({ kind: "implements (in)",          ...checkIncoming(target, "implements",      value, "src") }),
  extends_in:                (target, value) => ({ kind: "extends (in)",             ...checkIncoming(target, "extends",         value, "src") }),
  imports_in:                (target, value) => ({ kind: "imports (in)",             ...checkIncoming(target, "imports",         value, "src") }),
  field_of_type_in:          (target, value) => ({ kind: "field_of_type (in)",      ...checkIncoming(target, "field_of_type",   value, "src") }),
  aggregates_in:             (target, value) => ({ kind: "aggregates (in)",          ...checkIncoming(target, "aggregates",      value, "src") }),
  reads_field_in:            (target, value) => ({ kind: "reads_field (in)",         ...checkIncoming(target, "reads_field",     value, "src") }),
  writes_field_in:           (target, value) => ({ kind: "writes_field (in)",        ...checkIncoming(target, "writes_field",    value, "src") }),
  // Outgoing edges (suffix _out)
  calls_out:                 (target, value) => ({ kind: "calls (out)",             ...checkOutgoing(target, "calls",           value, "dst") }),
  contains_out:              (target, value) => ({ kind: "contains (out)",          ...checkOutgoing(target, "contains",        value, "dst") }),
  references_type_out:       (target, value) => ({ kind: "references_type (out)",   ...checkOutgoing(target, "references_type", value, "dst") }),
  implements_out:            (target, value) => ({ kind: "implements (out)",         ...checkOutgoing(target, "implements",      value, "dst") }),
  extends_out:               (target, value) => ({ kind: "extends (out)",            ...checkOutgoing(target, "extends",         value, "dst") }),
  imports_out:               (target, value) => ({ kind: "imports (out)",            ...checkOutgoing(target, "imports",         value, "dst") }),
  field_of_type_out:         (target, value) => ({ kind: "field_of_type (out)",     ...checkOutgoing(target, "field_of_type",   value, "dst") }),
  aggregates_out:            (target, value) => ({ kind: "aggregates (out)",         ...checkOutgoing(target, "aggregates",      value, "dst") }),
  reads_field_out:           (target, value) => ({ kind: "reads_field (out)",        ...checkOutgoing(target, "reads_field",     value, "dst") }),
  writes_field_out:          (target, value) => ({ kind: "writes_field (out)",       ...checkOutgoing(target, "writes_field",    value, "dst") }),
  // ── Hand-authored aliases ─────────────────────────────────────────────
  references_type:    (target, value) => ({ kind: "references_type (hand-out)", ...checkOutgoing(target, "references_type", value, "type") }),
  implements:         (target, value) => ({ kind: "implements (hand-out)",      ...checkOutgoing(target, "implements",      value, "type") }),
  extends:            (target, value) => ({ kind: "extends (hand-out)",         ...checkOutgoing(target, "extends",         value, "type") }),
  // ── Containment-style (hand-authored only) ────────────────────────────
  contains_methods:           (target, value) => ({ kind: "contains methods",        ...checkContains(target, value, ["method"]) }),
  contains_variants:          (target, value) => ({ kind: "contains enum_variants",  ...checkContains(target, value, ["enum_variant"]) }),
  contains_modules:           (target, value) => ({ kind: "contains modules",        ...checkContains(target, value, ["module", "namespace"]) }),
  contains_top_level_exports: (target, value) => ({ kind: "contains top-level exports", ...checkContains(target, value, null) }),
  field_kinds_present:        (target, value) => ({ kind: "contains fields",         ...checkContains(target, value, ["field"]) }),
}

// ── Walk fixtures ───────────────────────────────────────────────────────────

function walkJsonFiles(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJsonFiles(p))
    else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("_")) out.push(p)
  }
  return out
}

const fixtureFiles = walkJsonFiles(fixtureRoot).sort()
console.log(`[verify] ${fixtureFiles.length} fixture(s) to deep-verify\n`)

const fixtureResults = []
let lastCategory = ""

for (const path of fixtureFiles) {
  const fixture = JSON.parse(readFileSync(path, "utf8"))
  const rel = relative(fixtureRoot, path)
  const category = dirname(rel).split("/")[0] ?? "(root)"
  if (category !== lastCategory) {
    console.log(`── ${category} ──`)
    lastCategory = category
  }

  const expectedName = fixture.canonical_name
  const node = stmtNodeByCanonical.get(snapshotId, expectedName)
  if (!node) {
    console.log(`  MISS  ${basename(rel).padEnd(40)} node not in db: ${expectedName}`)
    fixtureResults.push({ fixture: rel, status: "node-missing", expected: expectedName })
    continue
  }

  const targetNodeId = `${NODE_ID_PREFIX}${expectedName}`
  const checks = []
  let totalExpected = 0
  let totalMatched = 0
  let unhandledKeys = []

  // Walk every key in fixture.relations and dispatch to a checker
  const relations = fixture.relations ?? {}
  for (const [key, value] of Object.entries(relations)) {
    if (!Array.isArray(value)) continue            // skip scalar / object fields
    if (value.length === 0) continue               // empty arrays = no expectations
    const checker = RELATION_CHECKERS[key]
    if (!checker) {
      unhandledKeys.push(key)
      continue
    }
    const result = checker(targetNodeId, value)
    totalExpected += result.expected
    totalMatched += result.matched
    checks.push({ key, ...result })
  }

  // Decide overall status
  let overall
  if (checks.length === 0) {
    overall = "node-only"     // no relations to verify, just node existence
  } else if (totalMatched === totalExpected) {
    overall = "pass"
  } else if (totalMatched === 0) {
    overall = "fail-all-relations"
  } else {
    overall = "partial"
  }

  const tag = overall === "pass" ? "PASS"
            : overall === "node-only" ? "NODE"
            : overall === "partial" ? "PART"
            : "FAIL"
  const summary = checks.length > 0 ? `${totalMatched}/${totalExpected}` : "node-only"
  console.log(`  ${tag.padEnd(5)} ${basename(rel).padEnd(40)} ${summary}`)
  for (const c of checks) {
    if (c.matched < c.expected) {
      console.log(`        ✗ ${c.kind.padEnd(28)} matched=${c.matched}/${c.expected} found=${c.found} missing=${JSON.stringify(c.missing.slice(0, 3))}`)
    } else {
      console.log(`        ✓ ${c.kind.padEnd(28)} matched=${c.matched}/${c.expected}`)
    }
  }
  if (unhandledKeys.length > 0) {
    console.log(`        · unhandled keys: ${unhandledKeys.join(", ")}`)
  }

  fixtureResults.push({
    fixture: rel,
    canonical_name: expectedName,
    status: overall,
    checks,
    unhandledKeys,
    totalExpected,
    totalMatched,
  })
}

// ── Summary ─────────────────────────────────────────────────────────────────

const pass     = fixtureResults.filter((r) => r.status === "pass").length
const partial  = fixtureResults.filter((r) => r.status === "partial").length
const failAll  = fixtureResults.filter((r) => r.status === "fail-all-relations").length
const nodeOnly = fixtureResults.filter((r) => r.status === "node-only").length
const nodeMiss = fixtureResults.filter((r) => r.status === "node-missing").length
const total    = fixtureResults.length

const allExpected = fixtureResults.reduce((s, r) => s + (r.totalExpected ?? 0), 0)
const allMatched  = fixtureResults.reduce((s, r) => s + (r.totalMatched  ?? 0), 0)
const relationPct = allExpected > 0 ? Math.round((allMatched / allExpected) * 100) : 0

console.log()
console.log(`══════ ${lang}/${project}`)
console.log(`  fixture-level: ${pass} pass · ${partial} partial · ${failAll} fail-all · ${nodeOnly} node-only · ${nodeMiss} node-missing  (of ${total})`)
console.log(`  relation-level: ${allMatched}/${allExpected} relations matched (${relationPct}%)`)

const resultsDir = join(HERE, lang, project, "results")
mkdirSync(resultsDir, { recursive: true })
const outFile = join(resultsDir, `deep-verify-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
writeFileSync(outFile, JSON.stringify({
  language: lang, project, workspace,
  timestamp: new Date().toISOString(),
  summary: { pass, partial, failAll, nodeOnly, nodeMiss, total, allExpected, allMatched, relationPct },
  results: fixtureResults,
}, null, 2))
console.log(`\nDetailed results: ${outFile}`)

process.exit(0)
