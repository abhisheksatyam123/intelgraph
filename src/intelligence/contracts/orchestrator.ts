export const enum RuntimeInvocationType {
  RUNTIME_DIRECT_CALL = "runtime_direct_call",
  RUNTIME_CALLBACK_REGISTRATION_CALL = "runtime_callback_registration_call",
  RUNTIME_FUNCTION_POINTER_CALL = "runtime_function_pointer_call",
  RUNTIME_DISPATCH_TABLE_CALL = "runtime_dispatch_table_call",
  RUNTIME_UNKNOWN_CALL_PATH = "runtime_unknown_call_path",
}

export const enum RuntimeStructureOperationType {
  RUNTIME_READ_FIELD_ACCESS = "runtime_read_field_access",
  RUNTIME_WRITE_FIELD_ASSIGNMENT = "runtime_write_field_assignment",
  RUNTIME_STRUCT_INITIALIZATION = "runtime_struct_initialization",
  RUNTIME_STRUCT_MUTATION = "runtime_struct_mutation",
  RUNTIME_STRUCT_OPERATION_UNKNOWN = "runtime_struct_operation_unknown",
}

export const RUNTIME_CONFIDENCE_DETERMINISTIC = 1.0
export const RUNTIME_CONFIDENCE_INFERRED = 0.7
export const RUNTIME_CONFIDENCE_FALLBACK = 0.4

