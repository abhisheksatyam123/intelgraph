import { describe, expect, it, vi, beforeEach } from "vitest"
import { TOOLS, setIngestDeps } from "../../../src/tools/index.js"
import type { IDbFoundation } from "../../../src/intelligence/contracts/db-foundation.js"
import type { IExtractionAdapter } from "../../../src/intelligence/contracts/extraction-adapter.js"
import type { GraphProjectionRepository } from "../../../src/intelligence/contracts/orchestrator.js"

// ---------------------------------------------------------------------------
// Find the intelligence_ingest tool
// ---------------------------------------------------------------------------

const tool = TOOLS.find((t) => t.name === "intelligence_ingest")!

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function mkDb(overrides: Partial<IDbFoundation> = {}): IDbFoundation {
  return {
    initSchema: vi.fn(async () => {}),
    runMigrations: vi.fn(async () => {}),
    beginSnapshot: vi.fn(async () => ({ snapshotId: 42, status: "building" as const, createdAt: "2026-01-01T00:00:00Z" })),
    commitSnapshot: vi.fn(async () => {}),
    failSnapshot: vi.fn(async () => {}),
    withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => []) })),
    ...overrides,
  }
}

function mkExtractor(counts = { symbols: 5, types: 2, edges: 8 }): IExtractionAdapter {
  return {
    extractSymbols: vi.fn(async () => ({
      symbols: Array.from({ length: counts.symbols }, (_, i) => ({ kind: "function" as const, name: `fn_${i}` })),
    })),
    extractTypes: vi.fn(async () => ({
      types: Array.from({ length: counts.types }, (_, i) => ({ kind: "struct" as const, spelling: `struct_${i}` })),
      fields: [],
    })),
    extractEdges: vi.fn(async () => ({
      edges: Array.from({ length: counts.edges }, (_, i) => ({
        edgeKind: "calls" as const,
        srcSymbolName: `fn_${i}`,
        dstSymbolName: `callee_${i}`,
        confidence: 1.0,
        derivation: "clangd",
      })),
    })),
    materializeSnapshot: vi.fn(async (snapshotId) => ({
      snapshotId,
      inserted: { symbols: counts.symbols, types: counts.types, fields: 0, edges: counts.edges, runtimeCallers: 0 },
      warnings: [],
    })),
  }
}

function mkProjection(): GraphProjectionRepository {
  return {
    syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 5, edgesUpserted: 8 })),
  }
}

const mockClient = {} as Parameters<typeof tool.execute>[1]
const mockTracker = {} as Parameters<typeof tool.execute>[2]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intelligence_ingest MCP tool", () => {
  beforeEach(() => setIngestDeps(null as never))

  it("tool is registered in TOOLS array", () => {
    expect(tool).toBeDefined()
    expect(tool.name).toBe("intelligence_ingest")
    expect(tool.description).toContain("extraction")
  })

  it("returns not-initialized message when deps not set", async () => {
    const res = await tool.execute({ workspaceRoot: "/wlan" }, mockClient, mockTracker)
    expect(res).toContain("not initialized")
  })

  it("full happy path: begin → extract → materialize → commit → sync", async () => {
    const db = mkDb()
    const extractor = mkExtractor()
    const projection = mkProjection()
    setIngestDeps({ db, extractor, projection })

    const res = await tool.execute({
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      compileDbHash: "abc123",
    }, mockClient, mockTracker)

    expect(res).toContain("Snapshot started: id=42")
    expect(res).toContain("Extracted: symbols=5 types=2 edges=8")
    expect(res).toContain("Persisted: symbols=5 types=2 edges=8")
    expect(res).toContain("Snapshot committed: id=42 status=ready")
    expect(res).toContain("Projection synced: nodes=5 edges=8")
    expect(res).toContain("Done in")
    expect(db.commitSnapshot).toHaveBeenCalledWith(42)
  })

  it("skips projection sync when syncProjection=false", async () => {
    const db = mkDb()
    const extractor = mkExtractor()
    const projection = mkProjection()
    setIngestDeps({ db, extractor, projection })

    const res = await tool.execute({
      workspaceRoot: "/wlan",
      syncProjection: false,
    }, mockClient, mockTracker)

    expect(res).not.toContain("Projection synced")
    expect(projection.syncFromAuthoritative).not.toHaveBeenCalled()
  })

  it("marks snapshot failed and returns error message when extraction throws", async () => {
    const db = mkDb()
    const extractor = mkExtractor()
    extractor.extractSymbols = vi.fn(async () => { throw new Error("clangd crashed") })
    const projection = mkProjection()
    setIngestDeps({ db, extractor, projection })

    const res = await tool.execute({ workspaceRoot: "/wlan" }, mockClient, mockTracker)

    expect(res).toContain("failed")
    expect(res).toContain("clangd crashed")
    expect(db.failSnapshot).toHaveBeenCalledWith(42, expect.stringContaining("clangd crashed"))
    expect(db.commitSnapshot).not.toHaveBeenCalled()
  })

  it("includes warnings in output when materialize produces them", async () => {
    const db = mkDb()
    const extractor = mkExtractor()
    extractor.materializeSnapshot = vi.fn(async (snapshotId) => ({
      snapshotId,
      inserted: { symbols: 3, types: 1, fields: 0, edges: 2, runtimeCallers: 0 },
      warnings: ["FK violation on edge 5", "duplicate symbol fn_x"],
    }))
    const projection = mkProjection()
    setIngestDeps({ db, extractor, projection })

    const res = await tool.execute({ workspaceRoot: "/wlan" }, mockClient, mockTracker)

    expect(res).toContain("Warnings (2)")
    expect(res).toContain("FK violation")
  })

  it("WLAN-grounded: ingest for 01880.3 workspace root produces correct output", async () => {
    const db = mkDb()
    const extractor = mkExtractor({ symbols: 1200, types: 80, edges: 3400 })
    const projection = mkProjection()
    setIngestDeps({ db, extractor, projection })

    const res = await tool.execute({
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      compileDbHash: "wlan01880hash",
      parserVersion: "1.0.0",
      fileLimit: 500,
    }, mockClient, mockTracker)

    expect(res).toContain("Snapshot started: id=42")
    expect(res).toContain("symbols=1200")
    expect(res).toContain("edges=3400")
    expect(res).toContain("Snapshot committed")
    expect(db.beginSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      compileDbHash: "wlan01880hash",
    }))
  })
})
