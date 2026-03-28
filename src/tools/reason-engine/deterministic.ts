/**
 * deterministic.ts — Write code-derived (deterministic) reason paths to the DB.
 *
 * The code-derived chain tracer produces a ResolvedChain by following LSP
 * operations from the registration site through the store field to the dispatch
 * site and then to the runtime trigger. This module converts that chain into a
 * ReasonPath with provenance:"deterministic" and persists it via writeLlmDbEntry.
 *
 * Confidence scoring:
 *   L1 (registration_detected)  → 0.5
 *   L3 (store_container_found)  → 0.7
 *   L4 (dispatch_site_found)    → 0.9
 *   L5 (runtime_trigger_found)  → 0.95
 */

import { fileURLToPath } from "url"
import type { ResolvedChain } from "../pattern-resolver/types.js"
import type { ReasonPath, InvocationReason, DispatchSite, RegistrationGate } from "./contracts.js"
import { writeLlmDbEntry, computeFileHash } from "./db.js"
import { toRuntimeFlowRecord } from "./runtime-flow.js"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DeterministicWriteInput {
  /** Workspace root for DB path resolution. */
  workspaceRoot: string
  /** Target callback symbol name. */
  targetSymbol: string
  /** Absolute path to the file containing the target function definition. */
  targetFile: string
  /** 1-based line number of the target function definition. */
  targetLine: number
  /** The resolved chain from the code-derived chain tracer. */
  resolvedChain: ResolvedChain
  /**
   * Parameter name in the registration API body that holds the target callback.
   * Extracted by the auto-classifier. Optional — absent for registry-based paths.
   */
  callbackParamName?: string
  /**
   * 0-based index of the callback arg in the registration call.
   * Extracted by the auto-classifier. Optional — absent for registry-based paths.
   */
  callbackArgIndex?: number
}

/**
 * Convert a ResolvedChain into a ReasonPath with provenance:"deterministic"
 * and write it to the LLM DB (same storage as LLM-derived entries).
 *
 * This allows the reason engine's cache-read path to serve deterministic
 * results without any special-casing — the consumer sees a ReasonPath
 * regardless of whether it was derived by code analysis or LLM.
 */
export function writeDeterministicReasonPath(input: DeterministicWriteInput): void {
  const {
    workspaceRoot,
    targetSymbol,
    targetFile,
    targetLine,
    resolvedChain,
    callbackParamName,
    callbackArgIndex,
  } = input

  const invocationReason = chainToInvocationReason(targetSymbol, resolvedChain)
  const runtimeFlow = toRuntimeFlowRecord(targetSymbol, invocationReason)

  const confidenceScore = resolvedChainConfidence(resolvedChain)

  const reasonPath: ReasonPath = {
    targetSymbol,
    invocationReason,
    runtimeFlow,
    registrarFn: resolvedChain.registration.apiName,
    registrationApi: resolvedChain.registration.apiName,
    storageFieldPath: resolvedChain.store.containerType ?? undefined,
    gates: [],
    evidence: [{ role: "code-derived", file: targetFile, line: targetLine }],
    provenance: "deterministic",
    confidence: {
      score: confidenceScore,
      reasons: ["code-derived-chain", `confidence-level:${resolvedChain.confidenceLevel}`],
    },
    callbackParamName,
    callbackArgIndex,
  }

  const connectionKey = `${workspaceRoot}::${targetSymbol}::${targetFile}:${targetLine}`

  // Collect files to hash for staleness detection
  const filesToHash = new Set<string>([targetFile])
  if (resolvedChain.dispatch.dispatchFile) filesToHash.add(resolvedChain.dispatch.dispatchFile)
  if (resolvedChain.trigger.triggerFile) filesToHash.add(resolvedChain.trigger.triggerFile)

  const hashManifest: Record<string, string> = {}
  for (const f of filesToHash) {
    const h = computeFileHash(f)
    if (h) hashManifest[f] = h
  }

  writeLlmDbEntry(workspaceRoot, {
    connectionKey,
    targetSymbol,
    reasonPaths: [reasonPath],
    requiredFiles: Array.from(filesToHash),
    hashManifest,
    createdAt: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a ResolvedChain into an InvocationReason.
 *
 * The chain stages map to InvocationReason fields:
 *   trigger  → runtimeTrigger (human-readable) + first entry in dispatchChain
 *   dispatch → middle entries in dispatchChain + dispatchSite
 *   target   → last entry in dispatchChain
 */
function chainToInvocationReason(
  targetSymbol: string,
  chain: ResolvedChain,
): InvocationReason {
  // Build dispatchChain: [trigger fn?, dispatch fn?, targetSymbol]
  const dispatchChain: string[] = []
  if (chain.trigger.triggerFile) {
    // Use the trigger file basename as a proxy for the trigger function name
    // when we don't have the actual function name yet
    const triggerFnName = chain.trigger.evidence ?? baseName(chain.trigger.triggerFile)
    if (triggerFnName) dispatchChain.push(triggerFnName)
  }
  if (chain.dispatch.dispatchFunction) {
    dispatchChain.push(chain.dispatch.dispatchFunction)
  }
  dispatchChain.push(targetSymbol)

  // Build runtimeTrigger description
  const triggerKind = chain.trigger.triggerKind ?? "unknown"
  const triggerKey = chain.trigger.triggerKey
  const runtimeTrigger = triggerKey
    ? `${triggerKind} (key: ${triggerKey})`
    : triggerKind

  // Build dispatchSite
  const dispatchSite: DispatchSite = {
    file: chain.dispatch.dispatchFile ?? chain.registration.file,
    line: chain.dispatch.dispatchLine !== null ? chain.dispatch.dispatchLine + 1 : chain.registration.line,
    snippet: chain.dispatch.invocationPattern ?? chain.dispatch.evidence ?? "",
  }

  // Build registrationGate
  const registrationGate: RegistrationGate = {
    registrarFn: chain.registration.apiName,
    registrationApi: chain.registration.apiName,
    conditions: [],
  }

  return {
    runtimeTrigger,
    dispatchChain,
    dispatchSite,
    registrationGate,
  }
}

/**
 * Map ResolvedChain confidence level to a numeric score.
 */
function resolvedChainConfidence(chain: ResolvedChain): number {
  switch (chain.confidenceLevel) {
    case "runtime_trigger_found":  return 0.95
    case "dispatch_site_found":    return 0.90
    case "store_container_found":  return 0.70
    case "dispatch_key_extracted": return 0.60
    case "registration_detected":  return 0.50
    default:                       return 0.50
  }
}

function baseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? filePath
}