export const QUERY_INTENTS = [
  "who_calls_api",
  "who_calls_api_at_runtime",
  "why_api_invoked",
  "what_api_calls",
  "show_registration_chain",
  "show_dispatch_sites",
  "find_callback_registrars",
  "where_struct_initialized",
  "where_struct_modified",
  "find_struct_owners",
  "find_struct_readers",
  "find_struct_writers",
  "find_field_access_path",
  "find_api_by_log_pattern",
  "show_runtime_flow_for_trace",
  "show_api_runtime_observations",
  "show_cross_module_path",
  "show_hot_call_paths",
  "find_api_logs",
  "find_api_logs_by_level",
  "find_api_timer_triggers",
  /** What structs does this API write? (API-centric, src_symbol_name = apiName) */
  "find_api_struct_writes",
  /** What structs does this API read? (API-centric, src_symbol_name = apiName) */
  "find_api_struct_reads",
  // ── language-agnostic structural intents (used by ts-core and any
  //    future plugin that emits imports/contains/extends/implements)
  /** Modules this module imports (outgoing 'imports' edges). */
  "find_module_imports",
  /** Modules that import this module (incoming 'imports' edges). */
  "find_module_dependents",
  /** Symbols declared in this module (outgoing 'contains' edges). */
  "find_module_symbols",
  /** Parent classes/interfaces this symbol extends (outgoing 'extends' edges). */
  "find_class_inheritance",
  /** Subclasses/sub-interfaces of this symbol (incoming 'extends' edges). */
  "find_class_subtypes",
  /** Classes that implement this interface (incoming 'implements' edges). */
  "find_interface_implementors",
  /** Types that this symbol references in its signature/body (outgoing 'references_type' edges). */
  "find_type_dependencies",
  /** Symbols that reference this type in their signatures/bodies (incoming 'references_type' edges). */
  "find_type_consumers",
  /** Pairs of modules that import each other (2-cycles in the imports graph). */
  "find_import_cycles",
  /** Top-N modules ranked by incoming imports edges (busy hubs). */
  "find_top_imported_modules",
  /** Top-N functions/methods ranked by incoming calls edges (most-called). */
  "find_top_called_functions",
  /** Modules with zero incoming imports — likely entry points / scripts / tests. */
  "find_module_entry_points",
  /** Exported symbols with zero incoming calls and zero incoming references_type — likely dead public API. */
  "find_dead_exports",
  /** Shortest call chain from srcApi → dstApi (BFS over calls edges, bounded depth). */
  "find_call_chain",
  /** Substring search across symbol canonical_name (request.pattern). */
  "find_symbols_by_name",
  /** All symbols of a given kind (request.pattern = kind name like 'class' / 'interface' / 'function'). */
  "find_symbols_by_kind",
  /** Transitive imports closure of a module (recursive walk over imports edges). */
  "find_transitive_dependencies",
  /** Innermost symbol whose source range contains the given filePath + lineNumber. */
  "find_symbol_at_location",
  /** Functions/methods exceeding `depth` lines (default 50), ordered DESC by lineCount. */
  "find_long_functions",
  /** Distinct list of external (npm/bare) imports with usage counts. */
  "find_external_imports",
  /** Single-row aggregate health summary for a module (symbol/import counts, line count). */
  "find_module_summary",
  /** All symbols defined in a file (request.filePath), ordered by line number. */
  "find_symbols_in_file",
  /** Sibling symbols: other children of the requested symbol's parent via contains edges. */
  "find_sibling_symbols",
  /** Exported symbols of a module ranked by total incoming usage (calls + references_type). */
  "find_module_top_exports",
  /** Cycles in the imports graph of length 3 to `depth` (recursive CTE, returns one row per cycle). */
  "find_import_cycles_deep",
  /** Degree counts for a symbol: incoming/outgoing edges grouped by edge_kind. */
  "find_symbol_degree",
  /** All calls + references_type edges between symbols in two modules (srcApi → dstApi). */
  "find_module_interactions",
  /** One-call overview: aggregate summary for every module in the snapshot. */
  "find_modules_overview",
  /** Pairs of types that reference each other (2-cycles in the references_type graph). */
  "find_type_cycles",
  /** Longest call chain reachable from a starting symbol (recursive walk over calls edges). */
  "find_deepest_call_chain",
  /** Search symbols by their JSDoc text (request.pattern, LIKE-matched against payload.metadata.doc). */
  "find_symbols_by_doc",
  /** Module pairs ranked by total inter-module edges (calls + references_type). Refactor candidates. */
  "find_tightly_coupled_modules",
  /** Classes ranked DESC by method count — surfaces god objects / refactor candidates. */
  "find_classes_by_method_count",
  /** Types used across the most distinct modules — core types of the codebase. */
  "find_widely_referenced_types",
  /** Exported symbols (functions/classes/interfaces) without JSDoc — documentation gaps. */
  "find_undocumented_exports",
  /** Interfaces ranked DESC by implementor count — core abstractions of the codebase. */
  "find_top_implemented_interfaces",
  /** Modules with NO incoming AND NO outgoing imports — completely isolated, likely dead. */
  "find_orphan_modules",
  /** Modules ranked DESC by line count — biggest files for refactor planning. */
  "find_largest_modules",
  /** Modules grouped by parent directory with aggregate stats — package overview view. */
  "find_modules_by_directory",
  // ── Phase 3e: data-structure intents (field_of_type / aggregates)
  /** What type(s) does this field declare, with containment metadata. */
  "find_field_type",
  /** Direct fields declared on this struct/class/interface. */
  "find_type_fields",
  /** Distinct types this struct aggregates (rolled up from field_of_type). */
  "find_type_aggregates",
  /** Reverse direction — types that aggregate this one. */
  "find_type_aggregators",
  // ── Phase 3g: field-access intents (cleaner aliases for the
  //              language-agnostic case — the older find_api_struct_*
  //              and find_struct_* names are kept for back-compat
  //              but suggested for C/C++. These four use TS/Rust-
  //              friendly naming.)
  /** Fields written by this API/method (outgoing writes_field edges). */
  "find_api_field_writes",
  /** Fields read by this API/method (outgoing reads_field edges). */
  "find_api_field_reads",
  /** APIs/methods that write to this field (incoming writes_field edges). */
  "find_field_writers",
  /** APIs/methods that read from this field (incoming reads_field edges). */
  "find_field_readers",
  // ── Phase 3h: data-path traversal (the data-side analog of
  //              find_call_chain — walks field_of_type + aggregates
  //              edges from a source type to a destination type to
  //              answer "how does Vault structurally reach Reference")
  "find_data_path",
  // ── Phase 3i: structural cycles via field_of_type / aggregates
  //              edges. The data-side analog of find_type_cycles
  //              (which only walks references_type). Catches the
  //              "A.b: B and B.a: A" antipattern that the existing
  //              intent misses.
  "find_struct_cycles",
  // ── Phase 3l: transitive data footprint. BFS-walks calls edges
  //              from a starting API and collects every field
  //              touched by any reachable method (reads_field +
  //              writes_field). Answers "what data does login()
  //              ultimately touch via its call chain", not just
  //              what login() literally writes itself.
  "find_api_data_footprint",
  // ── Phase 3m: data-side analog of find_top_called_functions.
  //              Ranks types by the number of DISTINCT APIs that
  //              read or write any of their fields. Surfaces the
  //              central pieces of state — the types the codebase
  //              actually revolves around.
  "find_top_touched_types",
  // ── Phase 3n: direct mutual recursion at the function/method
  //              level (A calls B AND B calls A). Closes the
  //              cycle-detection family alongside find_import_cycles,
  //              find_type_cycles, and find_struct_cycles.
  "find_call_cycles",
  // ── Phase 3o: top APIs ranked by the number of DISTINCT fields
  //              they write / read. The methodological analog of
  //              find_top_touched_types — from the API side instead
  //              of the data side. Surfaces "the methods doing the
  //              most state mutation" and "the methods reading the
  //              most state".
  "find_top_field_writers",
  "find_top_field_readers",
  // ── Phase 3p: data-side analog of find_dead_exports. Finds
  //              fields with zero incoming reads_field/writes_field
  //              edges — "dead state" left over from refactors that
  //              removed the only consumer.
  "find_unused_fields",
  // ── Phase 3t: field-level granularity sibling of
  //              find_top_touched_types. Ranks individual fields by
  //              distinct method touchers — finds the read-write
  //              hot spots inside a popular type.
  "find_top_hot_fields",
] as const

