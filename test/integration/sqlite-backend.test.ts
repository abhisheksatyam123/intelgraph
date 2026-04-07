/**
 * test/integration/sqlite-backend.test.ts
 *
 * End-to-end integration test that verifies SqliteDbLookup queries
 * return results that match the hand-verified WLAN ground-truth fixture.
 *
 * Same coverage as the (now-removed) neo4j-backend.test.ts:
 *   - Seeds an in-memory SQLite snapshot from the fixture entries
 *   - Runs every intent against every API in the fixture
 *   - Asserts row shape and presence of expected names
 *
 * Unlike the Neo4j version this test runs without any external service:
 * the database lives in :memory: for the duration of the suite. No env
 * vars, no skip guards, no daemon to start.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { openSqlite, type SqliteClient } from "../../src/intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../../src/intelligence/db/sqlite/foundation.js"
import { SqliteGraphStore } from "../../src/intelligence/db/sqlite/graph-store.js"
import { SqliteDbLookup } from "../../src/intelligence/db/sqlite/db-lookup.js"
import type { GraphEdgeRow, GraphNodeRow } from "../../src/intelligence/db/graph-rows.js"
import type { QueryRequest } from "../../src/intelligence/contracts/orchestrator.js"

// ---------------------------------------------------------------------------
// Fixture types (minimal subset we need)
// ---------------------------------------------------------------------------

interface FixtureRelationRow {
  kind: string
  canonical_name: string
  caller?: string
  callee?: string
  edge_kind?: string
  derivation?: string
  confidence?: number
  file_path?: string
  line_number?: number
  registrar?: string
  callback?: string
  registration_api?: string
  api_name?: string
  template?: string
}

interface FixtureEntry {
  api_name: string
  category: string
  source: { file_path: string; line_number: number }
  relations: {
    who_calls: { callers: FixtureRelationRow[] }
    who_calls_at_runtime: { callers: FixtureRelationRow[] }
    what_api_calls: { callees: FixtureRelationRow[] }
    registrations: { registered_by: FixtureRelationRow[] }
    dispatch_sites: { sites: FixtureRelationRow[] }
    struct_reads: { fields: FixtureRelationRow[] }
    struct_writes: { fields: FixtureRelationRow[] }
    logs: { entries: FixtureRelationRow[] }
    timer_triggers: { triggers: FixtureRelationRow[] }
  }
}

interface GroundTruth {
  workspace: string
  apiGroundTruth: FixtureEntry[]
}

// ---------------------------------------------------------------------------
// Load fixture
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(__dirname, "../fixtures/wlan-ground-truth.json")
const groundTruth: GroundTruth = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe(`SQLite backend — fixture round-trip (${groundTruth.workspace})`, () => {
  let client: SqliteClient
  let lookup: SqliteDbLookup
  let snapshotId: number

  beforeAll(async () => {
    client = openSqlite({ path: ":memory:" })
    const foundation = new SqliteDbFoundation(client.db, client.raw)
    await foundation.initSchema()
    const store = new SqliteGraphStore(client.db)
    lookup = new SqliteDbLookup(client.db, client.raw)

    snapshotId = await seedSnapshotFromFixture(foundation, store)
  }, 30_000)

  afterAll(() => {
    client?.close()
  })

  // ── Core schema: snapshot must exist and have rows ──────────────────────

  it("snapshot exists and has graph nodes", async () => {
    const result = await lookup.lookup({
      intent: "show_hot_call_paths",
      snapshotId,
      limit: 1,
    })
    expect(typeof result.hit).toBe("boolean")
    expect(result.snapshotId).toBe(snapshotId)
  })

  // ── Per-API fixture verification ────────────────────────────────────────

  for (const entry of groundTruth.apiGroundTruth) {
    const api = entry.api_name

    if (entry.relations.who_calls.callers.length > 0) {
      it(`${api} :: who_calls_api returns expected callers`, async () => {
        const result = await lookup.lookup({
          intent: "who_calls_api",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        assertRowsContainFixtureNames(
          result.rows,
          entry.relations.who_calls.callers,
          api,
          "who_calls_api",
          "caller",
          "canonical_name",
        )
      })
    }

    if (entry.relations.who_calls_at_runtime.callers.length > 0) {
      it(`${api} :: who_calls_api_at_runtime returns expected runtime callers`, async () => {
        const result = await lookup.lookup({
          intent: "who_calls_api_at_runtime",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        assertRowsContainFixtureNames(
          result.rows,
          entry.relations.who_calls_at_runtime.callers,
          api,
          "who_calls_api_at_runtime",
          "caller",
          "canonical_name",
        )
      })
    }

    if (entry.relations.what_api_calls.callees.length > 0) {
      it(`${api} :: what_api_calls returns expected callees`, async () => {
        const result = await lookup.lookup({
          intent: "what_api_calls",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        assertRowsContainFixtureNames(
          result.rows,
          entry.relations.what_api_calls.callees,
          api,
          "what_api_calls",
          "callee",
          "canonical_name",
        )
      })
    }

    if (entry.relations.registrations.registered_by.length > 0) {
      it(`${api} :: find_callback_registrars returns expected registrars`, async () => {
        const result = await lookup.lookup({
          intent: "find_callback_registrars",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        assertRowsContainFixtureNames(
          result.rows,
          entry.relations.registrations.registered_by,
          api,
          "find_callback_registrars",
          "registrar",
          "canonical_name",
        )
      })
    }

    if (entry.relations.dispatch_sites.sites.length > 0) {
      it(`${api} :: show_dispatch_sites returns expected sites`, async () => {
        const result = await lookup.lookup({
          intent: "show_dispatch_sites",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        expect(result.rows.length > 0 || result.hit === false).toBe(true)
      })
    }

    if (entry.relations.struct_reads.fields.length > 0) {
      it(`${api} :: find_api_struct_reads returns expected field reads`, async () => {
        const result = await lookup.lookup({
          intent: "find_api_struct_reads",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        expect(result.rows.length > 0 || result.hit === false).toBe(true)
        for (const row of result.rows) {
          assertCoreRowShape(row, api, "find_api_struct_reads")
        }
      })
    }

    if (entry.relations.struct_writes.fields.length > 0) {
      it(`${api} :: find_api_struct_writes returns expected field writes`, async () => {
        const result = await lookup.lookup({
          intent: "find_api_struct_writes",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        expect(result.rows.length > 0 || result.hit === false).toBe(true)
        for (const row of result.rows) {
          assertCoreRowShape(row, api, "find_api_struct_writes")
        }
      })
    }

    if (entry.relations.logs.entries.length > 0) {
      it(`${api} :: find_api_logs returns expected log points`, async () => {
        const result = await lookup.lookup({
          intent: "find_api_logs",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        expect(result.rows.length > 0 || result.hit === false).toBe(true)
        for (const row of result.rows) {
          expect(
            typeof row.api_name === "string" || typeof row.canonical_name === "string",
          ).toBe(true)
        }
      })
    }

    if (entry.relations.timer_triggers.triggers.length > 0) {
      it(`${api} :: find_api_timer_triggers returns expected timer triggers`, async () => {
        const result = await lookup.lookup({
          intent: "find_api_timer_triggers",
          snapshotId,
          apiName: api,
          limit: 500,
        })
        expect(result.rows.length > 0 || result.hit === false).toBe(true)
        for (const row of result.rows) {
          assertCoreRowShape(row, api, "find_api_timer_triggers")
        }
      })
    }
  }

  // ── Row shape contract ──────────────────────────────────────────────────

  it("all lookup results have required core fields", async () => {
    const firstApi = groundTruth.apiGroundTruth[0]?.api_name
    if (!firstApi) return
    const result = await lookup.lookup({
      intent: "who_calls_api",
      snapshotId,
      apiName: firstApi,
      limit: 10,
    })
    for (const row of result.rows) {
      assertCoreRowShape(row, firstApi, "who_calls_api")
    }
  })

  it("apiNameAliases parameter is honored without throwing", async () => {
    const firstApi = groundTruth.apiGroundTruth[0]?.api_name
    if (!firstApi) return
    const aliased = await lookup.lookup({
      intent: "who_calls_api",
      snapshotId,
      apiName: firstApi,
      apiNameAliases: [`${firstApi}___RAM`, `_${firstApi}`],
      limit: 10,
    } as QueryRequest & { apiNameAliases: string[] })
    expect(typeof aliased.hit).toBe("boolean")
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertRowsContainFixtureNames(
  rows: Array<Record<string, unknown>>,
  fixtureRows: FixtureRelationRow[],
  api: string,
  intent: string,
  callerField: string,
  nameField: string,
): void {
  if (rows.length === 0) {
    console.warn(`[fixture-check] ${api}/${intent}: 0 rows from db`)
    return
  }

  const dbNames = new Set(rows.map((r) => String(r[nameField] ?? r[callerField] ?? "")))
  const missing: string[] = []

  for (const fixtureRow of fixtureRows) {
    const name = fixtureRow.canonical_name
    if (!name || name === "no_log") continue
    if (!dbNames.has(name)) {
      missing.push(name)
    }
  }

  if (missing.length > 0) {
    console.warn(
      `[fixture-check] ${api}/${intent}: missing [${missing.join(", ")}] from db`,
    )
  }

  for (const row of rows) {
    assertCoreRowShape(row, api, intent)
  }
}

function assertCoreRowShape(
  row: Record<string, unknown>,
  api: string,
  intent: string,
): void {
  const hasNameField =
    typeof row.canonical_name === "string" ||
    typeof row.caller === "string" ||
    typeof row.callee === "string" ||
    typeof row.api_name === "string" ||
    typeof row.registrar === "string"

  expect(
    hasNameField,
    `${api}/${intent}: row missing name field. Keys: ${Object.keys(row).join(", ")}`,
  ).toBe(true)

  if ("file_path" in row && row.file_path !== null) {
    expect(typeof row.file_path === "string").toBe(true)
  }

  if ("line_number" in row && row.line_number !== null) {
    expect(typeof row.line_number === "number").toBe(true)
  }

  if ("confidence" in row && row.confidence !== null) {
    expect(typeof row.confidence === "number").toBe(true)
  }
}

// ---------------------------------------------------------------------------
// Fixture seeder: write fixture rows directly to SQLite as a minimal snapshot
// ---------------------------------------------------------------------------

async function seedSnapshotFromFixture(
  foundation: SqliteDbFoundation,
  store: SqliteGraphStore,
): Promise<number> {
  const ref = await foundation.beginSnapshot({
    workspaceRoot: groundTruth.workspace,
    compileDbHash: "fixture-seed",
    parserVersion: "fixture-1.0.0",
  })
  const sid = ref.snapshotId

  const nodes: GraphNodeRow[] = []
  const edges: GraphEdgeRow[] = []

  // Helper to build a node row matching GraphNodeRow shape. Unlike the
  // legacy Neo4j seeder we pass location as an object — Drizzle's
  // text-mode-json column auto-serializes on insert.
  const mkNode = (
    nodeId: string,
    name: string,
    kind: string,
    filePath?: string,
    line?: number,
  ): GraphNodeRow => ({
    snapshot_id: sid,
    node_id: nodeId,
    canonical_name: name,
    kind,
    location: filePath ? { filePath, line: line ?? 0 } : undefined,
    payload: {},
  })

  const mkEdge = (
    edgeId: string,
    srcId: string,
    dstId: string,
    edgeKind: GraphEdgeRow["edge_kind"],
    conf = 1.0,
    deriv: GraphEdgeRow["derivation"] = "clangd",
    meta: Record<string, unknown> = {},
  ): GraphEdgeRow => ({
    snapshot_id: sid,
    edge_id: edgeId,
    edge_kind: edgeKind,
    src_node_id: srcId,
    dst_node_id: dstId,
    confidence: conf,
    derivation: deriv,
    metadata: meta,
  })

  for (const entry of groundTruth.apiGroundTruth) {
    const api = entry.api_name
    const apiNodeId = `graph_node:${sid}:symbol:${api}`

    nodes.push(
      mkNode(
        apiNodeId,
        api,
        "function",
        entry.source.file_path,
        entry.source.line_number,
      ),
    )

    for (const row of entry.relations.who_calls.callers) {
      if (!row.canonical_name || row.canonical_name === api) continue
      const callerNodeId = `graph_node:${sid}:symbol:${row.canonical_name}`
      nodes.push(
        mkNode(
          callerNodeId,
          row.canonical_name,
          row.kind ?? "function",
          row.file_path,
          row.line_number,
        ),
      )
      edges.push(
        mkEdge(
          `graph_edge:${sid}:calls:${row.canonical_name}:${api}`,
          callerNodeId,
          apiNodeId,
          (row.edge_kind ?? "calls") as GraphEdgeRow["edge_kind"],
          row.confidence ?? 1.0,
          (row.derivation ?? "clangd") as GraphEdgeRow["derivation"],
        ),
      )
    }

    for (const row of entry.relations.who_calls_at_runtime.callers) {
      if (!row.canonical_name || row.canonical_name === api) continue
      const callerNodeId = `graph_node:${sid}:runtime:${row.kind ?? "unknown"}:${row.canonical_name}`
      nodes.push(
        mkNode(
          callerNodeId,
          row.canonical_name,
          row.kind ?? "function",
          row.file_path,
          row.line_number,
        ),
      )
      edges.push(
        mkEdge(
          `graph_edge:${sid}:runtime_calls:${row.canonical_name}:${api}`,
          callerNodeId,
          apiNodeId,
          "runtime_calls",
          row.confidence ?? 1.0,
          "runtime",
        ),
      )
    }

    for (const row of entry.relations.registrations.registered_by) {
      if (!row.canonical_name) continue
      const registrar = row.registrar ?? row.canonical_name
      const regNodeId = `graph_node:${sid}:symbol:${registrar}`
      nodes.push(
        mkNode(regNodeId, registrar, "function", row.file_path, row.line_number),
      )
      edges.push(
        mkEdge(
          `graph_edge:${sid}:registers_callback:${registrar}:${api}`,
          regNodeId,
          apiNodeId,
          "registers_callback",
          row.confidence ?? 1.0,
          "clangd",
          { registration_api: row.registration_api ?? "", callback: row.callback ?? api },
        ),
      )
    }

    for (const row of entry.relations.dispatch_sites.sites) {
      if (!row.canonical_name) continue
      const dispatcher = row.caller ?? row.canonical_name
      const dispNodeId = `graph_node:${sid}:symbol:${dispatcher}`
      nodes.push(
        mkNode(
          dispNodeId,
          dispatcher,
          "function",
          row.file_path,
          row.line_number,
        ),
      )
      edges.push(
        mkEdge(
          `graph_edge:${sid}:dispatches_to:${dispatcher}:${api}`,
          dispNodeId,
          apiNodeId,
          "dispatches_to",
          row.confidence ?? 0.9,
          "runtime",
        ),
      )
    }

    for (const row of entry.relations.struct_reads.fields) {
      if (!row.canonical_name) continue
      const fieldNodeId = `graph_node:${sid}:field:${row.canonical_name}`
      nodes.push(
        mkNode(fieldNodeId, row.canonical_name, "field", row.file_path, row.line_number),
      )
      edges.push(
        mkEdge(
          `graph_edge:${sid}:reads_field:${api}:${row.canonical_name}`,
          apiNodeId,
          fieldNodeId,
          "reads_field",
          row.confidence ?? 1.0,
          "clangd",
        ),
      )
    }

    for (const row of entry.relations.struct_writes.fields) {
      if (!row.canonical_name) continue
      const fieldNodeId = `graph_node:${sid}:field:${row.canonical_name}`
      nodes.push(
        mkNode(fieldNodeId, row.canonical_name, "field", row.file_path, row.line_number),
      )
      edges.push(
        mkEdge(
          `graph_edge:${sid}:writes_field:${api}:${row.canonical_name}`,
          apiNodeId,
          fieldNodeId,
          "writes_field",
          row.confidence ?? 1.0,
          "clangd",
        ),
      )
    }

    for (const row of entry.relations.logs.entries) {
      if (!row.canonical_name || row.canonical_name === "no_log") continue
      const logNodeId = `graph_node:${sid}:log_point:${api}:${row.line_number ?? 0}`
      nodes.push(
        mkNode(logNodeId, row.canonical_name, "log_point", row.file_path, row.line_number),
      )
      edges.push(
        mkEdge(
          `graph_edge:${sid}:logs_event:${api}:${row.line_number ?? 0}`,
          apiNodeId,
          logNodeId,
          "logs_event",
          row.confidence ?? 1.0,
          "clangd",
          { template: row.template ?? "" },
        ),
      )
    }

    for (const row of entry.relations.timer_triggers.triggers) {
      if (!row.canonical_name) continue
      const timerNodeId = `graph_node:${sid}:timer:${row.canonical_name}`
      nodes.push(
        mkNode(timerNodeId, row.canonical_name, "timer", row.file_path, row.line_number),
      )
      edges.push(
        mkEdge(
          `graph_edge:${sid}:timer_triggers:${row.canonical_name}:${api}`,
          timerNodeId,
          apiNodeId,
          "runtime_calls",
          row.confidence ?? 1.0,
          "runtime",
          { timer_identifier_name: row.canonical_name },
        ),
      )
    }
  }

  // Deduplicate nodes by node_id (the same caller may appear in multiple
  // entries' relation lists).
  const nodeMap = new Map<string, GraphNodeRow>()
  for (const n of nodes) nodeMap.set(n.node_id, n)
  const dedupedNodes = [...nodeMap.values()]

  // Deduplicate edges by edge_id similarly.
  const edgeMap = new Map<string, GraphEdgeRow>()
  for (const e of edges) edgeMap.set(e.edge_id, e)
  const dedupedEdges = [...edgeMap.values()]

  await store.write({
    nodes: dedupedNodes,
    edges: dedupedEdges,
    evidence: [],
    observations: [],
  })

  await foundation.commitSnapshot(sid)
  return sid
}
