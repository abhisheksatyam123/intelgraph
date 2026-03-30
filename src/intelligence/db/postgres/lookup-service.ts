import pg from "pg"
import type { DbLookupRepository } from "../../contracts/orchestrator.js"
import type { QueryRequest, LookupResult } from "../../contracts/orchestrator.js"

const { Pool } = pg

// ---------------------------------------------------------------------------
// Symbol canonicalization — strip leading underscores and ___SUFFIX variants
// ---------------------------------------------------------------------------

/**
 * Canonicalize a C symbol name:
 *   _foo, __foo, foo___RAM, _foo___RAM  →  foo
 * Applied to ALL symbol names returned from the DB so callers/callees are
 * always shown in their canonical form regardless of how they were ingested.
 */
export function canonicalizeSymbolName(name: string): string {
  const trimmed = (name ?? "").trim()
  if (!trimmed) return trimmed
  let canonical = trimmed
  canonical = canonical.replace(/^_+/, "")
  canonical = canonical.replace(/___[A-Za-z0-9_]+$/, "")
  return canonical || trimmed
}

/**
 * Build all alias variants of a symbol name for DB lookup.
 * Returns canonical name first, then variants.
 */
export function buildSymbolAliases(name: string): string[] {
  const canonical = canonicalizeSymbolName(name)
  const variants = new Set<string>([canonical])
  variants.add(`_${canonical}`)
  variants.add(`__${canonical}`)
  variants.add(`${canonical}___RAM`)
  variants.add(`_${canonical}___RAM`)
  if (name !== canonical) variants.add(name)
  return [...variants]
}

/**
 * Canonicalize all symbol-name fields in a result row.
 * Covers the common column names used across all intents.
 * Also canonicalizes string arrays (e.g. dispatch_chain).
 */
function canonicalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const SYMBOL_COLS = [
    "caller", "callee", "writer", "reader", "owner", "initializer", "mutator",
    "registrar", "callback", "dispatcher", "target", "src", "dst",
    "api_name", "src_symbol_name", "dst_symbol_name",
    "immediate_invoker", "target_api",
  ]
  // Array columns that contain lists of symbol names
  const SYMBOL_ARRAY_COLS = [
    "dispatch_chain",
    "runtime_execution_path_from_entrypoint_to_target_api",
  ]
  const out: Record<string, unknown> = { ...row }
  for (const col of SYMBOL_COLS) {
    if (typeof out[col] === "string") {
      out[col] = canonicalizeSymbolName(out[col] as string)
    }
  }
  for (const col of SYMBOL_ARRAY_COLS) {
    if (Array.isArray(out[col])) {
      out[col] = (out[col] as unknown[]).map((v) =>
        typeof v === "string" ? canonicalizeSymbolName(v) : v,
      )
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Helper: build the apiName match clause using aliases when available
// ---------------------------------------------------------------------------

/**
 * Build a SQL fragment and params for matching a symbol name column against
 * all alias variants.
 *
 * When aliases are provided:
 *   col = ANY($N::text[])   with params [..., aliases]
 * When only a single name:
 *   col = $N               with params [..., name]
 *
 * Returns { clause, param, nextIdx } where:
 *   clause  — the SQL fragment (e.g. "dst_symbol_name = ANY($2::text[])")
 *   param   — the value to append to params array
 *   nextIdx — the next $N index after this param
 */
function aliasClause(
  col: string,
  name: string | undefined,
  aliases: string[] | undefined,
  idx: number,
): { clause: string; param: unknown; nextIdx: number } {
  const effectiveAliases = aliases && aliases.length > 0 ? aliases : (name ? [name] : [])
  if (effectiveAliases.length > 1) {
    return {
      clause: `${col} = ANY($${idx}::text[])`,
      param: effectiveAliases,
      nextIdx: idx + 1,
    }
  }
  return {
    clause: `${col} = $${idx}`,
    param: name ?? null,
    nextIdx: idx + 1,
  }
}

// ---------------------------------------------------------------------------
// Intent SQL planner — maps each QueryIntent to a Postgres query
// ---------------------------------------------------------------------------

type IntentQuery = { sql: string; params: unknown[] }

function planQuery(req: QueryRequest): IntentQuery | null {
  const sid = req.snapshotId

  switch (req.intent) {
    case "who_calls_api":
    case "who_calls_api_at_runtime": {
      const { clause, param, nextIdx } = aliasClause("dst_symbol_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT src_symbol_name AS caller, dst_symbol_name AS callee,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND ${clause}
                AND edge_kind IN ('calls','indirect_calls','registers_callback','dispatches_to')
              ORDER BY confidence DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 100],
      }
    }

    case "what_api_calls": {
      const { clause, param, nextIdx } = aliasClause("src_symbol_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT src_symbol_name AS caller, dst_symbol_name AS callee,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND ${clause}
                AND edge_kind IN ('calls','indirect_calls','registers_callback','dispatches_to')
              ORDER BY confidence DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 100],
      }
    }

    case "why_api_invoked":
    case "show_runtime_flow_for_trace": {
      const { clause, param, nextIdx } = aliasClause("target_api", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT target_api, runtime_trigger, dispatch_chain,
                     immediate_invoker, dispatch_site, confidence
              FROM runtime_observation
              WHERE snapshot_id = $1
                AND (${clause} OR ($${nextIdx}::text IS NOT NULL AND trace_id = $${nextIdx}))
              ORDER BY confidence DESC
              LIMIT $${nextIdx + 1}`,
        params: [sid, param, req.traceId ?? null, req.limit ?? 50],
      }
    }

    case "show_registration_chain":
    case "find_callback_registrars": {
      const { clause, param, nextIdx } = aliasClause("dst_symbol_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT src_symbol_name AS registrar, dst_symbol_name AS callback,
                     edge_kind, confidence, derivation, metadata
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND ${clause}
                AND edge_kind IN ('registers_callback','dispatches_to')
              ORDER BY confidence DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 50],
      }
    }

    case "show_dispatch_sites": {
      const { clause, param, nextIdx } = aliasClause("src_symbol_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT src_symbol_name AS dispatcher, dst_symbol_name AS target,
                     edge_kind, confidence, derivation, metadata
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND ${clause}
                AND edge_kind IN ('dispatches_to','indirect_calls')
              ORDER BY confidence DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 50],
      }
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

    case "show_api_runtime_observations": {
      const { clause, param, nextIdx } = aliasClause("target_api", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT target_api, runtime_trigger, dispatch_chain,
                     immediate_invoker, dispatch_site, confidence
              FROM runtime_observation
              WHERE snapshot_id = $1
                AND ${clause}
              ORDER BY confidence DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 50],
      }
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

    case "show_hot_call_paths": {
      const { clause, param, nextIdx } = aliasClause("src_symbol_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT src_symbol_name AS caller, dst_symbol_name AS callee,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND ${clause}
                AND edge_kind IN ('calls','indirect_calls')
              ORDER BY confidence DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 50],
      }
    }

    case "find_api_logs": {
      const { clause, param, nextIdx } = aliasClause("api_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT api_name, level, template, subsystem, file_path, line, confidence
              FROM api_log
              WHERE snapshot_id = $1
                AND ${clause}
              ORDER BY confidence DESC, line ASC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 100],
      }
    }

    case "find_api_logs_by_level": {
      const { clause, param, nextIdx } = aliasClause("api_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT api_name, level, template, subsystem, file_path, line, confidence
              FROM api_log
              WHERE snapshot_id = $1
                AND ${clause}
                AND level = $${nextIdx}
              ORDER BY confidence DESC, line ASC
              LIMIT $${nextIdx + 1}`,
        params: [sid, param, req.logLevel ?? "INFO", req.limit ?? 100],
      }
    }

    case "find_api_timer_triggers": {
      const { clause, param, nextIdx } = aliasClause("api_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT api_name, timer_identifier_name, timer_trigger_condition_description,
                     timer_trigger_confidence_score, derivation
              FROM api_timer_trigger
              WHERE snapshot_id = $1
                AND ${clause}
              ORDER BY timer_trigger_confidence_score DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 50],
      }
    }

    case "find_api_struct_writes": {
      // API-centric: what structs does this API write?
      // src_symbol_name = apiName, edge_kind = writes_field
      const { clause, param, nextIdx } = aliasClause("src_symbol_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT src_symbol_name AS writer, dst_symbol_name AS target,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND ${clause}
                AND edge_kind = 'writes_field'
              ORDER BY confidence DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 50],
      }
    }

    case "find_api_struct_reads": {
      // API-centric: what structs does this API read?
      // src_symbol_name = apiName, edge_kind = reads_field
      const { clause, param, nextIdx } = aliasClause("src_symbol_name", req.apiName, req.apiNameAliases, 2)
      return {
        sql: `SELECT src_symbol_name AS reader, dst_symbol_name AS target,
                     edge_kind, confidence, derivation
              FROM semantic_edge
              WHERE snapshot_id = $1
                AND ${clause}
                AND edge_kind = 'reads_field'
              ORDER BY confidence DESC
              LIMIT $${nextIdx}`,
        params: [sid, param, req.limit ?? 50],
      }
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
    // Canonicalize all symbol names in returned rows so callers/callees are
    // always shown in their canonical form regardless of how they were ingested.
    const rows = (res.rows as Array<Record<string, unknown>>).map(canonicalizeRow)
    return {
      hit: rows.length > 0,
      intent: req.intent,
      snapshotId: req.snapshotId,
      rows,
    }
  }
}

