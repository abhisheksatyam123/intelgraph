import pg from "pg"
import type { IIndirectCallerIngestion } from "../../contracts/indirect-caller-ingestion.js"
import type {
  RuntimeCallerInput,
  RuntimeCallerBatch,
  LinkReport,
} from "../../contracts/indirect-caller-ingestion.js"
import type { IngestReport, RuntimeCallerRow } from "../../contracts/common.js"
import { PostgresSnapshotIngestWriter } from "../postgres/ingest-writer.js"

const { Pool } = pg

export class IndirectCallerIngestionService implements IIndirectCallerIngestion {
  constructor(private pool: pg.Pool) {}

  async parseRuntimeCallers(input: RuntimeCallerInput): Promise<RuntimeCallerBatch> {
    // If records are provided directly (e.g. from wlan-targets.ts ground truth), use them
    if (input.records && input.records.length > 0) {
      return { rows: input.records }
    }

    // Otherwise return empty — real parsing from artifacts is a future extension
    return { rows: [] }
  }

  async linkToSymbols(snapshotId: number, batch: RuntimeCallerBatch): Promise<LinkReport> {
    if (batch.rows.length === 0) {
      return { linked: [], unresolved: [], warnings: [] }
    }

    // Look up each targetApi in the symbol table to verify it exists in this snapshot
    const linked: RuntimeCallerRow[] = []
    const unresolved: RuntimeCallerRow[] = []
    const warnings: string[] = []

    for (const row of batch.rows) {
      const res = await this.pool.query<{ name: string }>(
        `SELECT name FROM symbol WHERE snapshot_id = $1 AND name = $2 LIMIT 1`,
        [snapshotId, row.targetApi],
      )
      if (res.rows.length > 0) {
        linked.push(row)
      } else {
        unresolved.push(row)
        warnings.push(`symbol not found in snapshot ${snapshotId}: ${row.targetApi}`)
      }
    }

    return { linked, unresolved, warnings }
  }

  async persistRuntimeChains(snapshotId: number, linked: LinkReport): Promise<IngestReport> {
    const writer = new PostgresSnapshotIngestWriter(this.pool)
    const report = await writer.writeSnapshotBatch(snapshotId, {
      runtimeCallers: linked.linked,
    })

    if (linked.warnings.length > 0) {
      report.warnings.push(...linked.warnings)
    }

    return report
  }
}