export type QueryIntent = (typeof QUERY_INTENTS)[number]

export interface QueryRequest {
  intent: QueryIntent
  snapshotId: number
  apiName?: string
  /**
   * All alias variants of apiName to match in DB queries.
   * When set, the DB uses `= ANY(ARRAY[...])` instead of `= $n`.
   * Populated automatically by the orchestrator from canonicalizeSymbol().
   * Example: ["wlan_bpf_filter_offload_handler", "_wlan_bpf_filter_offload_handler",
   *           "wlan_bpf_filter_offload_handler___RAM", "_wlan_bpf_filter_offload_handler___RAM"]
   */
  apiNameAliases?: string[]
  structName?: string
  fieldName?: string
  traceId?: string
  pattern?: string
  logLevel?: "ERROR" | "WARN" | "INFO" | "DEBUG" | "VERBOSE" | "TRACE"
  srcApi?: string
  dstApi?: string
  depth?: number
  limit?: number
  /** File path (used by find_symbol_at_location for click-to-symbol). */
  filePath?: string
  /** 1-based line number (used by find_symbol_at_location). */
  lineNumber?: number
  timeRange?: { from?: string; to?: string }
}

export type RuntimeFacetCompletenessStatus =
  | "runtime_facet_data_fully_available"
  | "runtime_facet_data_partially_available"
  | "runtime_facet_data_not_yet_ingested"

export interface RuntimeFacetCompletenessStatusMap {
  runtime_callers_facet_completeness_status: RuntimeFacetCompletenessStatus
  runtime_callees_facet_completeness_status: RuntimeFacetCompletenessStatus
  runtime_structure_access_facet_completeness_status: RuntimeFacetCompletenessStatus
  runtime_logs_facet_completeness_status: RuntimeFacetCompletenessStatus
  runtime_timers_facet_completeness_status: RuntimeFacetCompletenessStatus
}

export interface NormalizedQueryResponse {
  snapshotId: number
  intent: QueryIntent
  status: "hit" | "enriched" | "llm_fallback" | "not_found" | "error"
  data: {
    nodes: Array<Record<string, unknown>>
    edges: Array<Record<string, unknown>>
    observations?: Array<Record<string, unknown>>
    summary?: Record<string, unknown>
  }
  provenance: {
    path: "db_hit" | "db_miss_deterministic" | "db_miss_llm_last_resort"
    deterministicAttempts: string[]
    llmUsed: boolean
  }
  runtime_facet_completeness_status_map?: RuntimeFacetCompletenessStatusMap
  errors?: string[]
}

export interface FallbackPolicy {
  deterministicOrder: ["clangd", "c_parser"]
  llmLastResort: true
  maxDeterministicPasses: number
}

export type DeterministicEnricherSource = "clangd" | "c_parser"

export interface EnricherContext {
  policy: FallbackPolicy
  priorAttempts: EnrichmentAttempt[]
}

export interface ClangdEnricher {
  readonly source: "clangd"
  enrich(request: QueryRequest, ctx: EnricherContext): Promise<EnrichmentResult>
}

