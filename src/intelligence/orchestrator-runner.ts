import {
  DEFAULT_FALLBACK_POLICY,
  RuntimeInvocationType,
  decideOrchestrationAction,
  type CParserEnricher,
  type ClangdEnricher,
  type EnrichmentAttempt,
  type FallbackPolicy,
  type RuntimeFacetCompletenessStatus,
  type RuntimeFacetCompletenessStatusMap,
  type LlmEnricher,
  type NormalizedQueryResponse,
  type PersistenceContracts,
  type QueryRequest,
  validateQueryRequest,
} from "./contracts/orchestrator.js"

const RUNTIME_ONLY_INTENTS = new Set<QueryRequest["intent"]>([
  "who_calls_api_at_runtime",
  "why_api_invoked",
  "show_runtime_flow_for_trace",
  "show_api_runtime_observations",
  "find_api_timer_triggers",
])

const LEGACY_STRUCTURE_COMPAT_INTENTS = new Set<QueryRequest["intent"]>([
  "find_struct_writers",
  "find_struct_readers",
  "where_struct_initialized",
  "where_struct_modified",
  "find_struct_owners",
])

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]
  }
  return out
}

export function classifyRuntimeInvocationType(edgeKind: string): string {
  switch (edgeKind) {
    case "calls": return RuntimeInvocationType.RUNTIME_DIRECT_CALL
    case "registers_callback": return RuntimeInvocationType.RUNTIME_CALLBACK_REGISTRATION_CALL
    // runtime_calls is the unified runtime relationship kind (direct + indirect).
    // If runtime_call_kind metadata is absent, classify as function-pointer to avoid
    // over-claiming direct runtime invocation.
    case "runtime_calls": return RuntimeInvocationType.RUNTIME_FUNCTION_POINTER_CALL
    case "dispatches_to": return RuntimeInvocationType.RUNTIME_DISPATCH_TABLE_CALL
    default: return RuntimeInvocationType.RUNTIME_UNKNOWN_CALL_PATH
  }
}

function mapRuntimeCallerRowsToFrontendFriendlyLongNames(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    kind: row.kind,
    canonical_name: row.canonical_name ?? row.caller,
    caller: row.caller,
    callee: row.callee,
    edge_kind: row.edge_kind,
    derivation: row.derivation,
    confidence: row.confidence,
    runtime_caller_api_name: row.caller,
    runtime_called_api_name: row.callee,
    runtime_caller_invocation_type_classification: classifyRuntimeInvocationType(String(row.edge_kind ?? "")),
    runtime_relation_confidence_score: row.confidence,
    runtime_relation_derivation_source: row.derivation,
    file_path: row.file_path,
    line_number: row.line_number,
  }))
}

function mapRuntimeObservationRowsToFrontendFriendlyLongNames(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    kind: row.kind,
    canonical_name: row.canonical_name ?? row.immediate_invoker ?? row.target_api,
    caller: row.immediate_invoker,
    callee: row.target_api,
    edge_kind: row.edge_kind ?? "runtime_calls",
    derivation: row.derivation ?? "runtime",
    confidence: row.confidence,
    target_api_name: row.target_api,
    runtime_trigger_event_description: row.runtime_trigger,
    runtime_execution_path_from_entrypoint_to_target_api: row.dispatch_chain,
    runtime_immediate_caller_api_name: row.immediate_invoker,
    runtime_dispatch_source_location: row.dispatch_site,
    runtime_confidence_score: row.confidence,
    file_path: row.file_path ?? (row.dispatch_site as Record<string, unknown> | undefined)?.filePath,
    line_number: row.line_number ?? (row.dispatch_site as Record<string, unknown> | undefined)?.line,
  }))
}

function mapTimerTriggerRowsToFrontendFriendlyLongNames(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    kind: row.kind ?? "timer",
    canonical_name: row.canonical_name ?? row.timer_identifier_name ?? row.caller,
    caller: row.caller ?? row.timer_identifier_name ?? row.canonical_name,
    callee: row.callee,
    edge_kind: row.edge_kind ?? "runtime_calls",
    confidence: row.timer_trigger_confidence_score ?? row.confidence,
    derivation: row.derivation,
    file_path: row.file_path,
    line_number: row.line_number,
    current_api_runtime_timer_identifier_name: row.timer_identifier_name ?? row.caller ?? row.canonical_name,
    current_api_runtime_timer_trigger_condition_description: row.timer_trigger_condition_description,
    current_api_runtime_timer_trigger_confidence_score: row.timer_trigger_confidence_score ?? row.confidence,
    current_api_runtime_timer_relation_derivation_source: row.derivation,
  }))
}

