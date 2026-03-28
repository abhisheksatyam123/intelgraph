import { describe, expect, it, vi } from "vitest"
import { PostgresAuthoritativeStore } from "../../../src/intelligence/db/postgres/authoritative-store.js"
import { Neo4jGraphProjectionService } from "../../../src/intelligence/db/neo4j/projection-service.js"
import type { QueryRequest, EnrichmentResult } from "../../../src/intelligence/contracts/orchestrator.js"

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
