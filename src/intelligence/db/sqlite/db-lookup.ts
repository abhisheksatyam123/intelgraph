/**
 * db-lookup.ts — SQLite implementation of DbLookupRepository.
 *
 * This is the Phase 3 port of src/intelligence/db/neo4j/db-lookup.ts.
 * Same intent vocabulary (22 intents), same row shapes, same fallback
 * semantics. The data model is identical: graph_nodes + graph_edges +
 * graph_observations, keyed by (snapshot_id, id).
 *
 * Implementation notes:
 *
 * 1. The Neo4j queries were all three-way joins between GraphNode,
 *    GraphEdge, and GraphNode again — never real Cypher path traversal.
 *    Each Cypher query ports to a standard SQL INNER JOIN with two
 *    self-joins on graph_nodes. The pattern is:
 *
 *      SELECT ... FROM graph_edges e
 *      INNER JOIN graph_nodes src ON e.src_node_id = src.node_id
 *                                AND src.snapshot_id = e.snapshot_id
 *      INNER JOIN graph_nodes dst ON e.dst_node_id = dst.node_id
 *                                AND dst.snapshot_id = e.snapshot_id
 *      WHERE e.snapshot_id = @snapshotId AND ...
 *
 * 2. IN-list parameters: better-sqlite3 does not support array bindings
 *    directly, so we expand the IN list into repeated ? placeholders and
 *    pass the values as positional params. A tiny helper does this.
 *
 * 3. JSON fields (location, payload, metadata): stored as TEXT, returned
 *    as strings from raw SQL. The extractFilePath/extractLine helpers
 *    parse them on demand. For payload.target_api style nested access
 *    we use SQLite's json_extract() function.
 *
 * 4. Raw better-sqlite3 is used instead of the Drizzle query builder
 *    for these queries because Drizzle's self-join alias machinery
 *    gets verbose fast. Drizzle still owns schema + foundation writes.
 */

import type BetterSqlite3 from "better-sqlite3"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type {
  DbLookupRepository,
  LookupResult,
  QueryRequest,
} from "../../contracts/orchestrator.js"
import type * as schema from "./schema.js"

type SqliteDb = BetterSQLite3Database<typeof schema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApiNames(request: QueryRequest): string[] {
  const names = [
    ...(request.apiName ? [request.apiName] : []),
    ...(request.apiNameAliases ?? []),
  ].filter(Boolean)
  return [...new Set(names)]
}

function miss(request: QueryRequest): LookupResult {
  return { hit: false, intent: request.intent, snapshotId: request.snapshotId, rows: [] }
}

function expandIn(values: readonly string[]): string {
  // Returns "?, ?, ?" for N placeholders. Caller passes the values as
  // positional args after any other bound params.
  return values.map(() => "?").join(", ")
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value
  const n = Number(value)
  return isNaN(n) ? 0 : n
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = toNumber(value)
  return isNaN(n) ? null : n
}

function parseJson<T = unknown>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value !== "string") return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function extractFilePath(locationJson: unknown): string | null {
  const loc = parseJson<{ filePath?: string }>(locationJson)
  return loc && typeof loc.filePath === "string" ? loc.filePath : null
}

function extractLine(locationJson: unknown): number | null {
  const loc = parseJson<{ line?: unknown }>(locationJson)
  if (!loc || loc.line == null) return null
  return toNumberOrNull(loc.line)
}

// ---------------------------------------------------------------------------
// SqliteDbLookup
// ---------------------------------------------------------------------------

export class SqliteDbLookup implements DbLookupRepository {
  constructor(
    private readonly _db: SqliteDb,
    private readonly raw: BetterSqlite3.Database,
  ) {}

  async lookup(request: QueryRequest): Promise<LookupResult> {
    try {
      const rows = this.dispatch(request)
      return { hit: rows.length > 0, intent: request.intent, snapshotId: request.snapshotId, rows }
    } catch {
      return miss(request)
    }
  }