export interface CParserEnricher {
  readonly source: "c_parser"
  enrich(request: QueryRequest, ctx: EnricherContext): Promise<EnrichmentResult>
}

export interface LlmEnricher {
  readonly source: "llm"
  canRun(request: QueryRequest, ctx: EnricherContext): boolean
  enrich(request: QueryRequest, ctx: EnricherContext): Promise<EnrichmentResult>
}

export interface DbLookupRepository {
  lookup(request: QueryRequest): Promise<LookupResult>
}

export interface AuthoritativeSnapshotRepository {
  persistEnrichment(request: QueryRequest, result: EnrichmentResult): Promise<number>
}

export interface GraphProjectionRepository {
  syncFromAuthoritative(snapshotId: number): Promise<{ synced: boolean; nodesUpserted: number; edgesUpserted: number }>
}

export interface PersistenceContracts {
  dbLookup: DbLookupRepository
  authoritativeStore: AuthoritativeSnapshotRepository
  graphProjection: GraphProjectionRepository
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  deterministicOrder: ["clangd", "c_parser"],
  llmLastResort: true,
  maxDeterministicPasses: 2,
}

export interface EnrichmentAttempt {
  source: "clangd" | "c_parser" | "llm"
  status: "success" | "failed" | "skipped"
  reason?: string
}

export interface LookupResult {
  hit: boolean
  intent: QueryIntent
  snapshotId: number
  rows: Array<Record<string, unknown>>
}

export interface EnrichmentResult {
  attempts: EnrichmentAttempt[]
  persistedRows: number
}

export type OrchestrationAction =
  | { type: "return_hit" }
  | { type: "run_deterministic"; source: DeterministicEnricherSource }
  | { type: "retry_lookup" }
  | { type: "run_llm" }
  | { type: "return_not_found" }

export interface OrchestrationState {
  lookupHit: boolean
  request: QueryRequest
  policy: FallbackPolicy
  attempts: EnrichmentAttempt[]
}

export function decideOrchestrationAction(state: OrchestrationState): OrchestrationAction {
  if (state.lookupHit) return { type: "return_hit" }

  const lastAttempt = state.attempts[state.attempts.length - 1]
  if (lastAttempt?.status === "success") {
    return { type: "retry_lookup" }
  }

  const attemptedDeterministic = new Set<DeterministicEnricherSource>()
  for (const attempt of state.attempts) {
    if (attempt.source === "clangd" || attempt.source === "c_parser") {
      attemptedDeterministic.add(attempt.source)
    }
  }

  for (const source of state.policy.deterministicOrder) {
    if (!attemptedDeterministic.has(source)) {
      return { type: "run_deterministic", source }
    }
  }

  const llmAttempt = state.attempts.find((attempt) => attempt.source === "llm")
  if (llmAttempt?.status === "success") {
    return { type: "retry_lookup" }
  }
  if (llmAttempt?.status === "failed") {
    return { type: "return_not_found" }
  }

  if (
    shouldRunLlmFallback(state.request, {
      policy: state.policy,
      priorAttempts: state.attempts,
    })
  ) {
    return { type: "run_llm" }
  }

  return { type: "return_not_found" }
}

export function shouldRunLlmFallback(
  request: QueryRequest,
  ctx: EnricherContext,
): boolean {
  if (!ctx.policy.llmLastResort) return false

  const deterministicAttempts = ctx.priorAttempts.filter(
    (a): a is EnrichmentAttempt & { source: DeterministicEnricherSource } =>
      a.source === "clangd" || a.source === "c_parser",
  )
  if (deterministicAttempts.length === 0) return false

  const attemptedAllDeterministic = ctx.policy.deterministicOrder.every((source) =>
    deterministicAttempts.some((attempt) => attempt.source === source),
  )
  if (!attemptedAllDeterministic) return false

  const allDeterministicFailed = deterministicAttempts.every((attempt) => attempt.status === "failed")
  if (!allDeterministicFailed) return false

  const deterministicPassCount = deterministicAttempts.length
  if (deterministicPassCount > ctx.policy.maxDeterministicPasses) return false

  return Boolean(request.snapshotId > 0)
}

const INTENTS_REQUIRING_API = new Set<QueryIntent>([
  "who_calls_api",
  "who_calls_api_at_runtime",
  "why_api_invoked",
  "what_api_calls",
  "show_registration_chain",
  "show_dispatch_sites",
  "find_callback_registrars",
  "show_api_runtime_observations",
  "show_hot_call_paths",
  "find_api_timer_triggers",
  "find_api_logs",
  "find_api_logs_by_level",
  "find_api_struct_writes",
  "find_api_struct_reads",
])

