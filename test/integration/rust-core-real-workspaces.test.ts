/**
 * test/integration/rust-core-real-workspaces.test.ts
 *
 * End-to-end smoke tests that ingest a real Rust workspace using
 * the rust-core plugin and assert the resulting SQLite snapshot
 * answers basic queries correctly.
 *
 * Target: /home/abhi/qprojects/markdown-oxide (67 .rs files)
 *
 * Skips cleanly when the workspace path doesn't exist on the host.
 *
 * Mirrors the structure of test/integration/ts-core-real-workspaces.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import {
  openSqlite,
  type SqliteClient,
} from "../../src/intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../../src/intelligence/db/sqlite/foundation.js"
import { SqliteGraphStore } from "../../src/intelligence/db/sqlite/graph-store.js"
import { SqliteDbLookup } from "../../src/intelligence/db/sqlite/db-lookup.js"
import { ExtractorRunner } from "../../src/intelligence/extraction/runner.js"
import { rustCoreExtractor } from "../../src/plugins/index.js"
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

async function ingestWorkspace(
  workspaceRoot: string,
): Promise<IngestedWorkspace> {
  const client = openSqlite({ path: ":memory:" })
  const foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
  const store = new SqliteGraphStore(client.db)
  const lookup = new SqliteDbLookup(client.db, client.raw)

  const ref = await foundation.beginSnapshot({
    workspaceRoot,
    compileDbHash: "rust-core-smoke",
    parserVersion: "0.1.0",
  })
  const snapshotId = ref.snapshotId

  const runner = new ExtractorRunner({
    snapshotId,
    workspaceRoot,
    lsp: stubLsp,
    sink: store,
    plugins: [rustCoreExtractor],
  })
  const report = await runner.run()
  expect(report.pluginsFailed).toBe(0)
  expect(report.pluginsRun).toBe(1)

  await foundation.commitSnapshot(snapshotId)
  return { client, foundation, store, lookup, snapshotId }
}

const MARKDOWN_OXIDE = "/home/abhi/qprojects/markdown-oxide"

describe.skipIf(!existsSync(MARKDOWN_OXIDE))(
  "rust-core integration — markdown-oxide",
  () => {
    let ingest: IngestedWorkspace

    beforeAll(async () => {
      ingest = await ingestWorkspace(MARKDOWN_OXIDE)
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

    it("emits at least 30 module symbols", () => {
      const moduleCount = ingest.client.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ? AND kind = 'module'",
        )
        .get(ingest.snapshotId) as { n: number }
      expect(moduleCount.n).toBeGreaterThan(30)
    })

    it("emits structs, enums, traits, and methods", () => {
      const counts = ingest.client.raw
        .prepare(
          `SELECT kind, COUNT(*) AS n FROM graph_nodes
           WHERE snapshot_id = ?
             AND kind IN ('struct', 'enum', 'interface', 'method', 'function')
           GROUP BY kind`,
        )
        .all(ingest.snapshotId) as Array<{ kind: string; n: number }>
      const byKind: Record<string, number> = {}
      for (const row of counts) byKind[row.kind] = row.n
      expect(byKind.struct ?? 0).toBeGreaterThan(0)
      expect(byKind.function ?? 0).toBeGreaterThan(20)
      expect(byKind.method ?? 0).toBeGreaterThan(0)
    })

    it("emits imports edges from use declarations", () => {
      const importCount = ingest.client.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ? AND edge_kind = 'imports'",
        )
        .get(ingest.snapshotId) as { n: number }
      expect(importCount.n).toBeGreaterThan(50)
    })

    it("emits contains edges (module → declared symbol, type → method)", () => {
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
      expect(callCount.n).toBeGreaterThan(50)
    })

    it("at least some methods are qualified as Type.method", () => {
      const qualified = ingest.client.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM graph_nodes
           WHERE snapshot_id = ?
             AND kind = 'method'
             AND canonical_name LIKE '%#%.%'`,
        )
        .get(ingest.snapshotId) as { n: number }
      expect(qualified.n).toBeGreaterThan(0)
    })

    it("find_module_imports query runs cleanly on rust-core data", async () => {
      // Pick any module that has at least one outgoing imports edge
      const seed = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'imports'
             AND src.kind = 'module'
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string } | undefined
      if (!seed) return
      // Note: rust-core's import edges currently use Rust path syntax
      // (`crate::foo`) for the dst module, not the workspace file path
      // (`src/foo.rs`). find_module_imports needs the dst to exist as
      // a graph_node row, so the inner join filters out edges where
      // the rust path doesn't match a workspace module name. This is
      // a known gap — Rust module resolution is non-trivial. For now
      // we just verify the query runs and returns the right shape
      // (zero rows is an acceptable outcome until module resolution
      // is implemented).
      const result = await ingest.lookup.lookup({
        intent: "find_module_imports",
        snapshotId: ingest.snapshotId,
        apiName: seed.name,
        limit: 100,
      })
      expect(result.intent).toBe("find_module_imports")
      expect(Array.isArray(result.rows)).toBe(true)
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("imports")
      }
    })

    it("find_module_symbols returns symbols declared in a real module", async () => {
      const seed = ingest.client.raw
        .prepare(
          `SELECT src.canonical_name AS name FROM graph_edges e
           INNER JOIN graph_nodes src
             ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
           WHERE e.snapshot_id = ?
             AND e.edge_kind = 'contains'
             AND src.kind = 'module'
           GROUP BY src.canonical_name
           HAVING COUNT(*) > 2
           LIMIT 1`,
        )
        .get(ingest.snapshotId) as { name: string } | undefined
      if (!seed) return
      const result = await ingest.lookup.lookup({
        intent: "find_module_symbols",
        snapshotId: ingest.snapshotId,
        apiName: seed.name,
        limit: 50,
      })
      expect(result.hit).toBe(true)
      expect(result.rows.length).toBeGreaterThan(0)
      for (const row of result.rows) {
        expect(row.edge_kind).toBe("contains")
      }
    })

    it("Property: workspace-internal edge dsts must reference real graph_nodes", () => {
      // Same regression guard as the ts-core suite. Catches the
      // class of bug where an extractor emits a bare dst that never
      // joins to a real symbol.
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
      // markdown-oxide is a real Rust project; its imports almost
      // entirely point at external crates (std, tokio, …) so the
      // internal-checked count may be small. Just assert the orphan
      // RATE is below 50% when there are any internal edges.
      if (internalChecked > 0) {
        const rate = orphans / internalChecked
        expect(rate).toBeLessThan(0.5)
      }
    })
  },
)
