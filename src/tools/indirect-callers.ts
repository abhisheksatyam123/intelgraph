import type { LspClient } from "../lsp/index.js"
import {
  INDIRECT_CALLER_CLASSIFICATIONS,
  IndirectCallersEngine,
  SYMBOL_KIND_CONSTANT,
  SYMBOL_KIND_FUNCTION,
  SYMBOL_KIND_VARIABLE,
  WLAN_REGISTRATION_APIS,
  classifyIncomingCall,
  findRingTrigger,
  formatIndirectCallers,
  type IncomingCallLike,
} from "./indirect-callers-engine.js"

export {
  INDIRECT_CALLER_CLASSIFICATIONS,
  IndirectCallersEngine,
  WLAN_REGISTRATION_APIS,
  classifyIncomingCall,
  findRingTrigger,
  formatIndirectCallers,
}

export { formatIndirectCallers as formatIndirectCallerTree }

/**
 * Classify a batch of raw incomingCalls results for display in lsp_incoming_calls.
 *
 * When targetName is not available (batch context), Tier 3 source-text check
 * falls back to conservative registration-call for unknown patterns.
 * Tier 1 (from.kind) and Tier 2 (WLAN_REGISTRATION_APIS) are unaffected.
 */
export function classifyIncomingCalls(results: any[]): any[] {
  return [...results]
    .map((call) => {
      const from = call.from ?? call.caller ?? {}
      const kindTag = from.kind === SYMBOL_KIND_FUNCTION
        ? "function"
        : from.kind === SYMBOL_KIND_VARIABLE
          ? "variable"
          : from.kind === SYMBOL_KIND_CONSTANT
            ? "constant"
            : `kind-${from.kind ?? "unknown"}`
      // Pass empty targetName — Tier 1 and Tier 2 still work correctly.
      // Tier 3 will conservatively classify unknowns as registration-call.
      const classification = classifyIncomingCall(call as IncomingCallLike, "")
      const baseTag = classification === "direct"
        ? "direct"
        : classification === "registration-dispatch-table"
          ? "dispatch-table"
          : classification === "registration-call"
            ? "reg-call"
            : classification === "registration-struct"
              ? "struct-reg"
              : "signal"
      return {
        ...call,
        from,
        classification,
        tags: [baseTag, kindTag],
      }
    })
    .sort((a, b) => {
      const aName = a.from?.name ?? ""
      const bName = b.from?.name ?? ""
      if (aName !== bName) return aName.localeCompare(bName)
      const aUri = a.from?.uri ?? ""
      const bUri = b.from?.uri ?? ""
      if (aUri !== bUri) return aUri.localeCompare(bUri)
      const aLine = a.from?.selectionRange?.start?.line ?? a.from?.range?.start?.line ?? -1
      const bLine = b.from?.selectionRange?.start?.line ?? b.from?.range?.start?.line ?? -1
      return aLine - bLine
    })
}

export async function collectIndirectCallers(
  client: LspClient,
  args: { file: string; line: number; character: number; maxNodes?: number },
): Promise<any> {
  const engine = new IndirectCallersEngine(client, { maxNodes: args.maxNodes })
  return engine.run(args.file, args.line - 1, args.character - 1)
}
