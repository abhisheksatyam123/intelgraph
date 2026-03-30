/**
 * get-callers.ts — Unified single-endpoint caller resolution.
 *
 * Runs the full caller-resolution waterfall internally and returns a single
 * structured JSON response. Frontends call ONE tool instead of orchestrating
 * 5 different tools with fallback logic.
 *
 * Waterfall (highest quality first):
 *   1. lsp_runtime_flow      — LLM/cache-based runtime invoker (best quality, needs LLM config)
 *   2. who_calls_api_at_runtime — DB runtime graph (needs intelligence snapshot)
 *   3. who_calls_api         — DB static graph (needs intelligence snapshot)
 *   4. lsp_indirect_callers  — LSP + C parser dispatch chain (resolve:true)
 *   5. lsp_incoming_calls    — Direct callers only (always available)
 *
 * Name-alias handling: DB queries are tried with canonical name AND common
 * C firmware alias variants (_foo, __foo, foo___RAM, _foo___RAM).
 */

import type { LspClient } from "../lsp/index.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"
import type { OrchestratorRunnerDeps } from "../intelligence/index.js"
import { executeOrchestratedQuery } from "../intelligence/index.js"
import { buildRuntimeFlowPayload } from "./reason-engine/runtime-flow-output.js"
import { readReasoningConfig } from "./reason-engine/reason-config.js"
import { prepareReasonQuery } from "./reason-engine/reason-query.js"
import { getLogger } from "../logging/logger.js"
import { fileURLToPath } from "url"

// ── Response types ────────────────────────────────────────────────────────────

/**
 * The role of a caller entry — the key distinction the frontend needs.
 *
 *   runtime_caller  — this function ACTUALLY INVOKES the target at runtime
 *                     (via direct call, fn-ptr dispatch, timer callback, etc.)
 *   registrar       — this function REGISTERS the target as a callback/handler
 *                     but does NOT call it directly at runtime
 *   direct_caller   — direct static call (always a runtime caller)
 *
 * Frontends MUST show only runtime_caller and direct_caller entries.
 * Registrar entries are context only — they explain HOW the target got wired in,
 * but they are NOT the function that invokes the target at runtime.
 */
export type CallerRole = "runtime_caller" | "registrar" | "direct_caller"

export type CallerInvocationType =
  | "runtime_direct_call"
  | "runtime_dispatch_table_call"
  | "runtime_callback_registration_call"
  | "runtime_function_pointer_call"
  | "interface_registration"   // registrar — NOT a runtime caller
  | "direct_call"
  | "unknown"

export interface CallerEntry {
  /** Canonical function name of the caller / runtime invoker */
  name: string
  /** Absolute file path (empty string if not available) */
  filePath: string
  /** 1-based line number (0 if not available) */
  lineNumber: number
  /**
   * Role of this entry — use this to decide what to show in the UI.
   *   runtime_caller  → show in the callers tree
   *   direct_caller   → show in the callers tree
   *   registrar       → show only as context (viaRegistrationApi), NOT as a caller
   */
  callerRole: CallerRole
  /** How this function invokes the target (detail within the role) */
  invocationType: CallerInvocationType
  /** Confidence score 0–1 */
  confidence: number
  /**
   * Registration API that wired the fn-ptr (if indirect).
   * Present when callerRole=runtime_caller and the call is indirect.
   * Also present when callerRole=registrar (the registrar IS this function).
   */
  viaRegistrationApi?: string
  /** Which waterfall step produced this entry */
  source: WaterfallStep
}

export type WaterfallStep =
  | "lsp_runtime_flow"
  | "intelligence_query_runtime"
  | "intelligence_query_static"
  | "lsp_indirect_callers"
  | "lsp_incoming_calls"

export interface GetCallersResponse {
  /** Resolved target API name */
  targetApi: string
  /** Absolute file path of the target */
  targetFile: string
  /** 1-based line of the target */
  targetLine: number
  /**
   * Runtime callers and direct callers — the functions that ACTUALLY INVOKE
   * the target at runtime. These are what the frontend should display.
   * callerRole is always "runtime_caller" or "direct_caller" here.
   */
  callers: CallerEntry[]
  /**
   * Registration APIs — functions that WIRED the target as a callback/handler
   * but do NOT call it directly at runtime.
   * callerRole is always "registrar" here.
   * Show these as context (e.g. "registered via X") but NOT as callers in the tree.
   */
  registrars: CallerEntry[]
  /**
   * Which waterfall step produced the final callers list.
   * "none" means all steps failed or returned empty.
   */
  source: WaterfallStep | "none"
  provenance: {
    /** All steps that were attempted, in order */
    stepsAttempted: WaterfallStep[]
    /** The step whose results are in `callers` */
    stepUsed: WaterfallStep | "none"
    /** Whether alias variants were tried for DB queries */
    aliasVariantsTriedForDb: boolean
    /** Alias variants that were tried (if any) */
    aliasVariantsTried: string[]
  }
}