const INTENTS_REQUIRING_STRUCT = new Set<QueryIntent>([
  "where_struct_initialized",
  "where_struct_modified",
  "find_struct_owners",
  "find_struct_readers",
  "find_struct_writers",
  "find_field_access_path",
])

export function parseQueryIntent(input: string): QueryIntent | null {
  const normalized = input.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const alias: Record<string, QueryIntent> = {
    who_calls_api: "who_calls_api",
    who_calls: "who_calls_api",
    where_struct_init: "where_struct_initialized",
    where_struct_initialized: "where_struct_initialized",
    where_struct_modified: "where_struct_modified",
  }
  const candidate = (alias[normalized] ?? normalized) as QueryIntent
  return (QUERY_INTENTS as readonly string[]).includes(candidate) ? candidate : null
}

export function validateQueryRequest(input: unknown):
  | { ok: true; value: QueryRequest }
  | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!input || typeof input !== "object") return { ok: false, errors: ["request must be an object"] }

  const req = input as Partial<QueryRequest>
  if (!req.intent || !(QUERY_INTENTS as readonly string[]).includes(req.intent)) {
    errors.push("intent is required and must be valid")
  }
  if (typeof req.snapshotId !== "number" || !Number.isInteger(req.snapshotId) || req.snapshotId <= 0) {
    errors.push("snapshotId must be a positive integer")
  }

  const intent = req.intent
  if (intent && INTENTS_REQUIRING_API.has(intent) && !req.apiName) {
    errors.push(`apiName is required for intent '${intent}'`)
  }
  if (intent && INTENTS_REQUIRING_STRUCT.has(intent) && !req.structName) {
    errors.push(`structName is required for intent '${intent}'`)
  }
  if (intent === "find_field_access_path" && !req.fieldName) {
    errors.push("fieldName is required for intent 'find_field_access_path'")
  }
  if (intent === "show_runtime_flow_for_trace" && !req.traceId) {
    errors.push("traceId is required for intent 'show_runtime_flow_for_trace'")
  }
  if (intent === "find_api_by_log_pattern" && !req.pattern) {
    errors.push("pattern is required for intent 'find_api_by_log_pattern'")
  }
  if (intent === "find_api_logs_by_level" && !req.logLevel) {
    errors.push("logLevel is required for intent 'find_api_logs_by_level' (one of ERROR, WARN, INFO, DEBUG, VERBOSE, TRACE)")
  }
  if (intent === "show_cross_module_path" && (!req.srcApi || !req.dstApi)) {
    errors.push("srcApi and dstApi are required for intent 'show_cross_module_path'")
  }
  if (intent === "find_data_path" && (!req.srcApi || !req.dstApi)) {
    errors.push("srcApi and dstApi are required for intent 'find_data_path'")
  }

  if (req.depth !== undefined && (!Number.isInteger(req.depth) || req.depth <= 0)) {
    errors.push("depth must be a positive integer when provided")
  }
  if (req.limit !== undefined && (!Number.isInteger(req.limit) || req.limit <= 0)) {
    errors.push("limit must be a positive integer when provided")
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: req as QueryRequest }
}

export function validateResponseShape(input: unknown): string[] {
  const errors: string[] = []
  if (!input || typeof input !== "object") return ["response must be an object"]
  const res = input as Partial<NormalizedQueryResponse>

  if (typeof res.snapshotId !== "number") errors.push("snapshotId must be a number")
  if (!res.intent || !(QUERY_INTENTS as readonly string[]).includes(res.intent)) {
    errors.push("intent must be valid")
  }
  if (!res.status) errors.push("status is required")
  if (!res.data || !Array.isArray(res.data.nodes) || !Array.isArray(res.data.edges)) {
    errors.push("data.nodes and data.edges arrays are required")
  }
  if (!res.provenance) {
    errors.push("provenance is required")
  } else {
    if (!Array.isArray(res.provenance.deterministicAttempts)) {
      errors.push("provenance.deterministicAttempts must be an array")
    }
    if (typeof res.provenance.llmUsed !== "boolean") {
      errors.push("provenance.llmUsed must be boolean")
    }
  }

  return errors
}
