import { describe, expect, it } from "vitest"
import {
  decideOrchestrationAction,
  DEFAULT_FALLBACK_POLICY,
  QUERY_INTENTS,
  parseQueryIntent,
  shouldRunLlmFallback,
  validateQueryRequest,
  validateResponseShape,
  type EnricherContext,
  type EnrichmentAttempt,
  type NormalizedQueryResponse,
} from "../../src/intelligence/contracts/orchestrator.js"

describe("orchestrator contracts", () => {
  it("exposes expanded intent catalog", () => {
    expect(QUERY_INTENTS.length).toBeGreaterThanOrEqual(15)
    expect(QUERY_INTENTS).toContain("who_calls_api")
    expect(QUERY_INTENTS).toContain("where_struct_initialized")
    expect(QUERY_INTENTS).toContain("where_struct_modified")
    expect(QUERY_INTENTS).toContain("show_runtime_flow_for_trace")
  })

  it("parses normalized and alias intents", () => {
    expect(parseQueryIntent("who-calls-api")).toBe("who_calls_api")
    expect(parseQueryIntent("who_calls")).toBe("who_calls_api")
    expect(parseQueryIntent("where_struct_init")).toBe("where_struct_initialized")
    expect(parseQueryIntent("does_not_exist")).toBeNull()
  })

  it("validates api-based request", () => {
    const ok = validateQueryRequest({
      intent: "who_calls_api",
      snapshotId: 42,
      apiName: "wlan_bpf_filter_offload_handler",
      depth: 3,
    })
    expect(ok.ok).toBe(true)
  })

  it("rejects missing required fields by intent", () => {
    const badStruct = validateQueryRequest({ intent: "where_struct_modified", snapshotId: 1 })
    expect(badStruct.ok).toBe(false)
    if (!badStruct.ok) {
      expect(badStruct.errors.join(" ")).toContain("structName")
    }

    const badFieldPath = validateQueryRequest({
      intent: "find_field_access_path",
      snapshotId: 1,
      structName: "tqm_context",
    })
    expect(badFieldPath.ok).toBe(false)
    if (!badFieldPath.ok) {
      expect(badFieldPath.errors.join(" ")).toContain("fieldName")
    }
  })

  it("validates response shape for LLM-safe consumption", () => {
    const response: NormalizedQueryResponse = {
      snapshotId: 7,
      intent: "who_calls_api",
      status: "hit",
      data: { nodes: [], edges: [] },
      provenance: {
        path: "db_hit",
        deterministicAttempts: [],
        llmUsed: false,
      },
    }

    expect(validateResponseShape(response)).toEqual([])
    expect(validateResponseShape({ snapshotId: 7 })).not.toEqual([])
  })

  it("enforces deterministic-first fallback policy contract", () => {
    expect(DEFAULT_FALLBACK_POLICY.deterministicOrder).toEqual(["clangd", "c_parser"])
    expect(DEFAULT_FALLBACK_POLICY.llmLastResort).toBe(true)
    expect(DEFAULT_FALLBACK_POLICY.maxDeterministicPasses).toBeGreaterThan(0)
  })

  it("exposes backend adapter contracts and persistence boundaries", () => {
    type _ContractProbe = {
      sourceTypes: "clangd" | "c_parser" | "llm"
      hasCtx: EnricherContext
      hasAttempt: EnrichmentAttempt
    }
    const probe: _ContractProbe = {
      sourceTypes: "clangd",
      hasCtx: {
        policy: DEFAULT_FALLBACK_POLICY,
        priorAttempts: [],
      },
      hasAttempt: { source: "clangd", status: "success" },
    }
    expect(probe.sourceTypes).toBe("clangd")
    expect(probe.hasCtx.policy.llmLastResort).toBe(true)
  })

  it("allows llm fallback only after deterministic failures", () => {
    const request = {
      intent: "who_calls_api" as const,
      snapshotId: 100,
      apiName: "wlan_api",
    }

    const allowed = shouldRunLlmFallback(request, {
      policy: DEFAULT_FALLBACK_POLICY,
      priorAttempts: [
        { source: "clangd", status: "failed" },
        { source: "c_parser", status: "failed" },
      ],
    })
    expect(allowed).toBe(true)

    const deniedBeforeDeterministic = shouldRunLlmFallback(request, {
      policy: DEFAULT_FALLBACK_POLICY,
      priorAttempts: [],
    })
    expect(deniedBeforeDeterministic).toBe(false)

    const deniedWithSuccess = shouldRunLlmFallback(request, {
      policy: DEFAULT_FALLBACK_POLICY,
      priorAttempts: [
        { source: "clangd", status: "success" },
        { source: "c_parser", status: "failed" },
      ],
    })
    expect(deniedWithSuccess).toBe(false)
  })

  it("decides db-first orchestration lifecycle actions", () => {
    const request = {
      intent: "who_calls_api" as const,
      snapshotId: 100,
      apiName: "wlan_api",
    }

    const hit = decideOrchestrationAction({
      lookupHit: true,
      request,
      policy: DEFAULT_FALLBACK_POLICY,
      attempts: [],
    })
    expect(hit).toEqual({ type: "return_hit" })

    const firstMiss = decideOrchestrationAction({
      lookupHit: false,
      request,
      policy: DEFAULT_FALLBACK_POLICY,
      attempts: [],
    })
    expect(firstMiss).toEqual({ type: "run_deterministic", source: "clangd" })

    const secondDeterministic = decideOrchestrationAction({
      lookupHit: false,
      request,
      policy: DEFAULT_FALLBACK_POLICY,
      attempts: [{ source: "clangd", status: "failed" }],
    })
    expect(secondDeterministic).toEqual({ type: "run_deterministic", source: "c_parser" })

    const afterSuccess = decideOrchestrationAction({
      lookupHit: false,
      request,
      policy: DEFAULT_FALLBACK_POLICY,
      attempts: [{ source: "clangd", status: "success" }],
    })
    expect(afterSuccess).toEqual({ type: "retry_lookup" })

    const llmStep = decideOrchestrationAction({
      lookupHit: false,
      request,
      policy: DEFAULT_FALLBACK_POLICY,
      attempts: [
        { source: "clangd", status: "failed" },
        { source: "c_parser", status: "failed" },
      ],
    })
    expect(llmStep).toEqual({ type: "run_llm" })

    const terminal = decideOrchestrationAction({
      lookupHit: false,
      request,
      policy: DEFAULT_FALLBACK_POLICY,
      attempts: [
        { source: "clangd", status: "failed" },
        { source: "c_parser", status: "failed" },
        { source: "llm", status: "failed" },
      ],
    })
    expect(terminal).toEqual({ type: "return_not_found" })
  })
})