function extractStructureEvidenceFields(row: Record<string, unknown>): Record<string, unknown> {
  const evidence = row.runtime_structure_evidence
  if (!evidence || typeof evidence !== "object") return {}
  const ev = evidence as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (ev.access_path) {
    out.current_api_runtime_structure_access_path_expression = ev.access_path
  }
  if (ev.source_location) {
    out.current_api_runtime_structure_access_source_evidence_location = ev.source_location
  } else if (ev.file_path && ev.line !== undefined) {
    out.current_api_runtime_structure_access_source_evidence_location = `${ev.file_path}:${ev.line}`
  }
  return out
}

function mapLegacyStructureRowsToFrontendFriendlyLongNames(
  intent: QueryRequest["intent"],
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const roleKeyByIntent: Record<string, string> = {
    find_struct_writers: "writer",
    where_struct_modified: "writer",
    find_struct_readers: "reader",
    where_struct_initialized: "initializer",
    find_struct_owners: "owner",
  }

  const roleFieldByIntent: Record<string, string> = {
    find_struct_writers: "current_structure_runtime_writer_api_name",
    where_struct_modified: "current_structure_runtime_writer_api_name",
    find_struct_readers: "current_structure_runtime_reader_api_name",
    where_struct_initialized: "current_structure_runtime_initializer_api_name",
    find_struct_owners: "current_structure_runtime_owner_api_name",
  }

  const roleKey = roleKeyByIntent[intent]
  const roleField = roleFieldByIntent[intent]

  return rows.map((row) => ({
    [roleField]: row[roleKey],
    current_structure_runtime_target_structure_name: row.target ?? row.struct_name,
    current_structure_runtime_structure_operation_type_classification: row.edge_kind,
    current_structure_runtime_structure_operation_confidence_score: row.confidence,
    current_structure_runtime_relation_derivation_source: row.derivation,
    ...extractStructureEvidenceFields(row),
  }))
}

function projectRuntimeOnlyRows(intent: QueryRequest["intent"], rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (LEGACY_STRUCTURE_COMPAT_INTENTS.has(intent)) {
    return mapLegacyStructureRowsToFrontendFriendlyLongNames(intent, rows)
  }

  if (!RUNTIME_ONLY_INTENTS.has(intent)) return rows

  if (intent === "who_calls_api_at_runtime") {
    const runtimeOnlyRows = rows.map((r) => pick(r, [
      "kind",
      "canonical_name",
      "caller",
      "callee",
      "edge_kind",
      "confidence",
      "derivation",
      "file_path",
      "line_number",
      "filePath",
      "lineNumber",
    ]))
    return mapRuntimeCallerRowsToFrontendFriendlyLongNames(runtimeOnlyRows)
  }

  if (intent === "find_api_timer_triggers") {
    return mapTimerTriggerRowsToFrontendFriendlyLongNames(rows)
  }

  const runtimeObservationRows = rows.map((r) => pick(r, [
    "kind",
    "canonical_name",
    "target_api",
    "runtime_trigger",
    "dispatch_chain",
    "immediate_invoker",
    "dispatch_site",
    "edge_kind",
    "derivation",
    "confidence",
    "file_path",
    "line_number",
    "filePath",
    "lineNumber",
  ]))
  return mapRuntimeObservationRowsToFrontendFriendlyLongNames(runtimeObservationRows)
}

export interface OrchestratorRunnerDeps {
  persistence: PersistenceContracts
  clangdEnricher: ClangdEnricher
  cParserEnricher: CParserEnricher
  llmEnricher?: LlmEnricher
  policy?: FallbackPolicy
}

function rowsToResponseData(rows: Array<Record<string, unknown>>): NormalizedQueryResponse["data"] {
  if (rows.length === 1) {
    const first = rows[0] ?? {}
    const maybeNodes = first.nodes
    const maybeEdges = first.edges
    if (Array.isArray(maybeNodes) && Array.isArray(maybeEdges)) {
      return {
        nodes: maybeNodes as Array<Record<string, unknown>>,
        edges: maybeEdges as Array<Record<string, unknown>>,
        observations: Array.isArray(first.observations)
          ? (first.observations as Array<Record<string, unknown>>)
          : undefined,
        summary:
          first.summary && typeof first.summary === "object"
            ? (first.summary as Record<string, unknown>)
            : undefined,
      }
    }
  }

  return {
    nodes: rows,
    edges: [],
  }
}

function computeFacetCompletenessStatus(status: NormalizedQueryResponse["status"]): RuntimeFacetCompletenessStatus {
  if (status === "hit") return "runtime_facet_data_fully_available"
  if (status === "not_found") return "runtime_facet_data_not_yet_ingested"
  return "runtime_facet_data_partially_available"
}

