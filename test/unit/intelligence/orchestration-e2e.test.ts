import { describe, expect, it, vi } from "vitest"
import { executeOrchestratedQuery } from "../../../src/intelligence/orchestrator-runner.js"
import { PostgresDbLookupService } from "../../../src/intelligence/db/postgres/lookup-service.js"
import { PostgresAuthoritativeStore } from "../../../src/intelligence/db/postgres/authoritative-store.js"
import { Neo4jGraphProjectionService } from "../../../src/intelligence/db/neo4j/projection-service.js"
import type { OrchestratorRunnerDeps } from "../../../src/intelligence/orchestrator-runner.js"
import type { EnrichmentResult } from "../../../src/intelligence/contracts/orchestrator.js"

// ---------------------------------------------------------------------------
// Mock pool and driver factories
// ---------------------------------------------------------------------------

function mkPool(hitRows: Record<string, unknown>[] = []) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return {
    query: vi.fn(async () => ({ rows: hitRows })),
    connect: vi.fn(async () => client),
  } as unknown as import("pg").Pool
}

function mkDriver() {
  const session = {
    run: vi.fn(async () => ({ records: [] })),
    close: vi.fn(async () => {}),
  }
  return { session: vi.fn(() => session) } as unknown as import("neo4j-driver").Driver
}

