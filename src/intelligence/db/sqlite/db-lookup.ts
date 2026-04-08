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
      case "find_import_cycles":
        return this.importCycles(snapshotId, limit)
      case "find_top_imported_modules":
        return this.topByIncoming(snapshotId, "imports", "module", limit)
      case "find_top_called_functions":
        return this.topByIncoming(snapshotId, "calls", null, limit)
      case "find_module_entry_points":
        return this.moduleEntryPoints(snapshotId, limit)
      case "find_dead_exports":
        return this.deadExports(snapshotId, limit)
      case "find_call_chain":
        return this.callChain(
          snapshotId,
          request.srcApi ?? "",
          request.dstApi ?? "",
          request.depth ?? 6,
          limit,
        )
      case "find_symbols_by_name":
        return this.symbolsByName(snapshotId, request.pattern ?? "", limit)
      case "find_symbols_by_kind":
        return this.symbolsByKind(snapshotId, request.pattern ?? "", limit)
      case "find_transitive_dependencies":
        return this.transitiveDependencies(
          snapshotId,
          apiNames[0] ?? "",
          request.depth ?? 10,
          limit,
        )
      case "find_symbol_at_location":
        return this.symbolAtLocation(
          snapshotId,
          request.filePath ?? "",
          request.lineNumber ?? 0,
          limit,
        )
      case "find_long_functions":
        return this.longFunctions(snapshotId, request.depth ?? 50, limit)
      case "find_external_imports":
        return this.externalImports(snapshotId, limit)
      case "find_module_summary":
        return this.moduleSummary(snapshotId, apiNames[0] ?? "")
      case "find_symbols_in_file":
        return this.symbolsInFile(snapshotId, request.filePath ?? "", limit)
      case "find_sibling_symbols":
        return this.siblingSymbols(snapshotId, apiNames[0] ?? "", limit)
      case "find_module_top_exports":
        return this.moduleTopExports(snapshotId, apiNames[0] ?? "", limit)
      case "find_import_cycles_deep":
        return this.importCyclesDeep(
          snapshotId,
          apiNames[0] ?? "",
          request.depth ?? 5,
          limit,
        )
      case "find_symbol_degree":
        return this.symbolDegree(snapshotId, apiNames[0] ?? "")
      case "find_module_interactions":
        return this.moduleInteractions(
          snapshotId,
          request.srcApi ?? "",
          request.dstApi ?? "",
          limit,
        )
      case "find_modules_overview":
        return this.modulesOverview(snapshotId, limit)
      case "find_type_cycles":
        return this.typeCycles(snapshotId, limit)
      case "find_deepest_call_chain":
        return this.deepestCallChain(
          snapshotId,
          apiNames[0] ?? "",
          request.depth ?? 8,
        )
      case "find_symbols_by_doc":
        return this.symbolsByDoc(snapshotId, request.pattern ?? "", limit)
      case "find_tightly_coupled_modules":
        return this.tightlyCoupledModules(snapshotId, limit)
      case "find_classes_by_method_count":
        return this.classesByMethodCount(snapshotId, limit)
      case "find_widely_referenced_types":
        return this.widelyReferencedTypes(snapshotId, limit)
      case "find_undocumented_exports":
        return this.undocumentedExports(snapshotId, limit)
      case "find_top_implemented_interfaces":
        return this.topByIncoming(snapshotId, "implements", "interface", limit)
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

  /**
   * Find exported symbols that lack a JSDoc comment. Builds on D26
   * (exported flag) and D59 (JSDoc extraction). Visualizers can use
   * this for "what's missing documentation" workflows on public APIs.
   *
   * Filters:
   *   - kind IN (function, class, interface)
   *   - payload.metadata.exported = true
   *   - payload.metadata.doc IS NULL
   *
   * Methods inside classes are excluded — they don't carry exported=true
   * (their class does), and method-level docs are a separate concern.
   */
  private undocumentedExports(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        canonical_name,
        kind,
        location
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND kind IN ('function', 'class', 'interface')
        AND json_extract(payload, '$.metadata.exported') = 1
        AND json_extract(payload, '$.metadata.doc') IS NULL
      ORDER BY canonical_name
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Rank types by the number of DISTINCT modules that reference them.
   * Surfaces "core types" — types that touch many parts of the
   * codebase and are likely candidates for stability guarantees,
   * docs, or careful refactoring.
   *
   * Different from find_top_imported_modules: that counts module
   * imports, this counts type references across module boundaries.
   * A type used by 50 different modules is more central than a type
   * used 50 times in one module.
   *
   * Each row carries module_count = number of distinct source modules.
   */
  private widelyReferencedTypes(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        dst.canonical_name AS canonical_name,
        dst.kind AS kind,
        dst.location AS location,
        COUNT(DISTINCT
          SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1)
        ) AS module_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'references_type'
        AND INSTR(src.canonical_name, '#') > 0
        AND dst.kind IN ('class', 'interface', 'typedef')
      GROUP BY dst.canonical_name, dst.kind, dst.location
      ORDER BY module_count DESC, dst.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "class",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "references_type",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      module_count: toNumber(obj.module_count),
    }))
  }

  /**
   * Rank classes by their method count. After D4 methods are anchored
   * at the class via contains edges, so this is just a GROUP BY on
   * the contains edges where src is a class and dst is a method.
   *
   * Surfaces god objects — classes with disproportionately many
   * methods that are often refactor candidates. Visualizers can
   * highlight these for "split this class" suggestions.
   *
   * Each row carries a method_count field.
   */
  private classesByMethodCount(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        src.canonical_name AS canonical_name,
        src.location AS location,
        COUNT(*) AS method_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'contains'
        AND src.kind = 'class'
        AND dst.kind = 'method'
      GROUP BY src.canonical_name, src.location
      ORDER BY method_count DESC, src.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "class",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      method_count: toNumber(obj.method_count),
    }))
  }

  /**
   * Find module pairs ranked by total inter-module edges (calls +
   * references_type). Surfaces refactor candidates: pairs of modules
   * with high mutual coupling are often signs that code wants to be
   * combined or that an abstraction is leaking.
   *
   * Module membership is derived from canonical_name prefix: a symbol
   * `module:src/foo.ts#bar` belongs to module `module:src/foo.ts`.
   * The query aggregates by (src_module, dst_module) excluding pairs
   * where src == dst (those are intra-module noise).
   *
   * Result rows have caller=src_module, callee=dst_module, and
   * coupling_count = total edges between them. Ordered DESC.
   */
  private tightlyCoupledModules(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1) AS src_module,
        SUBSTR(dst.canonical_name, 1, INSTR(dst.canonical_name, '#') - 1) AS dst_module,
        COUNT(*) AS coupling_count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind IN ('calls', 'references_type')
        AND INSTR(src.canonical_name, '#') > 0
        AND INSTR(dst.canonical_name, '#') > 0
        AND SUBSTR(src.canonical_name, 1, INSTR(src.canonical_name, '#') - 1)
            != SUBSTR(dst.canonical_name, 1, INSTR(dst.canonical_name, '#') - 1)
      GROUP BY src_module, dst_module
      ORDER BY coupling_count DESC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<{
      src_module: string
      dst_module: string
      coupling_count: number
    }>
    return rows.map((row) => ({
      kind: "module",
      canonical_name: row.src_module,
      caller: row.src_module,
      callee: row.dst_module,
      edge_kind: "calls",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      coupling_count: toNumber(row.coupling_count),
    }))
  }

  /**
   * Search symbols by their JSDoc text. Builds on D59 which stores
   * the doc string at payload.metadata.doc. Useful for finding
   * deprecated APIs (search for "@deprecated"), TODO/FIXME comments,
   * or any documentation pattern across the codebase.
   *
   * Returns matching symbols ordered alphabetically by canonical_name.
   */
  private symbolsByDoc(
    snapshotId: number,
    pattern: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!pattern || pattern.length === 0) return []
    const safe = pattern.replace(/[\\%_]/g, "\\$&")
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.doc') AS doc
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND json_extract(payload, '$.metadata.doc') LIKE ? ESCAPE '\\'
      ORDER BY canonical_name
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, `%${safe}%`, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      doc: obj.doc,
    }))
  }

  /**
   * Find the deepest call chain reachable from a starting symbol.
   * Walks the calls graph forward via a recursive CTE without a
   * fixed destination — the result is the longest path from the
   * root within the depth bound.
   *
   * Visualizers use this for "worst-case execution path" or "show
   * me the deepest stack from this entry point" views. Returned
   * rows are per-hop in the longest chain found, ordered by
   * path_index, with chain_depth = total length.
   *
   * Bounded depth (default 8, clamped to [1, 12]) and cycle
   * prevention via the running path string.
   */
  private deepestCallChain(
    snapshotId: number,
    rootName: string,
    depth: number,
  ): Array<Record<string, unknown>> {
    if (!rootName) return []
    const maxDepth = Math.min(Math.max(depth, 1), 12)
    const sql = `
      WITH RECURSIVE chain(callee_name, depth_n, path) AS (
        SELECT
          dst.canonical_name,
          1,
          src.canonical_name || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'calls'
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          dst.canonical_name,
          c.depth_n + 1,
          c.path || ' -> ' || dst.canonical_name
        FROM chain c
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'calls'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id
          AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = c.callee_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id
          AND e.snapshot_id = dst.snapshot_id
        WHERE c.depth_n < ?
          AND instr(c.path || ' -> ', dst.canonical_name || ' -> ') = 0
      )
      SELECT depth_n, path
      FROM chain
      ORDER BY depth_n DESC, path ASC
      LIMIT 1
    `
    type Row = { depth_n: number; path: string }
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, rootName, snapshotId, maxDepth) as Row[]
    if (rows.length === 0) return []
    const longest = rows[0]
    const segments = longest.path.split(" -> ")
    return segments.slice(0, -1).map((caller, i) => ({
      kind: "function",
      canonical_name: caller,
      caller,
      callee: segments[i + 1],
      edge_kind: "calls",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      path_index: i,
      chain_depth: longest.depth_n,
    }))
  }

  /**
   * Find pairs of types that reference each other (2-cycles in the
   * references_type graph). When type A has a field of type B and
   * type B has a field of type A, that's a circular type dependency
   * — often a refactor signal (extract a shared interface, break
   * the bidirectional coupling, etc.).
   *
   * Same self-join pattern as find_import_cycles but on
   * references_type edges. Filters to class/interface dst kinds so
   * the result is meaningful (function-level type references aren't
   * usually mutual). De-duped via canonical_name comparison.
   */
  private typeCycles(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        a.canonical_name AS caller,
        b.canonical_name AS callee,
        a.canonical_name AS canonical_name,
        a.kind AS kind,
        'references_type' AS edge_kind,
        1.0 AS confidence,
        'clangd' AS derivation,
        a.location AS location
      FROM graph_edges e1
      INNER JOIN graph_nodes a
        ON e1.src_node_id = a.node_id AND e1.snapshot_id = a.snapshot_id
      INNER JOIN graph_nodes b
        ON e1.dst_node_id = b.node_id AND e1.snapshot_id = b.snapshot_id
      INNER JOIN graph_edges e2
        ON e2.snapshot_id = e1.snapshot_id
        AND e2.src_node_id = e1.dst_node_id
        AND e2.dst_node_id = e1.src_node_id
      WHERE e1.snapshot_id = ?
        AND e1.edge_kind = 'references_type'
        AND e2.edge_kind = 'references_type'
        AND a.kind IN ('class', 'interface')
        AND b.kind IN ('class', 'interface')
        AND a.canonical_name < b.canonical_name
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "class",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: "references_type",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Single-call overview of every module in the snapshot. Returns
   * aggregate counts (symbol_count, exported_count, outgoing_imports,
   * incoming_imports, line_count) for each module so visualizers can
   * populate a file tree without N round-trips.
   *
   * Each row is a module with its summary metrics. Ordered
   * alphabetically by canonical_name. Bounded by limit (the visualizer
   * can paginate or pre-filter via find_symbols_by_name first).
   */
  private modulesOverview(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        m.canonical_name AS canonical_name,
        m.location AS location,
        json_extract(m.payload, '$.metadata.lineCount') AS line_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'contains'
            AND src.canonical_name = m.canonical_name
        ) AS symbol_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'contains'
            AND src.canonical_name = m.canonical_name
            AND json_extract(dst.payload, '$.metadata.exported') = 1
        ) AS exported_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND src.canonical_name = m.canonical_name
        ) AS outgoing_imports,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND dst.canonical_name = m.canonical_name
        ) AS incoming_imports
      FROM graph_nodes m
      WHERE m.snapshot_id = ?
        AND m.kind = 'module'
      ORDER BY m.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      symbol_count: toNumber(obj.symbol_count),
      exported_count: toNumber(obj.exported_count),
      outgoing_imports: toNumber(obj.outgoing_imports),
      incoming_imports: toNumber(obj.incoming_imports),
      line_count: toNumberOrNull(obj.line_count),
    }))
  }

  /**
   * Find all calls + references_type edges between symbols in two
   * modules. Visualizers use this to render "how do these two modules
   * interact" views — typically a focused subgraph showing every
   * cross-talk site.
   *
   * Module membership is determined by canonical_name prefix matching.
   * A symbol with canonical_name `module:src/foo.ts#bar` belongs to
   * module `module:src/foo.ts`. The query also matches the module's
   * own symbol (for cases where the edge is module → module rather
   * than symbol → symbol).
   *
   * Required: srcApi and dstApi must be module canonical_names.
   */
  private moduleInteractions(
    snapshotId: number,
    srcModule: string,
    dstModule: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!srcModule || !dstModule) return []
    // Escape LIKE wildcards in the module names so they're treated
    // literally
    const escape = (s: string): string => s.replace(/[\\%_]/g, "\\$&")
    const srcPrefix = `${escape(srcModule)}#%`
    const dstPrefix = `${escape(dstModule)}#%`
    const sql = `
      SELECT
        src.canonical_name AS caller,
        dst.canonical_name AS callee,
        e.edge_kind AS edge_kind,
        e.confidence AS confidence,
        e.derivation AS derivation,
        src.location AS location,
        e.metadata AS metadata
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind IN ('calls', 'references_type')
        AND (src.canonical_name = ? OR src.canonical_name LIKE ? ESCAPE '\\')
        AND (dst.canonical_name = ? OR dst.canonical_name LIKE ? ESCAPE '\\')
      ORDER BY e.edge_kind, src.canonical_name, dst.canonical_name
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(
        snapshotId,
        srcModule,
        srcPrefix,
        dstModule,
        dstPrefix,
        limit,
      ) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "edge",
      canonical_name: obj.caller,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: obj.edge_kind,
      confidence: toNumber(obj.confidence),
      derivation: obj.derivation,
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      metadata: parseJson(obj.metadata),
    }))
  }

  /**
   * Return degree counts for a single symbol: total incoming and
   * outgoing edges, plus per-edge_kind breakdowns. Visualizers use
   * this to render fan-in/fan-out badges next to a symbol.
   *
   * Returns one row per (direction, edge_kind) pair so the
   * visualizer can pivot client-side. The first column says whether
   * the count is incoming or outgoing.
   */
  private symbolDegree(
    snapshotId: number,
    symbolName: string,
  ): Array<Record<string, unknown>> {
    if (!symbolName) return []
    const sql = `
      SELECT 'outgoing' AS direction, e.edge_kind, COUNT(*) AS count
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      WHERE e.snapshot_id = ?
        AND src.canonical_name = ?
      GROUP BY e.edge_kind
      UNION ALL
      SELECT 'incoming' AS direction, e.edge_kind, COUNT(*) AS count
      FROM graph_edges e
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND dst.canonical_name = ?
      GROUP BY e.edge_kind
      ORDER BY direction, count DESC
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, symbolName, snapshotId, symbolName) as Array<{
      direction: string
      edge_kind: string
      count: number
    }>
    return rows.map((row) => ({
      kind: "edge_count",
      canonical_name: symbolName,
      caller: row.direction === "incoming" ? null : symbolName,
      callee: row.direction === "outgoing" ? null : symbolName,
      edge_kind: row.edge_kind,
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      direction: row.direction,
      degree_count: toNumber(row.count),
    }))
  }

  /**
   * Find cycles in the imports graph that pass through a specific
   * starting module, of length 3 to `depth`. Uses a recursive CTE
   * that walks forward only from the requested module, which bounds
   * the search to the local neighborhood instead of exploring the
   * entire graph (which would be exponential on a 600-module project).
   *
   * Each cycle returns one row whose `path` field contains the full
   * sequence of module names involved (e.g.
   * `module:src/a.ts -> module:src/b.ts -> module:src/c.ts -> module:src/a.ts`).
   *
   * Cycles are de-duped by their canonical (sorted) member set — the
   * same cycle starting at a different rotation only appears once.
   * The first row's `path` shows the canonical traversal.
   *
   * Required: apiName must be the canonical_name of a module. Without
   * a starting module the query would explode combinatorially.
   */
  private importCyclesDeep(
    snapshotId: number,
    rootName: string,
    depth: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!rootName) return []
    const maxDepth = Math.min(Math.max(depth, 3), 8)
    const sql = `
      WITH RECURSIVE walks(start_name, current_name, depth_n, path) AS (
        SELECT
          src.canonical_name,
          dst.canonical_name,
          1,
          src.canonical_name || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'imports'
          AND src.kind = 'module'
          AND dst.kind = 'module'
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          w.start_name,
          dst.canonical_name,
          w.depth_n + 1,
          w.path || ' -> ' || dst.canonical_name
        FROM walks w
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'imports'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id
          AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = w.current_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id
          AND e.snapshot_id = dst.snapshot_id
        WHERE w.depth_n < ?
          -- prevent revisiting nodes other than the start
          AND (
            dst.canonical_name = w.start_name
            OR instr(w.path || ' -> ', dst.canonical_name || ' -> ') = 0
          )
      )
      SELECT DISTINCT
        depth_n + 1 AS cycle_length,
        path
      FROM walks
      WHERE current_name = start_name
        AND depth_n >= 2
      ORDER BY cycle_length ASC, path ASC
      LIMIT ?
    `
    type Row = { cycle_length: number; path: string }
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, rootName, snapshotId, maxDepth, limit) as Row[]
    // De-dup cycles by their canonical (sorted) member set so the same
    // cycle starting from different nodes only appears once.
    const seen = new Set<string>()
    const out: Array<Record<string, unknown>> = []
    for (const row of rows) {
      const segments = row.path.split(" -> ")
      // The path always closes back to the start, so the last segment
      // duplicates the first. Strip it for the canonical key.
      const ring = segments.slice(0, -1)
      const key = [...ring].sort().join("|")
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        kind: "module",
        canonical_name: ring[0],
        caller: ring[0],
        callee: ring[ring.length - 1],
        edge_kind: "imports",
        confidence: 1,
        derivation: "clangd",
        file_path: null,
        line_number: null,
        cycle_length: row.cycle_length - 1, // edges = nodes (since cycle closes)
        path: row.path,
      })
    }
    return out
  }

  /**
   * For a given module, return its exported symbols ranked by total
   * incoming usage (calls + references_type). Useful for "the most-used
   * exports of this module" views in API health dashboards.
   *
   * Implementation: a join between graph_nodes (the module's contained
   * symbols where exported=true) and a count of incoming usage edges.
   * Symbols are ordered DESC by usage_count, with ties broken
   * alphabetically.
   */
  private moduleTopExports(
    snapshotId: number,
    moduleName: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!moduleName) return []
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind AS kind,
        n.location AS location,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind IN ('calls', 'references_type')
            AND dst.canonical_name = n.canonical_name
        ) AS usage_count
      FROM graph_nodes n
      INNER JOIN graph_edges contains
        ON contains.dst_node_id = n.node_id
        AND contains.snapshot_id = n.snapshot_id
        AND contains.edge_kind = 'contains'
      INNER JOIN graph_nodes parent
        ON contains.src_node_id = parent.node_id
        AND contains.snapshot_id = parent.snapshot_id
      WHERE n.snapshot_id = ?
        AND parent.canonical_name = ?
        AND parent.kind = 'module'
        AND json_extract(n.payload, '$.metadata.exported') = 1
      ORDER BY usage_count DESC, n.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, moduleName, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      usage_count: toNumber(obj.usage_count),
    }))
  }

  /**
   * Find sibling symbols: peers that share the same parent via
   * contains edges. When the user clicks on a method, this returns
   * the other methods of the same class. When the user clicks on a
   * top-level function, it returns the other top-level symbols in
   * the same module. The original symbol is excluded.
   *
   * Two-step query: a CTE finds the symbol's parent (the src of any
   * incoming contains edge), then the outer SELECT enumerates that
   * parent's other children. Uses canonical_name throughout for
   * legibility.
   */
  private siblingSymbols(
    snapshotId: number,
    symbolName: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!symbolName) return []
    const sql = `
      WITH parent AS (
        SELECT src.canonical_name AS name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'contains'
          AND dst.canonical_name = ?
        LIMIT 1
      )
      SELECT DISTINCT
        dst.canonical_name AS canonical_name,
        dst.kind AS kind,
        dst.location AS location
      FROM graph_edges e
      INNER JOIN graph_nodes src
        ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      INNER JOIN parent p ON src.canonical_name = p.name
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'contains'
        AND dst.canonical_name != ?
      ORDER BY json_extract(dst.location, '$.line') ASC, dst.canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, symbolName, snapshotId, symbolName, limit) as Array<
      Record<string, unknown>
    >
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * List all symbols defined in a given file, ordered by start line.
   * Used by visualizer file-outline views — the visualizer can pass
   * a filepath without having to construct the module FQ name first.
   *
   * Returns every symbol whose location.filePath matches, including
   * the module symbol itself, top-level functions/classes, and nested
   * methods. Modules and members both flow through.
   */
  private symbolsInFile(
    snapshotId: number,
    filePath: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!filePath) return []
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.endLine') AS end_line
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND json_extract(location, '$.filePath') = ?
      ORDER BY json_extract(location, '$.line') ASC, canonical_name ASC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, filePath, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      end_line: toNumberOrNull(obj.end_line),
    }))
  }

  /**
   * Aggregate health summary for a single module. Returns one row
   * with these fields:
   *   - symbol_count: contained symbols (direct children via contains)
   *   - exported_count: contained symbols with metadata.exported=true
   *   - outgoing_imports: number of imports edges originating here
   *   - incoming_imports: number of imports edges pointing here
   *   - line_count: from the module's metadata.lineCount
   *
   * Visualizers use this for module browser hovers, tab badges, and
   * "module health at a glance" views.
   */
  private moduleSummary(
    snapshotId: number,
    moduleName: string,
  ): Array<Record<string, unknown>> {
    if (!moduleName) return []
    const sql = `
      SELECT
        m.canonical_name AS canonical_name,
        m.location AS location,
        json_extract(m.payload, '$.metadata.lineCount') AS line_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'contains'
            AND src.canonical_name = m.canonical_name
        ) AS symbol_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'contains'
            AND src.canonical_name = m.canonical_name
            AND json_extract(dst.payload, '$.metadata.exported') = 1
        ) AS exported_count,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes src
            ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND src.canonical_name = m.canonical_name
        ) AS outgoing_imports,
        (
          SELECT COUNT(*) FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND dst.canonical_name = m.canonical_name
        ) AS incoming_imports
      FROM graph_nodes m
      WHERE m.snapshot_id = ?
        AND m.kind = 'module'
        AND m.canonical_name = ?
      LIMIT 1
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, moduleName) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      symbol_count: toNumber(obj.symbol_count),
      exported_count: toNumber(obj.exported_count),
      outgoing_imports: toNumber(obj.outgoing_imports),
      incoming_imports: toNumber(obj.incoming_imports),
      line_count: toNumberOrNull(obj.line_count),
    }))
  }

  /**
   * Find distinct external (npm/bare) imports with usage counts.
   * Internal imports have a `module:path/with/slashes` form; external
   * imports are bare like `module:react` or `module:effect`. The
   * heuristic: an import dst is external if there's no graph_node
   * row with that canonical_name in the same snapshot — internal
   * modules are always extracted as graph_nodes.
   *
   * Result rows are ordered DESC by usage count so the most-relied-on
   * dependencies appear first. Each row has an `incoming_count` field
   * showing how many imports edges point at the package.
   */
  private externalImports(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        e.dst_node_id AS dst_id,
        REPLACE(e.dst_node_id,
          'graph_node:' || e.snapshot_id || ':symbol:',
          '') AS canonical_name,
        COUNT(*) AS usage_count
      FROM graph_edges e
      WHERE e.snapshot_id = ?
        AND e.edge_kind = 'imports'
        AND NOT EXISTS (
          SELECT 1 FROM graph_nodes n
          WHERE n.snapshot_id = e.snapshot_id
            AND n.node_id = e.dst_node_id
        )
      GROUP BY e.dst_node_id
      ORDER BY usage_count DESC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      incoming_count: toNumber(obj.usage_count),
    }))
  }

  /**
   * Find functions/methods exceeding a line-count threshold. Uses
   * the metadata.lineCount field set by D25. Visualizers can use
   * this to show "this function is too big" hints or rank symbols
   * by complexity proxy.
   *
   * The threshold comes from request.depth (a slight overload of
   * the depth field for size-based queries — naming a separate
   * minLineCount field would be cleaner but adding fields to
   * QueryRequest each round adds clutter). Default 50 lines.
   */
  private longFunctions(
    snapshotId: number,
    minLines: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.lineCount') AS line_count
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND kind IN ('function', 'method')
        AND CAST(json_extract(payload, '$.metadata.lineCount') AS INTEGER) >= ?
      ORDER BY CAST(json_extract(payload, '$.metadata.lineCount') AS INTEGER) DESC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, minLines, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      line_count: toNumberOrNull(obj.line_count),
    }))
  }

  /**
   * Find the innermost symbol whose source range contains a given
   * file/line. Used by visualizers for click-to-symbol navigation.
   *
   * Range check uses location.line (start) and metadata.endLine (set
   * by D25). The result is ORDER BY (endLine - startLine) ASC so the
   * smallest containing scope wins — a method inside a class returns
   * the method, not the class.
   *
   * Returns up to `limit` rows (usually 1 is enough but allowing more
   * lets the visualizer show all containing scopes if it wants).
   */
  private symbolAtLocation(
    snapshotId: number,
    filePath: string,
    lineNumber: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!filePath || lineNumber <= 0) return []
    const sql = `
      SELECT
        canonical_name,
        kind,
        location,
        json_extract(payload, '$.metadata.endLine') AS end_line,
        json_extract(location, '$.line') AS start_line
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND json_extract(location, '$.filePath') = ?
        AND json_extract(location, '$.line') <= ?
        AND COALESCE(json_extract(payload, '$.metadata.endLine'), json_extract(location, '$.line')) >= ?
        AND kind != 'module'
      ORDER BY
        (COALESCE(json_extract(payload, '$.metadata.endLine'), json_extract(location, '$.line'))
          - json_extract(location, '$.line')) ASC,
        json_extract(location, '$.line') DESC
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, filePath, lineNumber, lineNumber, limit) as Array<
      Record<string, unknown>
    >
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: toNumberOrNull(obj.start_line),
      end_line: toNumberOrNull(obj.end_line),
    }))
  }

  /**
   * Find the full transitive imports closure of a module — every
   * module reachable via repeated imports edges, with the depth at
   * which it was discovered. Cycle prevention via the running path
   * string. Bounded depth (default 10, clamped to [1, 20]) keeps
   * the query bounded on huge graphs.
   *
   * Returned rows have an extra `transitive_depth` field. The starting
   * module is at depth 0 (not included in results — the visualizer
   * already knows the root). Each unique downstream module appears
   * exactly once at its shortest distance.
   */
  private transitiveDependencies(
    snapshotId: number,
    rootName: string,
    depth: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!rootName) return []
    const maxDepth = Math.min(Math.max(depth, 1), 20)
    const sql = `
      WITH RECURSIVE deps(module_name, depth_n, path) AS (
        SELECT
          dst.canonical_name,
          1,
          ? || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'imports'
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          dst.canonical_name,
          d.depth_n + 1,
          d.path || ' -> ' || dst.canonical_name
        FROM deps d
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'imports'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id
          AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = d.module_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id
          AND e.snapshot_id = dst.snapshot_id
        WHERE d.depth_n < ?
          AND instr(d.path || ' -> ', dst.canonical_name || ' -> ') = 0
      )
      SELECT module_name, MIN(depth_n) AS shortest_depth
      FROM deps
      GROUP BY module_name
      ORDER BY shortest_depth ASC, module_name ASC
      LIMIT ?
    `
    type Row = { module_name: string; shortest_depth: number }
    const rows = this.raw
      .prepare(sql)
      .all(rootName, snapshotId, rootName, snapshotId, maxDepth, limit) as Row[]
    return rows.map((row) => ({
      kind: row.module_name.includes("#") ? "symbol" : "module",
      canonical_name: row.module_name,
      caller: rootName,
      callee: row.module_name,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      transitive_depth: row.shortest_depth,
    }))
  }

  /**
   * Browse all symbols of a given kind in the snapshot. Used by
   * visualizer kind-filtered views ("show me all classes", "show
   * me all interfaces"). Sorts alphabetically for deterministic
   * pagination.
   */
  private symbolsByKind(
    snapshotId: number,
    kind: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!kind || kind.length === 0) return []
    const sql = `
      SELECT
        canonical_name,
        kind,
        location
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND kind = ?
      ORDER BY canonical_name
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, kind, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? kind,
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Substring search across graph_nodes by canonical_name. Used by
   * visualizer search boxes — returns all symbols whose name
   * contains the given pattern (case-insensitive in SQLite by
   * default for ASCII). Sorts alphabetically for deterministic
   * pagination.
   */
  private symbolsByName(
    snapshotId: number,
    pattern: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!pattern || pattern.length === 0) return []
    const sql = `
      SELECT
        canonical_name,
        kind,
        location
      FROM graph_nodes
      WHERE snapshot_id = ?
        AND canonical_name LIKE ?
      ORDER BY canonical_name
      LIMIT ?
    `
    // Escape any LIKE wildcards in the user pattern
    const safe = pattern.replace(/[\\%_]/g, "\\$&")
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, `%${safe}%`, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find a shortest call chain from srcApi to dstApi via a bounded
   * BFS over the calls graph. Implementation: SQLite recursive CTE
   * that walks dst.canonical_name forward, joining graph_nodes at
   * each step to filter the destination by name.
   *
   * Returns one row per hop in the chain, ordered by depth, with
   * `caller`, `callee`, `path_index`, and `chain_depth` fields. The
   * visualizer can render this as a vertical call list.
   *
   * Returns an empty list when:
   *   - srcApi or dstApi is empty
   *   - No path exists within the depth bound
   *   - The chain would exceed the depth bound
   */
  private callChain(
    snapshotId: number,
    srcApi: string,
    dstApi: string,
    depth: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    if (!srcApi || !dstApi) return []
    const maxDepth = Math.min(Math.max(depth, 1), 10)
    // The recursive CTE walks forward via calls edges, tracking the
    // path through `prev_canonical` so we can reconstruct the chain
    // at the end. We use canonical_name (not node_id) so the join
    // back to graph_nodes is direct.
    const sql = `
      WITH RECURSIVE chain(caller_name, callee_name, depth_n, path) AS (
        SELECT
          src.canonical_name,
          dst.canonical_name,
          1,
          src.canonical_name || ' -> ' || dst.canonical_name
        FROM graph_edges e
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE e.snapshot_id = ?
          AND e.edge_kind = 'calls'
          AND src.canonical_name = ?
        UNION ALL
        SELECT
          c.callee_name,
          dst.canonical_name,
          c.depth_n + 1,
          c.path || ' -> ' || dst.canonical_name
        FROM chain c
        INNER JOIN graph_edges e
          ON e.snapshot_id = ?
          AND e.edge_kind = 'calls'
        INNER JOIN graph_nodes src
          ON e.src_node_id = src.node_id AND e.snapshot_id = src.snapshot_id
          AND src.canonical_name = c.callee_name
        INNER JOIN graph_nodes dst
          ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
        WHERE c.depth_n < ?
          -- avoid revisiting nodes already in the path (cycle prevention)
          AND instr(c.path || ' -> ', dst.canonical_name || ' -> ') = 0
      )
      SELECT caller_name, callee_name, depth_n, path
      FROM chain
      WHERE callee_name = ?
      ORDER BY depth_n ASC
      LIMIT ?
    `
    type Row = {
      caller_name: string
      callee_name: string
      depth_n: number
      path: string
    }
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, srcApi, snapshotId, maxDepth, dstApi, limit) as Row[]
    // Take the shortest chain. Expand its path into per-hop rows.
    if (rows.length === 0) return []
    const shortest = rows[0]
    const segments = shortest.path.split(" -> ")
    return segments.slice(0, -1).map((caller, i) => ({
      kind: "function",
      canonical_name: caller,
      caller,
      callee: segments[i + 1],
      edge_kind: "calls",
      confidence: 1,
      derivation: "clangd",
      file_path: null,
      line_number: null,
      path_index: i,
      chain_depth: shortest.depth_n,
    }))
  }

  /**
   * Find exported symbols (functions/classes/interfaces) with zero
   * incoming calls AND zero incoming references_type. Likely dead
   * public API: declared in an `export ...` statement but nobody
   * actually uses them. Visualizers can surface these as refactor
   * targets.
   *
   * Filters:
   *   - kind IN (function, class, interface, method)
   *   - payload.metadata.exported = true (set by D26)
   *   - NOT EXISTS incoming calls edges
   *   - NOT EXISTS incoming references_type edges
   *
   * Methods inside an exported class don't carry exported=true (the
   * class does), so this query finds exported top-level functions,
   * classes, and interfaces specifically.
   */
  private deadExports(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        n.canonical_name AS canonical_name,
        n.kind AS kind,
        n.location AS location
      FROM graph_nodes n
      WHERE n.snapshot_id = ?
        AND n.kind IN ('function', 'class', 'interface')
        AND json_extract(n.payload, '$.metadata.exported') = 1
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = n.snapshot_id
            AND e.edge_kind IN ('calls', 'references_type', 'extends', 'implements')
            AND dst.canonical_name = n.canonical_name
        )
      ORDER BY n.canonical_name
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "function",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "contains",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find modules with zero incoming imports — likely entry points
   * (CLI files, test files, scripts, top-level pages). The query
   * returns module nodes that don't appear as the dst of any imports
   * edge. Visualizers can use this to root the dependency tree or
   * highlight scripts that are only invoked externally.
   */
  private moduleEntryPoints(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        m.canonical_name AS canonical_name,
        m.kind AS kind,
        m.location AS location
      FROM graph_nodes m
      WHERE m.snapshot_id = ? AND m.kind = 'module'
        AND NOT EXISTS (
          SELECT 1 FROM graph_edges e
          INNER JOIN graph_nodes dst
            ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
          WHERE e.snapshot_id = m.snapshot_id
            AND e.edge_kind = 'imports'
            AND dst.canonical_name = m.canonical_name
        )
      ORDER BY m.canonical_name
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

  /**
   * Find the top-N nodes ranked by their incoming-edge count for a
   * given edge_kind. Useful for "hot spots" / hubs / most-X views in
   * visualizers. Optionally filters the dst node kind (e.g. only
   * count incoming edges to modules, or only to functions).
   *
   * Result rows include `incoming_count` so the visualizer can
   * render the in-degree alongside the symbol.
   */
  private topByIncoming(
    snapshotId: number,
    edgeKind: string,
    dstKind: string | null,
    limit: number,
  ): Array<Record<string, unknown>> {
    const kindFilter = dstKind ? "AND dst.kind = ?" : ""
    const sql = `
      SELECT
        dst.canonical_name AS canonical_name,
        dst.kind AS kind,
        dst.location AS location,
        COUNT(*) AS incoming_count
      FROM graph_edges e
      INNER JOIN graph_nodes dst
        ON e.dst_node_id = dst.node_id AND e.snapshot_id = dst.snapshot_id
      WHERE e.snapshot_id = ?
        AND e.edge_kind = ?
        ${kindFilter}
      GROUP BY dst.canonical_name, dst.kind, dst.location
      ORDER BY incoming_count DESC
      LIMIT ?
    `
    const params: Array<string | number> = [snapshotId, edgeKind]
    if (dstKind) params.push(dstKind)
    params.push(limit)
    const rows = this.raw
      .prepare(sql)
      .all(...params) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: obj.kind ?? "module",
      canonical_name: obj.canonical_name,
      caller: null,
      callee: obj.canonical_name,
      edge_kind: edgeKind,
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
      incoming_count: toNumber(obj.incoming_count),
    }))
  }

  /**
   * Find pairs of modules that mutually import each other (2-cycles
   * in the imports graph). Detected via a self-join: edge1 (A→B)
   * matched against edge2 (B→A) on the same snapshot. The
   * canonical_name comparison filters duplicates so each cycle
   * appears once as (a, b) with a < b alphabetically.
   *
   * Doesn't take an apiName — returns all cycles in the snapshot.
   * Visualizers can render these as bidirectional edges or refactor
   * suggestions.
   */
  private importCycles(
    snapshotId: number,
    limit: number,
  ): Array<Record<string, unknown>> {
    const sql = `
      SELECT
        a.canonical_name AS caller,
        b.canonical_name AS callee,
        a.canonical_name AS canonical_name,
        'module' AS kind,
        'imports' AS edge_kind,
        1.0 AS confidence,
        'clangd' AS derivation,
        a.location AS location
      FROM graph_edges e1
      INNER JOIN graph_nodes a
        ON e1.src_node_id = a.node_id AND e1.snapshot_id = a.snapshot_id
      INNER JOIN graph_nodes b
        ON e1.dst_node_id = b.node_id AND e1.snapshot_id = b.snapshot_id
      INNER JOIN graph_edges e2
        ON e2.snapshot_id = e1.snapshot_id
        AND e2.src_node_id = e1.dst_node_id
        AND e2.dst_node_id = e1.src_node_id
      WHERE e1.snapshot_id = ?
        AND e1.edge_kind = 'imports'
        AND e2.edge_kind = 'imports'
        AND a.kind = 'module' AND b.kind = 'module'
        AND a.canonical_name < b.canonical_name
      LIMIT ?
    `
    const rows = this.raw
      .prepare(sql)
      .all(snapshotId, limit) as Array<Record<string, unknown>>
    return rows.map((obj) => ({
      kind: "module",
      canonical_name: obj.canonical_name,
      caller: obj.caller,
      callee: obj.callee,
      edge_kind: "imports",
      confidence: 1,
      derivation: "clangd",
      file_path: extractFilePath(obj.location),
      line_number: extractLine(obj.location),
    }))
  }

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
