/**
 * Neo4jDbLookup — real Cypher-backed implementation of DbLookupRepository.
 *
 * Replaces NoopDbLookup in backend-factory.ts.  Each intent maps to a
 * purpose-written Cypher query against the GraphNode / GraphEdge /
 * GraphObservation node-labels that graph-store.ts writes during ingest.
 */
import { int as neo4jInt } from "neo4j-driver"
import type { DbLookupRepository, LookupResult, QueryRequest } from "../../contracts/orchestrator.js"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Combine apiName + apiNameAliases into one de-duplicated array. */
function buildApiNames(request: QueryRequest): string[] {
  const names = [
    ...(request.apiName ? [request.apiName] : []),
    ...(request.apiNameAliases ?? []),
  ].filter(Boolean)
  // de-duplicate while preserving order
  return [...new Set(names)]
}

function miss(request: QueryRequest): LookupResult {
  return { hit: false, intent: request.intent, snapshotId: request.snapshotId, rows: [] }
}

// ---------------------------------------------------------------------------
// public class
// ---------------------------------------------------------------------------

export class Neo4jDbLookup implements DbLookupRepository {
  constructor(private readonly driver: unknown) {}

  async lookup(request: QueryRequest): Promise<LookupResult> {
    const session = (this.driver as { session(): unknown }).session() as {
      run(cypher: string, params?: Record<string, unknown>): Promise<{
        records: Array<{ toObject(): Record<string, unknown> }>
      }>
      close(): Promise<void>
    }

    try {
      // Build a param-bag that replaces snapshotId and limit with proper
      // Neo4j Integer objects — the Bolt protocol rejects JS floats for LIMIT.
      const neo4jSnapshotId = toNeo4jInt(request.snapshotId)
      const neo4jLimit = toNeo4jInt(request.limit ?? 200)
      // Cast back through unknown so TypeScript accepts the Neo4j Integer
      // in the QueryRequest slots (the driver serialises them correctly).
      const normRequest: QueryRequest = {
        ...request,
        snapshotId: neo4jSnapshotId as unknown as number,
        limit: neo4jLimit as unknown as number,
      }
      const rows = await this._dispatch(session, normRequest)
      return { hit: rows.length > 0, intent: request.intent, snapshotId: request.snapshotId, rows }
    } catch (_err) {
      return miss(request)
    } finally {
      await session.close()
    }
  }

  // -------------------------------------------------------------------------
  // intent dispatcher
  // -------------------------------------------------------------------------

  private async _dispatch(
    session: {
      run(cypher: string, params?: Record<string, unknown>): Promise<{
        records: Array<{ toObject(): Record<string, unknown> }>
      }>
    },
    request: QueryRequest,
  ): Promise<Array<Record<string, unknown>>> {
    const { intent, snapshotId } = request
    const limit = request.limit ?? 200
    const apiNames = buildApiNames(request)

    switch (intent) {
      // ── callers (static + runtime) ────────────────────────────────────────
      case "who_calls_api":
        return this._callers(session, snapshotId, apiNames, ["calls", "runtime_calls"], limit)

      case "who_calls_api_at_runtime":
        return this._runtimeCallers(session, snapshotId, apiNames, limit)

      // ── callees ──────────────────────────────────────────────────────────
      case "what_api_calls":
        return this._callees(session, snapshotId, apiNames, limit)

      // ── logs ─────────────────────────────────────────────────────────────
      case "find_api_logs":
        return this._apiLogs(session, snapshotId, apiNames, undefined, limit)

      case "find_api_logs_by_level":
        return this._apiLogs(session, snapshotId, apiNames, request.logLevel, limit)

      // ── timers ────────────────────────────────────────────────────────────
      case "find_api_timer_triggers":
        return this._timerTriggers(session, snapshotId, apiNames, limit)

      // ── registration / dispatch ───────────────────────────────────────────
      case "show_registration_chain":
      case "find_callback_registrars":
        return this._registrationChain(session, snapshotId, apiNames, limit)

      case "show_dispatch_sites":
        return this._dispatchSites(session, snapshotId, apiNames, limit)

      // ── struct writers / readers ──────────────────────────────────────────
      case "find_struct_writers":
      case "where_struct_modified": {
        const structNames = request.structName ? [request.structName] : apiNames
        return this._structAccess(session, snapshotId, structNames, "writes_field", limit)
      }

      case "find_struct_readers":
      case "where_struct_initialized": {
        const structNames = request.structName ? [request.structName] : apiNames
        return this._structAccess(session, snapshotId, structNames, "reads_field", limit)
      }

      case "find_struct_owners": {
        const structNames = request.structName ? [request.structName] : apiNames
        return this._structAccess(session, snapshotId, structNames, "owns", limit)
      }

      // ── API-centric struct read/write (api side) ──────────────────────────
      case "find_api_struct_writes":
        return this._apiStructAccess(session, snapshotId, apiNames, "writes_field", limit)

      case "find_api_struct_reads":
        return this._apiStructAccess(session, snapshotId, apiNames, "reads_field", limit)

      // ── field access path ─────────────────────────────────────────────────
      case "find_field_access_path":
        return this._fieldAccessPath(session, snapshotId, request.structName, request.fieldName, limit)

      // ── cross-module path ─────────────────────────────────────────────────
      case "show_cross_module_path":
        return this._crossModulePath(session, snapshotId, request.srcApi, request.dstApi, limit)

      // ── hot call paths (diagnostic probe) ────────────────────────────────
      case "show_hot_call_paths":
        return this._hotCallPaths(session, snapshotId, apiNames, limit)

      // ── runtime observation intents ───────────────────────────────────────
      case "why_api_invoked":
      case "show_runtime_flow_for_trace":
      case "show_api_runtime_observations":
        return this._observations(session, snapshotId, apiNames, request.traceId, limit)

      // ── log pattern search ────────────────────────────────────────────────
      case "find_api_by_log_pattern":
        return this._logPattern(session, snapshotId, request.pattern, limit)

      default:
        return []
    }
  }