// ── Alias variant helpers ─────────────────────────────────────────────────────

/**
 * Canonicalize a C symbol name by stripping leading underscores and ___RAM suffixes.
 * wlan_bpf_filter_offload_handler___RAM → wlan_bpf_filter_offload_handler
 * _wlan_bpf_filter_offload_handler      → wlan_bpf_filter_offload_handler
 */
export function canonicalizeSymbol(name: string): string {
  const trimmed = name.trim()
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
export function symbolAliasVariants(name: string): string[] {
  const canonical = canonicalizeSymbol(name)
  const variants = new Set<string>([canonical])
  variants.add(`_${canonical}`)
  variants.add(`__${canonical}`)
  variants.add(`${canonical}___RAM`)
  variants.add(`_${canonical}___RAM`)
  if (name !== canonical) variants.add(name)
  return [...variants]
}

// ── Waterfall implementation ──────────────────────────────────────────────────

export async function resolveCallers(
  client: LspClient,
  tracker: IndexTracker,
  backend: UnifiedBackend,
  intelligenceDeps: OrchestratorRunnerDeps | null,
  args: {
    file: string
    line: number
    character: number
    snapshotId?: number
    maxNodes?: number
    resolve?: boolean
  },
): Promise<GetCallersResponse> {
  const log = getLogger()
  const maxNodes = args.maxNodes ?? 50
  const shouldResolve = args.resolve ?? true
  const stepsAttempted: WaterfallStep[] = []
  const aliasVariantsTried: string[] = []

  // ── Step 0: resolve target symbol name via prepareCallHierarchy ──────────────
  let targetApi = ""
  let targetFile = args.file
  let targetLine = args.line

  try {
    const seedItems = await client.prepareCallHierarchy(args.file, args.line - 1, args.character - 1)
    const seed = seedItems?.[0]
    if (seed) {
      targetApi = canonicalizeSymbol(seed.name ?? "")
      targetFile = seed.uri?.startsWith("file://") ? fileURLToPath(seed.uri) : (seed.uri ?? args.file)
      targetLine = (seed.selectionRange?.start?.line ?? seed.range?.start?.line ?? args.line - 1) + 1
    }
  } catch {
    // proceed with file/line as-is
  }

  // Fallback: use hover to get symbol name
  if (!targetApi) {
    try {
      const hover = await client.hover(args.file, args.line - 1, args.character - 1)
      const hoverText = typeof hover?.contents === "string"
        ? hover.contents
        : hover?.contents?.value ?? ""
      const match = hoverText.match(/(?:function|method|void|int|bool|static)\s+(\w+)/i)
      if (match) targetApi = canonicalizeSymbol(match[1]!)
    } catch { /* ignore */ }
  }

  if (!targetApi) targetApi = `symbol@${args.file}:${args.line}`

  // ── Step 1: lsp_runtime_flow (LLM/cache) ─────────────────────────────────────
  stepsAttempted.push("lsp_runtime_flow")
  try {
    const reasoningConfig = readReasoningConfig(client.root)
    const prepared = await prepareReasonQuery(backend, client, {
      file: args.file,
      line: args.line,
      character: args.character,
      targetSymbol: targetApi,
    })
    const result = await backend.reasonEngine.run(
      client,
      {
        targetSymbol: prepared.symbol || targetApi,
        targetFile: args.file,
        targetLine: args.line,
        knownEvidence: prepared.knownEvidence,
        suspectedPatterns: [],
      },
      reasoningConfig,
    )
    const payload = buildRuntimeFlowPayload(prepared.symbol || targetApi, result)
    const callers = runtimeFlowToCallers(payload, "lsp_runtime_flow")
    if (callers.length > 0) {
      log.info("get_callers: lsp_runtime_flow succeeded", { targetApi, callerCount: callers.length })
      return buildResponse(targetApi, targetFile, targetLine, callers, "lsp_runtime_flow", stepsAttempted, false, [])
    }
  } catch (err) {
    log.debug("get_callers: lsp_runtime_flow failed", { error: String(err) })
  }

  // ── Step 2 + 3: intelligence_query (DB) with alias variants ──────────────────
  if (intelligenceDeps && args.snapshotId && args.snapshotId > 0) {
    const variants = symbolAliasVariants(targetApi)
    aliasVariantsTried.push(...variants)

    // Step 2: who_calls_api_at_runtime — single query matching all alias variants
    stepsAttempted.push("intelligence_query_runtime")
    try {
      const res = await executeOrchestratedQuery(
        {
          intent: "who_calls_api_at_runtime",
          snapshotId: args.snapshotId,
          apiName: canonicalizeSymbol(targetApi),
          apiNameAliases: variants,
          limit: maxNodes,
        },
        intelligenceDeps,
      )
      if ((res.status === "hit" || res.status === "enriched") && res.data.nodes.length > 0) {
        const callers = dbRuntimeNodesToCallers(res.data.nodes, "intelligence_query_runtime")
        if (callers.length > 0) {
          log.info("get_callers: intelligence_query_runtime succeeded", { targetApi, callerCount: callers.length })
          return buildResponse(targetApi, targetFile, targetLine, callers, "intelligence_query_runtime", stepsAttempted, true, aliasVariantsTried)
        }
      }
    } catch (err) {
      log.debug("get_callers: intelligence_query_runtime failed", { error: String(err) })
    }

    // Step 3: who_calls_api (static graph) — single query matching all alias variants
    stepsAttempted.push("intelligence_query_static")
    try {
      const res = await executeOrchestratedQuery(
        {
          intent: "who_calls_api",
          snapshotId: args.snapshotId,
          apiName: canonicalizeSymbol(targetApi),
          apiNameAliases: variants,
          limit: maxNodes,
        },
        intelligenceDeps,
      )
      if ((res.status === "hit" || res.status === "enriched") && res.data.nodes.length > 0) {
        const callers = dbStaticNodesToCallers(res.data.nodes, res.data.edges ?? [], targetApi, "intelligence_query_static")
        if (callers.length > 0) {
          log.info("get_callers: intelligence_query_static succeeded", { targetApi, callerCount: callers.length })
          return buildResponse(targetApi, targetFile, targetLine, callers, "intelligence_query_static", stepsAttempted, true, aliasVariantsTried)
        }
      }
    } catch (err) {
      log.debug("get_callers: intelligence_query_static failed", { error: String(err) })
    }
  }

  // ── Step 4: lsp_indirect_callers (LSP + C parser, resolve:true) ──────────────
  stepsAttempted.push("lsp_indirect_callers")
  try {
    const graph = await backend.patterns.collectIndirectCallers(client, {
      file: args.file,
      line: args.line,
      character: args.character,
      maxNodes,
      resolve: shouldResolve,
    })
    if (graph.nodes.length > 0) {
      const callers = indirectGraphToCallers(graph, "lsp_indirect_callers")
      if (callers.length > 0) {
        log.info("get_callers: lsp_indirect_callers succeeded", { targetApi, callerCount: callers.length })
        return buildResponse(targetApi, targetFile, targetLine, callers, "lsp_indirect_callers", stepsAttempted, false, [])
      }
    }
  } catch (err) {
    log.debug("get_callers: lsp_indirect_callers failed", { error: String(err) })
  }

  // ── Step 5: lsp_incoming_calls (direct callers only, always available) ────────
  stepsAttempted.push("lsp_incoming_calls")
  try {
    const results = await client.incomingCalls(args.file, args.line - 1, args.character - 1)
    if (results?.length) {
      const callers = incomingCallsToCallers(results, "lsp_incoming_calls")
      log.info("get_callers: lsp_incoming_calls succeeded", { targetApi, callerCount: callers.length })
      return buildResponse(targetApi, targetFile, targetLine, callers, "lsp_incoming_calls", stepsAttempted, false, [])
    }
  } catch (err) {
    log.debug("get_callers: lsp_incoming_calls failed", { error: String(err) })
  }

  // All steps failed or returned empty
  log.warn("get_callers: all steps returned empty", { targetApi, stepsAttempted })
  return buildResponse(targetApi, targetFile, targetLine, [], "none", stepsAttempted, aliasVariantsTried.length > 0, aliasVariantsTried)
}

// ── Adapter functions ─────────────────────────────────────────────────────────

/** Derive callerRole from invocationType — single source of truth. */
function roleFromInvocationType(invocationType: CallerInvocationType): CallerRole {
  switch (invocationType) {
    case "runtime_direct_call":
    case "runtime_dispatch_table_call":
    case "runtime_callback_registration_call":
    case "runtime_function_pointer_call":
      return "runtime_caller"
    case "direct_call":
      return "direct_caller"
    case "interface_registration":
    case "unknown":
    default:
      return "registrar"
  }
}

function runtimeFlowToCallers(
  payload: import("./reason-engine/runtime-flow-output.js").RuntimeFlowPayload,
  source: WaterfallStep,
): CallerEntry[] {
  const out: CallerEntry[] = []
  const seen = new Set<string>()
  for (const flow of payload.runtimeFlows) {
    if (!flow) continue
    const name = canonicalizeSymbol(flow.immediateInvoker ?? "")
    if (!name) continue
    const key = `${name}|runtime_direct_call`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      filePath: flow.dispatchSite?.file ?? "",
      lineNumber: flow.dispatchSite?.line ?? 0,
      callerRole: "runtime_caller",
      invocationType: "runtime_direct_call",
      confidence: 0.9,
      source,
    })
  }
  return out
}