  // -------------------------------------------------------------------------
  // Intent dispatch
  // -------------------------------------------------------------------------

  private dispatch(request: QueryRequest): Array<Record<string, unknown>> {
    const { intent, snapshotId } = request
    const limit = request.limit ?? 200
    const apiNames = buildApiNames(request)

    switch (intent) {
      case "who_calls_api":
        return this.callers(snapshotId, apiNames, ["calls", "runtime_calls"], limit)
      case "who_calls_api_at_runtime":
        return this.runtimeCallers(snapshotId, apiNames, limit)
      case "what_api_calls":
        return this.callees(snapshotId, apiNames, limit)
      case "find_api_logs":
        return this.apiLogs(snapshotId, apiNames, undefined, limit)
      case "find_api_logs_by_level":
        return this.apiLogs(snapshotId, apiNames, request.logLevel, limit)
      case "find_api_timer_triggers":
        return this.timerTriggers(snapshotId, apiNames, limit)
      case "show_registration_chain":
      case "find_callback_registrars":
        return this.registrationChain(snapshotId, apiNames, limit)
      case "show_dispatch_sites":
        return this.dispatchSites(snapshotId, apiNames, limit)
      case "find_struct_writers":
      case "where_struct_modified": {
        const structNames = request.structName ? [request.structName] : apiNames
        return this.structAccess(snapshotId, structNames, "writes_field", limit)
      }
      case "find_struct_readers":
      case "where_struct_initialized": {
        const structNames = request.structName ? [request.structName] : apiNames
        return this.structAccess(snapshotId, structNames, "reads_field", limit)
      }
      case "find_struct_owners": {
        const structNames = request.structName ? [request.structName] : apiNames
        return this.structAccess(snapshotId, structNames, "owns", limit)
      }
      case "find_api_struct_writes":
        return this.apiStructAccess(snapshotId, apiNames, "writes_field", limit)
      case "find_api_struct_reads":
        return this.apiStructAccess(snapshotId, apiNames, "reads_field", limit)
      case "find_field_access_path":
        return this.fieldAccessPath(snapshotId, request.structName, request.fieldName, limit)
      case "show_cross_module_path":
        return this.crossModulePath(snapshotId, request.srcApi, request.dstApi, limit)
      case "show_hot_call_paths":
        return this.hotCallPaths(snapshotId, apiNames, limit)
      case "why_api_invoked":
      case "show_runtime_flow_for_trace":
      case "show_api_runtime_observations":
        return this.observations(snapshotId, apiNames, limit)
      case "find_api_by_log_pattern":
        return this.logPattern(snapshotId, request.pattern, limit)
      // ── Language-agnostic structural intents (used by ts-core and any
      //    future plugin that emits imports/contains/extends/implements)
      case "find_module_imports":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "imports", limit)
      case "find_module_dependents":
        return this.incomingByEdgeKind(snapshotId, apiNames, "imports", limit)
      case "find_module_symbols":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "contains", limit)
      case "find_class_inheritance":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "extends", limit)
      case "find_class_subtypes":
        return this.incomingByEdgeKind(snapshotId, apiNames, "extends", limit)
      case "find_interface_implementors":
        return this.incomingByEdgeKind(snapshotId, apiNames, "implements", limit)
      case "find_type_dependencies":
        return this.outgoingByEdgeKind(snapshotId, apiNames, "references_type", limit)
      case "find_type_consumers":
        return this.incomingByEdgeKind(snapshotId, apiNames, "references_type", limit)
      default:
        return []
    }
  }

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  // ── who_calls_api (callers by edge kind) ────────────────────────────────
  private callers(
    snapshotId: number,
    apiNames: string[],
    edgeKinds: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name   AS caller,
        dst.canonical_name   AS callee,
        src.kind             AS kind,
        src.canonical_name   AS canonical_name,
        e.edge_kind          AS edge_kind,
        e.confidence         AS confidence,
        e.derivation         AS derivation,
        src.location         AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind        IN (${expandIn(edgeKinds)})
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...apiNames, ...edgeKinds, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name ?? obj.caller,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── who_calls_api_at_runtime ────────────────────────────────────────────
  private runtimeCallers(
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const edgeRows = this.callers(snapshotId, apiNames, ["runtime_calls"], limit)

    // GraphObservation rows
    const obsSql = `
      SELECT
        payload,
        confidence
      FROM graph_observations
      WHERE snapshot_id = ?
        AND kind = 'runtime_invocation'
        AND payload IS NOT NULL
        AND json_extract(payload, '$.target_api') IN (${expandIn(apiNames)})
      LIMIT ?
    `
    const obsRaw = this.raw
      .prepare(obsSql)
      .all(snapshotId, ...apiNames, limit) as Array<{
        payload: string | null
        confidence: number
      }>

    const obsRows: Array<Record<string, unknown>> = obsRaw.map((r) => {
      const payload = parseJson<{
        target_api?: string
        immediate_invoker?: string
        runtime_trigger?: string
        dispatch_chain?: string[]
        dispatch_site?: { filePath?: string; line?: number }
      }>(r.payload) ?? {}
      const site = payload.dispatch_site
      return {
        kind: "function",
        canonical_name: payload.immediate_invoker,
        caller: payload.immediate_invoker,
        callee: payload.target_api,
        edge_kind: "runtime_calls",
        confidence: toNumber(r.confidence),
        derivation: "runtime",
        runtime_trigger: payload.runtime_trigger,
        dispatch_chain: payload.dispatch_chain,
        dispatch_site: payload.dispatch_site,
        file_path: site?.filePath ?? null,
        line_number: site?.line != null ? toNumber(site.line) : null,
      }
    })

    // Merge, preferring observation rows when both exist
    const seen = new Set<string>()
    const merged: Array<Record<string, unknown>> = []
    for (const row of [...obsRows, ...edgeRows]) {
      const key = `${String(row.caller)}::${String(row.callee)}`
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(row)
      }
    }
    return merged.slice(0, limit)
  }

  // ── what_api_calls ──────────────────────────────────────────────────────
  private callees(
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name   AS caller,
        dst.canonical_name   AS callee,
        dst.kind             AS kind,
        dst.canonical_name   AS canonical_name,
        e.edge_kind          AS edge_kind,
        e.confidence         AS confidence,
        e.derivation         AS derivation,
        dst.location         AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind IN ('calls', 'runtime_calls')
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...apiNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name ?? obj.callee,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── find_api_logs / find_api_logs_by_level ──────────────────────────────
  private apiLogs(
    snapshotId: number,
    apiNames: string[],
    logLevel: string | undefined,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const levelFilter = logLevel
      ? `AND json_extract(e.metadata, '$.log_level') = ?`
      : ""
    const sql = `
      SELECT
        src.canonical_name   AS api_name,
        log.canonical_name   AS canonical_name,
        log.kind             AS kind,
        e.metadata           AS metadata,
        e.confidence         AS confidence,
        e.derivation         AS derivation,
        src.location         AS src_location,
        log.location         AS log_location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes log
        ON e.dst_node_id = log.node_id AND e.snapshot_id = log.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind = 'logs_event'
        AND log.kind = 'log_point'
        ${levelFilter}
      LIMIT ?
    `
    const params: unknown[] = [snapshotId, ...apiNames]
    if (logLevel) params.push(logLevel)
    params.push(limit)
    const rows = this.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>

    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: "log_point",
        api_name: obj.api_name,
        canonical_name: obj.canonical_name,
        template: meta.template ?? meta.log_template ?? obj.canonical_name,
        log_level: meta.log_level ?? "UNKNOWN",
        subsystem: meta.subsystem ?? null,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path:
          extractFilePath(obj.src_location) ?? extractFilePath(obj.log_location),
        line_number:
          extractLine(obj.src_location) ?? extractLine(obj.log_location),
        edge_kind: "logs_event",
        caller: obj.api_name,
        callee: obj.canonical_name,
      }
    })
  }

  // ── find_api_timer_triggers ─────────────────────────────────────────────
  private timerTriggers(
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        timer.canonical_name AS timer_identifier_name,
        timer.canonical_name AS canonical_name,
        timer.kind           AS kind,
        dst.canonical_name   AS callee,
        e.edge_kind          AS edge_kind,
        e.confidence         AS confidence,
        e.derivation         AS derivation,
        e.metadata           AS metadata,
        timer.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes timer
        ON e.src_node_id = timer.node_id AND e.snapshot_id = timer.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind IN ('runtime_calls', 'calls')
        AND timer.kind = 'timer'
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...apiNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: "timer",
        canonical_name: obj.canonical_name,
        timer_identifier_name: obj.timer_identifier_name,
        timer_trigger_condition_description:
          meta.timer_trigger_condition_description ?? null,
        timer_trigger_confidence_score: toNumber(obj.confidence),
        caller: obj.timer_identifier_name,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── show_registration_chain / find_callback_registrars ─────────────────
  private registrationChain(
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        registrar.canonical_name AS registrar,
        callback.canonical_name  AS callback,
        registrar.canonical_name AS canonical_name,
        registrar.kind           AS kind,
        e.metadata               AS metadata,
        e.confidence             AS confidence,
        e.derivation             AS derivation,
        registrar.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes registrar
        ON e.src_node_id = registrar.node_id AND e.snapshot_id = registrar.snapshot_id
      INNER JOIN graph_nodes callback
        ON e.dst_node_id = callback.node_id AND e.snapshot_id = callback.snapshot_id
      WHERE e.snapshot_id = ?
        AND callback.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind = 'registers_callback'
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...apiNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        registrar: obj.registrar,
        callback: obj.callback,
        registration_api: meta.registration_api ?? obj.registrar,
        caller: obj.registrar,
        callee: obj.callback,
        edge_kind: "registers_callback",
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── show_dispatch_sites ─────────────────────────────────────────────────
  private dispatchSites(
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        dispatcher.canonical_name AS caller,
        dst.canonical_name        AS callee,
        dispatcher.canonical_name AS canonical_name,
        dispatcher.kind           AS kind,
        e.metadata                AS metadata,
        e.confidence              AS confidence,
        e.derivation              AS derivation,
        dispatcher.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes dispatcher
        ON e.src_node_id = dispatcher.node_id AND e.snapshot_id = dispatcher.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind = 'dispatches_to'
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...apiNames, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      const site = (meta.dispatch_site as Record<string, unknown> | undefined) ?? {}
      const filePath =
        extractFilePath(obj.location) ?? (typeof site.filePath === "string" ? site.filePath : "")
      const lineNumber =
        extractLine(obj.location) ?? toNumberOrNull(site.line)
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: "dispatches_to",
        dispatch_site: { file: filePath, line: lineNumber },
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: filePath,
        line_number: lineNumber,
      }
    })
  }

  // ── find_struct_writers / readers / owners ──────────────────────────────
  private structAccess(
    snapshotId: number,
    structNames: string[],
    edgeKind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (structNames.length === 0) return []
    const sql = `
      SELECT
        accessor.canonical_name AS accessor_name,
        target.canonical_name   AS target,
        target.canonical_name   AS struct_name,
        accessor.kind           AS kind,
        accessor.canonical_name AS canonical_name,
        e.edge_kind             AS edge_kind,
        e.metadata              AS metadata,
        e.confidence            AS confidence,
        e.derivation            AS derivation,
        accessor.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes accessor
        ON e.src_node_id = accessor.node_id AND e.snapshot_id = accessor.snapshot_id
      INNER JOIN graph_nodes target
        ON e.dst_node_id = target.node_id AND e.snapshot_id = target.snapshot_id
      WHERE e.snapshot_id = ?
        AND target.canonical_name IN (${expandIn(structNames)})
        AND e.edge_kind = ?
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...structNames, edgeKind, limit) as Array<Record<string, unknown>>

    const roleByEdgeKind: Record<string, string> = {
      writes_field: "writer",
      reads_field: "reader",
      owns: "owner",
      operates_on_struct: "reader",
    }
    const role = roleByEdgeKind[edgeKind] ?? "accessor"

    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        [role]: obj.accessor_name,
        target: obj.target,
        struct_name: obj.struct_name,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        caller: obj.accessor_name,
        callee: obj.target,
        runtime_structure_evidence: meta,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── find_api_struct_writes / reads ──────────────────────────────────────
  private apiStructAccess(
    snapshotId: number,
    apiNames: string[],
    edgeKind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        dst.canonical_name AS canonical_name,
        dst.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.metadata         AS metadata,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        src.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(apiNames)})
        AND e.edge_kind = ?
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...apiNames, edgeKind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "struct",
      canonical_name: obj.canonical_name ?? obj.callee,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── find_field_access_path ──────────────────────────────────────────────
  private fieldAccessPath(
    snapshotId: number,
    structName: string | undefined,
    fieldName: string | undefined,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!structName && !fieldName) return []
    // SQLite LIKE is case-sensitive by default; the Cypher version used
    // exact prefix/suffix via STARTS WITH / ENDS WITH.
    const conditions: string[] = []
    const params: unknown[] = [snapshotId]
    if (structName) {
      conditions.push("field.canonical_name LIKE ?")
      params.push(`${structName}%`)
    }
    if (fieldName) {
      conditions.push("field.canonical_name LIKE ?")
      params.push(`%${fieldName}`)
    }
    params.push(limit)
    const sql = `
      SELECT
        accessor.canonical_name AS caller,
        field.canonical_name    AS callee,
        field.canonical_name    AS canonical_name,
        accessor.kind           AS kind,
        e.edge_kind             AS edge_kind,
        e.metadata              AS metadata,
        e.confidence            AS confidence,
        e.derivation            AS derivation,
        accessor.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes accessor
        ON e.src_node_id = accessor.node_id AND e.snapshot_id = accessor.snapshot_id
      INNER JOIN graph_nodes field
        ON e.dst_node_id = field.node_id AND e.snapshot_id = field.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind IN ('reads_field', 'writes_field')
        ${conditions.length > 0 ? "AND " + conditions.join(" AND ") : ""}
      LIMIT ?
    `
    const rows = this.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        access_path: meta.access_path ?? obj.callee,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── show_cross_module_path ──────────────────────────────────────────────
  private crossModulePath(
    snapshotId: number,
    srcApi: string | undefined,
    dstApi: string | undefined,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!srcApi || !dstApi) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        src.canonical_name AS canonical_name,
        src.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        src.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name = ?
        AND dst.canonical_name = ?
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, srcApi, dstApi, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── show_hot_call_paths (diagnostic probe) ──────────────────────────────
  private hotCallPaths(
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    // Any edges in the snapshot; used to detect empty snapshots. When
    // apiNames is empty, return everything; otherwise filter to edges
    // whose src or dst match.
    let sql: string
    let params: unknown[]
    if (apiNames.length === 0) {
      sql = `
        SELECT
          src.canonical_name AS caller,
          dst.canonical_name AS callee,
          src.canonical_name AS canonical_name,
          src.kind           AS kind,
          e.edge_kind        AS edge_kind,
          e.confidence       AS confidence,
          e.derivation       AS derivation,
          src.location       AS location
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
        LIMIT ?
      `
      params = [snapshotId, limit]
    } else {
      const apiIn = expandIn(apiNames)
      sql = `
        SELECT
          src.canonical_name AS caller,
          dst.canonical_name AS callee,
          src.canonical_name AS canonical_name,
          src.kind           AS kind,
          e.edge_kind        AS edge_kind,
          e.confidence       AS confidence,
          e.derivation       AS derivation,
          src.location       AS location
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND (src.canonical_name IN (${apiIn}) OR dst.canonical_name IN (${apiIn}))
        LIMIT ?
      `
      params = [snapshotId, ...apiNames, ...apiNames, limit]
    }
    const rows = this.raw.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  // ── runtime observations ────────────────────────────────────────────────
  private observations(
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Array<Record<string, unknown>> {
    if (apiNames.length === 0) return []
    const sql = `
      SELECT payload, confidence
      FROM graph_observations
      WHERE snapshot_id = ?
        AND kind = 'runtime_invocation'
        AND payload IS NOT NULL
        AND json_extract(payload, '$.target_api') IN (${expandIn(apiNames)})
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...apiNames, limit) as Array<{ payload: string | null; confidence: number }>
    return rows.map((r) => {
      const payload = parseJson<{
        target_api?: string
        immediate_invoker?: string
        runtime_trigger?: string
        dispatch_chain?: string[]
        dispatch_site?: { filePath?: string; line?: number }
      }>(r.payload) ?? {}
      const site = payload.dispatch_site
      return {
        kind: "function",
        canonical_name: payload.immediate_invoker ?? payload.target_api,
        target_api: payload.target_api,
        immediate_invoker: payload.immediate_invoker,
        runtime_trigger: payload.runtime_trigger,
        dispatch_chain: payload.dispatch_chain,
        dispatch_site: payload.dispatch_site,
        edge_kind: "runtime_calls",
        derivation: "runtime",
        confidence: toNumber(r.confidence),
        file_path: site?.filePath ?? null,
        line_number: site?.line != null ? toNumber(site.line) : null,
      }
    })
  }

  // ── find_api_by_log_pattern ─────────────────────────────────────────────
  private logPattern(
    snapshotId: number,
    pattern: string | undefined,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!pattern) return []
    const sql = `
      SELECT
        src.canonical_name AS canonical_name,
        src.kind           AS kind,
        log.canonical_name AS log_name,
        e.metadata         AS metadata,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        src.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes log
        ON e.dst_node_id = log.node_id AND e.snapshot_id = log.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'logs_event'
        AND log.kind = 'log_point'
        AND (
          log.canonical_name LIKE ?
          OR (e.metadata IS NOT NULL AND json_extract(e.metadata, '$.template') LIKE ?)
        )
      LIMIT ?
    `
    const likePattern = `%${pattern}%`
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, likePattern, likePattern, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => {
      const meta = parseJson<Record<string, unknown>>(obj.metadata) ?? {}
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        log_name: obj.log_name,
        template: meta.template ?? obj.log_name,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        edge_kind: "logs_event",
        caller: obj.canonical_name,
        callee: obj.log_name,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── language-agnostic structural intent helpers ─────────────────────────
  //
  // outgoingByEdgeKind / incomingByEdgeKind back the new ts-core intents
  // (find_module_imports, find_class_inheritance, etc.) but are kind-
  // parameterized so they work for any future structural edge_kind
  // without per-intent code duplication.

  private outgoingByEdgeKind(
    snapshotId: number,
    srcNames: string[],
    edgeKind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (srcNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        dst.canonical_name AS canonical_name,
        dst.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        dst.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name IN (${expandIn(srcNames)})
        AND e.edge_kind = ?
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...srcNames, edgeKind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "module",
      canonical_name: obj.canonical_name ?? obj.callee,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  private incomingByEdgeKind(
    snapshotId: number,
    dstNames: string[],
    edgeKind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (dstNames.length === 0) return []
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        src.canonical_name AS canonical_name,
        src.kind           AS kind,
        e.edge_kind        AS edge_kind,
        e.confidence       AS confidence,
        e.derivation       AS derivation,
        src.location       AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name IN (${expandIn(dstNames)})
        AND e.edge_kind = ?
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, ...dstNames, edgeKind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "module",
      canonical_name: obj.canonical_name ?? obj.caller,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }
}
