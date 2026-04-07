/**
 * test/integration/ts-core-real-workspaces.test.ts
 *
 * End-to-end smoke tests that ingest real TypeScript workspaces using
 * the ts-core plugin and assert that the resulting SQLite snapshot
 * answers basic intent queries correctly.
 *
 * Targets:
 *   - /home/abhi/qprojects/opencode (Bun monorepo, packages/opencode/src)
 *   - /home/abhi/qprojects/instructkr-claude-code (TS/React project)
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
// instructkr-claude-code workspace
// ---------------------------------------------------------------------------

const INSTRUCTKR_ROOT = "/home/abhi/qprojects/instructkr-claude-code"

describe.skipIf(!existsSync(INSTRUCTKR_ROOT))(
  "ts-core integration — instructkr-claude-code",
  () => {
    let ingest: IngestedWorkspace

    beforeAll(async () => {
      ingest = await ingestWorkspace(INSTRUCTKR_ROOT)
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
  },
)
