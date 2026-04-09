// run-multi-lang.mjs — multi-language fixture verifier.
//
// Verifies that intelgraph's extractor pipelines populate the SQLite
// intelligence graph with the entities every fixture expects.
//
// Unlike test/fixtures/linux/run-fixtures.mjs (which queries clangd via
// MCP at runtime), this runner triggers the extractor directly into an
// on-disk SQLite db and then queries `graph_nodes` / `graph_edges`
// directly. That tests the "fill DB dynamically on the fly" pipeline
// end-to-end:
//
//   workspace source files
//        │
//        ▼  ExtractorRunner (BUILT_IN_EXTRACTORS)
//   graph_nodes / graph_edges in SQLite
//        │
//        ▼  THIS RUNNER queries the table directly
//   pass / fail per fixture
//
// Layout consumed:
//   test/fixtures/<lang>/<project>/api/<category>/<symbol>.json
//
// Usage:
//   node test/fixtures/run-multi-lang.mjs <lang> <project> <workspace_root>
//   node test/fixtures/run-multi-lang.mjs ts intelgraph /home/abhi/qprojects/intelgraph
//   node test/fixtures/run-multi-lang.mjs rust markdown-oxide /home/abhi/qprojects/markdown-oxide
//   node test/fixtures/run-multi-lang.mjs c linux /home/abhi/qprojects/linux
//
// Each fixture is verified by looking up its `canonical_name` in the
// `graph_nodes` table for the snapshot we just created. The runner does
// NOT do per-relation validation (use linux/run-fixtures.mjs for that
// against a live MCP daemon). Its job is the simpler question:
// "did the extractor put this entity into the database at all?"

import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join, dirname, relative, basename } from "node:path"
import { fileURLToPath } from "node:url"

import { openSqlite } from "../../src/intelligence/db/sqlite/client.ts"
import { SqliteDbFoundation } from "../../src/intelligence/db/sqlite/foundation.ts"
import { SqliteGraphStore } from "../../src/intelligence/db/sqlite/graph-store.ts"
import { ExtractorRunner } from "../../src/intelligence/extraction/runner.ts"
import { BUILT_IN_EXTRACTORS } from "../../src/plugins/index.ts"

const HERE = dirname(fileURLToPath(import.meta.url))

// ── Argument parsing ────────────────────────────────────────────────────────

const [lang, project, workspace] = process.argv.slice(2)
if (!lang || !project || !workspace) {
  console.error("Usage: node test/fixtures/run-multi-lang.mjs <lang> <project> <workspace_root>")
  console.error("Example: node test/fixtures/run-multi-lang.mjs ts intelgraph /home/abhi/qprojects/intelgraph")
  process.exit(2)
}

const fixtureRoot = join(HERE, lang, project, "api")
const dbPath = `/tmp/intelgraph-${lang}-${project}.db`

console.log(`╔══════════════════════════════════════════════════════════════════╗`)
console.log(`║  Multi-language fixture runner                                   ║`)
console.log(`╠══════════════════════════════════════════════════════════════════╣`)
console.log(`║  language:  ${lang.padEnd(54)}║`)
console.log(`║  project:   ${project.padEnd(54)}║`)
console.log(`║  workspace: ${workspace.padEnd(54)}║`)
console.log(`║  fixtures:  ${fixtureRoot.padEnd(54)}║`)
console.log(`║  db:        ${dbPath.padEnd(54)}║`)
console.log(`╚══════════════════════════════════════════════════════════════════╝`)

// ── Step 1: trigger extraction into a fresh on-disk SQLite db ────────────

rmSync(dbPath, { force: true })

// The clangd-core extractor needs an LSP client. For TS and Rust we don't
// need clangd, so we provide a stub. C/C++ workspaces need a real clangd
// connection — handled separately when lang === "c".
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
  try {
    const { LspClient } = await import("../../src/lsp/index.ts")
    console.log("\n[c] spawning clangd for C/C++ extraction...")
    lsp = await LspClient.create({
      root: workspace,
      clangdPath: "clangd",
      clangdArgs: ["--background-index", "--enable-config", "--log=error"],
    })
    console.log("[c] clangd ready")
  } catch (err) {
    console.error("[c] clangd init failed, falling back to stub:", err.message)
  }
}

