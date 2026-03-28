/**
 * Intelligence backend factory — wires all concrete adapters into
 * OrchestratorRunnerDeps ready for executeOrchestratedQuery.
 */
import pg from "pg"
import neo4j from "neo4j-driver"
import { PostgresDbFoundation, createPool } from "./db/postgres/client.js"
import { PostgresSnapshotIngestWriter } from "./db/postgres/ingest-writer.js"
import { PostgresDbLookupService } from "./db/postgres/lookup-service.js"
import { PostgresAuthoritativeStore } from "./db/postgres/authoritative-store.js"
import { Neo4jGraphProjectionService } from "./db/neo4j/projection-service.js"
import { IndirectCallerIngestionService } from "./db/ingestion/indirect-caller-ingestion-service.js"
import type { OrchestratorRunnerDeps } from "./orchestrator-runner.js"
import type { IDbFoundation, ISnapshotIngestWriter } from "./contracts/db-foundation.js"
import type { IIndirectCallerIngestion } from "./contracts/indirect-caller-ingestion.js"

export interface BackendConfig {
  postgresUrl: string
  neo4jUrl: string
  neo4jUser: string
  neo4jPassword: string
}

export interface IntelligenceBackend {
  deps: OrchestratorRunnerDeps
  db: IDbFoundation
  ingestWriter: ISnapshotIngestWriter
  ingestion: IIndirectCallerIngestion
  close(): Promise<void>
}

export async function createIntelligenceBackend(
  cfg: BackendConfig,
  enrichers: Pick<OrchestratorRunnerDeps, "clangdEnricher" | "cParserEnricher" | "llmEnricher">,
): Promise<IntelligenceBackend> {
  const pool = createPool(cfg.postgresUrl)
  const driver = neo4j.driver(
    cfg.neo4jUrl,
    neo4j.auth.basic(cfg.neo4jUser, cfg.neo4jPassword),
  )

  const db = new PostgresDbFoundation(pool)
  const ingestWriter = new PostgresSnapshotIngestWriter(pool)
  const lookup = new PostgresDbLookupService(pool)
  const store = new PostgresAuthoritativeStore(pool)
  const projection = new Neo4jGraphProjectionService(driver, pool)
  const ingestion = new IndirectCallerIngestionService(pool)

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
    close: async () => {
      await pool.end()
      await driver.close()
    },
  }
}
