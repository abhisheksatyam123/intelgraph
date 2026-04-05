import { vi } from "vitest"
import { TOOLS } from "../../../src/tools/index.js"
import type { IDbFoundation } from "../../../src/intelligence/contracts/db-foundation.js"
import type { IExtractionAdapter } from "../../../src/intelligence/contracts/extraction-adapter.js"
import type {
  EnrichmentResult,
  GraphProjectionRepository,
} from "../../../src/intelligence/contracts/orchestrator.js"
import type { EdgeRow, IngestReport } from "../../../src/intelligence/contracts/common.js"
import type { OrchestratorRunnerDeps } from "../../../src/intelligence/orchestrator-runner.js"
import type { ToolDef } from "../../../src/core/types.js"

export function tool(name: string): ToolDef {
  const row = TOOLS.find((it) => it.name === name)
  if (!row) throw new Error(`Tool not found: ${name}`)
  return row
}

export function ctx(t: ToolDef) {
  return {
    client: {} as Parameters<typeof t.execute>[1],
    tracker: {} as Parameters<typeof t.execute>[2],
  }
}

export function db(overrides: Partial<IDbFoundation> = {}): IDbFoundation {
  return {
    initSchema: vi.fn(async () => {}),
    runMigrations: vi.fn(async () => {}),
    beginSnapshot: vi.fn(async () => ({ snapshotId: 42, status: "building" as const, createdAt: "2026-01-01T00:00:00Z" })),
    commitSnapshot: vi.fn(async () => {}),
    failSnapshot: vi.fn(async () => {}),
    getLatestReadySnapshot: vi.fn(async () => null),
    withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => []) })),
    ...overrides,
  }
}

export function extractor(counts = { symbols: 5, types: 2, edges: 8 }): IExtractionAdapter {
  const edges: EdgeRow[] = Array.from({ length: counts.edges }, (_, i) => ({
    edgeKind: "calls" as const,
    srcSymbolName: `fn_${i}`,
    dstSymbolName: `callee_${i}`,
    confidence: 1.0,
    derivation: "clangd" as const,
  }))
  const report: IngestReport = {
    snapshotId: 42,
    inserted: { symbols: counts.symbols, types: counts.types, fields: 0, edges: counts.edges, runtimeCallers: 0, logs: 0, timerTriggers: 0 },
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

export function projection(): GraphProjectionRepository {
  return {
    syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 5, edgesUpserted: 8 })),
  }
}

export function deps(rows: Record<string, unknown>[] = []): OrchestratorRunnerDeps {
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
