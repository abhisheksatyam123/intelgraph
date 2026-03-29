import { describe, expect, it, vi } from "vitest"
import { TOOLS, setIntelligenceDeps } from "../../../src/tools/index.js"
import type { OrchestratorRunnerDeps } from "../../../src/intelligence/orchestrator-runner.js"
import type { EnrichmentResult } from "../../../src/intelligence/contracts/orchestrator.js"

// ---------------------------------------------------------------------------
// Find the intelligence_query tool
// ---------------------------------------------------------------------------

const tool = TOOLS.find((t) => t.name === "intelligence_query")!

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function mkDeps(rows: Record<string, unknown>[] = []): OrchestratorRunnerDeps {
  return {
    persistence: {
      dbLookup: { lookup: vi.fn(async () => ({ hit: rows.length > 0, intent: "who_calls_api", snapshotId: 1, rows })) },
      authoritativeStore: { persistEnrichment: vi.fn(async () => 0) },
      graphProjection: { syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })) },
    },
    clangdEnricher: { source: "clangd" as const, enrich: vi.fn(async (): Promise<EnrichmentResult> => ({ attempts: [{ source: "clangd", status: "failed" }], persistedRows: 0 })) },
    cParserEnricher: { source: "c_parser" as const, enrich: vi.fn(async (): Promise<EnrichmentResult> => ({ attempts: [{ source: "c_parser", status: "failed" }], persistedRows: 0 })) },
  }
}

const mockClient = {} as Parameters<typeof tool.execute>[1]
const mockTracker = {} as Parameters<typeof tool.execute>[2]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intelligence_query MCP tool", () => {
  it("tool is registered in TOOLS array", () => {
    expect(tool).toBeDefined()
    expect(tool.name).toBe("intelligence_query")
    expect(tool.description).toContain("intelligence backend")
  })

  it("returns not-initialized message when deps not set", async () => {
    setIntelligenceDeps(null as never)
    const res = await tool.execute({ intent: "who_calls_api", snapshotId: 1, apiName: "fn" }, mockClient, mockTracker)
    expect(res).toContain("not initialized")
  })

  it("returns validation error for invalid request", async () => {
    setIntelligenceDeps(mkDeps())
    const res = await tool.execute({ intent: "who_calls_api", snapshotId: -1, apiName: "fn" }, mockClient, mockTracker)
    expect(res).toContain("invalid request")
  })

  it("returns formatted hit response with nodes", async () => {
    setIntelligenceDeps(mkDeps([
      { caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" },
    ]))
    const res = await tool.execute({ intent: "who_calls_api", snapshotId: 1, apiName: "wlan_bpf_filter_offload_handler" }, mockClient, mockTracker)
    const parsed = JSON.parse(res)
    expect(parsed.intent).toBe("who_calls_api")
    expect(parsed.status).toBe("hit")
    expect(parsed.provenance.path).toBe("db_hit")
    expect(JSON.stringify(parsed)).toContain("wlan_bpf_enable_data_path")
  })

  it("returns no-results message when no rows and enrichers fail", async () => {
    setIntelligenceDeps(mkDeps([]))
    const res = await tool.execute({ intent: "who_calls_api", snapshotId: 1, apiName: "unknown_fn" }, mockClient, mockTracker)
    // orchestrator exhausts enrichers and returns error or not_found
    expect(res).toMatch(/not_found|error|No results/)
  })

  it("input schema includes all 25 intents (20 original + 4 structure-centric runtime intents + find_api_timer_triggers)", () => {
    const schema = tool.inputSchema as import("zod").ZodObject<Record<string, import("zod").ZodTypeAny>>
    const intentField = schema.shape.intent as import("zod").ZodEnum<[string, ...string[]]>
    expect(intentField._def.values).toHaveLength(25)
    expect(intentField._def.values).toContain("find_api_logs")
    expect(intentField._def.values).toContain("find_api_logs_by_level")
    expect(intentField._def.values).toContain("current_structure_runtime_writers_of_structure")
    expect(intentField._def.values).toContain("current_structure_runtime_readers_of_structure")
    expect(intentField._def.values).toContain("current_structure_runtime_initializers_of_structure")
    expect(intentField._def.values).toContain("current_structure_runtime_mutators_of_structure")
    expect(intentField._def.values).toContain("find_api_timer_triggers")
  })

  it("input schema has all optional params", () => {
    const schema = tool.inputSchema as import("zod").ZodObject<Record<string, import("zod").ZodTypeAny>>
    const keys = Object.keys(schema.shape)
    expect(keys).toContain("apiName")
    expect(keys).toContain("structName")
    expect(keys).toContain("fieldName")
    expect(keys).toContain("traceId")
    expect(keys).toContain("pattern")
    expect(keys).toContain("srcApi")
    expect(keys).toContain("dstApi")
    expect(keys).toContain("depth")
    expect(keys).toContain("limit")
  })

  it("WLAN-grounded: who_calls_api for bpf handler returns registrar in output", async () => {
    setIntelligenceDeps(mkDeps([
      { caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" },
      { caller: "wlan_bpf_offload_test_route_uc_active", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 0.9, derivation: "clangd" },
    ]))
    const res = await tool.execute({ intent: "who_calls_api", snapshotId: 1, apiName: "wlan_bpf_filter_offload_handler" }, mockClient, mockTracker)
    expect(res).toContain("wlan_bpf_enable_data_path")
    expect(res).toContain("wlan_bpf_offload_test_route_uc_active")
    const parsed = JSON.parse(res)
    expect(parsed.data.nodes).toHaveLength(2)
  })
})
