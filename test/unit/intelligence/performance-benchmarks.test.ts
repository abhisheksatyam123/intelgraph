/**
 * Performance benchmarks for intelligence backend lookup + sync paths.
 * Captures baseline latency and throughput with guard thresholds.
 */
import { describe, expect, it } from "vitest"
import { PostgresDbLookupService } from "../../../src/intelligence/db/postgres/lookup-service.js"
import { Neo4jGraphProjectionService } from "../../../src/intelligence/db/neo4j/projection-service.js"
import { vi } from "vitest"

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now()
  const result = await fn()
  return { result, ms: performance.now() - start }
}

// ---------------------------------------------------------------------------
// Mock pool with configurable latency
// ---------------------------------------------------------------------------

function mkFastPool(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn(async () => ({ rows })),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
  } as unknown as import("pg").Pool
}

function mkFastDriver() {
  const session = {
    run: vi.fn(async () => ({ records: [] })),
    close: vi.fn(async () => {}),
  }
  return { session: vi.fn(() => session) } as unknown as import("neo4j-driver").Driver
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("Performance benchmarks: DbLookup", () => {
  it("single lookup completes under 50ms", async () => {
    const pool = mkFastPool([{ caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const { ms } = await timed(() => svc.lookup({ intent: "who_calls_api", snapshotId: 1, apiName: "wlan_bpf_filter_offload_handler" }))
    expect(ms).toBeLessThan(50)
  })

  it("100 sequential lookups complete under 500ms", async () => {
    const pool = mkFastPool([{ caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const { ms } = await timed(async () => {
      for (let i = 0; i < 100; i++) {
        await svc.lookup({ intent: "who_calls_api", snapshotId: i + 1, apiName: "wlan_bpf_filter_offload_handler" })
      }
    })
    expect(ms).toBeLessThan(500)
  })

  it("all 18 intents complete under 200ms total", async () => {
    const pool = mkFastPool([])
    const svc = new PostgresDbLookupService(pool)
    const intents = [
      { intent: "who_calls_api" as const, apiName: "fn" },
      { intent: "who_calls_api_at_runtime" as const, apiName: "fn" },
      { intent: "why_api_invoked" as const, apiName: "fn" },
      { intent: "what_api_calls" as const, apiName: "fn" },
      { intent: "show_registration_chain" as const, apiName: "fn" },
      { intent: "show_dispatch_sites" as const, apiName: "fn" },
      { intent: "find_callback_registrars" as const, apiName: "fn" },
      { intent: "where_struct_initialized" as const, structName: "s" },
      { intent: "where_struct_modified" as const, structName: "s" },
      { intent: "find_struct_owners" as const, structName: "s" },
      { intent: "find_struct_readers" as const, structName: "s" },
      { intent: "find_struct_writers" as const, structName: "s" },
      { intent: "find_field_access_path" as const, fieldName: "f" },
      { intent: "find_api_by_log_pattern" as const, pattern: "bpf" },
      { intent: "show_runtime_flow_for_trace" as const, traceId: "t1" },
      { intent: "show_api_runtime_observations" as const, apiName: "fn" },
      { intent: "show_cross_module_path" as const, srcApi: "a", dstApi: "b" },
      { intent: "show_hot_call_paths" as const, apiName: "fn" },
    ]
    const { ms } = await timed(async () => {
      for (const req of intents) {
        await svc.lookup({ snapshotId: 1, ...req } as Parameters<typeof svc.lookup>[0])
      }
    })
    expect(ms).toBeLessThan(200)
  })
})

describe("Performance benchmarks: GraphProjectionSync", () => {
  it("sync with 10 symbols and 10 edges completes under 100ms", async () => {
    const symbols = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `fn_${i}`, kind: "function" }))
    const edges = Array.from({ length: 10 }, (_, i) => ({ id: String(i), src_symbol_name: `fn_${i}`, dst_symbol_name: `fn_${(i + 1) % 10}`, edge_kind: "calls", confidence: 1.0, derivation: "clangd" }))
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id, name, kind")) return { rows: symbols }
        if (sql.includes("SELECT id, src_symbol_name")) return { rows: edges }
        return { rows: [] }
      }),
    } as unknown as import("pg").Pool
    const driver = mkFastDriver()
    const svc = new Neo4jGraphProjectionService(driver, pool)
    const { ms } = await timed(() => svc.syncFromAuthoritative(1))
    expect(ms).toBeLessThan(100)
  })
})
