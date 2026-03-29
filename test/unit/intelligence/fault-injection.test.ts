/**
 * fault-injection.test.ts
 * Fault-injection tests for intelligence backend tools.
 * Pattern: fail-before (DB/enricher throws) → pass-after (deterministic error returned).
 *
 * Three scenarios:
 *   1. intelligence_snapshot: DB throws during operation → tool propagates error (no internal catch)
 *   2. intelligence_ingest: partial failure rollback — materializeSnapshot throws → snapshot marked failed
 *   3. intelligence_query: malformed input → deterministic validation error (no throw)
 *
 * Robustness gap documented: intelligence_snapshot has no try/catch around DB calls.
 * intelligence_ingest has try/catch only around extraction phase, not beginSnapshot.
 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import { TOOLS, setDbFoundation, setIngestDeps, setIntelligenceDeps } from "../../../src/tools/index.js"
import type { IDbFoundation } from "../../../src/intelligence/contracts/db-foundation.js"
import type { IExtractionAdapter } from "../../../src/intelligence/contracts/extraction-adapter.js"
import type { GraphProjectionRepository, EnrichmentResult } from "../../../src/intelligence/contracts/orchestrator.js"
import type { OrchestratorRunnerDeps } from "../../../src/intelligence/orchestrator-runner.js"
import type { EdgeRow, IngestReport } from "../../../src/intelligence/contracts/common.js"

// ---------------------------------------------------------------------------
// Tool handles
// ---------------------------------------------------------------------------

const snapshotTool = TOOLS.find((t) => t.name === "intelligence_snapshot")!
const ingestTool = TOOLS.find((t) => t.name === "intelligence_ingest")!
const queryTool = TOOLS.find((t) => t.name === "intelligence_query")!

const mockClient = {} as Parameters<typeof snapshotTool.execute>[1]
const mockTracker = {} as Parameters<typeof snapshotTool.execute>[2]

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
    getSnapshot: vi.fn(async (id: number) => ({ snapshotId: id, status: "ready" as const, createdAt: "2026-01-01T00:00:00Z" })),
    withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => []) })),
    ...overrides,
  }
}

function mkExtractor(counts = { symbols: 5, types: 2, edges: 8 }): IExtractionAdapter {
  const edges: EdgeRow[] = Array.from({ length: counts.edges }, (_, i) => ({
    edgeKind: "calls" as const,
    srcSymbolName: `fn_${i}`,
    dstSymbolName: `callee_${i}`,
    confidence: 1.0,
    derivation: "clangd" as const,
  }))
  const report: IngestReport = {
    snapshotId: 42,
    inserted: { symbols: counts.symbols, types: counts.types, fields: 0, edges: counts.edges, runtimeCallers: 0, logs: 0 },
    warnings: [],
  }
  return {
    extractSymbols: vi.fn(async () => ({
      symbols: Array.from({ length: counts.symbols }, (_, i) => ({ kind: "function" as const, name: `fn_${i}` })),
    })),
    extractTypes: vi.fn(async () => ({
      types: Array.from({ length: counts.types }, (_, i) => ({ kind: "struct" as const, spelling: `struct_${i}` })),
      fields: [],
    })),
    extractEdges: vi.fn(async () => ({ edges })),
    materializeSnapshot: vi.fn(async () => report),
  }
}

function mkProjection(): GraphProjectionRepository {
  return {
    syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 5, edgesUpserted: 8 })),
  }
}

function mkQueryDeps(rows: Record<string, unknown>[] = []): OrchestratorRunnerDeps {
  return {
    persistence: {
      dbLookup: {
        lookup: vi.fn(async () => ({
          hit: rows.length > 0,
          intent: "who_calls_api" as const,
          snapshotId: 1,
          rows,
        })),
      },
      authoritativeStore: { persistEnrichment: vi.fn(async () => 0) },
      graphProjection: { syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })) },
    },
    clangdEnricher: {
      source: "clangd" as const,
      enrich: vi.fn(async (): Promise<EnrichmentResult> => ({ attempts: [{ source: "clangd", status: "failed" }], persistedRows: 0 })),
    },
    cParserEnricher: {
      source: "c_parser" as const,
      enrich: vi.fn(async (): Promise<EnrichmentResult> => ({ attempts: [{ source: "c_parser", status: "failed" }], persistedRows: 0 })),
    },
  }
}

// ---------------------------------------------------------------------------
// Fault-injection tests
// ---------------------------------------------------------------------------

describe("Fault-injection: intelligence backend tools", () => {
  beforeEach(() => {
    setDbFoundation(null as never)
    setIngestDeps(null as never)
    setIntelligenceDeps(null as never)
  })

  // ── Test 1: intelligence_snapshot — DB not initialized ─────────────────────
  // The snapshot tool has no try/catch around DB calls. The "not initialized"
  // guard is the primary deterministic error path. DB throws propagate.
  describe("intelligence_snapshot: deterministic error paths", () => {
    it("FAIL-BEFORE: DB not initialized → returns deterministic 'not initialized' message", async () => {
      // No setDbFoundation call — DB is null
      const res = await snapshotTool.execute(
        { action: "begin", workspaceRoot: "/wlan", compileDbHash: "abc123" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("not initialized")
      // Must not throw — this is the deterministic guard path
    })

    it("PASS-AFTER: DB initialized → begin returns snapshotId and status", async () => {
      const healthyDb = mkDb()
      setDbFoundation(healthyDb)

      const res = await snapshotTool.execute(
        { action: "begin", workspaceRoot: "/wlan", compileDbHash: "abc123" },
        mockClient,
        mockTracker,
      )

      expect(res).toContain("snapshotId:  42")
      expect(res).toContain("status:      building")
      expect(healthyDb.beginSnapshot).toHaveBeenCalledOnce()
    })

    it("FAIL-BEFORE: begin with missing workspaceRoot → returns deterministic validation error", async () => {
      setDbFoundation(mkDb())

      const res = await snapshotTool.execute(
        { action: "begin" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("workspaceRoot and compileDbHash are required")
    })

    it("FAIL-BEFORE: commit with missing snapshotId → returns deterministic validation error", async () => {
      setDbFoundation(mkDb())

      const res = await snapshotTool.execute(
        { action: "commit" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("snapshotId is required")
    })

    it("PASS-AFTER: commit with valid snapshotId → returns committed message", async () => {
      const healthyDb = mkDb()
      setDbFoundation(healthyDb)

      const res = await snapshotTool.execute(
        { action: "commit", snapshotId: 42 },
        mockClient,
        mockTracker,
      )

      expect(res).toContain("42")
      expect(res).toContain("committed")
      expect(healthyDb.commitSnapshot).toHaveBeenCalledWith(42)
    })

    it("FAIL-BEFORE: DB throws during beginSnapshot → error propagates (no internal catch — robustness gap)", async () => {
      // Document: snapshot tool now has try/catch around DB calls.
      // DB errors are caught and returned as deterministic error strings.
      const faultyDb = mkDb({
        beginSnapshot: vi.fn(async () => {
          throw new Error("ECONNREFUSED: PostgreSQL connection refused on port 5432")
        }),
      })
      setDbFoundation(faultyDb)

      // The tool returns a deterministic error string (does NOT throw)
      const res = await snapshotTool.execute(
        { action: "begin", workspaceRoot: "/wlan", compileDbHash: "abc123" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("ECONNREFUSED")
      expect(faultyDb.beginSnapshot).toHaveBeenCalledOnce()
    })
  })

  // ── Test 2: intelligence_ingest — partial failure rollback ─────────────────
  // The ingest tool has try/catch around the extraction phase (after beginSnapshot).
  // If beginSnapshot throws, it propagates. If extraction/materialize throws,
  // the snapshot is marked failed and a deterministic error string is returned.
  describe("intelligence_ingest: partial failure rollback", () => {
    it("FAIL-BEFORE: deps not initialized → returns deterministic 'not initialized' message", async () => {
      // No setIngestDeps call
      const res = await ingestTool.execute(
        { workspaceRoot: "/wlan" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("not initialized")
    })

    it("FAIL-BEFORE: materializeSnapshot throws → snapshot marked failed, no commit, no projection sync", async () => {
      // Inject fault: materialize fails with FK constraint violation
      const db = mkDb()
      const extractor = mkExtractor()
      extractor.materializeSnapshot = vi.fn(async () => {
        throw new Error("FK constraint violation: symbol_id not found in symbols table")
      })
      const projection = mkProjection()
      setIngestDeps({ db, extractor, projection })

      const res = await ingestTool.execute(
        { workspaceRoot: "/wlan" },
        mockClient,
        mockTracker,
      )

      // Must return deterministic error string, not throw
      expect(typeof res).toBe("string")
      expect(res).toContain("failed")
      expect(res).toContain("FK constraint violation")
      // Snapshot must be marked failed, not committed
      expect(db.failSnapshot).toHaveBeenCalledWith(42, expect.stringContaining("FK constraint violation"))
      expect(db.commitSnapshot).not.toHaveBeenCalled()
      // Projection sync must NOT have been called after failure
      expect(projection.syncFromAuthoritative).not.toHaveBeenCalled()
    })

    it("PASS-AFTER: materializeSnapshot succeeds → snapshot committed and projection synced", async () => {
      const db = mkDb()
      const extractor = mkExtractor()
      const projection = mkProjection()
      setIngestDeps({ db, extractor, projection })

      const res = await ingestTool.execute(
        { workspaceRoot: "/wlan" },
        mockClient,
        mockTracker,
      )

      expect(res).toContain("Snapshot committed: id=42 status=ready")
      expect(res).toContain("Projection synced")
      expect(db.failSnapshot).not.toHaveBeenCalled()
    })

    it("FAIL-BEFORE: extractSymbols throws → snapshot marked failed, no commit", async () => {
      const db = mkDb()
      const extractor = mkExtractor()
      extractor.extractSymbols = vi.fn(async () => {
        throw new Error("clangd LSP timeout: documentSymbol request timed out after 30s")
      })
      const projection = mkProjection()
      setIngestDeps({ db, extractor, projection })

      const res = await ingestTool.execute(
        { workspaceRoot: "/wlan" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("failed")
      expect(res).toContain("clangd LSP timeout")
      expect(db.failSnapshot).toHaveBeenCalledWith(42, expect.stringContaining("clangd LSP timeout"))
      expect(db.commitSnapshot).not.toHaveBeenCalled()
    })

    it("PASS-AFTER: all extraction succeeds → full pipeline completes with correct output", async () => {
      const db = mkDb()
      const extractor = mkExtractor({ symbols: 1200, types: 80, edges: 3400 })
      const projection = mkProjection()
      setIngestDeps({ db, extractor, projection })

      const res = await ingestTool.execute({
        workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
        compileDbHash: "wlan01880hash",
        parserVersion: "1.0.0",
        fileLimit: 500,
      }, mockClient, mockTracker)

      expect(res).toContain("Snapshot started: id=42")
      expect(res).toContain("symbols=1200")
      expect(res).toContain("edges=3400")
      expect(res).toContain("Snapshot committed")
      expect(db.failSnapshot).not.toHaveBeenCalled()
    })
  })

  // ── Test 3: intelligence_query — malformed input returns deterministic error ─
  // The query tool validates input before calling the orchestrator.
  // Invalid requests return deterministic error strings without throwing.
  describe("intelligence_query: malformed input returns deterministic error", () => {
    it("FAIL-BEFORE: deps not initialized → returns deterministic 'not initialized' message", async () => {
      // No setIntelligenceDeps call
      const res = await queryTool.execute(
        { intent: "who_calls_api", snapshotId: 1, apiName: "fn" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("not initialized")
    })

    it("FAIL-BEFORE: negative snapshotId → returns deterministic validation error (no throw)", async () => {
      setIntelligenceDeps(mkQueryDeps())

      const res = await queryTool.execute(
        { intent: "who_calls_api", snapshotId: -1, apiName: "fn" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("invalid request")
    })

    it("FAIL-BEFORE: zero snapshotId → returns deterministic validation error (no throw)", async () => {
      setIntelligenceDeps(mkQueryDeps())

      const res = await queryTool.execute(
        { intent: "who_calls_api", snapshotId: 0, apiName: "fn" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("invalid request")
    })

    it("FAIL-BEFORE: missing required apiName for who_calls_api → returns deterministic validation error", async () => {
      setIntelligenceDeps(mkQueryDeps())

      // who_calls_api requires apiName — omitting it should fail validation
      const res = await queryTool.execute(
        { intent: "who_calls_api", snapshotId: 1 },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("invalid request")
      expect(res).toContain("apiName")
    })

    it("FAIL-BEFORE: missing required structName for where_struct_initialized → returns deterministic validation error", async () => {
      setIntelligenceDeps(mkQueryDeps())

      const res = await queryTool.execute(
        { intent: "where_struct_initialized", snapshotId: 1 },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      expect(res).toContain("invalid request")
      expect(res).toContain("structName")
    })

    it("PASS-AFTER: valid request with DB hit → returns formatted result (no throw)", async () => {
      setIntelligenceDeps(mkQueryDeps([
        { caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" },
      ]))

      const res = await queryTool.execute(
        { intent: "who_calls_api", snapshotId: 1, apiName: "wlan_bpf_filter_offload_handler" },
        mockClient,
        mockTracker,
      )

      const parsed = JSON.parse(res)
      expect(parsed.intent).toBe("who_calls_api")
      expect(parsed.status).toBe("hit")
      expect(JSON.stringify(parsed)).toContain("wlan_bpf_enable_data_path")
    })

    it("PASS-AFTER: valid request with no DB results → returns not_found or no-results (no throw)", async () => {
      setIntelligenceDeps(mkQueryDeps([]))

      const res = await queryTool.execute(
        { intent: "who_calls_api", snapshotId: 1, apiName: "unknown_fn" },
        mockClient,
        mockTracker,
      )

      expect(typeof res).toBe("string")
      // Orchestrator exhausts enrichers and returns not_found or error
      expect(res).toMatch(/not_found|error|No results/)
    })
  })
})
