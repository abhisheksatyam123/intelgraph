import pg from "pg"
import type { DbLookupRepository } from "../../contracts/orchestrator.js"
import type { QueryRequest, LookupResult } from "../../contracts/orchestrator.js"

const { Pool } = pg

// ---------------------------------------------------------------------------
// Intent SQL planner — maps each QueryIntent to a Postgres query
// ---------------------------------------------------------------------------

type IntentQuery = { sql: string; params: unknown[] }

function planQuery(req: QueryRequest): IntentQuery | null {
  const sid = req.snapshotId

  switch (req.intent) {
    case "who_calls_api":
    case "who_calls_api_at_runtime":
      return {
        sql: `SELECT src_symbol_name AS caller, dst_symbol_name AS callee,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND dst_symbol_name = $2
                AND edge_kind IN ('calls','indirect_calls','registers_callback','dispatches_to')
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.apiName, req.limit ?? 100],
      }

    case "what_api_calls":
      return {
        sql: `SELECT src_symbol_name AS caller, dst_symbol_name AS callee,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND src_symbol_name = $2
                AND edge_kind IN ('calls','indirect_calls','registers_callback','dispatches_to')
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.apiName, req.limit ?? 100],
      }

    case "why_api_invoked":
    case "show_runtime_flow_for_trace":
      return {
        sql: `SELECT target_api, runtime_trigger, dispatch_chain,
                     immediate_invoker, dispatch_site, confidence
              FROM runtime_observation
              WHERE snapshot_id = $1
                AND (target_api = $2 OR ($3::text IS NOT NULL AND trace_id = $3))
              ORDER BY confidence DESC
              LIMIT $4`,
        params: [sid, req.apiName ?? null, req.traceId ?? null, req.limit ?? 50],
      }

    case "show_registration_chain":
    case "find_callback_registrars":
      return {
        sql: `SELECT src_symbol_name AS registrar, dst_symbol_name AS callback,
                     edge_kind, confidence, derivation, metadata
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND dst_symbol_name = $2
                AND edge_kind IN ('registers_callback','dispatches_to')
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.apiName, req.limit ?? 50],
      }

    case "show_dispatch_sites":
      return {
        sql: `SELECT src_symbol_name AS dispatcher, dst_symbol_name AS target,
                     edge_kind, confidence, derivation, metadata
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND src_symbol_name = $2
                AND edge_kind IN ('dispatches_to','indirect_calls')
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.apiName, req.limit ?? 50],
      }

    case "where_struct_initialized":
      return {
        sql: `SELECT src_symbol_name AS initializer, dst_symbol_name AS struct_name,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND dst_symbol_name = $2
                AND edge_kind = 'operates_on_struct'
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.structName, req.limit ?? 50],
      }

    case "where_struct_modified":
    case "find_struct_writers":
      return {
        sql: `SELECT src_symbol_name AS writer, dst_symbol_name AS target,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND dst_symbol_name = $2
                AND edge_kind = 'writes_field'
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.structName, req.limit ?? 50],
      }

    case "find_struct_owners":
      return {
        sql: `SELECT src_symbol_name AS owner, dst_symbol_name AS struct_name,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND dst_symbol_name = $2
                AND edge_kind IN ('operates_on_struct','writes_field')
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.structName, req.limit ?? 50],
      }

    case "find_struct_readers":
      return {
        sql: `SELECT src_symbol_name AS reader, dst_symbol_name AS target,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND dst_symbol_name = $2
                AND edge_kind = 'reads_field'
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.structName, req.limit ?? 50],
      }

    case "current_structure_runtime_writers_of_structure":
      return {
        sql: `SELECT COALESCE(srr.api_name, se.src_symbol_name) AS writer,
                     COALESCE(srr.target_structure_name, se.dst_symbol_name) AS target,
                     COALESCE(srr.edge_kind, se.edge_kind) AS edge_kind,
                     COALESCE(srr.confidence, se.confidence) AS confidence,
                     COALESCE(srr.derivation, se.derivation) AS derivation,
                     srr.runtime_structure_evidence
              FROM (
                SELECT api_name, target_structure_name, edge_kind, confidence, derivation, runtime_structure_evidence
                FROM structure_runtime_relation
                WHERE snapshot_id = $1 AND target_structure_name = $2 AND role = 'writer'
              ) srr
              FULL OUTER JOIN (
                SELECT src_symbol_name, dst_symbol_name, edge_kind, confidence, derivation
                FROM semantic_edge
                WHERE snapshot_id = $1 AND dst_symbol_name = $2 AND edge_kind = 'writes_field'
              ) se ON srr.api_name = se.src_symbol_name
              ORDER BY COALESCE(srr.confidence, se.confidence) DESC
              LIMIT $3`,
        params: [sid, req.structName, req.limit ?? 50],
      }

    case "current_structure_runtime_readers_of_structure":
      return {
        sql: `SELECT COALESCE(srr.api_name, se.src_symbol_name) AS reader,
                     COALESCE(srr.target_structure_name, se.dst_symbol_name) AS target,
                     COALESCE(srr.edge_kind, se.edge_kind) AS edge_kind,
                     COALESCE(srr.confidence, se.confidence) AS confidence,
                     COALESCE(srr.derivation, se.derivation) AS derivation,
                     srr.runtime_structure_evidence
              FROM (
                SELECT api_name, target_structure_name, edge_kind, confidence, derivation, runtime_structure_evidence
                FROM structure_runtime_relation
                WHERE snapshot_id = $1 AND target_structure_name = $2 AND role = 'reader'
              ) srr
              FULL OUTER JOIN (
                SELECT src_symbol_name, dst_symbol_name, edge_kind, confidence, derivation
                FROM semantic_edge
                WHERE snapshot_id = $1 AND dst_symbol_name = $2 AND edge_kind = 'reads_field'
              ) se ON srr.api_name = se.src_symbol_name
              ORDER BY COALESCE(srr.confidence, se.confidence) DESC
              LIMIT $3`,
        params: [sid, req.structName, req.limit ?? 50],
      }

    case "current_structure_runtime_initializers_of_structure":
      return {
        sql: `SELECT COALESCE(srr.api_name, se.src_symbol_name) AS initializer,
                     COALESCE(srr.target_structure_name, se.dst_symbol_name) AS target,
                     COALESCE(srr.edge_kind, se.edge_kind) AS edge_kind,
                     COALESCE(srr.confidence, se.confidence) AS confidence,
                     COALESCE(srr.derivation, se.derivation) AS derivation,
                     srr.runtime_structure_evidence
              FROM (
                SELECT api_name, target_structure_name, edge_kind, confidence, derivation, runtime_structure_evidence
                FROM structure_runtime_relation
                WHERE snapshot_id = $1 AND target_structure_name = $2 AND role = 'initializer'
              ) srr
              FULL OUTER JOIN (
                SELECT src_symbol_name, dst_symbol_name, edge_kind, confidence, derivation
                FROM semantic_edge
                WHERE snapshot_id = $1 AND dst_symbol_name = $2 AND edge_kind = 'operates_on_struct'
              ) se ON srr.api_name = se.src_symbol_name
              ORDER BY COALESCE(srr.confidence, se.confidence) DESC
              LIMIT $3`,
        params: [sid, req.structName, req.limit ?? 50],
      }

    case "current_structure_runtime_mutators_of_structure":
      return {
        sql: `SELECT COALESCE(srr.api_name, se.src_symbol_name) AS mutator,
                     COALESCE(srr.target_structure_name, se.dst_symbol_name) AS target,
                     COALESCE(srr.edge_kind, se.edge_kind) AS edge_kind,
                     COALESCE(srr.confidence, se.confidence) AS confidence,
                     COALESCE(srr.derivation, se.derivation) AS derivation,
                     srr.runtime_structure_evidence
              FROM (
                SELECT api_name, target_structure_name, edge_kind, confidence, derivation, runtime_structure_evidence
                FROM structure_runtime_relation
                WHERE snapshot_id = $1 AND target_structure_name = $2 AND role = 'mutator'
              ) srr
              FULL OUTER JOIN (
                SELECT src_symbol_name, dst_symbol_name, edge_kind, confidence, derivation
                FROM semantic_edge
                WHERE snapshot_id = $1 AND dst_symbol_name = $2 AND edge_kind = 'writes_field'
              ) se ON srr.api_name = se.src_symbol_name
              ORDER BY COALESCE(srr.confidence, se.confidence) DESC
              LIMIT $3`,
        params: [sid, req.structName, req.limit ?? 50],
      }

    case "find_field_access_path":
      return {
        sql: `SELECT src_symbol_name AS accessor, dst_symbol_name AS field,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND dst_symbol_name = $2
                AND edge_kind IN ('reads_field','writes_field')
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.fieldName, req.limit ?? 50],
      }

    case "find_api_by_log_pattern":
      return {
        sql: `SELECT s.name AS api_name, s.file_path, s.line, s.kind
              FROM symbol s
              WHERE s.snapshot_id = $1
                AND s.kind = 'function'
                AND s.name ILIKE $2
              LIMIT $3`,
        params: [sid, `%${req.pattern ?? ""}%`, req.limit ?? 50],
      }

    case "show_api_runtime_observations":
      return {
        sql: `SELECT target_api, runtime_trigger, dispatch_chain,
                     immediate_invoker, dispatch_site, confidence
              FROM runtime_observation
              WHERE snapshot_id = $1
                AND target_api = $2
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.apiName, req.limit ?? 50],
      }

    case "show_cross_module_path":
      return {
        sql: `SELECT src_symbol_name AS src, dst_symbol_name AS dst,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND src_symbol_name = $2
                AND dst_symbol_name = $3
              ORDER BY confidence DESC
              LIMIT $4`,
        params: [sid, req.srcApi, req.dstApi, req.limit ?? 50],
      }

    case "show_hot_call_paths":
      return {
        sql: `SELECT src_symbol_name AS caller, dst_symbol_name AS callee,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND src_symbol_name = $2
                AND edge_kind IN ('calls','indirect_calls')
              ORDER BY confidence DESC
              LIMIT $3`,
        params: [sid, req.apiName, req.limit ?? 50],
      }

    case "find_api_logs":
      return {
        sql: `SELECT api_name, level, template, subsystem, file_path, line, confidence
              FROM api_log
              WHERE snapshot_id = $1
                AND api_name = $2
              ORDER BY confidence DESC, line ASC
              LIMIT $3`,
        params: [sid, req.apiName, req.limit ?? 100],
      }

    case "find_api_logs_by_level":
      return {
        sql: `SELECT api_name, level, template, subsystem, file_path, line, confidence
              FROM api_log
              WHERE snapshot_id = $1
                AND api_name = $2
                AND level = $3
              ORDER BY confidence DESC, line ASC
              LIMIT $4`,
        params: [sid, req.apiName, (req as QueryRequest & { logLevel?: string }).logLevel ?? "INFO", req.limit ?? 100],
      }

    case "find_api_timer_triggers":
      return {
        sql: `SELECT api_name, timer_identifier_name, timer_trigger_condition_description,
                     timer_trigger_confidence_score, derivation
              FROM api_timer_trigger
              WHERE snapshot_id = $1
                AND api_name = $2
              ORDER BY timer_trigger_confidence_score DESC
              LIMIT $3`,
        params: [sid, req.apiName, req.limit ?? 50],
      }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// PostgresDbLookupService
// ---------------------------------------------------------------------------

export class PostgresDbLookupService implements DbLookupRepository {
  constructor(private pool: pg.Pool) {}

  async lookup(req: QueryRequest): Promise<LookupResult> {
    const planned = planQuery(req)
    if (!planned) {
      return { hit: false, intent: req.intent, snapshotId: req.snapshotId, rows: [] }
    }

    const res = await this.pool.query(planned.sql, planned.params)
    return {
      hit: res.rows.length > 0,
      intent: req.intent,
      snapshotId: req.snapshotId,
      rows: res.rows as Array<Record<string, unknown>>,
    }
  }
}
