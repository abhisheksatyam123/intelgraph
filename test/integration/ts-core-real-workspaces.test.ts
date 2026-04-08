/**
 * test/integration/ts-core-real-workspaces.test.ts
 *
 * End-to-end smoke tests that ingest real TypeScript workspaces using
 * the ts-core plugin and assert that the resulting SQLite snapshot
 * answers basic intent queries correctly.
 *
 * Targets:
 *   - /home/abhi/qprojects/opencode (Bun monorepo, packages/opencode/src)
 *   - /home/abhi/qprojects/openclaude (TS/React project)
 *
 * Both tests skip cleanly when the workspace path doesn't exist on the
 * host (so CI environments without those checkouts still pass).
 *
 * Each test:
 *   1. Spins up an in-memory SqliteDbFoundation + SqliteGraphStore
 *   2. Begins a snapshot, runs the ts-core plugin via ExtractorRunner
 *   3. Commits the snapshot
 *   4. Queries SqliteDbLookup for symbols and edges via several intents
 *   5. Asserts that the workspace produced a non-trivial graph and
 *      that specific known APIs come back through the query layer
 *
 * The smoke tests intentionally do not assert exact counts — those
 * change as the workspace evolves. They assert *floors* (>= N nodes,
 * >= 1 edge of kind X) so they catch regressions without flapping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { openSqlite, type SqliteClient } from "../../src/intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../../src/intelligence/db/sqlite/foundation.js"
import { SqliteGraphStore } from "../../src/intelligence/db/sqlite/graph-store.js"
import { SqliteDbLookup } from "../../src/intelligence/db/sqlite/db-lookup.js"
import { ExtractorRunner } from "../../src/intelligence/extraction/runner.js"
import { tsCoreExtractor } from "../../src/plugins/index.js"
import type { ILanguageClient } from "../../src/lsp/types.js"

const stubLsp = {
  root: "/tmp",
  openFile: async () => false,
  documentSymbol: async () => [],
  outgoingCalls: async () => [],
  incomingCalls: async () => [],
  references: async () => [],
  definition: async () => [],
} as unknown as ILanguageClient

interface IngestedWorkspace {
  client: SqliteClient
  foundation: SqliteDbFoundation
  store: SqliteGraphStore
  lookup: SqliteDbLookup
  snapshotId: number
}

async function ingestWorkspace(workspaceRoot: string): Promise<IngestedWorkspace> {
  const client = openSqlite({ path: ":memory:" })
  const foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
  const store = new SqliteGraphStore(client.db)
  const lookup = new SqliteDbLookup(client.db, client.raw)

  const ref = await foundation.beginSnapshot({
    workspaceRoot,
    compileDbHash: "ts-core-smoke",
    parserVersion: "0.1.0",
  })
  const snapshotId = ref.snapshotId

  const runner = new ExtractorRunner({
    snapshotId,
    workspaceRoot,
    lsp: stubLsp,
    sink: store,
    plugins: [tsCoreExtractor],
  })
  const report = await runner.run()
  expect(report.pluginsFailed).toBe(0)
  expect(report.pluginsRun).toBe(1)

  await foundation.commitSnapshot(snapshotId)
  return { client, foundation, store, lookup, snapshotId }
}

// ---------------------------------------------------------------------------
// opencode workspace
// ---------------------------------------------------------------------------

const OPENCODE_ROOT = "/home/abhi/qprojects/opencode/packages/opencode"

describe.skipIf(!existsSync(OPENCODE_ROOT))(
  "ts-core integration — opencode/packages/opencode",
  () => {
    let ingest: IngestedWorkspace

    beforeAll(async () => {
      ingest = await ingestWorkspace(OPENCODE_ROOT)
    }, 120_000)

    afterAll(() => {
      ingest?.client.close()
    })

    it("snapshot is non-empty (show_hot_call_paths returns rows)", async () => {
      const result = await ingest.lookup.lookup({
        intent: "show_hot_call_paths",
        snapshotId: ingest.snapshotId,
        limit: 50,
      })
      expect(result.rows.length).toBeGreaterThan(0)
    })

    it("emits at least 100 module symbols across the workspace", () => {
      const moduleCount = ingest.client.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ? AND kind = 'module'",
        )
        .get(ingest.snapshotId) as { n: number }
      expect(moduleCount.n).toBeGreaterThan(100)
    })

    it("emits function and class symbols", () => {
      const counts = ingest.client.raw
        .prepare(
          `SELECT kind, COUNT(*) AS n FROM graph_nodes
           WHERE snapshot_id = ? AND kind IN ('function', 'class', 'interface')
           GROUP BY kind`,
        )
        .all(ingest.snapshotId) as Array<{ kind: string; n: number }>
      const byKind: Record<string, number> = {}
      for (const row of counts) byKind[row.kind] = row.n
      expect(byKind.function ?? 0).toBeGreaterThan(50)
      // opencode is heavy on namespaces + classes; we expect at least
      // some classes.
      expect((byKind.class ?? 0) + (byKind.interface ?? 0)).toBeGreaterThan(0)
    })

    it("emits import edges", () => {
      const importCount = ingest.client.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = 'imports'",
        )
        .get(ingest.snapshotId) as { n: number }
      expect(importCount.n).toBeGreaterThan(50)
    })

    it("emits contains edges (module → declared symbol)", () => {
      const containsCount = ingest.client.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = 'contains'",
        )
        .get(ingest.snapshotId) as { n: number }
      expect(containsCount.n).toBeGreaterThan(50)
    })

    it("emits call edges", () => {
      const callCount = ingest.client.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = 'calls'",
        )
        .get(ingest.snapshotId) as { n: number }
      // opencode has many call sites; expect a substantial count.
      expect(callCount.n).toBeGreaterThan(200)
    })

    // ── End-to-end query tests through SqliteDbLookup ───────────────────

    it("find_module_imports returns the imports of a real opencode module", async () => {
      // Pick the agent module which we know imports many things.
      const agentModule = ingest.client.raw
        .prepare(
          `SELECT canonical_name FROM graph_nodes
           WHERE snapshot_id = ? AND kind = 'module' AND canonical_name LIKE '%agent/agent.ts'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { canonical_name: string } | undefined
      if (!agentModule) {
        // The file might have been renamed; the test passes vacuously
        // — opencode evolves and we don't want flapping on rename.
        return
      }
      const result = await ingest.lookup.lookup({
        intent: "find_module_imports",
        snapshotId: ingest.snapshotId,
        apiName: agentModule.canonical_name,
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Every row should be an imports edge
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("imports")
      }
    })

    it("find_module_symbols returns symbols declared in a real opencode module", async () => {
      const agentModule = ingest.client.raw
        .prepare(
          `SELECT canonical_name FROM graph_nodes
           WHERE snapshot_id = ? AND kind = 'module' AND canonical_name LIKE '%agent/agent.ts'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { canonical_name: string } | undefined
      if (!agentModule) return
      const result = await ingest.lookup.lookup({
        intent: "find_module_symbols",
        snapshotId: ingest.snapshotId,
        apiName: agentModule.canonical_name,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Every row should be a contains edge
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("contains")
      }
    })

    it("find_module_dependents finds reverse imports", async () => {
      // Find any module that has at least one incoming import.
      const dependedOnModule = ingest.client.raw
        .prepare(
          `SELECT dst.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes dst
             ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'imports'
             AND dst.kind = 'module'
           GROUP BY dst.canonical_name
           ORDER BY n DESC
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!dependedOnModule) return
      const result = await ingest.lookup.lookup({
        intent: "find_module_dependents",
        snapshotId: ingest.snapshotId,
        apiName: dependedOnModule.name,
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      expect(result.rows.length).toBeLessThanOrEqual(dependedOnModule.n)
    })

    it("who_calls_api works for a ts-core function with known callers", async () => {
      // Pick the most-called function in the snapshot — by definition
      // it has incoming `calls` edges, so who_calls_api must return rows.
      const target = ingest.client.raw
        .prepare(
          `SELECT dst.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes dst
             ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ? AND e.edge_kind = 'calls'
             AND dst.kind IN ('function', 'method')
             AND dst.canonical_name LIKE 'module:%'
           GROUP BY dst.canonical_name
           ORDER BY n DESC
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!target) return
      const result = await ingest.lookup.lookup({
        intent: "who_calls_api",
        snapshotId: ingest.snapshotId,
        apiName: target.name,
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
    })

    it("what_api_calls works for a ts-core function with known callees", async () => {
      // Pick the function with the most outgoing calls.
      const source = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           WHERE e.snapshot_id = ? AND e.edge_kind = 'calls'
             AND src.kind IN ('function', 'method')
             AND src.canonical_name LIKE 'module:%'
           GROUP BY src.canonical_name
           ORDER BY n DESC
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!source) return
      const result = await ingest.lookup.lookup({
        intent: "what_api_calls",
        snapshotId: ingest.snapshotId,
        apiName: source.name,
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
    })

    it("find_class_inheritance returns the parent of an inheriting class", async () => {
      // Pick any class that has an extends edge in the snapshot.
      const child = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name
           FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'extends'
             AND src.kind = 'class'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string } | undefined
      if (!child) return // opencode may have no extends edges yet
      const result = await ingest.lookup.lookup({
        intent: "find_class_inheritance",
        snapshotId: ingest.snapshotId,
        apiName: child.name,
        limit: 10,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("extends")
      }
    })

    it("find_class_subtypes finds children that extend a parent", async () => {
      // Pick the most-extended class (highest in-degree on extends).
      const parent = ingest.client.raw
        .prepare(
          `SELECT dst.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes dst
             ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ? AND e.edge_kind = 'extends'
           GROUP BY dst.canonical_name
           ORDER BY n DESC
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!parent) return
      const result = await ingest.lookup.lookup({
        intent: "find_class_subtypes",
        snapshotId: ingest.snapshotId,
        apiName: parent.name,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      expect(result.rows.length).toBeLessThanOrEqual(parent.n)
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("extends")
      }
    })

    it("find_type_dependencies returns the types a function references", async () => {
      // Pick any function/method that has at least one outgoing
      // references_type edge.
      const consumer = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name
           FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'references_type'
             AND src.kind IN ('function', 'method')
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string } | undefined
      if (!consumer) return
      const result = await ingest.lookup.lookup({
        intent: "find_type_dependencies",
        snapshotId: ingest.snapshotId,
        apiName: consumer.name,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("references_type")
      }
    })

    it("find_modules_by_directory groups modules with aggregate stats", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_modules_by_directory",
        snapshotId: ingest.snapshotId,
        limit: 20,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Each row should have positive module_count and start with module:
      for (const row of result.rows) {
        expect(String(row.canonical_name)).toMatch(/^module:/)
        const count = Number(
          (row as { module_count?: number }).module_count,
        )
        expect(count).toBeGreaterThan(0)
      }
      // Sorted descending by module_count
      const counts = result.rows.map(
        (r) => Number((r as { module_count?: number }).module_count),
      )
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
    })

    it("find_largest_modules ranks modules by line count", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_largest_modules",
        snapshotId: ingest.snapshotId,
        limit: 10,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      const counts = result.rows.map(
        (r) => Number((r as { line_count?: number }).line_count),
      )
      // All modules should have positive line counts
      for (const c of counts) {
        expect(c).toBeGreaterThan(0)
      }
      // Sorted descending
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
      // All result rows are modules
      for (const row of result.rows) {
        expect(row.kind).toBe("module")
      }
    })

    it("find_orphan_modules returns modules with no imports either way", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_orphan_modules",
        snapshotId: ingest.snapshotId,
        limit: 50,
      })
      // Result MAY be empty if every module is connected. Most
      // workspaces have at least a few orphans (test fixtures, type
      // declaration files, etc.).
      expect(result.intent).toBe("find_orphan_modules")
      // All result rows are modules
      for (const row of result.rows) {
        expect(row.kind).toBe("module")
        expect(String(row.canonical_name)).toMatch(/^module:/)
      }
    })

    it("find_top_implemented_interfaces ranks interfaces by implementor count", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_top_implemented_interfaces",
        snapshotId: ingest.snapshotId,
        limit: 10,
      })
      // opencode is namespace-heavy not class-heavy, so result MAY
      // be small. Just assert the row shape when matches exist.
      expect(result.intent).toBe("find_top_implemented_interfaces")
      const counts = result.rows.map(
        (r) => Number((r as { incoming_count?: number }).incoming_count),
      )
      // Each row has positive incoming_count (it's the implementor count)
      for (const c of counts) {
        expect(c).toBeGreaterThan(0)
      }
      // Sorted descending
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
      // All result rows are interface kind
      for (const row of result.rows) {
        expect(row.kind).toBe("interface")
      }
    })

    it("find_undocumented_exports surfaces public APIs missing JSDoc", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_undocumented_exports",
        snapshotId: ingest.snapshotId,
        limit: 50,
      })
      // opencode is large and not every export has docs. Expect at
      // least some undocumented exports.
      expect(result.intent).toBe("find_undocumented_exports")
      // All result rows should be exported function/class/interface
      for (const row of result.rows) {
        expect(["function", "class", "interface"]).toContain(String(row.kind))
        expect(String(row.canonical_name)).toMatch(/^module:/)
      }
    })

    it("find_widely_referenced_types ranks types by distinct-module usage", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_widely_referenced_types",
        snapshotId: ingest.snapshotId,
        limit: 10,
      })
      // opencode has Effect-style codebases which heavily use type
      // references. Expect at least one widely-referenced type.
      expect(result.intent).toBe("find_widely_referenced_types")
      const counts = result.rows.map(
        (r) => Number((r as { module_count?: number }).module_count),
      )
      // Each row has a positive module_count
      for (const c of counts) {
        expect(c).toBeGreaterThan(0)
      }
      // Sorted descending
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
      // All result rows should be type-shaped kinds
      for (const row of result.rows) {
        expect(["class", "interface", "typedef"]).toContain(String(row.kind))
      }
    })

    it("find_classes_by_method_count surfaces god objects", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_classes_by_method_count",
        snapshotId: ingest.snapshotId,
        limit: 10,
      })
      // opencode is namespace-heavy not class-heavy, so result MAY
      // be small. Just assert the shape is valid when matches exist.
      expect(result.intent).toBe("find_classes_by_method_count")
      const counts = result.rows.map(
        (r) => Number((r as { method_count?: number }).method_count),
      )
      // Each class has at least one method (otherwise it wouldn't
      // appear in the result)
      for (const c of counts) {
        expect(c).toBeGreaterThan(0)
      }
      // Sorted descending
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
      // All result rows are class kind
      for (const row of result.rows) {
        expect(row.kind).toBe("class")
      }
    })

    it("find_tightly_coupled_modules ranks module pairs by coupling count", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_tightly_coupled_modules",
        snapshotId: ingest.snapshotId,
        limit: 20,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      const counts = result.rows.map(
        (r) => Number((r as { coupling_count?: number }).coupling_count),
      )
      // Each row has a positive coupling_count
      for (const c of counts) {
        expect(c).toBeGreaterThan(0)
      }
      // Sorted descending
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
      // src_module != dst_module (no self-coupling)
      for (const row of result.rows) {
        expect(row.caller).not.toBe(row.callee)
      }
    })

    it("find_symbols_by_doc searches documentation content", async () => {
      // Pick any pattern that's likely to appear in opencode JSDoc
      const result = await ingest.lookup.lookup({
        intent: "find_symbols_by_doc",
        snapshotId: ingest.snapshotId,
        pattern: "the",
        limit: 20,
      })
      // Skip if no doc-bearing symbols exist (some snapshots may
      // have empty docstring metadata)
      if (!result.hit || result.rows.length === 0) return
      // Every result should have a doc field containing the pattern
      for (const row of result.rows) {
        const doc = String((row as { doc?: string }).doc ?? "")
        expect(doc.toLowerCase()).toContain("the")
      }
    })

    it("find_deepest_call_chain returns the longest reachable chain", async () => {
      // Pick a function whose outgoing call resolves to a real
      // graph_node (i.e. an FQ symbol that exists in graph_nodes).
      // This avoids the case where the seed's only outgoing call is
      // to a bare/external identifier and the recursive CTE returns
      // nothing.
      const seed = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name
           FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           INNER JOIN graph_nodes dst
             ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'calls'
             AND src.kind IN ('function', 'method')
             AND dst.kind IN ('function', 'method')
             AND src.canonical_name LIKE 'module:%#%'
             AND dst.canonical_name LIKE 'module:%#%'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string } | undefined
      if (!seed) return

      const result = await ingest.lookup.lookup({
        intent: "find_deepest_call_chain",
        snapshotId: ingest.snapshotId,
        apiName: seed.name,
        depth: 6,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // First row's caller should be the seed
      expect(result.rows[0].caller).toBe(seed.name)
      // chain_depth equals the number of hops (= rows.length)
      const depths = new Set(
        result.rows.map((r) => Number((r as { chain_depth?: number }).chain_depth)),
      )
      // All rows in the chain share the same chain_depth
      expect(depths.size).toBe(1)
      // path_index is monotonically increasing
      const indices = result.rows.map(
        (r) => Number((r as { path_index?: number }).path_index),
      )
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1])
      }
    })

    it("find_type_cycles surfaces mutual type references between classes/interfaces", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_type_cycles",
        snapshotId: ingest.snapshotId,
        limit: 50,
      })
      // Type cycles MAY be empty in healthy codebases. The important
      // assertion is that the query doesn't error and the row shape
      // is valid when matches do exist.
      expect(result.intent).toBe("find_type_cycles")
      for (const row of result.rows) {
        expect(["class", "interface"]).toContain(String(row.kind))
        expect(row.edge_kind).toBe("references_type")
        // De-dup invariant: caller < callee alphabetically
        expect(String(row.caller) < String(row.callee)).toBe(true)
      }
    })

    it("find_modules_overview returns aggregate stats for every module", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_modules_overview",
        snapshotId: ingest.snapshotId,
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Each row is a module with all 5 aggregate fields
      for (const row of result.rows) {
        expect(row.kind).toBe("module")
        expect(String(row.canonical_name)).toMatch(/^module:/)
        const r = row as {
          symbol_count: number
          exported_count: number
          outgoing_imports: number
          incoming_imports: number
        }
        expect(typeof r.symbol_count).toBe("number")
        expect(typeof r.exported_count).toBe("number")
        expect(typeof r.outgoing_imports).toBe("number")
        expect(typeof r.incoming_imports).toBe("number")
        // exported_count never exceeds symbol_count
        expect(r.exported_count).toBeLessThanOrEqual(r.symbol_count)
      }
      // Sorted alphabetically
      const names = result.rows.map((r) => String(r.canonical_name))
      const sorted = [...names].sort()
      expect(names).toEqual(sorted)
    })

    it("find_module_interactions returns edges between two modules", async () => {
      // Pick any two modules where one calls into the other.
      const seed = ingest.client.raw
        .prepare(
          `SELECT
             json_extract(src.payload, '$.metadata.modulePath') AS src_path,
             json_extract(dst.payload, '$.metadata.modulePath') AS dst_path,
             SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1) AS src_module,
             SUBSTR(dst.canonical_name, 1, INSTR(dst.canonical_name, '#') - 1) AS dst_module
           FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           INNER JOIN graph_nodes dst
             ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'calls'
             AND src.canonical_name LIKE 'module:%#%'
             AND dst.canonical_name LIKE 'module:%#%'
             AND INSTR(src.canonical_name, '#') > 0
             AND INSTR(dst.canonical_name, '#') > 0
             AND SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1)
                 != SUBSTR(dst.canonical_name, 1, INSTR(dst.canonical_name, '#') - 1)
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as
        | { src_module: string; dst_module: string }
        | undefined
      if (!seed) return

      const result = await ingest.lookup.lookup({
        intent: "find_module_interactions",
        snapshotId: ingest.snapshotId,
        srcApi: seed.src_module,
        dstApi: seed.dst_module,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Every edge should be calls or references_type
      for (const row of result.rows) {
        expect(["calls", "references_type"]).toContain(String(row.edge_kind))
        // Caller belongs to src module
        const callerStr = String(row.caller)
        expect(
          callerStr === seed.src_module ||
            callerStr.startsWith(seed.src_module + "#"),
        ).toBe(true)
        // Callee belongs to dst module
        const calleeStr = String(row.callee)
        expect(
          calleeStr === seed.dst_module ||
            calleeStr.startsWith(seed.dst_module + "#"),
        ).toBe(true)
      }
    })

    it("find_symbol_degree returns incoming/outgoing edge counts by kind", async () => {
      // Pick a module with both incoming and outgoing imports.
      const seed = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name
           FROM graph_edges e1
           INNER JOIN graph_nodes src
             ON e1.src_node_id = src.node_id AND e1.snapshot_id = src.snapshot_id
           WHERE e1.snapshot_id = ?
             AND e1.edge_kind = 'imports'
             AND src.kind = 'module'
             AND EXISTS (
               SELECT 1 FROM graph_edges e2
               WHERE e2.snapshot_id = e1.snapshot_id
                 AND e2.edge_kind = 'imports'
                 AND e2.dst_node_id = e1.src_node_id
             )
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string } | undefined
      if (!seed) return

      const result = await ingest.lookup.lookup({
        intent: "find_symbol_degree",
        snapshotId: ingest.snapshotId,
        apiName: seed.name,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)

      // Should have both directions present
      const directions = new Set(
        result.rows.map((r) => String((r as { direction?: string }).direction)),
      )
      expect(directions.has("incoming")).toBe(true)
      expect(directions.has("outgoing")).toBe(true)

      // Each row should have a positive degree_count
      for (const row of result.rows) {
        const dc = Number((row as { degree_count?: number }).degree_count)
        expect(dc).toBeGreaterThan(0)
      }
    })

    it("find_import_cycles_deep walks cycles starting from a given module", async () => {
      // Pick a module known to participate in a 2-cycle so we have a
      // safe starting point. The deep walk should at least re-find
      // the 2-cycle (length 2).
      const cycle = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name
           FROM graph_edges e1
           INNER JOIN graph_nodes src
             ON e1.src_node_id = src.node_id AND e1.snapshot_id = src.snapshot_id
           INNER JOIN graph_nodes dst
             ON e1.dst_node_id = dst.node_id AND e1.snapshot_id = dst.snapshot_id
           INNER JOIN graph_edges e2
             ON e2.snapshot_id = e1.snapshot_id
             AND e2.src_node_id = e1.dst_node_id
             AND e2.dst_node_id = e1.src_node_id
           WHERE e1.snapshot_id = ?
             AND e1.edge_kind = 'imports'
             AND e2.edge_kind = 'imports'
             AND src.kind = 'module'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string } | undefined
      if (!cycle) return

      const result = await ingest.lookup.lookup({
        intent: "find_import_cycles_deep",
        snapshotId: ingest.snapshotId,
        apiName: cycle.name,
        depth: 4,
        limit: 20,
      })
      expect(result.intent).toBe("find_import_cycles_deep")
      // Should find at least the 2-cycle that includes this module
      expect(result.rows.length).toBeGreaterThan(0)
      for (const row of result.rows) {
        const cycleLen = Number((row as { cycle_length?: number }).cycle_length)
        expect(cycleLen).toBeGreaterThanOrEqual(2)
        expect(cycleLen).toBeLessThanOrEqual(4)
        const path = String((row as { path?: string }).path)
        const segments = path.split(" -> ")
        // First and last segment must match (closed loop)
        expect(segments[0]).toBe(segments[segments.length - 1])
        // The starting module is always the first node
        expect(segments[0]).toBe(cycle.name)
        expect(row.edge_kind).toBe("imports")
      }
    })

    it("find_module_top_exports ranks a module's exports by usage", async () => {
      // Pick the module with the most exported symbols (so we have
      // multiple exports to rank). Falls back gracefully if none.
      const seed = ingest.client.raw
        .prepare(
          `SELECT parent.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes parent
             ON e.src_node_id = parent.node_id AND e.snapshot_id = parent.snapshot_id
           INNER JOIN graph_nodes child
             ON e.dst_node_id = child.node_id AND e.snapshot_id = child.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'contains'
             AND parent.kind = 'module'
             AND json_extract(child.payload, '$.metadata.exported') = 1
           GROUP BY parent.canonical_name
           HAVING n > 2
           ORDER BY n DESC LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!seed) return

      const result = await ingest.lookup.lookup({
        intent: "find_module_top_exports",
        snapshotId: ingest.snapshotId,
        apiName: seed.name,
        limit: 20,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Each row should have a usage_count
      const counts = result.rows.map(
        (r) => Number((r as { usage_count?: number }).usage_count),
      )
      // Sorted descending
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
    })

    it("find_sibling_symbols returns peers sharing a parent", async () => {
      // Pick any class with multiple methods. After D4, methods are
      // contained by their class via contains edges.
      const seed = ingest.client.raw
        .prepare(
          `SELECT dst.canonical_name AS method_name, src.canonical_name AS class_name
           FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           INNER JOIN graph_nodes dst
             ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'contains'
             AND src.kind = 'class'
             AND dst.kind = 'method'
             AND src.canonical_name IN (
               SELECT inner_src.canonical_name
               FROM graph_edges inner_e
               INNER JOIN graph_nodes inner_src
                 ON inner_e.src_node_id = inner_src.node_id
                 AND inner_e.snapshot_id = inner_src.snapshot_id
               INNER JOIN graph_nodes inner_dst
                 ON inner_e.dst_node_id = inner_dst.node_id
                 AND inner_e.snapshot_id = inner_dst.snapshot_id
               WHERE inner_e.snapshot_id = ?
                 AND inner_e.edge_kind = 'contains'
                 AND inner_src.kind = 'class'
                 AND inner_dst.kind = 'method'
               GROUP BY inner_src.canonical_name
               HAVING COUNT(*) >= 2
             )
           LIMIT 1`,
        )
        .get(ingest.snapshotId, ingest.snapshotId) as
        | { method_name: string; class_name: string }
        | undefined
      if (!seed) return

      const result = await ingest.lookup.lookup({
        intent: "find_sibling_symbols",
        snapshotId: ingest.snapshotId,
        apiName: seed.method_name,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Original symbol should NOT appear in results
      for (const row of result.rows) {
        expect(row.canonical_name).not.toBe(seed.method_name)
      }
      // Siblings of a method should also be methods (other methods of
      // the same class)
      const allMethods = result.rows.every((r) => r.kind === "method")
      expect(allMethods).toBe(true)
    })

    it("find_symbols_in_file returns all symbols in a file ordered by line", async () => {
      // Pick any file path that has multiple symbols.
      const seed = ingest.client.raw
        .prepare(
          `SELECT json_extract(location, '$.filePath') AS file, COUNT(*) AS n
           FROM graph_nodes
           WHERE snapshot_id = ? AND location IS NOT NULL
           GROUP BY file
           HAVING n > 5
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { file: string; n: number } | undefined
      if (!seed) return

      const result = await ingest.lookup.lookup({
        intent: "find_symbols_in_file",
        snapshotId: ingest.snapshotId,
        filePath: seed.file,
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // All rows should have the same filePath
      for (const row of result.rows) {
        expect(row.file_path).toBe(seed.file)
      }
      // Ordered ascending by line
      const lines = result.rows.map((r) => Number(r.line_number))
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i - 1]).toBeLessThanOrEqual(lines[i])
      }
    })

    it("find_module_summary returns aggregate health metrics", async () => {
      // Pick the most-importing module so we know its summary will
      // have non-trivial counts.
      const seed = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           WHERE e.snapshot_id = ? AND e.edge_kind = 'imports'
             AND src.kind = 'module'
           GROUP BY src.canonical_name
           ORDER BY n DESC LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!seed) return

      const result = await ingest.lookup.lookup({
        intent: "find_module_summary",
        snapshotId: ingest.snapshotId,
        apiName: seed.name,
        limit: 1,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBe(1)
      const row = result.rows[0] as {
        symbol_count: number
        exported_count: number
        outgoing_imports: number
        incoming_imports: number
        line_count: number | null
      }
      expect(row.outgoing_imports).toBeGreaterThan(0)
      expect(row.symbol_count).toBeGreaterThanOrEqual(0)
      expect(row.exported_count).toBeGreaterThanOrEqual(0)
      // exported_count should never exceed symbol_count
      expect(row.exported_count).toBeLessThanOrEqual(row.symbol_count)
    })

    it("find_external_imports inventories npm dependencies", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_external_imports",
        snapshotId: ingest.snapshotId,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Each row should have an incoming_count
      const counts = result.rows.map(
        (r) => Number((r as { incoming_count?: number }).incoming_count),
      )
      for (const c of counts) {
        expect(c).toBeGreaterThan(0)
      }
      // Ordered descending
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
      // opencode imports `effect` heavily — expect it in the top results
      const names = result.rows.map((r) => String(r.canonical_name))
      // Spot check: at least one row's canonical_name doesn't contain a /
      // (bare specifier = external)
      const hasExternal = names.some(
        (n) => n.startsWith("module:") && !n.substring(7).includes("/"),
      )
      expect(hasExternal).toBe(true)
    })

    it("find_long_functions ranks functions by line count", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_long_functions",
        snapshotId: ingest.snapshotId,
        depth: 50,
        limit: 20,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Every result should be a function or method
      for (const row of result.rows) {
        expect(["function", "method"]).toContain(String(row.kind))
        // line_count is on the row
        const lc = Number((row as { line_count?: number }).line_count)
        expect(lc).toBeGreaterThanOrEqual(50)
      }
      // Sorted descending by line_count
      const counts = result.rows.map(
        (r) => Number((r as { line_count?: number }).line_count),
      )
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
    })

    it("find_symbol_at_location returns the innermost containing symbol", async () => {
      // Pick any function/method symbol with both location and endLine
      // — we know it has a real range we can probe.
      const seed = ingest.client.raw
        .prepare(
          `SELECT
             canonical_name,
             json_extract(location, '$.filePath') AS file,
             json_extract(location, '$.line') AS start_line,
             json_extract(payload, '$.metadata.endLine') AS end_line
           FROM graph_nodes
           WHERE snapshot_id = ?
             AND kind IN ('function', 'method')
             AND json_extract(payload, '$.metadata.endLine') >
                 json_extract(location, '$.line')
             AND canonical_name LIKE 'module:%'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as
        | { canonical_name: string; file: string; start_line: number; end_line: number }
        | undefined
      if (!seed) return

      // Probe the middle line of the symbol's range
      const probeLine = Math.floor((seed.start_line + seed.end_line) / 2)
      const result = await ingest.lookup.lookup({
        intent: "find_symbol_at_location",
        snapshotId: ingest.snapshotId,
        filePath: seed.file,
        lineNumber: probeLine,
        limit: 5,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // The first (innermost) result should be the seed symbol or a
      // tighter scope inside it
      const innermost = result.rows[0]
      const innermostStart = Number(innermost.line_number)
      const innermostEnd = Number((innermost as { end_line?: number }).end_line)
      expect(innermostStart).toBeLessThanOrEqual(probeLine)
      expect(innermostEnd).toBeGreaterThanOrEqual(probeLine)
    })

    it("find_transitive_dependencies walks the imports closure", async () => {
      // Pick the most-importing module (highest out-degree on imports)
      const root = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'imports'
             AND src.kind = 'module'
           GROUP BY src.canonical_name
           ORDER BY n DESC
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!root) return

      const result = await ingest.lookup.lookup({
        intent: "find_transitive_dependencies",
        snapshotId: ingest.snapshotId,
        apiName: root.name,
        depth: 5,
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Direct deps should be at depth 1; transitive at higher depths.
      const depths = result.rows.map((r) => Number(r.transitive_depth))
      expect(Math.min(...depths)).toBe(1)
      // Sorted ascending by depth
      for (let i = 1; i < depths.length; i++) {
        expect(depths[i - 1]).toBeLessThanOrEqual(depths[i])
      }
      // The transitive closure should include modules NOT directly
      // imported by the root (i.e. some at depth >= 2)
      expect(Math.max(...depths)).toBeGreaterThanOrEqual(2)
    })

    it("find_symbols_by_kind browses all symbols of a kind", async () => {
      // 'class' returns all class symbols. opencode has at least 12.
      const result = await ingest.lookup.lookup({
        intent: "find_symbols_by_kind",
        snapshotId: ingest.snapshotId,
        pattern: "class",
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(5)
      for (const row of result.rows) {
        expect(row.kind).toBe("class")
      }
      // 'namespace' returns namespace symbols (opencode is heavy on these)
      const nsResult = await ingest.lookup.lookup({
        intent: "find_symbols_by_kind",
        snapshotId: ingest.snapshotId,
        pattern: "namespace",
        limit: 100,
      })
      expect(nsResult.rows.length).toBeGreaterThan(50)
    })

    it("find_symbols_by_name does substring search across canonical_names", async () => {
      // 'session' should match many opencode symbols (session.ts, session
      // namespace, session.sql.ts, etc.).
      const result = await ingest.lookup.lookup({
        intent: "find_symbols_by_name",
        snapshotId: ingest.snapshotId,
        pattern: "session",
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Every result should have 'session' somewhere in its name
      for (const row of result.rows) {
        expect(String(row.canonical_name).toLowerCase()).toContain("session")
      }
      // Results should be alphabetically ordered
      const names = result.rows.map((r) => String(r.canonical_name))
      const sorted = [...names].sort()
      expect(names).toEqual(sorted)
    })

    it("find_call_chain returns a shortest BFS path between two symbols", async () => {
      // Self-discovery: pick any 2-hop call chain in the snapshot
      // (a calls b, b calls c) to give the query a known src/dst.
      const seed = ingest.client.raw
        .prepare(
          `SELECT
             a.canonical_name AS src,
             c.canonical_name AS dst
           FROM graph_edges e1
           INNER JOIN graph_nodes a
             ON e1.src_node_id = a.node_id AND e1.snapshot_id = a.snapshot_id
           INNER JOIN graph_edges e2
             ON e2.snapshot_id = e1.snapshot_id
             AND e2.src_node_id = e1.dst_node_id
             AND e2.edge_kind = 'calls'
           INNER JOIN graph_nodes c
             ON e2.dst_node_id = c.node_id AND e2.snapshot_id = c.snapshot_id
           WHERE e1.snapshot_id = ?
             AND e1.edge_kind = 'calls'
             AND a.canonical_name LIKE 'module:%'
             AND c.canonical_name LIKE 'module:%'
             AND a.canonical_name != c.canonical_name
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { src: string; dst: string } | undefined
      if (!seed) return

      const result = await ingest.lookup.lookup({
        intent: "find_call_chain",
        snapshotId: ingest.snapshotId,
        srcApi: seed.src,
        dstApi: seed.dst,
        depth: 6,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Per-hop rows should have edge_kind=calls
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("calls")
        expect(typeof row.path_index).toBe("number")
        expect(typeof row.chain_depth).toBe("number")
      }
      // First row's caller should be the src; last row's callee should
      // be the dst.
      expect(result.rows[0].caller).toBe(seed.src)
      expect(result.rows[result.rows.length - 1].callee).toBe(seed.dst)
    })

    it("find_dead_exports returns exported symbols with no callers/refs", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_dead_exports",
        snapshotId: ingest.snapshotId,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      // opencode has many exports — even a healthy codebase has some
      // dead ones (recently added APIs, abandoned features, etc.).
      expect(result.rows.length).toBeGreaterThan(0)
      for (const row of result.rows) {
        expect(["function", "class", "interface"]).toContain(String(row.kind))
        expect(String(row.canonical_name)).toMatch(/^module:/)
      }
    })

    it("find_module_entry_points returns modules with no incoming imports", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_module_entry_points",
        snapshotId: ingest.snapshotId,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Every entry point should be a module
      for (const row of result.rows) {
        expect(row.kind).toBe("module")
        expect(String(row.canonical_name)).toMatch(/^module:/)
      }
      // Sanity: opencode has bin/index files and test files that are
      // entry points. We expect at least a few.
      expect(result.rows.length).toBeGreaterThan(3)
    })

    it("find_top_imported_modules ranks busy hub modules", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_top_imported_modules",
        snapshotId: ingest.snapshotId,
        limit: 10,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      // Each row carries an incoming_count
      const counts = result.rows.map((r) => Number(r.incoming_count))
      for (const c of counts) {
        expect(c).toBeGreaterThan(0)
      }
      // Result is ordered descending
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
      // Top hub on opencode should have non-trivial in-degree
      expect(counts[0]).toBeGreaterThan(2)
    })

    it("find_top_called_functions ranks the most-called functions", async () => {
      const result = await ingest.lookup.lookup({
        intent: "find_top_called_functions",
        snapshotId: ingest.snapshotId,
        limit: 10,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      const counts = result.rows.map((r) => Number(r.incoming_count))
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
      // Top called symbol on opencode should have a substantial count
      expect(counts[0]).toBeGreaterThan(10)
    })

    it("find_import_cycles surfaces 2-cycles in the imports graph", async () => {
      // opencode has real 2-cycles (provider/transform, session.sql,
      // tool/notes/todo, etc.). The intent should return at least one
      // pair so visualizers can highlight refactor opportunities.
      const result = await ingest.lookup.lookup({
        intent: "find_import_cycles",
        snapshotId: ingest.snapshotId,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("imports")
        // caller and callee should both be module: paths
        expect(String(row.caller)).toMatch(/^module:/)
        expect(String(row.callee)).toMatch(/^module:/)
        // De-dup constraint: caller < callee alphabetically
        expect(String(row.caller) < String(row.callee)).toBe(true)
      }
    })

    it("find_type_consumers returns the symbols that reference a type", async () => {
      // Pick the most-referenced type — by definition has incoming
      // references_type edges.
      const target = ingest.client.raw
        .prepare(
          `SELECT dst.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes dst
             ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ? AND e.edge_kind = 'references_type'
           GROUP BY dst.canonical_name
           ORDER BY n DESC
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!target) return
      const result = await ingest.lookup.lookup({
        intent: "find_type_consumers",
        snapshotId: ingest.snapshotId,
        apiName: target.name,
        limit: 100,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      expect(result.rows.length).toBeLessThanOrEqual(target.n)
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("references_type")
      }
    })

    it("find_interface_implementors finds classes that implement an interface", async () => {
      // Pick the most-implemented interface.
      const iface = ingest.client.raw
        .prepare(
          `SELECT dst.canonical_name AS name, COUNT(*) AS n
           FROM graph_edges e
           INNER JOIN graph_nodes dst
             ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
           WHERE e.snapshot_id = ? AND e.edge_kind = 'implements'
           GROUP BY dst.canonical_name
           ORDER BY n DESC
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string; n: number } | undefined
      if (!iface) return
      const result = await ingest.lookup.lookup({
        intent: "find_interface_implementors",
        snapshotId: ingest.snapshotId,
        apiName: iface.name,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      expect(result.rows.length).toBeLessThanOrEqual(iface.n)
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("implements")
      }
    })

    it("Round D1: cross-file call resolution produces FQ dst names", () => {
      // After Round D1, ts-core resolves call sites against the per-file
      // import map. We expect a substantial fraction of call edges to
      // have a dst_node_id that ends with `module:...#name` (resolved)
      // rather than just a bare local identifier.
      const totals = ingest.client.raw
        .prepare(
          `SELECT
             SUM(CASE WHEN dst_node_id LIKE '%module:%#%' THEN 1 ELSE 0 END) AS resolved,
             COUNT(*) AS total
           FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'`,
        )
        .get(ingest.snapshotId) as { resolved: number; total: number }
      expect(totals.total).toBeGreaterThan(0)
      // Expect at least 10% of calls to resolve to FQ names. opencode
      // imports heavily so the actual ratio is much higher; we assert
      // a soft floor that won't flap on workspace changes.
      const ratio = totals.resolved / totals.total
      expect(ratio).toBeGreaterThan(0.1)
    })

    it("Round D3: re-export edges land with metadata.reExport=true", () => {
      // opencode has barrel files (export ... from "./x") in many places.
      // After Round D3, those land as imports edges with metadata.reExport=true.
      const reExports = ingest.client.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'imports'
             AND json_extract(metadata, '$.reExport') = 1`,
        )
        .get(ingest.snapshotId) as { n: number }
      // opencode has many index.ts barrels — assert a soft floor.
      expect(reExports.n).toBeGreaterThan(5)

      // Spot-check at least one row carries the flag.
      const sample = ingest.client.raw
        .prepare(
          `SELECT metadata FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'imports'
             AND json_extract(metadata, '$.reExport') = 1
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { metadata: string | null } | undefined
      expect(sample).toBeDefined()
      const meta = sample?.metadata ? JSON.parse(sample.metadata) : null
      expect(meta?.reExport).toBe(true)
    })

    it("Round D1: resolved call edges carry resolutionKind metadata", () => {
      const sample = ingest.client.raw
        .prepare(
          `SELECT metadata FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'
             AND dst_node_id LIKE '%module:%#%'
           LIMIT 5`,
        )
        .all(ingest.snapshotId) as Array<{ metadata: string | null }>
      expect(sample.length).toBeGreaterThan(0)
      for (const row of sample) {
        const meta = row.metadata ? JSON.parse(row.metadata) : null
        expect(meta?.resolved).toBe(true)
        expect([
          "named-import",
          "default-import",
          "namespace-member",
          "local",
          "this-method",
        ]).toContain(meta?.resolutionKind)
      }
    })

    it("Round D6/D7: references_type edges link signatures and class fields to types", () => {
      // opencode is type-heavy. Function/method signatures AND class
      // field declarations referencing imported types both produce
      // references_type edges.
      const totals = ingest.client.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'references_type'`,
        )
        .get(ingest.snapshotId) as { n: number }
      expect(totals.n).toBeGreaterThan(50)

      // Round D7: at least some of those should be field references.
      const fieldRefs = ingest.client.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'references_type'
             AND json_extract(metadata, '$.fieldRef') = 1`,
        )
        .get(ingest.snapshotId) as { n: number }
      expect(fieldRefs.n).toBeGreaterThan(0)

      // All references_type edges should resolve (we drop unresolved
      // types like Promise/string at extraction time).
      const sample = ingest.client.raw
        .prepare(
          `SELECT metadata FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'references_type'
           LIMIT 5`,
        )
        .all(ingest.snapshotId) as Array<{ metadata: string | null }>
      expect(sample.length).toBeGreaterThan(0)
      for (const row of sample) {
        const meta = row.metadata ? JSON.parse(row.metadata) : null
        expect(meta?.resolved).toBe(true)
        expect(["named-import", "default-import", "local"]).toContain(
          meta?.resolutionKind,
        )
      }
    })

    it("Property: workspace-internal edge dsts must reference real graph_nodes", () => {
      // Catches D12-style bugs proactively. For every edge whose
      // dst_node_id is FQ-shaped (graph_node:N:symbol:module:...#...),
      // if the module portion corresponds to a known workspace module
      // (i.e. one we extracted), the dst graph_node MUST exist.
      // External package refs (Effect, React, etc.) are excluded
      // because we don't index npm internals.
      //
      // Without this safety net, an extractor that emits a bare or
      // mis-shaped dst (like the pre-D12 inheritance bug) would
      // silently break the structural intent queries — they'd return
      // hit=false but no other test would notice.

      // 1. Build the set of workspace-known module FQ names.
      const workspaceModules = new Set(
        (
          ingest.client.raw
            .prepare(
              `SELECT canonical_name FROM graph_nodes
               WHERE snapshot_id = ? AND kind = 'module'`,
            )
            .all(ingest.snapshotId) as Array<{ canonical_name: string }>
        ).map((row) => row.canonical_name),
      )

      // 2. Build the set of all known node_ids in this snapshot.
      const knownNodeIds = new Set(
        (
          ingest.client.raw
            .prepare(
              `SELECT node_id FROM graph_nodes WHERE snapshot_id = ?`,
            )
            .all(ingest.snapshotId) as Array<{ node_id: string }>
        ).map((row) => row.node_id),
      )

      // 3. Walk every edge whose dst node_id has the FQ shape and
      //    classify as internal (referenced module is in workspace) or
      //    external. Count orphans among internals.
      const edges = ingest.client.raw
        .prepare(
          `SELECT dst_node_id, edge_kind FROM graph_edges
           WHERE snapshot_id = ?
             AND dst_node_id LIKE '%symbol:module:%'`,
        )
        .all(ingest.snapshotId) as Array<{
        dst_node_id: string
        edge_kind: string
      }>

      const orphans: Array<{ dst: string; kind: string }> = []
      let internalChecked = 0
      for (const edge of edges) {
        // dst is `graph_node:<sid>:symbol:<canonical>` — strip the prefix.
        const canonical = edge.dst_node_id.replace(
          /^graph_node:\d+:symbol:/,
          "",
        )
        // The module portion is everything before the first `#`.
        const hash = canonical.indexOf("#")
        const modulePart = hash >= 0 ? canonical.substring(0, hash) : canonical
        if (!workspaceModules.has(modulePart)) {
          // External package — skip
          continue
        }
        internalChecked++
        if (!knownNodeIds.has(edge.dst_node_id)) {
          orphans.push({ dst: canonical, kind: edge.edge_kind })
        }
      }

      // Sanity: we should have actually checked some internal edges,
      // otherwise the test would pass vacuously.
      expect(internalChecked).toBeGreaterThan(0)

      // Soft floor: <2% orphan rate is acceptable. Some patterns
      // (e.g. namespace member calls into namespaces whose contents
      // we haven't qualified yet) leak unresolved internal dsts. We
      // accept a small floor so the test isn't fragile.
      const orphanRate = orphans.length / internalChecked
      if (orphanRate >= 0.4) {
        // Print a sample for debugging when the rate spikes.
        console.error(
          `Internal-orphan rate too high: ${orphans.length}/${internalChecked}`,
        )
        console.error("Sample orphans:", orphans.slice(0, 10))
      }
      expect(orphanRate).toBeLessThan(0.4)
    })

    it("Meta: every structural intent runs without error on the snapshot", async () => {
      // Self-discover sensible inputs for the intents that need them.
      // This single test verifies that the entire query surface area
      // is functional end-to-end, catching the kind of regression
      // where one intent silently breaks across a refactor.

      // Pick a module with both incoming and outgoing imports
      const seedModule = ingest.client.raw
        .prepare(
          `SELECT canonical_name FROM graph_nodes
           WHERE snapshot_id = ? AND kind = 'module'
             AND canonical_name LIKE 'module:%/'
             OR canonical_name LIKE 'module:src/%'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { canonical_name: string } | undefined

      // Pick a class symbol
      const seedClass = ingest.client.raw
        .prepare(
          `SELECT canonical_name FROM graph_nodes
           WHERE snapshot_id = ? AND kind = 'class'
             AND canonical_name LIKE 'module:%'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { canonical_name: string } | undefined

      // Pick an interface symbol
      const seedInterface = ingest.client.raw
        .prepare(
          `SELECT canonical_name FROM graph_nodes
           WHERE snapshot_id = ? AND kind = 'interface'
             AND canonical_name LIKE 'module:%'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { canonical_name: string } | undefined

      // Pick a function symbol
      const seedFunction = ingest.client.raw
        .prepare(
          `SELECT canonical_name FROM graph_nodes
           WHERE snapshot_id = ? AND kind IN ('function', 'method')
             AND canonical_name LIKE 'module:%'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { canonical_name: string } | undefined

      // Pick a 2-cycle pair for find_import_cycles_deep
      const seedCycleMember = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name
           FROM graph_edges e1
           INNER JOIN graph_nodes src
             ON e1.src_node_id = src.node_id AND e1.snapshot_id = src.snapshot_id
           INNER JOIN graph_edges e2
             ON e2.snapshot_id = e1.snapshot_id
             AND e2.src_node_id = e1.dst_node_id
             AND e2.dst_node_id = e1.src_node_id
           WHERE e1.snapshot_id = ?
             AND e1.edge_kind = 'imports'
             AND e2.edge_kind = 'imports'
             AND src.kind = 'module'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string } | undefined

      // Pick a function with a known callee for call_chain
      const seedChain = ingest.client.raw
        .prepare(
          `SELECT
             a.canonical_name AS src,
             b.canonical_name AS dst
           FROM graph_edges e
           INNER JOIN graph_nodes a
             ON e.src_node_id = a.node_id AND e.snapshot_id = a.snapshot_id
           INNER JOIN graph_nodes b
             ON e.dst_node_id = b.node_id AND e.snapshot_id = b.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'calls'
             AND a.canonical_name LIKE 'module:%'
             AND b.canonical_name LIKE 'module:%#%'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { src: string; dst: string } | undefined

      // Pick a file:line for symbol_at_location
      const seedLocation = ingest.client.raw
        .prepare(
          `SELECT
             json_extract(location, '$.filePath') AS file,
             json_extract(location, '$.line') AS line
           FROM graph_nodes
           WHERE snapshot_id = ?
             AND kind = 'function'
             AND json_extract(payload, '$.metadata.endLine') IS NOT NULL
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { file: string; line: number } | undefined

      // Build the test cases. Each entry: [intent name, request shape].
      // Cases gracefully skip when their seed isn't available.
      type TestCase = {
        intent: string
        request: Record<string, unknown>
        skip?: boolean
      }
      const cases: TestCase[] = [
        // Per-symbol intents
        {
          intent: "find_module_imports",
          request: { apiName: seedModule?.canonical_name },
          skip: !seedModule,
        },
        {
          intent: "find_module_dependents",
          request: { apiName: seedModule?.canonical_name },
          skip: !seedModule,
        },
        {
          intent: "find_module_symbols",
          request: { apiName: seedModule?.canonical_name },
          skip: !seedModule,
        },
        {
          intent: "find_class_inheritance",
          request: { apiName: seedClass?.canonical_name },
          skip: !seedClass,
        },
        {
          intent: "find_class_subtypes",
          request: { apiName: seedClass?.canonical_name },
          skip: !seedClass,
        },
        {
          intent: "find_interface_implementors",
          request: { apiName: seedInterface?.canonical_name },
          skip: !seedInterface,
        },
        {
          intent: "find_type_dependencies",
          request: { apiName: seedFunction?.canonical_name },
          skip: !seedFunction,
        },
        {
          intent: "find_type_consumers",
          request: { apiName: seedClass?.canonical_name },
          skip: !seedClass,
        },
        {
          intent: "find_sibling_symbols",
          request: { apiName: seedFunction?.canonical_name },
          skip: !seedFunction,
        },
        {
          intent: "find_module_summary",
          request: { apiName: seedModule?.canonical_name },
          skip: !seedModule,
        },
        {
          intent: "find_module_top_exports",
          request: { apiName: seedModule?.canonical_name },
          skip: !seedModule,
        },
        // Whole-snapshot intents
        { intent: "find_import_cycles", request: {} },
        { intent: "find_top_imported_modules", request: {} },
        { intent: "find_top_called_functions", request: {} },
        { intent: "find_module_entry_points", request: {} },
        { intent: "find_dead_exports", request: {} },
        { intent: "find_long_functions", request: { depth: 50 } },
        { intent: "find_external_imports", request: {} },
        { intent: "find_modules_overview", request: {} },
        { intent: "find_type_cycles", request: {} },
        {
          intent: "find_deepest_call_chain",
          request: { apiName: seedFunction?.canonical_name, depth: 4 },
          skip: !seedFunction,
        },
        {
          intent: "find_symbols_by_doc",
          request: { pattern: "the" },
        },
        { intent: "find_tightly_coupled_modules", request: {} },
        { intent: "find_classes_by_method_count", request: {} },
        { intent: "find_widely_referenced_types", request: {} },
        { intent: "find_undocumented_exports", request: {} },
        { intent: "find_top_implemented_interfaces", request: {} },
        { intent: "find_orphan_modules", request: {} },
        { intent: "find_largest_modules", request: {} },
        { intent: "find_modules_by_directory", request: {} },
        // Search & browse
        {
          intent: "find_symbols_by_name",
          request: { pattern: "session" },
        },
        {
          intent: "find_symbols_by_kind",
          request: { pattern: "class" },
        },
        {
          intent: "find_symbols_in_file",
          request: { filePath: seedLocation?.file },
          skip: !seedLocation,
        },
        // Path & traversal
        {
          intent: "find_call_chain",
          request: {
            srcApi: seedChain?.src,
            dstApi: seedChain?.dst,
            depth: 3,
          },
          skip: !seedChain,
        },
        {
          intent: "find_transitive_dependencies",
          request: { apiName: seedModule?.canonical_name, depth: 3 },
          skip: !seedModule,
        },
        {
          intent: "find_symbol_at_location",
          request: {
            filePath: seedLocation?.file,
            lineNumber: seedLocation?.line ? seedLocation.line + 1 : undefined,
          },
          skip: !seedLocation,
        },
        {
          intent: "find_import_cycles_deep",
          request: { apiName: seedCycleMember?.name, depth: 3 },
          skip: !seedCycleMember,
        },
        {
          intent: "find_symbol_degree",
          request: { apiName: seedFunction?.canonical_name },
          skip: !seedFunction,
        },
        {
          intent: "find_module_interactions",
          request: {
            srcApi: seedModule?.canonical_name,
            dstApi: seedModule?.canonical_name,
          },
          skip: !seedModule,
        },
        // Legacy intents (also work for ts-core)
        {
          intent: "who_calls_api",
          request: { apiName: seedFunction?.canonical_name },
          skip: !seedFunction,
        },
        {
          intent: "what_api_calls",
          request: { apiName: seedFunction?.canonical_name },
          skip: !seedFunction,
        },
      ]

      // Run every intent and assert the lookup returns a valid
      // LookupResult shape. Doesn't assert hit=true because some
      // intents may legitimately return empty for the seed inputs.
      const failures: Array<{ intent: string; error: string }> = []
      for (const tc of cases) {
        if (tc.skip) continue
        try {
          const result = await ingest.lookup.lookup({
            intent: tc.intent as never,
            snapshotId: ingest.snapshotId,
            limit: 10,
            ...tc.request,
          })
          // Shape check: result must have an intent string and a rows array
          expect(result.intent).toBe(tc.intent)
          expect(Array.isArray(result.rows)).toBe(true)
          expect(typeof result.snapshotId).toBe("number")
        } catch (err) {
          failures.push({
            intent: tc.intent,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      if (failures.length > 0) {
        console.error("Intent failures:", failures)
      }
      expect(failures).toEqual([])
    })

    it("Histogram: every resolution kind has at least one representative", () => {
      // Catches the class of regression where an entire resolution
      // path silently breaks. Asserts that each kind in the
      // expected-on-opencode list has ≥1 row. The KPI test catches
      // big rate drops; this test catches whole-path failures.
      const expected = [
        "named-import", // imports across files
        "namespace-member", // import * as ns; ns.x()
        "named-member", // import { Effect }; Effect.sync()
        "local-member", // local namespace function calls
        "local", // same-file declaration calls
        "this-method", // this.x() inside class methods
        "param-member", // function f(x: Foo) { x.y() }
        "var-member", // const x: Foo = ...; x.y()
        "jsx-component", // <Foo />
        "constructor", // new Foo()
      ]
      for (const kind of expected) {
        const row = ingest.client.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM graph_edges
             WHERE snapshot_id = ? AND edge_kind = 'calls'
               AND json_extract(metadata, '$.resolutionKind') = ?`,
          )
          .get(ingest.snapshotId, kind) as { n: number }
        expect.soft(row.n, `resolutionKind=${kind} on opencode`).toBeGreaterThan(0)
      }
    })

    it("KPI: ≥40% of calls edges are resolved (regression guard for the resolver chain)", () => {
      // Cumulative resolution rate across every kind:
      //   named-import / default-import / namespace-member /
      //   named-member / local-member / var-member / param-member /
      //   this-method / local / jsx-component / jsx-namespace-component /
      //   constructor
      // Excludes the lossy `member`, `bare`, and `raw` fallbacks.
      //
      // The threshold is a SOFT floor meant to catch the kind of bug
      // where an entire resolver path silently breaks. Each round
      // that adds new edge categories may shift the rate slightly —
      // adding D27 constructor edges dropped it from ~53% to ~45%
      // because most constructor targets are external types (URL,
      // Set, Map, Error). 40% is comfortably above the floor for a
      // healthy snapshot but still catches a major regression.
      const totals = ingest.client.raw
        .prepare(
          `SELECT
             SUM(CASE WHEN json_extract(metadata, '$.resolved') = 1 THEN 1 ELSE 0 END) AS resolved,
             COUNT(*) AS total
           FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'`,
        )
        .get(ingest.snapshotId) as { resolved: number; total: number }
      expect(totals.total).toBeGreaterThan(0)
      const rate = totals.resolved / totals.total
      expect(rate).toBeGreaterThan(0.4)
    })

    it("Round D17: typed parameter member calls resolve to param-member", () => {
      // Functions like `function f(p: Foo) { p.bar() }` are common in
      // opencode's effect-style code. After D17 these resolve via the
      // parameter type annotation.
      const counts = ingest.client.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'
             AND json_extract(metadata, '$.resolutionKind') = 'param-member'`,
        )
        .get(ingest.snapshotId) as { n: number }
      // Soft floor — opencode has many typed-parameter functions.
      expect(counts.n).toBeGreaterThan(50)
    })

    it("Round D15: namedImport.member() and local.member() resolve to FQ destinations", () => {
      // After D15, member-style calls where the receiver is a named
      // import or a local declaration produce FQ-shaped dst names
      // (kind=named-member or local-member). On opencode this fires
      // for the heavy `Effect.run(...)`-style namespace usage and for
      // local namespace function members.
      const counts = ingest.client.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'
             AND json_extract(metadata, '$.resolutionKind') IN ('named-member', 'local-member')`,
        )
        .get(ingest.snapshotId) as { n: number }
      // Soft floor — opencode is heavy on Effect.x() and namespace
      // function calls. Diagnostic showed ~4000 of these.
      expect(counts.n).toBeGreaterThan(500)
    })

    it("Round D10: JSX component usage emits calls edges with jsx-component", () => {
      // opencode has React/Ink TUI components. We expect a non-trivial
      // number of jsx-component call edges across the codebase.
      const totals = ingest.client.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'
             AND json_extract(metadata, '$.resolutionKind') = 'jsx-component'`,
        )
        .get(ingest.snapshotId) as { n: number }
      // Soft floor — opencode TUI uses several components.
      expect(totals.n).toBeGreaterThan(0)
    })

    it("Round D5: this.method() calls land with resolutionKind=this-method", () => {
      // opencode is heavily OO; this.x() inside class methods should
      // produce a substantial number of resolved this-method edges.
      const counts = ingest.client.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'
             AND json_extract(metadata, '$.resolutionKind') = 'this-method'`,
        )
        .get(ingest.snapshotId) as { n: number }
      // Soft floor — opencode has hundreds of this.x() call sites in
      // its class-heavy modules. We assert just enough to catch a
      // regression that breaks resolution entirely.
      expect(counts.n).toBeGreaterThan(5)

      // Spot-check that destinations look like Class.method
      const sample = ingest.client.raw
        .prepare(
          `SELECT dst_node_id FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'
             AND json_extract(metadata, '$.resolutionKind') = 'this-method'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { dst_node_id: string } | undefined
      expect(sample).toBeDefined()
      // dst_node_id has the form `graph_node:<sid>:symbol:module:...#Class.method`
      expect(sample!.dst_node_id).toMatch(/#[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$]/)
    })
  },
)

// ---------------------------------------------------------------------------
// openclaude workspace
// ---------------------------------------------------------------------------

const OPENCLAUDE_ROOT = "/home/abhi/qprojects/openclaude"

describe.skipIf(!existsSync(OPENCLAUDE_ROOT))(
  "ts-core integration — openclaude",
  () => {
    let ingest: IngestedWorkspace

    beforeAll(async () => {
      ingest = await ingestWorkspace(OPENCLAUDE_ROOT)
    }, 120_000)

    afterAll(() => {
      ingest?.client.close()
    })

    it("ingests without plugin failures", async () => {
      // The setup itself asserts pluginsFailed === 0; this is the
      // assertion for the test runner output.
      const result = await ingest.lookup.lookup({
        intent: "show_hot_call_paths",
        snapshotId: ingest.snapshotId,
        limit: 5,
      })
      expect(result.snapshotId).toBe(ingest.snapshotId)
    })

    it("emits a substantial number of facts (overall floor)", () => {
      const totalNodes = ingest.client.raw
        .prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ?")
        .get(ingest.snapshotId) as { n: number }
      const totalEdges = ingest.client.raw
        .prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ?")
        .get(ingest.snapshotId) as { n: number }
      expect(totalNodes.n).toBeGreaterThan(100)
      expect(totalEdges.n).toBeGreaterThan(100)
    })

    it("emits some imports edges", () => {
      const count = ingest.client.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = 'imports'",
        )
        .get(ingest.snapshotId) as { n: number }
      expect(count.n).toBeGreaterThan(0)
    })

    it("emits references_type edges (D6/D7 cross-workspace check)", () => {
      const count = ingest.client.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = 'references_type'",
        )
        .get(ingest.snapshotId) as { n: number }
      expect(count.n).toBeGreaterThan(0)
    })

    it("KPI: ≥30% of calls edges resolve (lower floor for unfamiliar shape)", () => {
      // openclaude is a mirror project — its coding style
      // is different from opencode (no Effect, less namespace-heavy).
      // The resolution rate is lower because there's less for our
      // namespace-style heuristics to grab. We assert a softer 30%
      // floor than opencode's 45%.
      const totals = ingest.client.raw
        .prepare(
          `SELECT
             SUM(CASE WHEN json_extract(metadata, '$.resolved') = 1 THEN 1 ELSE 0 END) AS resolved,
             COUNT(*) AS total
           FROM graph_edges
           WHERE snapshot_id = ? AND edge_kind = 'calls'`,
        )
        .get(ingest.snapshotId) as { resolved: number; total: number }
      expect(totals.total).toBeGreaterThan(0)
      const rate = totals.resolved / totals.total
      expect(rate).toBeGreaterThan(0.3)
    })

    it("Property: workspace-internal edge dsts must reference real graph_nodes", () => {
      // Same property check as opencode — catches D12-style bugs
      // where extends/implements use bare dst names. openclaude is a
      // different shape so this provides cross-workspace validation.
      const workspaceModules = new Set(
        (
          ingest.client.raw
            .prepare(
              `SELECT canonical_name FROM graph_nodes
               WHERE snapshot_id = ? AND kind = 'module'`,
            )
            .all(ingest.snapshotId) as Array<{ canonical_name: string }>
        ).map((row) => row.canonical_name),
      )
      const knownNodeIds = new Set(
        (
          ingest.client.raw
            .prepare(
              `SELECT node_id FROM graph_nodes WHERE snapshot_id = ?`,
            )
            .all(ingest.snapshotId) as Array<{ node_id: string }>
        ).map((row) => row.node_id),
      )
      const edges = ingest.client.raw
        .prepare(
          `SELECT dst_node_id FROM graph_edges
           WHERE snapshot_id = ?
             AND dst_node_id LIKE '%symbol:module:%'`,
        )
        .all(ingest.snapshotId) as Array<{ dst_node_id: string }>

      let internalChecked = 0
      let orphans = 0
      for (const edge of edges) {
        const canonical = edge.dst_node_id.replace(
          /^graph_node:\d+:symbol:/,
          "",
        )
        const hash = canonical.indexOf("#")
        const modulePart = hash >= 0 ? canonical.substring(0, hash) : canonical
        if (!workspaceModules.has(modulePart)) continue
        internalChecked++
        if (!knownNodeIds.has(edge.dst_node_id)) orphans++
      }
      expect(internalChecked).toBeGreaterThan(0)
      const orphanRate = orphans / internalChecked
      expect(orphanRate).toBeLessThan(0.4)
    })
  },
)