function buildFacetCompletenessStatusMap(status: NormalizedQueryResponse["status"]): RuntimeFacetCompletenessStatusMap {
  const s = computeFacetCompletenessStatus(status)
  return {
    runtime_callers_facet_completeness_status: s,
    runtime_callees_facet_completeness_status: s,
    runtime_structure_access_facet_completeness_status: s,
    runtime_logs_facet_completeness_status: s,
    runtime_timers_facet_completeness_status: s,
  }
}

function buildResponse(params: {
  request: QueryRequest
  status: NormalizedQueryResponse["status"]
  rows: Array<Record<string, unknown>>
  attempts: EnrichmentAttempt[]
  errors?: string[]
}): NormalizedQueryResponse {
  const projectedRows = projectRuntimeOnlyRows(params.request.intent, params.rows)
  const llmUsed = params.attempts.some((a) => a.source === "llm" && a.status === "success")
  const path: NormalizedQueryResponse["provenance"]["path"] =
    params.status === "hit"
      ? "db_hit"
      : llmUsed
        ? "db_miss_llm_last_resort"
        : "db_miss_deterministic"

  return {
    snapshotId: params.request.snapshotId,
    intent: params.request.intent,
    status: params.status,
    data: rowsToResponseData(projectedRows),
    provenance: {
      path,
      deterministicAttempts: params.attempts
        .filter((a) => a.source === "clangd" || a.source === "c_parser")
        .map((a) => `${a.source}:${a.status}`),
      llmUsed,
    },
    runtime_facet_completeness_status_map: buildFacetCompletenessStatusMap(params.status),
    errors: params.errors,
  }
}

export async function executeOrchestratedQuery(
  input: unknown,
  deps: OrchestratorRunnerDeps,
): Promise<NormalizedQueryResponse> {
  const validated = validateQueryRequest(input)
  if (!validated.ok) {
    const req = (input ?? {}) as Partial<QueryRequest>
    return {
      snapshotId: typeof req.snapshotId === "number" ? req.snapshotId : -1,
      intent: (req.intent as QueryRequest["intent"]) ?? "who_calls_api",
      status: "error",
      data: { nodes: [], edges: [] },
      provenance: { path: "db_miss_deterministic", deterministicAttempts: [], llmUsed: false },
      errors: validated.errors,
    }
  }

  const request = validated.value
  const policy = deps.policy ?? DEFAULT_FALLBACK_POLICY
  const attempts: EnrichmentAttempt[] = []
  const errors: string[] = []

  let lookup = await deps.persistence.dbLookup.lookup(request)
  const initialHit = lookup.hit
  let guard = 0

  while (guard < 12) {
    guard += 1
    const action = decideOrchestrationAction({
      lookupHit: lookup.hit,
      request,
      policy,
      attempts,
    })

    if (action.type === "return_hit") {
      return buildResponse({
        request,
        status: initialHit ? "hit" : attempts.some((a) => a.source === "llm" && a.status === "success")
          ? "llm_fallback"
          : "enriched",
        rows: lookup.rows,
        attempts,
      })
    }

    if (action.type === "run_deterministic") {
      const enricher = action.source === "clangd" ? deps.clangdEnricher : deps.cParserEnricher
      const result = await enricher.enrich(request, { policy, priorAttempts: attempts })
      attempts.push(...result.attempts)
      await deps.persistence.authoritativeStore.persistEnrichment(request, result)
      await deps.persistence.graphProjection.syncFromAuthoritative(request.snapshotId)
      continue
    }

    if (action.type === "run_llm") {
      if (!deps.llmEnricher) {
        attempts.push({ source: "llm", status: "skipped", reason: "llm enricher not configured" })
        continue
      }
      const canRun = deps.llmEnricher.canRun(request, { policy, priorAttempts: attempts })
      if (!canRun) {
        attempts.push({ source: "llm", status: "skipped", reason: "llm guard denied" })
        continue
      }
      const result = await deps.llmEnricher.enrich(request, { policy, priorAttempts: attempts })
      attempts.push(...result.attempts)
      await deps.persistence.authoritativeStore.persistEnrichment(request, result)
      await deps.persistence.graphProjection.syncFromAuthoritative(request.snapshotId)
      continue
    }

    if (action.type === "retry_lookup") {
      lookup = await deps.persistence.dbLookup.lookup(request)
      continue
    }

    return buildResponse({
      request,
      status: "not_found",
      rows: [],
      attempts,
      errors: errors.length > 0 ? errors : undefined,
    })
  }

  return buildResponse({
    request,
    status: "error",
    rows: [],
    attempts,
    errors: ["orchestration guard limit exceeded"],
  })
}
