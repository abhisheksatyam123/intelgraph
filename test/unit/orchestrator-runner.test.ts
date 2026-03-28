import { describe, expect, it, vi } from "vitest"
import { executeOrchestratedQuery } from "../../src/intelligence/orchestrator-runner.js"
import { DEFAULT_FALLBACK_POLICY, type EnrichmentResult } from "../../src/intelligence/contracts/orchestrator.js"

function mkDeterministicSuccess(source: "clangd" | "c_parser"): EnrichmentResult {
  return {
    attempts: [{ source, status: "success" }],
    persistedRows: 3,
  }
}

describe("orchestrator runner", () => {
  it("returns DB hit without enrichment", async () => {
    const dbLookup = vi
      .fn()
      .mockResolvedValue({ hit: true, intent: "who_calls_api", snapshotId: 1, rows: [{ nodes: [], edges: [] }] })
    const persist = vi.fn().mockResolvedValue(0)
    const sync = vi.fn().mockResolvedValue({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })
    const clangd = { source: "clangd" as const, enrich: vi.fn() }
    const cparser = { source: "c_parser" as const, enrich: vi.fn() }

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 1, apiName: "wlan_api" },
      {
        persistence: {
          dbLookup: { lookup: dbLookup },
          authoritativeStore: { persistEnrichment: persist },
          graphProjection: { syncFromAuthoritative: sync },
        },
        clangdEnricher: clangd,
        cParserEnricher: cparser,
      },
    )

    expect(res.status).toBe("hit")
    expect(clangd.enrich).not.toHaveBeenCalled()
    expect(cparser.enrich).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it("runs deterministic enrichment on miss then retries lookup", async () => {
    const dbLookup = vi
      .fn()
      .mockResolvedValueOnce({ hit: false, intent: "who_calls_api", snapshotId: 7, rows: [] })
      .mockResolvedValueOnce({ hit: false, intent: "who_calls_api", snapshotId: 7, rows: [] })
      .mockResolvedValueOnce({ hit: true, intent: "who_calls_api", snapshotId: 7, rows: [{ nodes: [], edges: [] }] })

    const clangd = {
      source: "clangd" as const,
      enrich: vi.fn().mockResolvedValue({ attempts: [{ source: "clangd", status: "failed" }], persistedRows: 0 }),
    }
    const cparser = {
      source: "c_parser" as const,
      enrich: vi.fn().mockResolvedValue(mkDeterministicSuccess("c_parser")),
    }
    const persist = vi.fn().mockResolvedValue(3)
    const sync = vi.fn().mockResolvedValue({ synced: true, nodesUpserted: 3, edgesUpserted: 2 })

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 7, apiName: "wlan_api" },
      {
        persistence: {
          dbLookup: { lookup: dbLookup },
          authoritativeStore: { persistEnrichment: persist },
          graphProjection: { syncFromAuthoritative: sync },
        },
        clangdEnricher: clangd,
        cParserEnricher: cparser,
      },
    )

    expect(clangd.enrich).toHaveBeenCalledTimes(1)
    expect(cparser.enrich).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(dbLookup).toHaveBeenCalledTimes(3)
    expect(res.status).toBe("enriched")
    expect(res.provenance.llmUsed).toBe(false)
  })

  it("uses llm only after deterministic failures", async () => {
    const dbLookup = vi
      .fn()
      .mockResolvedValueOnce({ hit: false, intent: "who_calls_api", snapshotId: 9, rows: [] })
      .mockResolvedValueOnce({ hit: false, intent: "who_calls_api", snapshotId: 9, rows: [] })
      .mockResolvedValueOnce({ hit: false, intent: "who_calls_api", snapshotId: 9, rows: [] })
      .mockResolvedValueOnce({ hit: true, intent: "who_calls_api", snapshotId: 9, rows: [{ nodes: [], edges: [] }] })

    const clangd = {
      source: "clangd" as const,
      enrich: vi.fn().mockResolvedValue({ attempts: [{ source: "clangd", status: "failed" }], persistedRows: 0 }),
    }
    const cparser = {
      source: "c_parser" as const,
      enrich: vi.fn().mockResolvedValue({ attempts: [{ source: "c_parser", status: "failed" }], persistedRows: 0 }),
    }
    const llm = {
      source: "llm" as const,
      canRun: vi.fn().mockReturnValue(true),
      enrich: vi.fn().mockResolvedValue({ attempts: [{ source: "llm", status: "success" }], persistedRows: 1 }),
    }
    const persist = vi.fn().mockResolvedValue(1)
    const sync = vi.fn().mockResolvedValue({ synced: true, nodesUpserted: 1, edgesUpserted: 0 })

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 9, apiName: "wlan_api" },
      {
        persistence: {
          dbLookup: { lookup: dbLookup },
          authoritativeStore: { persistEnrichment: persist },
          graphProjection: { syncFromAuthoritative: sync },
        },
        clangdEnricher: clangd,
        cParserEnricher: cparser,
        llmEnricher: llm,
        policy: DEFAULT_FALLBACK_POLICY,
      },
    )

    expect(clangd.enrich).toHaveBeenCalledTimes(1)
    expect(cparser.enrich).toHaveBeenCalledTimes(1)
    expect(llm.canRun).toHaveBeenCalledTimes(1)
    expect(llm.enrich).toHaveBeenCalledTimes(1)
    expect(res.status).toBe("llm_fallback")
    expect(res.provenance.llmUsed).toBe(true)
  })

  it("returns not_found when all enrichers exhausted", async () => {
    const dbLookup = vi.fn().mockResolvedValue({ hit: false, intent: "who_calls_api", snapshotId: 11, rows: [] })
    const clangd = {
      source: "clangd" as const,
      enrich: vi.fn().mockResolvedValue({ attempts: [{ source: "clangd", status: "failed" }], persistedRows: 0 }),
    }
    const cparser = {
      source: "c_parser" as const,
      enrich: vi.fn().mockResolvedValue({ attempts: [{ source: "c_parser", status: "failed" }], persistedRows: 0 }),
    }
    const llm = {
      source: "llm" as const,
      canRun: vi.fn().mockReturnValue(true),
      enrich: vi.fn().mockResolvedValue({ attempts: [{ source: "llm", status: "failed" }], persistedRows: 0 }),
    }
    const persist = vi.fn().mockResolvedValue(0)
    const sync = vi.fn().mockResolvedValue({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api", snapshotId: 11, apiName: "wlan_api" },
      {
        persistence: {
          dbLookup: { lookup: dbLookup },
          authoritativeStore: { persistEnrichment: persist },
          graphProjection: { syncFromAuthoritative: sync },
        },
        clangdEnricher: clangd,
        cParserEnricher: cparser,
        llmEnricher: llm,
      },
    )

    expect(res.status).toBe("not_found")
    expect(res.provenance.llmUsed).toBe(false)
  })
})
