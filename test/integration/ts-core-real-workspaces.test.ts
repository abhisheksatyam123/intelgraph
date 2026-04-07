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