const client = openSqlite({ path: dbPath })
const foundation = new SqliteDbFoundation(client.db, client.raw)
await foundation.initSchema()
const store = new SqliteGraphStore(client.db)

const ref = await foundation.beginSnapshot({
  workspaceRoot: workspace,
  compileDbHash: `multi-lang-${lang}-${project}`,
  parserVersion: "0.1.0",
})
const snapshotId = ref.snapshotId

console.log(`\n[extract] running BUILT_IN_EXTRACTORS on ${workspace}...`)
const t0 = Date.now()
const runner = new ExtractorRunner({
  snapshotId,
  workspaceRoot: workspace,
  lsp,
  sink: store,
  plugins: BUILT_IN_EXTRACTORS,
})
const report = await runner.run()
await foundation.commitSnapshot(snapshotId)
const ms = Date.now() - t0
console.log(`[extract] done in ${ms}ms`)
for (const p of report.perPlugin) {
  const counters = p.metrics?.counters ?? {}
  if (Object.keys(counters).length > 0) {
    console.log(`[extract]   ${p.pluginId ?? "unknown"}: ${JSON.stringify(counters)}`)
  }
}

// Quick totals from the db
const totalNodes = client.raw.prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ?").get(snapshotId).n
const totalEdges = client.raw.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ?").get(snapshotId).n
console.log(`[extract] graph_nodes=${totalNodes}  graph_edges=${totalEdges}`)

// ── Step 2: walk fixtures and verify each ────────────────────────────────

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
console.log(`\n[verify] ${fixtureFiles.length} fixture(s) to check\n`)

const lookupNode = client.raw.prepare(
  "SELECT canonical_name, kind, location FROM graph_nodes WHERE snapshot_id = ? AND canonical_name = ?",
)
const lookupNodeByLike = client.raw.prepare(
  "SELECT canonical_name, kind FROM graph_nodes WHERE snapshot_id = ? AND canonical_name LIKE ? LIMIT 5",
)

const results = []
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
  const expectedKind = fixture.kind
  const exact = lookupNode.get(snapshotId, expectedName)
  let result
  if (exact) {
    const kindMatches = !expectedKind || exact.kind === expectedKind
    if (kindMatches) {
      result = { fixture: rel, status: "pass", got: exact }
    } else {
      result = { fixture: rel, status: "wrong-kind", expectedKind, got: exact }
    }
  } else {
    // Try a fuzzy lookup so we can report close misses
    const suffix = basename(expectedName)
    const fuzzy = lookupNodeByLike.all(snapshotId, `%${suffix}%`)
    result = { fixture: rel, status: "missing", expectedName, fuzzyHits: fuzzy }
  }
  results.push(result)
  const tag = result.status === "pass" ? "PASS" : result.status === "wrong-kind" ? "WKND" : "MISS"
  console.log(`  ${tag.padEnd(5)} ${basename(rel).padEnd(40)} ${expectedName}`)
  if (result.status === "wrong-kind") {
    console.log(`        expected kind=${expectedKind}, got kind=${result.got.kind}`)
  }
  if (result.status === "missing" && result.fuzzyHits.length > 0) {
    console.log(`        fuzzy:`)
    for (const f of result.fuzzyHits.slice(0, 3)) console.log(`          ${f.kind.padEnd(10)} ${f.canonical_name}`)
  }
}

const pass = results.filter((r) => r.status === "pass").length
const wknd = results.filter((r) => r.status === "wrong-kind").length
const miss = results.filter((r) => r.status === "missing").length
const total = results.length
const pct = total > 0 ? Math.round((pass / total) * 100) : 0

console.log(`\n══════ ${lang}/${project}: ${pass}/${total} pass (${pct}%) · ${wknd} wrong-kind · ${miss} missing`)

// Save results
const resultsDir = join(HERE, lang, project, "results")
mkdirSync(resultsDir, { recursive: true })
const outFile = join(resultsDir, `pass-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
writeFileSync(outFile, JSON.stringify({
  language: lang,
  project,
  workspace,
  timestamp: new Date().toISOString(),
  totals: { pass, wknd, miss, total, pct },
  results,
}, null, 2))
console.log(`Results: ${outFile}`)

process.exit(0)