  // =========================================================================
  // private query methods
  // =========================================================================

  // ── who_calls_api (static + runtime callers) ─────────────────────────────

  private async _callers(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    edgeKinds: string[],
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0) return []
    const result = await session.run(
      `MATCH (src:GraphNode)
       MATCH (dst:GraphNode)
       MATCH (e:GraphEdge)
       WHERE dst.snapshot_id = $snapshotId
         AND dst.canonical_name IN $apiNames
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind IN $edgeKinds
         AND e.dst_node_id = dst.node_id
         AND e.src_node_id = src.node_id
         AND src.snapshot_id = $snapshotId
       RETURN src.canonical_name AS caller,
              dst.canonical_name AS callee,
              src.kind AS kind,
              src.canonical_name AS canonical_name,
              e.edge_kind AS edge_kind,
              e.confidence AS confidence,
              e.derivation AS derivation,
              src.location AS location
       LIMIT $limit`,
      { snapshotId, apiNames, edgeKinds, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name ?? obj.caller,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── who_calls_api_at_runtime (edges + observations) ──────────────────────

  private async _runtimeCallers(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0) return []

    // 1. Runtime edges (runtime_calls)
    const edgeRows = await this._callers(session, snapshotId, apiNames, ["runtime_calls"], limit)

    // 2. GraphObservation nodes
    const obsResult = await session.run(
      `MATCH (obs:GraphObservation)
       WHERE obs.snapshot_id = $snapshotId
         AND obs.kind = 'runtime_invocation'
         AND obs.payload IS NOT NULL
       WITH obs
       WHERE obs.payload.target_api IN $apiNames
       RETURN obs.payload.immediate_invoker AS caller,
              obs.payload.target_api AS callee,
              obs.payload.runtime_trigger AS runtime_trigger,
              obs.payload.dispatch_chain AS dispatch_chain,
              obs.payload.dispatch_site AS dispatch_site,
              obs.confidence AS confidence
       LIMIT $limit`,
      { snapshotId, apiNames, limit },
    )

    const obsRows: Array<Record<string, unknown>> = obsResult.records.map((r) => {
      const obj = r.toObject()
      const site = obj.dispatch_site as Record<string, unknown> | null | undefined
      return {
        kind: "function",
        canonical_name: obj.caller,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: "runtime_calls",
        confidence: toNumber(obj.confidence),
        derivation: "runtime",
        runtime_trigger: obj.runtime_trigger,
        dispatch_chain: obj.dispatch_chain,
        dispatch_site: obj.dispatch_site,
        file_path: site?.filePath ?? null,
        line_number: site?.line != null ? toNumber(site.line) : null,
      }
    })

    // Merge, preferring observation rows (richer data) when both exist
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

  // ── what_api_calls (outgoing) ─────────────────────────────────────────────

  private async _callees(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0) return []
    const result = await session.run(
      `MATCH (src:GraphNode)
       MATCH (dst:GraphNode)
       MATCH (e:GraphEdge)
       WHERE src.snapshot_id = $snapshotId
         AND src.canonical_name IN $apiNames
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind IN ['calls', 'runtime_calls']
         AND e.src_node_id = src.node_id
         AND e.dst_node_id = dst.node_id
         AND dst.snapshot_id = $snapshotId
       RETURN src.canonical_name AS caller,
              dst.canonical_name AS callee,
              dst.kind AS kind,
              dst.canonical_name AS canonical_name,
              e.edge_kind AS edge_kind,
              e.confidence AS confidence,
              e.derivation AS derivation,
              dst.location AS location
       LIMIT $limit`,
      { snapshotId, apiNames, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name ?? obj.callee,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── find_api_logs / find_api_logs_by_level ────────────────────────────────

  private async _apiLogs(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    logLevel: string | undefined,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0) return []
    const levelFilter = logLevel
      ? "AND e.metadata IS NOT NULL AND e.metadata.log_level = $logLevel"
      : ""
    const result = await session.run(
      `MATCH (src:GraphNode)
       MATCH (log:GraphNode)
       MATCH (e:GraphEdge)
       WHERE src.snapshot_id = $snapshotId
         AND src.canonical_name IN $apiNames
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind = 'logs_event'
         ${levelFilter}
         AND e.src_node_id = src.node_id
         AND e.dst_node_id = log.node_id
         AND log.snapshot_id = $snapshotId
         AND log.kind = 'log_point'
       RETURN src.canonical_name AS api_name,
              log.canonical_name AS canonical_name,
              log.kind AS kind,
              e.metadata AS metadata,
              e.confidence AS confidence,
              e.derivation AS derivation,
              src.location AS src_location,
              log.location AS log_location
       LIMIT $limit`,
      { snapshotId, apiNames, logLevel: logLevel ?? null, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      const meta = asMap(obj.metadata)
      return {
        kind: "log_point",
        api_name: obj.api_name,
        canonical_name: obj.canonical_name,
        template: meta?.template ?? meta?.log_template ?? obj.canonical_name,
        log_level: meta?.log_level ?? "UNKNOWN",
        subsystem: meta?.subsystem ?? null,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.src_location) ?? extractFilePath(obj.log_location),
        line_number: extractLine(obj.src_location) ?? extractLine(obj.log_location),
        edge_kind: "logs_event",
        caller: obj.api_name,
        callee: obj.canonical_name,
      }
    })
  }

  // ── find_api_timer_triggers ───────────────────────────────────────────────

  private async _timerTriggers(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0) return []
    const result = await session.run(
      `MATCH (timer:GraphNode)
       MATCH (dst:GraphNode)
       MATCH (e:GraphEdge)
       WHERE dst.snapshot_id = $snapshotId
         AND dst.canonical_name IN $apiNames
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind IN ['runtime_calls', 'calls']
         AND e.src_node_id = timer.node_id
         AND e.dst_node_id = dst.node_id
         AND timer.snapshot_id = $snapshotId
         AND timer.kind = 'timer'
       RETURN timer.canonical_name AS timer_identifier_name,
              timer.canonical_name AS canonical_name,
              timer.kind AS kind,
              dst.canonical_name AS callee,
              e.edge_kind AS edge_kind,
              e.confidence AS confidence,
              e.derivation AS derivation,
              e.metadata AS metadata,
              timer.location AS location
       LIMIT $limit`,
      { snapshotId, apiNames, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      const meta = asMap(obj.metadata)
      return {
        kind: "timer",
        canonical_name: obj.canonical_name,
        timer_identifier_name: obj.timer_identifier_name,
        timer_trigger_condition_description: meta?.timer_trigger_condition_description ?? null,
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

  // ── show_registration_chain / find_callback_registrars ────────────────────

  private async _registrationChain(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0) return []
    const result = await session.run(
      `MATCH (registrar:GraphNode)
       MATCH (callback:GraphNode)
       MATCH (e:GraphEdge)
       WHERE callback.snapshot_id = $snapshotId
         AND callback.canonical_name IN $apiNames
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind = 'registers_callback'
         AND e.src_node_id = registrar.node_id
         AND e.dst_node_id = callback.node_id
         AND registrar.snapshot_id = $snapshotId
       RETURN registrar.canonical_name AS registrar,
              callback.canonical_name AS callback,
              registrar.canonical_name AS canonical_name,
              registrar.kind AS kind,
              e.metadata AS metadata,
              e.confidence AS confidence,
              e.derivation AS derivation,
              registrar.location AS location
       LIMIT $limit`,
      { snapshotId, apiNames, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      const meta = asMap(obj.metadata)
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        registrar: obj.registrar,
        callback: obj.callback,
        registration_api: meta?.registration_api ?? obj.registrar,
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

  // ── show_dispatch_sites ───────────────────────────────────────────────────

  private async _dispatchSites(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0) return []
    const result = await session.run(
      `MATCH (dispatcher:GraphNode)
       MATCH (dst:GraphNode)
       MATCH (e:GraphEdge)
       WHERE dst.snapshot_id = $snapshotId
         AND dst.canonical_name IN $apiNames
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind = 'dispatches_to'
         AND e.src_node_id = dispatcher.node_id
         AND e.dst_node_id = dst.node_id
         AND dispatcher.snapshot_id = $snapshotId
       RETURN dispatcher.canonical_name AS caller,
              dst.canonical_name AS callee,
              dispatcher.canonical_name AS canonical_name,
              dispatcher.kind AS kind,
              e.metadata AS metadata,
              e.confidence AS confidence,
              e.derivation AS derivation,
              dispatcher.location AS location
       LIMIT $limit`,
      { snapshotId, apiNames, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      const meta = asMap(obj.metadata)
      const filePath = extractFilePath(obj.location) ?? String(asMap(meta?.dispatch_site)?.filePath ?? "")
      const lineNumber = extractLine(obj.location) ?? toNumberOrNull(asMap(meta?.dispatch_site)?.line)
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

  // ── find_struct_writers / find_struct_readers / find_struct_owners ─────────

  private async _structAccess(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    structNames: string[],
    edgeKind: string,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (structNames.length === 0) return []
    const result = await session.run(
      `MATCH (accessor:GraphNode)
       MATCH (target:GraphNode)
       MATCH (e:GraphEdge)
       WHERE target.snapshot_id = $snapshotId
         AND target.canonical_name IN $structNames
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind = $edgeKind
         AND e.src_node_id = accessor.node_id
         AND e.dst_node_id = target.node_id
         AND accessor.snapshot_id = $snapshotId
       RETURN accessor.canonical_name AS accessor_name,
              target.canonical_name AS target,
              target.canonical_name AS struct_name,
              accessor.kind AS kind,
              accessor.canonical_name AS canonical_name,
              e.edge_kind AS edge_kind,
              e.metadata AS metadata,
              e.confidence AS confidence,
              e.derivation AS derivation,
              accessor.location AS location
       LIMIT $limit`,
      { snapshotId, structNames, edgeKind, limit },
    )

    const roleByEdgeKind: Record<string, string> = {
      writes_field: "writer",
      reads_field: "reader",
      owns: "owner",
      operates_on_struct: "reader",
    }
    const role = roleByEdgeKind[edgeKind] ?? "accessor"

    return result.records.map((r) => {
      const obj = r.toObject()
      const meta = asMap(obj.metadata)
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

  // ── find_api_struct_writes / find_api_struct_reads (API-centric, src side) ─

  private async _apiStructAccess(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    edgeKind: string,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0) return []
    const result = await session.run(
      `MATCH (src:GraphNode)
       MATCH (dst:GraphNode)
       MATCH (e:GraphEdge)
       WHERE src.snapshot_id = $snapshotId
         AND src.canonical_name IN $apiNames
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind = $edgeKind
         AND e.src_node_id = src.node_id
         AND e.dst_node_id = dst.node_id
         AND dst.snapshot_id = $snapshotId
       RETURN src.canonical_name AS caller,
              dst.canonical_name AS callee,
              dst.canonical_name AS canonical_name,
              dst.kind AS kind,
              e.edge_kind AS edge_kind,
              e.metadata AS metadata,
              e.confidence AS confidence,
              e.derivation AS derivation,
              src.location AS location
       LIMIT $limit`,
      { snapshotId, apiNames, edgeKind, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      return {
        kind: obj.kind ?? "struct",
        canonical_name: obj.canonical_name ?? obj.callee,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── find_field_access_path ─────────────────────────────────────────────────

  private async _fieldAccessPath(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    structName: string | undefined,
    fieldName: string | undefined,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (!structName && !fieldName) return []
    const result = await session.run(
      `MATCH (accessor:GraphNode)
       MATCH (field:GraphNode)
       MATCH (e:GraphEdge)
       WHERE e.snapshot_id = $snapshotId
         AND e.edge_kind IN ['reads_field', 'writes_field']
         AND e.src_node_id = accessor.node_id
         AND e.dst_node_id = field.node_id
         AND accessor.snapshot_id = $snapshotId
         AND field.snapshot_id = $snapshotId
         AND ($structName IS NULL OR field.canonical_name STARTS WITH $structName)
         AND ($fieldName IS NULL OR field.canonical_name ENDS WITH $fieldName)
       RETURN accessor.canonical_name AS caller,
              field.canonical_name AS callee,
              field.canonical_name AS canonical_name,
              accessor.kind AS kind,
              e.edge_kind AS edge_kind,
              e.metadata AS metadata,
              e.confidence AS confidence,
              e.derivation AS derivation,
              accessor.location AS location
       LIMIT $limit`,
      { snapshotId, structName: structName ?? null, fieldName: fieldName ?? null, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      const meta = asMap(obj.metadata)
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        access_path: meta?.access_path ?? obj.callee,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── show_cross_module_path ─────────────────────────────────────────────────

  private async _crossModulePath(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    srcApi: string | undefined,
    dstApi: string | undefined,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (!srcApi || !dstApi) return []
    const result = await session.run(
      `MATCH (src:GraphNode)
       MATCH (dst:GraphNode)
       MATCH (e:GraphEdge)
       WHERE src.snapshot_id = $snapshotId
         AND src.canonical_name = $srcApi
         AND dst.snapshot_id = $snapshotId
         AND dst.canonical_name = $dstApi
         AND e.snapshot_id = $snapshotId
         AND e.src_node_id = src.node_id
         AND e.dst_node_id = dst.node_id
       RETURN src.canonical_name AS caller,
              dst.canonical_name AS callee,
              src.canonical_name AS canonical_name,
              src.kind AS kind,
              e.edge_kind AS edge_kind,
              e.confidence AS confidence,
              e.derivation AS derivation,
              src.location AS location
       LIMIT $limit`,
      { snapshotId, srcApi, dstApi, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── show_hot_call_paths (diagnostic probe) ────────────────────────────────

  private async _hotCallPaths(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    // Any edges in the snapshot — used as a diagnostic probe to detect empty snapshots.
    const result = await session.run(
      `MATCH (src:GraphNode)
       MATCH (dst:GraphNode)
       MATCH (e:GraphEdge)
       WHERE e.snapshot_id = $snapshotId
         AND e.src_node_id = src.node_id
         AND e.dst_node_id = dst.node_id
         AND src.snapshot_id = $snapshotId
         AND dst.snapshot_id = $snapshotId
         AND (size($apiNames) = 0 OR src.canonical_name IN $apiNames OR dst.canonical_name IN $apiNames)
       RETURN src.canonical_name AS caller,
              dst.canonical_name AS callee,
              src.canonical_name AS canonical_name,
              src.kind AS kind,
              e.edge_kind AS edge_kind,
              e.confidence AS confidence,
              e.derivation AS derivation,
              src.location AS location
       LIMIT $limit`,
      { snapshotId, apiNames, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        caller: obj.caller,
        callee: obj.callee,
        edge_kind: obj.edge_kind,
        confidence: toNumber(obj.confidence),
        derivation: obj.derivation,
        file_path: extractFilePath(obj.location),
        line_number: extractLine(obj.location),
      }
    })
  }

  // ── runtime observations (why_api_invoked, show_api_runtime_observations) ─

  private async _observations(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    apiNames: string[],
    traceId: string | undefined,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (apiNames.length === 0 && !traceId) return []
    const result = await session.run(
      `MATCH (obs:GraphObservation)
       WHERE obs.snapshot_id = $snapshotId
         AND obs.kind = 'runtime_invocation'
         AND obs.payload IS NOT NULL
         AND (size($apiNames) = 0 OR obs.payload.target_api IN $apiNames)
       RETURN obs.payload.target_api AS target_api,
              obs.payload.immediate_invoker AS immediate_invoker,
              obs.payload.runtime_trigger AS runtime_trigger,
              obs.payload.dispatch_chain AS dispatch_chain,
              obs.payload.dispatch_site AS dispatch_site,
              obs.confidence AS confidence,
              'runtime' AS derivation,
              'runtime_calls' AS edge_kind
       LIMIT $limit`,
      { snapshotId, apiNames, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      const site = obj.dispatch_site as Record<string, unknown> | null | undefined
      return {
        kind: "function",
        canonical_name: obj.immediate_invoker ?? obj.target_api,
        target_api: obj.target_api,
        immediate_invoker: obj.immediate_invoker,
        runtime_trigger: obj.runtime_trigger,
        dispatch_chain: obj.dispatch_chain,
        dispatch_site: obj.dispatch_site,
        edge_kind: "runtime_calls",
        derivation: "runtime",
        confidence: toNumber(obj.confidence),
        file_path: site?.filePath ?? null,
        line_number: site?.line != null ? toNumber(site.line) : null,
      }
    })
  }

  // ── find_api_by_log_pattern ───────────────────────────────────────────────

  private async _logPattern(
    session: { run(c: string, p?: Record<string, unknown>): Promise<{ records: Array<{ toObject(): Record<string, unknown> }> }> },
    snapshotId: number,
    pattern: string | undefined,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (!pattern) return []
    const result = await session.run(
      `MATCH (src:GraphNode)
       MATCH (log:GraphNode)
       MATCH (e:GraphEdge)
       WHERE src.snapshot_id = $snapshotId
         AND e.snapshot_id = $snapshotId
         AND e.edge_kind = 'logs_event'
         AND e.src_node_id = src.node_id
         AND e.dst_node_id = log.node_id
         AND log.snapshot_id = $snapshotId
         AND log.kind = 'log_point'
         AND (log.canonical_name CONTAINS $pattern
              OR (e.metadata IS NOT NULL AND e.metadata.template CONTAINS $pattern))
       RETURN src.canonical_name AS canonical_name,
              src.kind AS kind,
              log.canonical_name AS log_name,
              e.metadata AS metadata,
              e.confidence AS confidence,
              e.derivation AS derivation,
              src.location AS location
       LIMIT $limit`,
      { snapshotId, pattern, limit },
    )
    return result.records.map((r) => {
      const obj = r.toObject()
      const meta = asMap(obj.metadata)
      return {
        kind: obj.kind ?? "function",
        canonical_name: obj.canonical_name,
        log_name: obj.log_name,
        template: meta?.template ?? obj.log_name,
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
}

// =============================================================================
// tiny utilities
// =============================================================================

function toNeo4jInt(value: unknown): unknown {
  // Use the neo4j-driver's integer representation so Bolt serialises
  // the value as a Cypher Integer (not a Float — which LIMIT rejects).
  const n = Math.trunc(Number(value))
  return isNaN(n) ? neo4jInt(0) : neo4jInt(n)
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (value != null && typeof (value as Record<string, unknown>).toNumber === "function") {
    return (value as { toNumber(): number }).toNumber()
  }
  const n = Number(value)
  return isNaN(n) ? 0 : n
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = toNumber(value)
  return isNaN(n) ? null : n
}

function asMap(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return null
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * The `location` column in GraphNode is serialized as a SourceLocation map:
 * `{ filePath: string, line: number }`.
 * Neo4j returns map properties as plain JS objects after `.toObject()`,
 * but our seed test inserts them as JSON strings.
 */
function extractFilePath(location: unknown): string | null {
  const map = asMap(location)
  if (!map) return null
  return typeof map.filePath === "string" ? map.filePath : null
}

function extractLine(location: unknown): number | null {
  const map = asMap(location)
  if (!map) return null
  if (map.line == null) return null
  return toNumber(map.line)
}
