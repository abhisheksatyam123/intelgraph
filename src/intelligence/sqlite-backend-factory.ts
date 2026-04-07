/**
 * sqlite-backend-factory.ts — wires up an IntelligenceBackend backed by
 * SQLite (via Drizzle + better-sqlite3) instead of Neo4j.
 *
 * This is the Phase 5 piece of the Neo4j → SQLite migration. It
 * parallels backend-factory.ts but returns an IntelligenceBackend whose
 * db, sink, and lookup all talk to a local .clangd-mcp/intelligence.db
 * file (or :memory: in tests).
 *
 * Both factories coexist during the migration. init.ts picks one or
 * the other based on config. Phase 7 removes the Neo4j factory.
 */

import type { IntelligenceBackend } from "./backend-factory.js"
import type { BackendConfig as Neo4jBackendConfig, LspClientForExtraction } from "./backend-factory.js"
import type { OrchestratorRunnerDeps } from "./orchestrator-runner.js"
import type { IExtractionAdapter } from "./contracts/extraction-adapter.js"
import { ClangdExtractionAdapter } from "./db/extraction/clangd-extraction-adapter.js"
import { openSqlite, type SqliteClient } from "./db/sqlite/client.js"
import { SqliteDbFoundation } from "./db/sqlite/foundation.js"
import { SqliteGraphStore } from "./db/sqlite/graph-store.js"
import { SqliteDbLookup } from "./db/sqlite/db-lookup.js"
import { SqliteGraphProjectionService } from "./db/sqlite/projection-service.js"
import { IndirectCallerIngestionService } from "./db/ingestion/indirect-caller-ingestion-service.js"
import type { IIndirectCallerIngestion } from "./contracts/indirect-caller-ingestion.js"
import type { IDbFoundation, ISnapshotIngestWriter } from "./contracts/db-foundation.js"
import type {
  AggregateFieldRow,
  EdgeRow,
  IngestReport,
  SymbolRow,
  TypeRow,
} from "./contracts/common.js"
import type { EnrichmentResult, QueryRequest } from "./contracts/orchestrator.js"

export interface SqliteBackendConfig {
  /**
   * Path to the sqlite database file, or ":memory:" for tests.
   * Defaults to ".clangd-mcp/intelligence.db" relative to cwd when
   * constructed via init.ts; callers may pass an absolute path.
   */
  dbPath: string
}

// Re-export the legacy Neo4j config alias for back-compat with
// existing call sites that imported it from here.
export type { Neo4jBackendConfig }

/**
 * Same shape as SnapshotIngestWriter in backend-factory.ts — used by
 * IndirectCallerIngestionService's persistRuntimeChains path. The
 * writer delegates to an IExtractionAdapter, which in our case is
 * still ClangdExtractionAdapter. This will move to its own Phase-2
 * plugin eventually but is unchanged for the migration.
 */
class SnapshotIngestWriter implements ISnapshotIngestWriter {
  constructor(private extractor: IExtractionAdapter) {}

  async writeSnapshotBatch(
    snapshotId: number,
    batch: {
      symbols?: unknown[]
      types?: unknown[]
      fields?: unknown[]
      edges?: unknown[]
      runtimeCallers?: unknown[]
    },
  ): Promise<IngestReport> {
    const report = await this.extractor.materializeSnapshot(snapshotId, {
      symbolBatch: { symbols: (batch.symbols ?? []) as SymbolRow[] },
      typeBatch: {
        types: (batch.types ?? []) as TypeRow[],
        fields: (batch.fields ?? []) as AggregateFieldRow[],
      },
      edgeBatch: { edges: (batch.edges ?? []) as EdgeRow[] },
    })
    return {
      snapshotId,
      inserted: report.inserted,
      warnings: report.warnings,
    }
  }
}

class NoopAuthoritativeStore {
  async persistEnrichment(
    _request: QueryRequest,
    result: EnrichmentResult,
  ): Promise<number> {
    return result.persistedRows
  }
}

/**
 * Extended IntelligenceBackend shape that carries the SqliteClient
 * handle so init.ts can close it on shutdown.
 */
export interface SqliteIntelligenceBackend extends IntelligenceBackend {
  readonly sqliteClient: SqliteClient
}

export async function createSqliteIntelligenceBackend(
  cfg: SqliteBackendConfig,
  enrichers: Pick<
    OrchestratorRunnerDeps,
    "clangdEnricher" | "cParserEnricher" | "llmEnricher"
  >,
  lspClient?: LspClientForExtraction,
): Promise<SqliteIntelligenceBackend> {
  const sqliteClient = openSqlite({ path: cfg.dbPath })
  const db = new SqliteDbFoundation(sqliteClient.db, sqliteClient.raw)
  await db.initSchema()

  const sink = new SqliteGraphStore(sqliteClient.db)
  const lookup = new SqliteDbLookup(sqliteClient.db, sqliteClient.raw)
  const projection = new SqliteGraphProjectionService()

  // ClangdExtractionAdapter still used by SnapshotIngestWriter for
  // the indirect-caller batch persistence path. Its own ingest output
  // goes nowhere in the new pipeline — the FactBus-backed ExtractorRunner
  // is what feeds the snapshot. Kept here to satisfy the shim.
  const extractor: IExtractionAdapter = new ClangdExtractionAdapter(
    lspClient ?? {
      documentSymbol: async () => [],
      incomingCalls: async () => [],
      outgoingCalls: async () => [],
    },
    sink,
  )
  const ingestWriter = new SnapshotIngestWriter(extractor)

  // The indirect-caller ingestion service needs a SymbolFinder (hasSymbol)
  // and a GraphWriteSink. SqliteGraphStore implements both, same as
  // Neo4jGraphStore.
  const ingestion = new IndirectCallerIngestionService(sink, sink)

  const store = new NoopAuthoritativeStore()

  const deps: OrchestratorRunnerDeps = {
    persistence: {
      dbLookup: lookup,
      authoritativeStore: store,
      graphProjection: projection,
    },
    ...enrichers,
  }

  return {
    deps,
    db: db as IDbFoundation,
    ingestWriter,
    ingestion: ingestion as IIndirectCallerIngestion,
    extractor,
    sink,
    sqliteClient,
    close: async () => {
      sqliteClient.close()
    },
  }
}
