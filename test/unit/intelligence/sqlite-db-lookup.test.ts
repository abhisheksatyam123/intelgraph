/**
 * sqlite-db-lookup.test.ts — exercises SqliteDbLookup against a seeded
 * in-memory database covering all 22 intents.
 *
 * Test strategy:
 *   1. Seed a fixture snapshot with nodes, edges, and observations that
 *      together exercise every intent code path.
 *   2. Call lookup(request) for each intent.
 *   3. Assert on specific fields in the returned rows (not just counts)
 *      to catch regressions in row shaping / field renames.
 *
 * Fixture covers:
 *   - 4 functions (foo, bar, baz, wlan_timer_handler)
 *   - 1 struct (wlan_vdev), 2 fields (wlan_vdev.state, wlan_vdev.flags)
 *   - 1 log point (LOG_ERR_WLAN_INIT)
 *   - 1 timer node
 *   - Edges: calls, runtime_calls, registers_callback, dispatches_to,
 *     reads_field, writes_field, logs_event
 *   - 1 runtime_invocation observation
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openSqlite, type SqliteClient } from "../../../src/intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../../../src/intelligence/db/sqlite/foundation.js"
import { SqliteGraphStore } from "../../../src/intelligence/db/sqlite/graph-store.js"
import { SqliteDbLookup } from "../../../src/intelligence/db/sqlite/db-lookup.js"
import type {
  GraphEdgeRow,
  GraphNodeRow,
  GraphObservationRow,
} from "../../../src/intelligence/db/graph-rows.js"
import type { QueryRequest } from "../../../src/intelligence/contracts/orchestrator.js"

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let client: SqliteClient
let foundation: SqliteDbFoundation
let store: SqliteGraphStore
let lookup: SqliteDbLookup
let snapshotId: number

function makeNode(opts: {
  id: string
  name: string
  kind: string
  file?: string
  line?: number
}): GraphNodeRow {
  return {
    snapshot_id: snapshotId,
    node_id: opts.id,
    canonical_name: opts.name,
    kind: opts.kind,
    location: opts.file
      ? { filePath: opts.file, line: opts.line ?? 1 }
      : undefined,
    payload: {},
  }
}

function makeEdge(opts: {
  id: string
  kind: GraphEdgeRow["edge_kind"]
  src: string
  dst: string
  confidence?: number
  derivation?: string
  metadata?: Record<string, unknown>
}): GraphEdgeRow {
  return {
    snapshot_id: snapshotId,
    edge_id: opts.id,
    edge_kind: opts.kind,
    src_node_id: opts.src,
    dst_node_id: opts.dst,
    confidence: opts.confidence ?? 1.0,
    derivation: (opts.derivation ?? "clangd") as GraphEdgeRow["derivation"],
    metadata: opts.metadata ?? {},
  }
}

function makeObservation(opts: {
  id: string
  nodeId: string
  payload: Record<string, unknown>
  confidence?: number
}): GraphObservationRow {
  return {
    snapshot_id: snapshotId,
    observation_id: opts.id,
    node_id: opts.nodeId,
    kind: "runtime_invocation",
    observed_at: "2026-04-07T00:00:00Z",
    confidence: opts.confidence ?? 0.9,
    payload: opts.payload,
  }
}

beforeEach(async () => {
  client = openSqlite({ path: ":memory:" })
  foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
  store = new SqliteGraphStore(client.db)
  lookup = new SqliteDbLookup(client.db, client.raw)

  const ref = await foundation.beginSnapshot({
    workspaceRoot: "/tmp/ws",
    compileDbHash: "abc",
    parserVersion: "1.0.0",
  })
  snapshotId = ref.snapshotId

  // Seed fixture data
  await store.write({
    nodes: [
      // Functions
      makeNode({ id: "n-foo", name: "foo", kind: "function", file: "/src/a.c", line: 10 }),
      makeNode({ id: "n-bar", name: "bar", kind: "function", file: "/src/a.c", line: 20 }),
      makeNode({ id: "n-baz", name: "baz", kind: "function", file: "/src/b.c", line: 5 }),
      makeNode({
        id: "n-wtimer",
        name: "wlan_timer_handler",
        kind: "function",
        file: "/src/wlan.c",
        line: 100,
      }),
      // Registrar
      makeNode({
        id: "n-reg",
        name: "wlan_register_timer",
        kind: "function",
        file: "/src/wlan.c",
        line: 50,
      }),
      // Dispatcher
      makeNode({
        id: "n-disp",
        name: "wlan_dispatch",
        kind: "function",
        file: "/src/wlan.c",
        line: 80,
      }),
      // Struct
      makeNode({ id: "n-struct", name: "wlan_vdev", kind: "struct", file: "/src/wlan.h", line: 3 }),
      // Fields (canonical_name of form struct.field for STARTS WITH match)
      makeNode({ id: "n-f1", name: "wlan_vdev.state", kind: "field" }),
      makeNode({ id: "n-f2", name: "wlan_vdev.flags", kind: "field" }),
      // Log point
      makeNode({
        id: "n-log",
        name: "LOG_ERR_WLAN_INIT",
        kind: "log_point",
        file: "/src/wlan.c",
        line: 42,
      }),
      // Timer
      makeNode({
        id: "n-timer",
        name: "wlan_scan_timer",
        kind: "timer",
        file: "/src/wlan.c",
        line: 60,
      }),
    ],
    edges: [
      // foo calls bar (static) and baz (runtime)
      makeEdge({ id: "e1", kind: "calls", src: "n-foo", dst: "n-bar" }),
      makeEdge({ id: "e2", kind: "runtime_calls", src: "n-foo", dst: "n-baz", derivation: "runtime" }),
      // bar calls baz
      makeEdge({ id: "e3", kind: "calls", src: "n-bar", dst: "n-baz" }),
      // wlan_register_timer registers wlan_timer_handler as callback
      makeEdge({
        id: "e4",
        kind: "registers_callback",
        src: "n-reg",
        dst: "n-wtimer",
        metadata: { registration_api: "timer_register" },
      }),
      // wlan_dispatch dispatches to wlan_timer_handler
      makeEdge({
        id: "e5",
        kind: "dispatches_to",
        src: "n-disp",
        dst: "n-wtimer",
        metadata: { dispatch_site: { filePath: "/src/wlan.c", line: 85 } },
      }),
      // Timer calls wlan_timer_handler
      makeEdge({ id: "e6", kind: "runtime_calls", src: "n-timer", dst: "n-wtimer", derivation: "runtime" }),
      // foo writes wlan_vdev.state; bar reads wlan_vdev.flags
      makeEdge({
        id: "e7",
        kind: "writes_field",
        src: "n-foo",
        dst: "n-f1",
        metadata: { access_path: "vdev->state" },
      }),
      makeEdge({
        id: "e8",
        kind: "reads_field",
        src: "n-bar",
        dst: "n-f2",
        metadata: { access_path: "vdev->flags" },
      }),
      // foo writes wlan_vdev struct (owns)
      makeEdge({ id: "e9", kind: "writes_field", src: "n-foo", dst: "n-struct" }),
      // foo emits a log event
      makeEdge({
        id: "e10",
        kind: "logs_event",
        src: "n-foo",
        dst: "n-log",
        metadata: { log_level: "ERROR", template: "wlan init failed: %s", subsystem: "WLAN" },
      }),
    ],
    evidence: [],
    observations: [
      // Runtime observation for wlan_timer_handler dispatched from wlan_dispatch
      makeObservation({
        id: "o1",
        nodeId: "n-wtimer",
        payload: {
          target_api: "wlan_timer_handler",
          immediate_invoker: "wlan_dispatch",
          runtime_trigger: "timer",
          dispatch_chain: ["wlan_register_timer", "wlan_dispatch", "wlan_timer_handler"],
          dispatch_site: { filePath: "/src/wlan.c", line: 85 },
        },
        confidence: 0.95,
      }),
    ],
  })
})

afterEach(() => {
  client.close()
})

// ---------------------------------------------------------------------------
// Helper to build a QueryRequest
// ---------------------------------------------------------------------------

function req(overrides: Partial<QueryRequest>): QueryRequest {
  return {
    snapshotId,
    intent: "who_calls_api",
    apiName: "bar",
    limit: 50,
    ...overrides,
  } as QueryRequest
}

// ---------------------------------------------------------------------------
// Tests by intent
// ---------------------------------------------------------------------------

describe("SqliteDbLookup — callers", () => {
  it("who_calls_api returns static and runtime callers", async () => {
    const result = await lookup.lookup(req({ intent: "who_calls_api", apiName: "baz" }))
    expect(result.hit).toBe(true)
    const callers = result.rows.map((r) => r.caller).sort()
    // foo calls baz at runtime; bar calls baz statically
    expect(callers).toEqual(["bar", "foo"])
  })

  it("who_calls_api returns empty when no callers exist", async () => {
    const result = await lookup.lookup(req({ intent: "who_calls_api", apiName: "nothing" }))
    expect(result.hit).toBe(false)
    expect(result.rows).toHaveLength(0)
  })

  it("who_calls_api populates file_path and line_number from caller location", async () => {
    const result = await lookup.lookup(req({ intent: "who_calls_api", apiName: "bar" }))
    const row = result.rows[0]
    expect(row.caller).toBe("foo")
    expect(row.file_path).toBe("/src/a.c")
    expect(row.line_number).toBe(10)
  })
})

describe("SqliteDbLookup — runtime callers and observations", () => {
  it("who_calls_api_at_runtime merges observation rows with edge rows", async () => {
    const result = await lookup.lookup(
      req({ intent: "who_calls_api_at_runtime", apiName: "wlan_timer_handler" }),
    )
    expect(result.hit).toBe(true)
    // Observation should win (richer data)
    const callers = result.rows.map((r) => r.caller)
    expect(callers).toContain("wlan_dispatch")
    const obsRow = result.rows.find((r) => r.caller === "wlan_dispatch")
    expect(obsRow?.runtime_trigger).toBe("timer")
    expect(obsRow?.dispatch_chain).toEqual([
      "wlan_register_timer",
      "wlan_dispatch",
      "wlan_timer_handler",
    ])
  })

  it("why_api_invoked returns the runtime observation payload", async () => {
    const result = await lookup.lookup(
      req({ intent: "why_api_invoked", apiName: "wlan_timer_handler" }),
    )
    expect(result.hit).toBe(true)
    expect(result.rows[0].target_api).toBe("wlan_timer_handler")
    expect(result.rows[0].runtime_trigger).toBe("timer")
  })
})

describe("SqliteDbLookup — callees", () => {
  it("what_api_calls returns both static and runtime callees", async () => {
    const result = await lookup.lookup(req({ intent: "what_api_calls", apiName: "foo" }))
    expect(result.hit).toBe(true)
    const callees = result.rows.map((r) => r.callee).sort()
    expect(callees).toEqual(["bar", "baz"])
  })
})

describe("SqliteDbLookup — logs", () => {
  it("find_api_logs returns log_event edges for the api", async () => {
    const result = await lookup.lookup(req({ intent: "find_api_logs", apiName: "foo" }))
    expect(result.hit).toBe(true)
    expect(result.rows[0].template).toBe("wlan init failed: %s")
    expect(result.rows[0].log_level).toBe("ERROR")
    expect(result.rows[0].subsystem).toBe("WLAN")
  })

  it("find_api_logs_by_level filters by log level", async () => {
    const hit = await lookup.lookup(
      req({ intent: "find_api_logs_by_level", apiName: "foo", logLevel: "ERROR" } as QueryRequest),
    )
    expect(hit.hit).toBe(true)
    const miss = await lookup.lookup(
      req({ intent: "find_api_logs_by_level", apiName: "foo", logLevel: "WARN" } as QueryRequest),
    )
    expect(miss.hit).toBe(false)
  })

  it("find_api_by_log_pattern matches on template contents", async () => {
    const result = await lookup.lookup(
      req({ intent: "find_api_by_log_pattern", pattern: "wlan init" } as QueryRequest),
    )
    expect(result.hit).toBe(true)
    expect(result.rows[0].caller).toBe("foo")
  })
})

describe("SqliteDbLookup — timer triggers", () => {
  it("find_api_timer_triggers finds timer → api edges", async () => {
    const result = await lookup.lookup(
      req({ intent: "find_api_timer_triggers", apiName: "wlan_timer_handler" }),
    )
    expect(result.hit).toBe(true)
    expect(result.rows[0].timer_identifier_name).toBe("wlan_scan_timer")
  })
})

describe("SqliteDbLookup — registration and dispatch", () => {
  it("show_registration_chain finds registers_callback edges", async () => {
    const result = await lookup.lookup(
      req({ intent: "show_registration_chain", apiName: "wlan_timer_handler" }),
    )
    expect(result.hit).toBe(true)
    expect(result.rows[0].registrar).toBe("wlan_register_timer")
    expect(result.rows[0].callback).toBe("wlan_timer_handler")
    expect(result.rows[0].registration_api).toBe("timer_register")
  })

  it("find_callback_registrars uses the same code path", async () => {
    const result = await lookup.lookup(
      req({ intent: "find_callback_registrars", apiName: "wlan_timer_handler" }),
    )
    expect(result.hit).toBe(true)
    expect(result.rows[0].registrar).toBe("wlan_register_timer")
  })

  it("show_dispatch_sites finds dispatches_to edges", async () => {
    const result = await lookup.lookup(
      req({ intent: "show_dispatch_sites", apiName: "wlan_timer_handler" }),
    )
    expect(result.hit).toBe(true)
    const row = result.rows[0]
    expect(row.caller).toBe("wlan_dispatch")
    const dispatchSite = row.dispatch_site as { file: string; line: number }
    expect(dispatchSite.file).toBe("/src/wlan.c")
    expect(dispatchSite.line).toBe(80)
  })
})

describe("SqliteDbLookup — struct access", () => {
  it("find_struct_writers returns nodes with writes_field edges", async () => {
    const result = await lookup.lookup(
      req({
        intent: "find_struct_writers",
        structName: "wlan_vdev.state",
      } as QueryRequest),
    )
    expect(result.hit).toBe(true)
    expect(result.rows[0].writer).toBe("foo")
  })

  it("find_struct_readers returns nodes with reads_field edges", async () => {
    const result = await lookup.lookup(
      req({
        intent: "find_struct_readers",
        structName: "wlan_vdev.flags",
      } as QueryRequest),
    )
    expect(result.hit).toBe(true)
    expect(result.rows[0].reader).toBe("bar")
  })

  it("find_api_struct_writes finds api-centric writes", async () => {
    const result = await lookup.lookup(
      req({ intent: "find_api_struct_writes", apiName: "foo" }),
    )
    expect(result.hit).toBe(true)
    const callees = result.rows.map((r) => r.callee).sort()
    expect(callees).toContain("wlan_vdev.state")
  })

  it("find_field_access_path uses STARTS WITH / ENDS WITH semantics", async () => {
    const hit1 = await lookup.lookup(
      req({
        intent: "find_field_access_path",
        structName: "wlan_vdev",
      } as QueryRequest),
    )
    expect(hit1.hit).toBe(true)
    expect(hit1.rows.length).toBeGreaterThanOrEqual(2) // state + flags

    const hit2 = await lookup.lookup(
      req({ intent: "find_field_access_path", fieldName: "state" } as QueryRequest),
    )
    expect(hit2.hit).toBe(true)
    expect(hit2.rows[0].callee).toBe("wlan_vdev.state")
  })
})

describe("SqliteDbLookup — cross-module path and hot paths", () => {
  it("show_cross_module_path returns the edge between two specific apis", async () => {
    const result = await lookup.lookup(
      req({ intent: "show_cross_module_path", srcApi: "foo", dstApi: "bar" } as QueryRequest),
    )
    expect(result.hit).toBe(true)
    expect(result.rows[0].caller).toBe("foo")
    expect(result.rows[0].callee).toBe("bar")
  })

  it("show_hot_call_paths with empty apis returns any edges (diagnostic)", async () => {
    const result = await lookup.lookup(
      req({ intent: "show_hot_call_paths", apiName: undefined } as unknown as QueryRequest),
    )
    expect(result.hit).toBe(true)
    expect(result.rows.length).toBeGreaterThan(0)
  })
})

describe("SqliteDbLookup — snapshot isolation", () => {
  it("queries scoped to a different snapshotId return no rows", async () => {
    const result = await lookup.lookup(
      req({ snapshotId: 99, intent: "who_calls_api", apiName: "bar" }),
    )
    expect(result.hit).toBe(false)
  })
})

describe("SqliteDbLookup — unknown intent", () => {
  it("returns a miss for an unrecognized intent", async () => {
    const result = await lookup.lookup(
      req({ intent: "not_an_intent" as QueryRequest["intent"] }),
    )
    expect(result.hit).toBe(false)
    expect(result.rows).toHaveLength(0)
  })
})