function mkEnrichers(clangdRows: Record<string, unknown>[] = [], cparserRows: Record<string, unknown>[] = []) {
  return {
    clangdEnricher: {
      source: "clangd" as const,
      enrich: vi.fn(async (): Promise<EnrichmentResult> => ({
        attempts: [{ source: "clangd", status: clangdRows.length > 0 ? "success" : "failed" }],
        persistedRows: clangdRows.length,
      })),
    },
    cParserEnricher: {
      source: "c_parser" as const,
      enrich: vi.fn(async (): Promise<EnrichmentResult> => ({
        attempts: [{ source: "c_parser", status: cparserRows.length > 0 ? "success" : "failed" }],
        persistedRows: cparserRows.length,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E orchestration with concrete services", () => {
  it("DB hit path: returns immediately without enrichment", async () => {
    const hitRow = { caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" }
    const pool = mkPool([hitRow])
    const driver = mkDriver()
    const { clangdEnricher, cParserEnricher } = mkEnrichers()

    const deps: OrchestratorRunnerDeps = {
      persistence: {
        dbLookup: new PostgresDbLookupService(pool),
        authoritativeStore: new PostgresAuthoritativeStore(pool),
        graphProjection: new Neo4jGraphProjectionService(driver, pool),
      },
      clangdEnricher,
      cParserEnricher,
    }

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("hit")
    expect(res.provenance.path).toBe("db_hit")
    expect(res.provenance.llmUsed).toBe(false)
    expect(clangdEnricher.enrich).not.toHaveBeenCalled()
    expect(cParserEnricher.enrich).not.toHaveBeenCalled()
  })

  it("DB miss -> clangd enrichment -> retry -> hit path", async () => {
    let callCount = 0
    const pool = {
      query: vi.fn(async () => {
        callCount++
        // First lookup: miss. After enrichment: hit.
        if (callCount <= 1) return { rows: [] }
        return { rows: [{ caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" }] }
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string) => {
          if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
          return { rows: [] }
        }),
        release: vi.fn(),
      })),
    } as unknown as import("pg").Pool

    const driver = mkDriver()
    const { clangdEnricher, cParserEnricher } = mkEnrichers([{ caller: "wlan_bpf_enable_data_path" }])

    const deps: OrchestratorRunnerDeps = {
      persistence: {
        dbLookup: new PostgresDbLookupService(pool),
        authoritativeStore: new PostgresAuthoritativeStore(pool),
        graphProjection: new Neo4jGraphProjectionService(driver, pool),
      },
      clangdEnricher,
      cParserEnricher,
    }

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("enriched")
    expect(res.provenance.path).toBe("db_miss_deterministic")
    expect(clangdEnricher.enrich).toHaveBeenCalledTimes(1)
  })

  it("DB miss -> all deterministic fail -> LLM last resort -> hit", async () => {
    let callCount = 0
    const pool = {
      query: vi.fn(async () => {
        callCount++
        if (callCount <= 3) return { rows: [] }
        return { rows: [{ caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 0.7, derivation: "llm" }] }
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string) => {
          if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
          return { rows: [] }
        }),
        release: vi.fn(),
      })),
    } as unknown as import("pg").Pool

    const driver = mkDriver()
    const { clangdEnricher, cParserEnricher } = mkEnrichers()
    const llmEnricher = {
      source: "llm" as const,
      canRun: vi.fn(() => true),
      enrich: vi.fn(async (): Promise<EnrichmentResult> => ({
        attempts: [{ source: "llm", status: "success" }],
        persistedRows: 1,
      })),
    }

    const deps: OrchestratorRunnerDeps = {
      persistence: {
        dbLookup: new PostgresDbLookupService(pool),
        authoritativeStore: new PostgresAuthoritativeStore(pool),
        graphProjection: new Neo4jGraphProjectionService(driver, pool),
      },
      clangdEnricher,
      cParserEnricher,
      llmEnricher,
    }

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("llm_fallback")
    expect(res.provenance.path).toBe("db_miss_llm_last_resort")
    expect(res.provenance.llmUsed).toBe(true)
    expect(llmEnricher.enrich).toHaveBeenCalledTimes(1)
  })

  it("all enrichers fail -> not_found", async () => {
    const pool = mkPool([])
    const driver = mkDriver()
    const { clangdEnricher, cParserEnricher } = mkEnrichers()
    const llmEnricher = {
      source: "llm" as const,
      canRun: vi.fn(() => true),
      enrich: vi.fn(async (): Promise<EnrichmentResult> => ({
        attempts: [{ source: "llm", status: "failed" }],
        persistedRows: 0,
      })),
    }

    const deps: OrchestratorRunnerDeps = {
      persistence: {
        dbLookup: new PostgresDbLookupService(pool),
        authoritativeStore: new PostgresAuthoritativeStore(pool),
        graphProjection: new Neo4jGraphProjectionService(driver, pool),
      },
      clangdEnricher,
      cParserEnricher,
      llmEnricher,
    }

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("not_found")
  })

  it("invalid request returns error status", async () => {
    const pool = mkPool([])
    const driver = mkDriver()
    const { clangdEnricher, cParserEnricher } = mkEnrichers()

    const deps: OrchestratorRunnerDeps = {
      persistence: {
        dbLookup: new PostgresDbLookupService(pool),
        authoritativeStore: new PostgresAuthoritativeStore(pool),
        graphProjection: new Neo4jGraphProjectionService(driver, pool),
      },
      clangdEnricher,
      cParserEnricher,
    }

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: -1, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("error")
    expect(res.errors).toBeDefined()
  })

  it("WLAN-grounded: who_calls_api for wlan_bpf_filter_offload_handler returns registrar", async () => {
    const pool = mkPool([
      { caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" },
      { caller: "wlan_bpf_offload_test_route_uc_active", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 0.9, derivation: "clangd" },
    ])
    const driver = mkDriver()
    const { clangdEnricher, cParserEnricher } = mkEnrichers()

    const deps: OrchestratorRunnerDeps = {
      persistence: {
        dbLookup: new PostgresDbLookupService(pool),
        authoritativeStore: new PostgresAuthoritativeStore(pool),
        graphProjection: new Neo4jGraphProjectionService(driver, pool),
      },
      clangdEnricher,
      cParserEnricher,
    }

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("hit")
    expect(res.data.nodes).toHaveLength(2)
    const callers = res.data.nodes.map((n) => n.caller)
    expect(callers).toContain("wlan_bpf_enable_data_path")
    expect(callers).toContain("wlan_bpf_offload_test_route_uc_active")
  })

  it("WLAN-grounded: why_api_invoked returns runtime trigger for bpf handler", async () => {
    const pool = mkPool([
      {
        target_api: "wlan_bpf_filter_offload_handler",
        runtime_trigger: "Incoming RX data packet from hardware matched BPF filter criteria",
        dispatch_chain: JSON.stringify(["offloadif_data_ind", "_offldmgr_protocol_data_handler", "_offldmgr_enhanced_data_handler"]),
        immediate_invoker: "_offldmgr_enhanced_data_handler",
        confidence: 1.0,
      },
    ])
    const driver = mkDriver()
    const { clangdEnricher, cParserEnricher } = mkEnrichers()

    const deps: OrchestratorRunnerDeps = {
      persistence: {
        dbLookup: new PostgresDbLookupService(pool),
        authoritativeStore: new PostgresAuthoritativeStore(pool),
        graphProjection: new Neo4jGraphProjectionService(driver, pool),
      },
      clangdEnricher,
      cParserEnricher,
    }

    const res = await executeOrchestratedQuery(
      { intent: "why_api_invoked", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("hit")
    expect(res.data.nodes[0]!.runtime_trigger).toContain("RX data packet")
  })
})
