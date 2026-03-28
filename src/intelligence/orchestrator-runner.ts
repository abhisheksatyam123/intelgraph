import {
  DEFAULT_FALLBACK_POLICY,
  decideOrchestrationAction,
  type CParserEnricher,
  type ClangdEnricher,
  type EnrichmentAttempt,
  type FallbackPolicy,
  type LlmEnricher,
  type NormalizedQueryResponse,
  type PersistenceContracts,
  type QueryRequest,
  validateQueryRequest,
} from "./contracts/orchestrator.js"

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

function buildResponse(params: {
  request: QueryRequest
  status: NormalizedQueryResponse["status"]
  rows: Array<Record<string, unknown>>
  attempts: EnrichmentAttempt[]
  errors?: string[]
}): NormalizedQueryResponse {
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
    data: rowsToResponseData(params.rows),
    provenance: {
      path,
      deterministicAttempts: params.attempts
        .filter((a) => a.source === "clangd" || a.source === "c_parser")
        .map((a) => `${a.source}:${a.status}`),
      llmUsed,
    },
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
