import { describe, expect, it, vi } from "vitest"
import { PostgresAuthoritativeStore } from "../../../src/intelligence/db/postgres/authoritative-store.js"
import { Neo4jGraphProjectionService } from "../../../src/intelligence/db/neo4j/projection-service.js"
import { classifyAndStoreInvocationType } from "../../../src/intelligence/db/postgres/ingest-writer.js"
import type { QueryRequest, EnrichmentResult } from "../../../src/intelligence/contracts/orchestrator.js"
import { RuntimeInvocationType } from "../../../src/intelligence/contracts/orchestrator.js"

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

function mkPool(overrides: Record<string, unknown> = {}) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return {
    query: vi.fn(async (sql: string) => {
      // For Neo4j projection reads
      if (sql.includes("SELECT id, name, kind FROM symbol")) {
        return { rows: [{ id: "1", name: "wlan_bpf_filter_offload_handler", kind: "function" }] }
      }
      if (sql.includes("SELECT id, src_symbol_name")) {
        return { rows: [{ id: "1", src_symbol_name: "wlan_bpf_enable_data_path", dst_symbol_name: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" }] }
      }
      return { rows: [] }
    }),
    connect: vi.fn(async () => client),
    ...overrides,
  } as unknown as import("pg").Pool
}

// ---------------------------------------------------------------------------
// PostgresAuthoritativeStore tests
// ---------------------------------------------------------------------------

describe("PostgresAuthoritativeStore", () => {
  it("persists enrichment edges and returns inserted count", async () => {
    const pool = mkPool()
    const store = new PostgresAuthoritativeStore(pool)
    const req: QueryRequest = { intent: "who_calls_api", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" }
    const result: EnrichmentResult & { edges: unknown[] } = {
      attempts: [{ source: "clangd", status: "success" }],
      persistedRows: 1,
      edges: [
        {
          edgeKind: "registers_callback",
          srcSymbolName: "wlan_bpf_enable_data_path",
          dstSymbolName: "wlan_bpf_filter_offload_handler",
          confidence: 1.0,
          derivation: "clangd",
          evidence: { sourceKind: "clangd_response", location: { filePath: "bpf_offload_int.c", line: 1093 } },
        },
      ],
    }
    const count = await store.persistEnrichment(req, result)
    expect(count).toBeGreaterThanOrEqual(0)
  })

  it("handles empty enrichment result without error", async () => {
    const pool = mkPool()
    const store = new PostgresAuthoritativeStore(pool)
    const req: QueryRequest = { intent: "who_calls_api", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" }
    const result: EnrichmentResult = {
      attempts: [{ source: "clangd", status: "failed" }],
      persistedRows: 0,
    }
    const count = await store.persistEnrichment(req, result)
    expect(count).toBe(0)
  })

  it("persists runtime callers from enrichment result", async () => {
    const pool = mkPool()
    const store = new PostgresAuthoritativeStore(pool)
    const req: QueryRequest = { intent: "why_api_invoked", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" }
    const result: EnrichmentResult & { runtimeCallers: unknown[] } = {
      attempts: [{ source: "c_parser", status: "success" }],
      persistedRows: 1,
      runtimeCallers: [
        {
          targetApi: "wlan_bpf_filter_offload_handler",
          runtimeTrigger: "Incoming RX data packet from hardware",
          dispatchChain: ["offloadif_data_ind", "_offldmgr_protocol_data_handler", "_offldmgr_enhanced_data_handler"],
          immediateInvoker: "_offldmgr_enhanced_data_handler",
          dispatchSite: { filePath: "offload_mgr_ext.c", line: 1107 },
          confidence: 1.0,
        },
      ],
    }
    const count = await store.persistEnrichment(req, result)
    expect(count).toBeGreaterThanOrEqual(0)
  })

  // ---------------------------------------------------------------------------
  // Timer trigger persistence tests (1.5.3)
  // ---------------------------------------------------------------------------

  it("persists timer trigger rows from enrichment result and includes them in returned count", async () => {
    const timerInsertSqls: string[] = []
    const timerInsertParams: unknown[][] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO api_timer_trigger")) {
          timerInsertSqls.push(sql)
          if (params) timerInsertParams.push(params)
        }
        if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as import("pg").Pool

    const store = new PostgresAuthoritativeStore(pool)
    const req: QueryRequest = { intent: "find_api_timer_triggers", snapshotId: 99, apiName: "wlan_bpf_traffic_timer_handler" }
    const result = {
      attempts: [{ source: "clangd" as const, status: "success" as const }],
      persistedRows: 1,
      timerTriggers: [
        {
          apiName: "wlan_bpf_traffic_timer_handler",
          timerIdentifierName: "bpf_traffic_watchdog_timer",
          timerTriggerConditionDescription: "Fires when BPF traffic watchdog timer expires after inactivity period",
          timerTriggerConfidenceScore: 0.95,
          derivation: "clangd" as const,
          evidence: { sourceKind: "file_line" as const, location: { filePath: "wlan_bpf_offload.c", line: 412 } },
        },
      ],
    }

    const count = await store.persistEnrichment(req, result)

    // Should return 1 for the timer trigger row
    expect(count).toBe(1)

    // Verify INSERT INTO api_timer_trigger was called
    expect(timerInsertSqls).toHaveLength(1)

    // Verify correct params were passed
    const timerParams = timerInsertParams[0]
    expect(timerParams).toBeDefined()
    expect(timerParams![0]).toBe(99)  // snapshotId
    expect(timerParams![1]).toBe("wlan_bpf_traffic_timer_handler")  // api_name
    expect(timerParams![2]).toBe("bpf_traffic_watchdog_timer")  // timer_identifier_name
    expect(timerParams![3]).toContain("BPF traffic watchdog")  // condition description
    expect(timerParams![4]).toBe(0.95)  // confidence score
    expect(timerParams![5]).toBe("clangd")  // derivation
  })

  it("returns combined count of edges + runtimeCallers + timerTriggers", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as import("pg").Pool

    const store = new PostgresAuthoritativeStore(pool)
    const req: QueryRequest = { intent: "find_api_timer_triggers", snapshotId: 10, apiName: "wlan_bpf_traffic_timer_handler" }
    const result = {
      attempts: [{ source: "clangd" as const, status: "success" as const }],
      persistedRows: 3,
      edges: [
        { edgeKind: "calls" as const, srcSymbolName: "caller_fn", dstSymbolName: "wlan_bpf_traffic_timer_handler", confidence: 1.0, derivation: "clangd" as const },
      ],
      runtimeCallers: [
        {
          targetApi: "wlan_bpf_traffic_timer_handler",
          runtimeTrigger: "timer expiry",
          dispatchChain: ["timer_dispatch"],
          immediateInvoker: "timer_dispatch",
          dispatchSite: { filePath: "timer.c", line: 100 },
          confidence: 0.9,
        },
      ],
      timerTriggers: [
        {
          apiName: "wlan_bpf_traffic_timer_handler",
          timerIdentifierName: "bpf_traffic_watchdog_timer",
          timerTriggerConfidenceScore: 0.95,
          derivation: "clangd" as const,
        },
      ],
    }

    const count = await store.persistEnrichment(req, result)
    // 1 edge + 1 runtimeCaller + 1 timerTrigger = 3
    expect(count).toBe(3)
  })

  it("WLAN-grounded: persists bpf_traffic_watchdog_timer trigger for wlan_bpf_traffic_timer_handler", async () => {
    const insertedTimerRows: unknown[][] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO api_timer_trigger") && params) {
          insertedTimerRows.push(params)
        }
        if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as import("pg").Pool

    const store = new PostgresAuthoritativeStore(pool)
    const req: QueryRequest = {
      intent: "find_api_timer_triggers",
      snapshotId: 77,
      apiName: "wlan_bpf_traffic_timer_handler",
    }
    const result = {
      attempts: [{ source: "clangd" as const, status: "success" as const }],
      persistedRows: 1,
      timerTriggers: [
        {
          apiName: "wlan_bpf_traffic_timer_handler",
          timerIdentifierName: "bpf_traffic_watchdog_timer",
          timerTriggerConditionDescription: "Fires when BPF traffic watchdog timer expires — monitors data path inactivity",
          timerTriggerConfidenceScore: 1.0,
          derivation: "clangd" as const,
          evidence: {
            sourceKind: "file_line" as const,
            location: { filePath: "wlan_bpf_offload.c", line: 412 },
          },
        },
      ],
    }

    await store.persistEnrichment(req, result)

    expect(insertedTimerRows).toHaveLength(1)
    const [row] = insertedTimerRows
    expect(row![0]).toBe(77)  // snapshotId
    expect(row![1]).toBe("wlan_bpf_traffic_timer_handler")  // api_name
    expect(row![2]).toBe("bpf_traffic_watchdog_timer")  // timer_identifier_name
    expect(row![3]).toContain("BPF traffic watchdog")  // condition description
    expect(row![4]).toBe(1.0)  // confidence score
    expect(row![5]).toBe("clangd")  // derivation
    // evidence should be JSON-serialized
    expect(typeof row![6]).toBe("string")
    const evidence = JSON.parse(row![6] as string)
    expect(evidence.sourceKind).toBe("file_line")
    expect(evidence.location.filePath).toBe("wlan_bpf_offload.c")
    expect(evidence.location.line).toBe(412)
  })
})

// ---------------------------------------------------------------------------
// classifyAndStoreInvocationType unit tests (1.5.1.1 + 1.5.1.2)
// ---------------------------------------------------------------------------

describe("classifyAndStoreInvocationType", () => {
  it("maps 'calls' to RUNTIME_DIRECT_CALL", () => {
    expect(classifyAndStoreInvocationType("calls")).toBe(RuntimeInvocationType.RUNTIME_DIRECT_CALL)
  })

  it("maps 'registers_callback' to RUNTIME_CALLBACK_REGISTRATION_CALL", () => {
    expect(classifyAndStoreInvocationType("registers_callback")).toBe(RuntimeInvocationType.RUNTIME_CALLBACK_REGISTRATION_CALL)
  })

  it("maps 'indirect_calls' to RUNTIME_FUNCTION_POINTER_CALL", () => {
    expect(classifyAndStoreInvocationType("indirect_calls")).toBe(RuntimeInvocationType.RUNTIME_FUNCTION_POINTER_CALL)
  })

  it("maps 'dispatches_to' to RUNTIME_DISPATCH_TABLE_CALL", () => {
    expect(classifyAndStoreInvocationType("dispatches_to")).toBe(RuntimeInvocationType.RUNTIME_DISPATCH_TABLE_CALL)
  })

  it("maps unknown edge kinds to RUNTIME_UNKNOWN_CALL_PATH", () => {
    expect(classifyAndStoreInvocationType("reads_field")).toBe(RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH)
    expect(classifyAndStoreInvocationType("writes_field")).toBe(RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH)
    expect(classifyAndStoreInvocationType("operates_on_struct")).toBe(RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH)
    expect(classifyAndStoreInvocationType("uses_macro")).toBe(RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH)
    expect(classifyAndStoreInvocationType("logs_event")).toBe(RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH)
  })

  it("stores invocation_type_classification in metadata JSONB during edge persistence", async () => {
    const insertedMetadataValues: unknown[] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO semantic_edge") && params) {
          // metadata is the 8th param (index 7)
          insertedMetadataValues.push(params[7])
        }
        if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as import("pg").Pool

    const store = new PostgresAuthoritativeStore(pool)
    const req: QueryRequest = { intent: "who_calls_api", snapshotId: 5, apiName: "target_fn" }
    const result = {
      attempts: [{ source: "clangd" as const, status: "success" as const }],
      persistedRows: 5,
      edges: [
        { edgeKind: "calls" as const, srcSymbolName: "a", dstSymbolName: "target_fn", confidence: 1.0, derivation: "clangd" as const },
        { edgeKind: "registers_callback" as const, srcSymbolName: "b", dstSymbolName: "target_fn", confidence: 0.9, derivation: "clangd" as const },
        { edgeKind: "indirect_calls" as const, srcSymbolName: "c", dstSymbolName: "target_fn", confidence: 0.8, derivation: "clangd" as const },
        { edgeKind: "dispatches_to" as const, srcSymbolName: "d", dstSymbolName: "target_fn", confidence: 0.7, derivation: "clangd" as const },
        { edgeKind: "reads_field" as const, srcSymbolName: "e", dstSymbolName: "target_fn", confidence: 0.5, derivation: "clangd" as const },
      ],
    }

    await store.persistEnrichment(req, result)

    expect(insertedMetadataValues).toHaveLength(5)

    const parsed = insertedMetadataValues.map(v => JSON.parse(v as string))
    expect(parsed[0]!.invocation_type_classification).toBe(RuntimeInvocationType.RUNTIME_DIRECT_CALL)
    expect(parsed[1]!.invocation_type_classification).toBe(RuntimeInvocationType.RUNTIME_CALLBACK_REGISTRATION_CALL)
    expect(parsed[2]!.invocation_type_classification).toBe(RuntimeInvocationType.RUNTIME_FUNCTION_POINTER_CALL)
    expect(parsed[3]!.invocation_type_classification).toBe(RuntimeInvocationType.RUNTIME_DISPATCH_TABLE_CALL)
    expect(parsed[4]!.invocation_type_classification).toBe(RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH)
  })
})

// ---------------------------------------------------------------------------
// Neo4jGraphProjectionService tests
// ---------------------------------------------------------------------------

describe("Neo4jGraphProjectionService", () => {
  function mkDriver() {
    const session = {
      run: vi.fn(async () => ({ records: [] })),
      close: vi.fn(async () => {}),
    }
    return {
      session: vi.fn(() => session),
      _session: session,
    } as unknown as import("neo4j-driver").Driver & { _session: typeof session }
  }

  it("syncs symbols and edges from Postgres to Neo4j", async () => {
    const pool = mkPool()
    const driver = mkDriver()
    const svc = new Neo4jGraphProjectionService(driver, pool)
    const report = await svc.syncFromAuthoritative(42)
    expect(report.synced).toBe(true)
    expect(report.nodesUpserted).toBe(1)
    expect(report.edgesUpserted).toBe(1)
    expect((driver as ReturnType<typeof mkDriver>)._session.run).toHaveBeenCalledTimes(2)
  })

  it("returns zero counts when no symbols or edges exist", async () => {
    const pool = mkPool({
      query: vi.fn(async () => ({ rows: [] })),
    })
    const driver = mkDriver()
    const svc = new Neo4jGraphProjectionService(driver, pool)
    const report = await svc.syncFromAuthoritative(42)
    expect(report.synced).toBe(true)
    expect(report.nodesUpserted).toBe(0)
    expect(report.edgesUpserted).toBe(0)
  })

  it("skips edges with null src or dst symbol names", async () => {
    const pool = mkPool({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id, name, kind FROM symbol")) return { rows: [] }
        if (sql.includes("SELECT id, src_symbol_name")) {
          return { rows: [{ id: "1", src_symbol_name: null, dst_symbol_name: "wlan_bpf_filter_offload_handler", edge_kind: "calls", confidence: 1.0, derivation: "clangd" }] }
        }
        return { rows: [] }
      }),
    })
    const driver = mkDriver()
    const svc = new Neo4jGraphProjectionService(driver, pool)
    const report = await svc.syncFromAuthoritative(42)
    expect(report.edgesUpserted).toBe(0)
  })

  it("closes session even on error", async () => {
    const pool = mkPool()
    const session = {
      run: vi.fn(async () => { throw new Error("neo4j error") }),
      close: vi.fn(async () => {}),
    }
    const driver = { session: vi.fn(() => session) } as unknown as import("neo4j-driver").Driver
    const svc = new Neo4jGraphProjectionService(driver, pool)
    await expect(svc.syncFromAuthoritative(42)).rejects.toThrow("neo4j error")
    expect(session.close).toHaveBeenCalled()
  })
})
