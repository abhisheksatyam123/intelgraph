import pg from "pg"
import type { ISnapshotIngestWriter } from "../../contracts/db-foundation.js"
import type { IngestReport } from "../../contracts/common.js"
import type {
  SymbolRow,
  TypeRow,
  AggregateFieldRow,
  EdgeRow,
  RuntimeCallerRow,
  LogRow,
  TimerTriggerRow,
} from "../../contracts/common.js"
import { RuntimeInvocationType } from "../../contracts/orchestrator.js"

/**
 * Maps an edge_kind string to a RuntimeInvocationType enum value string.
 * Returns the string value suitable for storage in metadata JSONB.
 */
export function classifyAndStoreInvocationType(edgeKind: string): string {
  switch (edgeKind) {
    case "calls": return RuntimeInvocationType.RUNTIME_DIRECT_CALL
    case "registers_callback": return RuntimeInvocationType.RUNTIME_CALLBACK_REGISTRATION_CALL
    case "indirect_calls": return RuntimeInvocationType.RUNTIME_FUNCTION_POINTER_CALL
    case "dispatches_to": return RuntimeInvocationType.RUNTIME_DISPATCH_TABLE_CALL
    default: return RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH
  }
}

const { Pool } = pg

export class PostgresSnapshotIngestWriter implements ISnapshotIngestWriter {
  constructor(private pool: pg.Pool) {}

  async writeSnapshotBatch(
    snapshotId: number,
    batch: {
      symbols?: unknown[]
      types?: unknown[]
      fields?: unknown[]
      edges?: unknown[]
      runtimeCallers?: unknown[]
      logs?: unknown[]
      timerTriggers?: unknown[]
    },
  ): Promise<IngestReport> {
    const report: IngestReport = {
      snapshotId,
      inserted: { symbols: 0, types: 0, fields: 0, edges: 0, runtimeCallers: 0, logs: 0, timerTriggers: 0 },
      warnings: [],
    }

    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")

      for (const raw of batch.symbols ?? []) {
        const s = raw as SymbolRow
        await client.query(
          `INSERT INTO symbol (snapshot_id, kind, name, qualified_name, signature, linkage, file_path, line, col, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT DO NOTHING`,
          [snapshotId, s.kind, s.name, s.qualifiedName ?? null, s.signature ?? null,
           s.linkage ?? null, s.location?.filePath ?? null, s.location?.line ?? null,
           s.location?.column ?? null, s.metadata ?? null],
        )
        report.inserted.symbols++
      }

      for (const raw of batch.types ?? []) {
        const t = raw as TypeRow
        await client.query(
          `INSERT INTO c_type (snapshot_id, kind, spelling, size_bits, align_bits, symbol_name)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [snapshotId, t.kind, t.spelling, t.sizeBits ?? null, t.alignBits ?? null, t.symbolName ?? null],
        )
        report.inserted.types++
      }

      for (const raw of batch.fields ?? []) {
        const f = raw as AggregateFieldRow
        await client.query(
          `INSERT INTO aggregate_field (snapshot_id, aggregate_symbol_name, name, ordinal, type_spelling, bit_offset, bit_width, is_bitfield)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT DO NOTHING`,
          [snapshotId, f.aggregateSymbolName, f.name, f.ordinal, f.typeSpelling,
           f.bitOffset ?? null, f.bitWidth ?? null, f.isBitfield ?? false],
        )
        report.inserted.fields++
      }

      for (const raw of batch.edges ?? []) {
        const e = raw as EdgeRow
        let evidenceId: number | null = null
        if (e.evidence) {
          const ev = await client.query<{ id: string }>(
            `INSERT INTO evidence (snapshot_id, source_kind, file_path, line, col, raw)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [snapshotId, e.evidence.sourceKind, e.evidence.location?.filePath ?? null,
             e.evidence.location?.line ?? null, e.evidence.location?.column ?? null,
             e.evidence.raw ?? null],
          )
          evidenceId = Number(ev.rows[0]!.id)
        }
        const invocationType = classifyAndStoreInvocationType(e.edgeKind)
        const metadata: Record<string, unknown> = {
          ...(e.metadata ?? {}),
          invocation_type_classification: invocationType,
          ...(e.accessPath !== undefined ? { access_path: e.accessPath } : {}),
          ...(e.sourceLocation !== undefined ? { source_location: e.sourceLocation } : {}),
        }
        await client.query(
          `INSERT INTO semantic_edge (snapshot_id, edge_kind, src_symbol_name, dst_symbol_name, confidence, derivation, evidence_id, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT DO NOTHING`,
          [snapshotId, e.edgeKind, e.srcSymbolName ?? null, e.dstSymbolName ?? null,
           e.confidence, e.derivation, evidenceId, JSON.stringify(metadata)],
        )
        report.inserted.edges++
      }

      for (const raw of batch.runtimeCallers ?? []) {
        const r = raw as RuntimeCallerRow
        await client.query(
          `INSERT INTO runtime_observation (snapshot_id, target_api, runtime_trigger, dispatch_chain, immediate_invoker, dispatch_site, confidence, evidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [snapshotId, r.targetApi, r.runtimeTrigger, JSON.stringify(r.dispatchChain),
           r.immediateInvoker, r.dispatchSite ? JSON.stringify(r.dispatchSite) : null,
           r.confidence, r.evidence ? JSON.stringify(r.evidence) : null],
        )
        report.inserted.runtimeCallers++
      }

      for (const raw of batch.logs ?? []) {
        const l = raw as LogRow
        await client.query(
          `INSERT INTO api_log (snapshot_id, api_name, level, template, subsystem, file_path, line, confidence, evidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [snapshotId, l.apiName, l.level, l.template, l.subsystem ?? null,
           l.location?.filePath ?? null, l.location?.line ?? null,
           l.confidence, l.evidence ? JSON.stringify(l.evidence) : null],
        )
        report.inserted.logs++
      }

      for (const raw of batch.timerTriggers ?? []) {
        const t = raw as TimerTriggerRow
        await client.query(
          `INSERT INTO api_timer_trigger (snapshot_id, api_name, timer_identifier_name, timer_trigger_condition_description, timer_trigger_confidence_score, derivation, evidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [snapshotId, t.apiName, t.timerIdentifierName,
           t.timerTriggerConditionDescription ?? null,
           t.timerTriggerConfidenceScore, t.derivation,
           t.evidence ? JSON.stringify(t.evidence) : null],
        )
        report.inserted.timerTriggers++
      }

      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK")
      report.warnings.push(`batch write failed: ${String(err)}`)
    } finally {
      client.release()
    }

    return report
  }
}
