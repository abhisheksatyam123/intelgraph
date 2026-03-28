import pg from "pg"
import type { AuthoritativeSnapshotRepository } from "../../contracts/orchestrator.js"
import type { QueryRequest, EnrichmentResult } from "../../contracts/orchestrator.js"
import { PostgresSnapshotIngestWriter } from "./ingest-writer.js"
import type { EdgeRow, RuntimeCallerRow } from "../../contracts/common.js"

const { Pool } = pg

export class PostgresAuthoritativeStore implements AuthoritativeSnapshotRepository {
  private writer: PostgresSnapshotIngestWriter

  constructor(private pool: pg.Pool) {
    this.writer = new PostgresSnapshotIngestWriter(pool)
  }

  async persistEnrichment(req: QueryRequest, result: EnrichmentResult): Promise<number> {
    // Extract edges and runtime callers from enrichment result metadata if present
    const meta = result as EnrichmentResult & {
      edges?: EdgeRow[]
      runtimeCallers?: RuntimeCallerRow[]
    }

    const report = await this.writer.writeSnapshotBatch(req.snapshotId, {
      edges: meta.edges ?? [],
      runtimeCallers: meta.runtimeCallers ?? [],
    })

    return report.inserted.edges + report.inserted.runtimeCallers
  }
}
