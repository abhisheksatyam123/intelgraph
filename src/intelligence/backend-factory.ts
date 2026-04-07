/**
 * Intelligence backend factory — wires all concrete adapters into
 * OrchestratorRunnerDeps ready for executeOrchestratedQuery.
 */
import neo4j from "neo4j-driver"
import { Neo4jGraphProjectionService } from "./db/neo4j/projection-service.js"
import { Neo4jDbFoundation } from "./db/neo4j/foundation.js"
import { Neo4jGraphStore } from "./db/neo4j/graph-store.js"
import type { GraphWriteSink } from "./db/neo4j/node-contracts.js"
import { IndirectCallerIngestionService } from "./db/ingestion/indirect-caller-ingestion-service.js"
import type { IExtractionAdapter } from "./contracts/extraction-adapter.js"
import { ClangdExtractionAdapter } from "./db/extraction/clangd-extraction-adapter.js"
import type { OrchestratorRunnerDeps } from "./orchestrator-runner.js"
import type { IDbFoundation, ISnapshotIngestWriter } from "./contracts/db-foundation.js"
import type { IIndirectCallerIngestion } from "./contracts/indirect-caller-ingestion.js"
import type { AggregateFieldRow, EdgeRow, IngestReport, SymbolRow, TypeRow } from "./contracts/common.js"
import type { EnrichmentResult, QueryRequest } from "./contracts/orchestrator.js"
import { Neo4jDbLookup } from "./db/neo4j/db-lookup.js"

export interface BackendConfig {
  neo4jUrl: string
  neo4jUser: string
  neo4jPassword: string
}

export interface LspClientForExtraction {
  documentSymbol: (filePath: string) => Promise<any[]>
  incomingCalls: (filePath: string, line: number, char: number) => Promise<any[]>
  outgoingCalls: (filePath: string, line: number, char: number) => Promise<any[]>
}

export interface IntelligenceBackend {
  deps: OrchestratorRunnerDeps
  db: IDbFoundation
  ingestWriter: ISnapshotIngestWriter
  ingestion: IIndirectCallerIngestion
  extractor: IExtractionAdapter
  /** Sink the ingest pipeline writes facts through (Neo4jGraphStore in prod). */
  sink: GraphWriteSink
  close(): Promise<void>
}

class SnapshotIngestWriter implements ISnapshotIngestWriter {
  constructor(private extractor: IExtractionAdapter) {}

  async writeSnapshotBatch(snapshotId: number, batch: {
    symbols?: unknown[]
    types?: unknown[]
    fields?: unknown[]
    edges?: unknown[]
    runtimeCallers?: unknown[]
  }): Promise<IngestReport> {
    const report = await this.extractor.materializeSnapshot(snapshotId, {
      symbolBatch: { symbols: (batch.symbols ?? []) as SymbolRow[] },
      typeBatch: { types: (batch.types ?? []) as TypeRow[], fields: (batch.fields ?? []) as AggregateFieldRow[] },
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
  async persistEnrichment(_request: QueryRequest, result: EnrichmentResult): Promise<number> {
    return result.persistedRows
  }
}

export async function createIntelligenceBackend(
  cfg: BackendConfig,
  enrichers: Pick<OrchestratorRunnerDeps, "clangdEnricher" | "cParserEnricher" | "llmEnricher">,
  lspClient?: LspClientForExtraction,
): Promise<IntelligenceBackend> {
  const driver = neo4j.driver(
    cfg.neo4jUrl,
    neo4j.auth.basic(cfg.neo4jUser, cfg.neo4jPassword),
  )

  const db = new Neo4jDbFoundation(driver)
  const store4j = new Neo4jGraphStore(driver)
  const extractor = new ClangdExtractionAdapter(
    lspClient ?? {
      documentSymbol: async () => [],
      incomingCalls: async () => [],
      outgoingCalls: async () => [],
    },
    store4j,
  )
  const ingestWriter = new SnapshotIngestWriter(extractor)
  const lookup = new Neo4jDbLookup(driver)
  const store = new NoopAuthoritativeStore()
  const projection = new Neo4jGraphProjectionService(driver)
  const ingestion = new IndirectCallerIngestionService(store4j, store4j)

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
    db,
    ingestWriter,
    ingestion,
    extractor,
    sink: store4j,
    close: async () => {
      await driver.close()
    },
  }
}

export async function createNeo4jIntelligenceBackend(
  cfg: BackendConfig,
  enrichers: Pick<OrchestratorRunnerDeps, "clangdEnricher" | "cParserEnricher" | "llmEnricher">,
  lspClient?: LspClientForExtraction,
): Promise<IntelligenceBackend> {
  return createIntelligenceBackend(cfg, enrichers, lspClient)
}