function dbRuntimeNodesToCallers(
  nodes: Record<string, unknown>[],
  source: WaterfallStep,
): CallerEntry[] {
  const out: CallerEntry[] = []
  const seen = new Set<string>()
  for (const n of nodes) {
    const name = canonicalizeSymbol(String(n["runtime_caller_api_name"] ?? ""))
    if (!name) continue
    const rawType = String(n["runtime_caller_invocation_type_classification"] ?? "")
    const invocationType = dbInvocationTypeToCallerType(rawType)
    const key = `${name}|${invocationType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      filePath: String(n["file_path"] ?? n["filePath"] ?? ""),
      lineNumber: Number(n["line_number"] ?? n["lineNumber"] ?? 0),
      callerRole: roleFromInvocationType(invocationType),
      invocationType,
      confidence: Number(n["runtime_relation_confidence_score"] ?? 0.7),
      source,
    })
  }
  return out
}

function dbStaticNodesToCallers(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  targetApiName: string,
  source: WaterfallStep,
): CallerEntry[] {
  const canonical = canonicalizeSymbol(targetApiName)
  // Find the target node id (kind='api' or matches the target name)
  const targetNodeId = nodes.find(
    (n) => n["kind"] === "api" || canonicalizeSymbol(String(n["symbol"] ?? n["name"] ?? "")) === canonical,
  )?.["id"] as string | undefined

  const out: CallerEntry[] = []
  const seen = new Set<string>()

  for (const edge of edges) {
    const toId = String(edge["to"] ?? "")
    if (targetNodeId && toId !== targetNodeId) continue

    const fromId = String(edge["from"] ?? "")
    const fromNode = nodes.find((n) => n["id"] === fromId)
    if (!fromNode) continue

    const name = canonicalizeSymbol(String(fromNode["symbol"] ?? fromNode["name"] ?? ""))
    if (!name) continue

    const edgeKind = String(edge["kind"] ?? edge["edge_kind"] ?? "calls")
    const invocationType = staticEdgeKindToCallerType(edgeKind)
    // registers_callback / dispatches_to / interface_registration = registrar, NOT runtime caller
    const callerRole = roleFromInvocationType(invocationType)
    const key = `${name}|${invocationType}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      name,
      filePath: String(fromNode["filePath"] ?? fromNode["file_path"] ?? ""),
      lineNumber: Number(fromNode["lineNumber"] ?? fromNode["line_number"] ?? 0),
      callerRole,
      invocationType,
      confidence: Number(edge["confidence"] ?? 0.6),
      viaRegistrationApi: edge["viaRegistrationApi"] ? String(edge["viaRegistrationApi"]) : undefined,
      source,
    })
  }
  return out
}

function indirectGraphToCallers(
  graph: import("./indirect-callers.js").IndirectCallerGraph,
  source: WaterfallStep,
): CallerEntry[] {
  const out: CallerEntry[] = []
  const seen = new Set<string>()

  for (const node of graph.nodes) {
    // If a resolved dispatch function is available, use it as the runtime invoker
    const chain = node.resolvedChain
    if (chain?.dispatch?.dispatchFunction) {
      const name = canonicalizeSymbol(chain.dispatch.dispatchFunction)
      const key = `${name}|runtime_dispatch_table_call`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({
          name,
          filePath: chain.dispatch.dispatchFile ?? node.file,
          lineNumber: chain.dispatch.dispatchLine != null ? chain.dispatch.dispatchLine + 1 : node.line,
          callerRole: "runtime_caller",
          invocationType: "runtime_dispatch_table_call",
          confidence: confidenceLevelToScore(chain.confidenceLevel),
          viaRegistrationApi: node.classification?.registrationApi ?? node.name,
          source,
        })
      }
      continue
    }

    // No dispatch resolved — emit the registrar as the best available answer.
    // callerRole=registrar so the frontend knows this is NOT the runtime invoker.
    const name = canonicalizeSymbol(node.name)
    if (!name) continue
    const invocationType = classificationToCallerType(node.classification?.connectionKind)
    const key = `${name}|${invocationType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      filePath: node.file,
      lineNumber: node.line,
      callerRole: "registrar",
      invocationType,
      confidence: chain ? confidenceLevelToScore(chain.confidenceLevel) : 0.5,
      viaRegistrationApi: node.classification?.registrationApi,
      source,
    })
  }

  return out
}

function incomingCallsToCallers(
  results: any[],
  source: WaterfallStep,
): CallerEntry[] {
  const out: CallerEntry[] = []
  const seen = new Set<string>()

  for (const call of results) {
    const from = call.from ?? call.caller
    if (!from) continue
    const name = canonicalizeSymbol(from.name ?? "")
    if (!name) continue
    const key = `${name}|direct_call`
    if (seen.has(key)) continue
    seen.add(key)
    const uri = from.uri ?? ""
    const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri
    const line = (from.selectionRange?.start?.line ?? from.range?.start?.line ?? 0) + 1
    out.push({
      name,
      filePath,
      lineNumber: line,
      callerRole: "direct_caller",
      invocationType: "direct_call",
      confidence: 1.0,
      source,
    })
  }
  return out
}

// ── Type mapping helpers ──────────────────────────────────────────────────────

function dbInvocationTypeToCallerType(raw: string): CallerInvocationType {
  switch (raw) {
    case "runtime_direct_call":                return "runtime_direct_call"
    case "runtime_callback_registration_call": return "runtime_callback_registration_call"
    case "runtime_function_pointer_call":      return "runtime_function_pointer_call"
    case "runtime_dispatch_table_call":        return "runtime_dispatch_table_call"
    default:                                   return "unknown"
  }
}

function staticEdgeKindToCallerType(edgeKind: string): CallerInvocationType {
  switch (edgeKind) {
    case "calls":
    case "api_call":
    case "direct_call":          return "direct_call"
    case "indirect_calls":
    case "registers_callback":
    case "dispatches_to":
    case "interface_registration": return "interface_registration"
    default:                       return "unknown"
  }
}

function classificationToCallerType(connectionKind?: string): CallerInvocationType {
  switch (connectionKind) {
    case "api_call":               return "direct_call"
    case "interface_registration": return "interface_registration"
    case "hw_interrupt":           return "runtime_function_pointer_call"
    case "ring_signal":            return "runtime_function_pointer_call"
    case "timer_callback":         return "runtime_callback_registration_call"
    default:                       return "interface_registration"
  }
}

function confidenceLevelToScore(level?: string): number {
  switch (level) {
    case "high":   return 0.9
    case "medium": return 0.7
    case "low":    return 0.4
    default:       return 0.5
  }
}

// ── Response builder ──────────────────────────────────────────────────────────

function buildResponse(
  targetApi: string,
  targetFile: string,
  targetLine: number,
  allEntries: CallerEntry[],
  stepUsed: WaterfallStep | "none",
  stepsAttempted: WaterfallStep[],
  aliasVariantsTriedForDb: boolean,
  aliasVariantsTried: string[],
): GetCallersResponse {
  // Split into runtime callers and registrars
  const runtimeCallers = allEntries.filter((e) => e.callerRole !== "registrar")
  const registrars = allEntries.filter((e) => e.callerRole === "registrar")

  // Sort each group by confidence descending, then by name for stability
  const sortFn = (a: CallerEntry, b: CallerEntry) =>
    b.confidence !== a.confidence ? b.confidence - a.confidence : a.name.localeCompare(b.name)

  return {
    targetApi,
    targetFile,
    targetLine,
    callers: runtimeCallers.sort(sortFn),
    registrars: registrars.sort(sortFn),
    source: stepUsed,
    provenance: {
      stepsAttempted,
      stepUsed,
      aliasVariantsTriedForDb,
      aliasVariantsTried,
    },
  }
}
