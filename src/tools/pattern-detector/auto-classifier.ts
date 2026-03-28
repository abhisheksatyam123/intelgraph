/**
 * auto-classifier.ts — Code-derived classification of unknown registration calls.
 *
 * Uses tree-sitter AST (via c-parser.ts) to classify registration calls without
 * any hardcoded pattern names. The approach:
 *
 *   1. Parse the registration API body with tree-sitter
 *   2. Extract function parameters — identify fn-ptr params by type_identifier
 *      (typedef) vs primitive_type (int, void, etc.)
 *   3. Find the fn-ptr parameter at the matching arg position
 *   4. Extract callbackParamName from the function signature
 *   5. Derive connectionKind from call name tokens
 *   6. Extract dispatchKey from adjacent ALL_CAPS arg
 *
 * No LSP hover() needed — tree-sitter gives us the parameter types directly
 * from the function signature. No regex for store scanning — tree-sitter
 * assignment_expression nodes give us exact field names.
 *
 * Macro expansion: if definition() resolves to a macro body, the auto-classifier
 * extracts the underlying function name and calls definition() again.
 *
 * Graceful degradation: any failure returns null (caller falls back to
 * unclassified site — same as before auto-classifier existed).
 */

import { fileURLToPath } from "url"
import {
  parseSource,
  extractFunctionParams,
  findStoreAssignments,
  findAllNodes,
} from "./c-parser.js"
import type { FunctionCall } from "./c-parser.js"
import type { ClassifiedSite, PatternConnectionKind } from "./types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoClassifierDeps {
  lspClientFull: {
    /** hover() kept for backward compat but NOT used for fn-ptr detection */
    hover?: (file: string, line: number, char: number) => Promise<any>
    definition: (file: string, line: number, char: number) => Promise<any[]>
  }
  readFile: (filePath: string) => string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to auto-classify an unknown registration call using tree-sitter AST
 * analysis of the registration API body.
 *
 * Returns a ClassifiedSite with matchedPattern.name = "auto:<callName>"
 * and callbackParamName set, or null if classification fails.
 */
export async function autoClassifyCall(
  call: FunctionCall,
  callbackName: string,
  filePath: string,
  refLine0: number,
  refChar0: number,
  deps: AutoClassifierDeps,
): Promise<ClassifiedSite | null> {
  try {
    // Step 1: get the registration API body via definition()
    const callNameChar = findCallNameChar(filePath, refLine0, call.name, deps)
    if (callNameChar < 0) return null

    const defs = await deps.lspClientFull.definition(filePath, refLine0, callNameChar)
    if (!defs?.length) return null

    const defUri = defs[0].uri ?? ""
    const defFile = defUri.startsWith("file://") ? fileURLToPath(defUri) : defUri
    const defLine = defs[0].range?.start?.line ?? 0
    const defSource = deps.readFile(defFile)
    if (!defSource) return null

    // Step 2: check if definition resolved to a macro — if so, follow expansion
    const { resolvedSource, resolvedFile, resolvedLine } = await followMacroExpansion(
      defSource, defFile, defLine, deps,
    )

    // Step 3: parse the registration API body with tree-sitter
    const root = parseSource(resolvedSource)

    // Step 4: extract function parameters from the AST
    const params = root
      ? extractFunctionParams(root, resolvedLine)
      : extractParamsFallback(resolvedSource, resolvedLine)

    // Step 5: find which arg in the call matches the callback (fn-ptr param)
    // Strategy: find the first fn-ptr typedef param whose name appears in the call args
    const fnPtrArgIndex = detectFnPtrArgIndex(call.args, callbackName, params)

    // Step 6: extract callbackParamName — the parameter name in the body
    const callbackParamName = fnPtrArgIndex >= 0 && fnPtrArgIndex < params.length
      ? params[fnPtrArgIndex].name
      : null

    // Step 7: derive connection kind and dispatch key
    const connectionKind = deriveConnectionKind(call.name)
    const dispatchKey = extractDispatchKey(call.args, fnPtrArgIndex)

    // Build a synthetic CallPattern
    const syntheticPattern = {
      name: `auto:${call.name}`,
      registrationApi: call.name,
      connectionKind,
      keyArgIndex: fnPtrArgIndex > 0 ? fnPtrArgIndex - 1 : 0,
      keyDescription: "auto-detected",
    }

    return {
      callbackName,
      filePath,
      line: refLine0,
      character: refChar0,
      sourceText: call.fullText,
      matchedPattern: syntheticPattern,
      dispatchKey,
      connectionKind,
      viaRegistrationApi: call.name,
      enclosingCall: call,
      callbackParamName: callbackParamName ?? undefined,
      callbackArgIndex: fnPtrArgIndex >= 0 ? fnPtrArgIndex : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Derive a PatternConnectionKind from the registration call name.
 * Uses token-based heuristics — no hardcoded API names.
 */
export function deriveConnectionKind(callName: string): PatternConnectionKind {
  const n = callName.toLowerCase()
  if (/irq|interrupt/.test(n))             return "hw_interrupt"
  if (/signal|event|notif|notify/.test(n)) return "event"
  if (/msg|message|thread_comm/.test(n))   return "api_call"
  return "api_call"
}

/**
 * Extract the dispatch key from the arguments adjacent to the fn-ptr arg.
 * Looks for ALL_CAPS_CONSTANT or numeric literal not at the fn-ptr position.
 */
export function extractDispatchKey(args: string[], fnPtrArgIndex: number): string | null {
  // Check arg immediately before the fn-ptr arg first (most common: key, callback)
  const candidates = [fnPtrArgIndex - 1, fnPtrArgIndex + 1]
  for (const idx of candidates) {
    if (idx < 0 || idx >= args.length) continue
    const arg = args[idx].trim()
    // ALL_CAPS_CONSTANT (e.g. OFFLOAD_BPF, A_INUM_WSI, WMI_LPI_RESULT_EVENTID)
    if (/^[A-Z_][A-Z0-9_]{2,}$/.test(arg)) return arg
    // Numeric literal
    if (/^\d+$/.test(arg)) return arg
  }
  return null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect which argument index is the fn-ptr (callback) using tree-sitter
 * parameter type analysis.
 *
 * Strategy:
 *   1. Find fn-ptr typedef params (type_identifier + identifier declarator)
 *   2. Match against the call args by position
 *   3. If the callbackName appears in the args, use that position
 *   4. Otherwise use the first fn-ptr param position
 *   5. Fallback: last arg
 */
function detectFnPtrArgIndex(
  callArgs: string[],
  callbackName: string,
  params: Array<{ name: string; typeText: string; isFnPtrTypedef: boolean }>,
): number {
  // First: check if callbackName directly appears in the args
  const directIdx = callArgs.findIndex((a) => a.trim() === callbackName)
  if (directIdx >= 0) return directIdx

  // Second: find fn-ptr typedef params and return the first one's index
  for (let i = 0; i < params.length && i < callArgs.length; i++) {
    if (params[i].isFnPtrTypedef) return i
  }

  // Fallback: last arg (most WLAN registration APIs put callback last or second-to-last)
  return callArgs.length - 1
}

/**
 * Check if a macro definition body contains a call to an underlying function,
 * and if so, follow definition() to that function's body.
 */
async function followMacroExpansion(
  defSource: string,
  defFile: string,
  defLine: number,
  deps: AutoClassifierDeps,
): Promise<{ resolvedSource: string; resolvedFile: string; resolvedLine: number }> {
  const lines = defSource.split(/\r?\n/)
  const defLineText = lines[defLine] ?? ""

  // Detect macro: line starts with #define
  const isMacro = /^\s*#\s*define\b/.test(defLineText)
  if (!isMacro) {
    return { resolvedSource: defSource, resolvedFile: defFile, resolvedLine: defLine }
  }

  // Parse the macro body with tree-sitter to find the underlying function call
  const root = parseSource(defSource)
  if (root) {
    // Find call_expression nodes in the macro body lines
    const macroLines = lines.slice(defLine, Math.min(defLine + 10, lines.length))
    const macroText = macroLines.join("\n").replace(/\\\s*\n/g, " ")

    // Extract the first function name called in the macro body
    const callMatch = macroText.match(/\b([a-zA-Z_]\w+)\s*\(/)
    const macroNameMatch = defLineText.match(/#\s*define\s+(\w+)/)
    const macroName = macroNameMatch?.[1] ?? ""

    const bodyCallMatches = [...macroText.matchAll(/\b([a-zA-Z_]\w+)\s*\(/g)]
    const underlyingFn = bodyCallMatches
      .map((m) => m[1])
      .find((name) => name !== macroName && name.length > 3 && !/^(if|for|while|switch|return)$/.test(name))

    if (underlyingFn) {
      // Find the line in the macro body that contains the underlying function
      const bodyLineIdx = lines.slice(defLine, defLine + 10).findIndex((l) => l.includes(underlyingFn))
      if (bodyLineIdx >= 0) {
        const bodyLine = defLine + bodyLineIdx
        const bodyLineText = lines[bodyLine] ?? ""
        const fnCharOffset = bodyLineText.indexOf(underlyingFn)

        if (fnCharOffset >= 0) {
          try {
            const defs2 = await deps.lspClientFull.definition(defFile, bodyLine, fnCharOffset)
            if (defs2?.length) {
              const realFile = defs2[0].uri?.startsWith("file://")
                ? fileURLToPath(defs2[0].uri)
                : defs2[0].uri
              const realLine = defs2[0].range?.start?.line ?? 0
              const realSource = deps.readFile(realFile)
              if (realSource) {
                return { resolvedSource: realSource, resolvedFile: realFile, resolvedLine: realLine }
              }
            }
          } catch {
            // definition() failed — return original
          }
        }
      }
    }
  }

  return { resolvedSource: defSource, resolvedFile: defFile, resolvedLine: defLine }
}

/**
 * Fallback parameter extraction using regex when tree-sitter is not available.
 * Handles: "int name", "data_fn_t data_handler", "void *ctx"
 */
function extractParamsFallback(
  source: string,
  defLine: number,
): Array<{ name: string; typeText: string; isFnPtrTypedef: boolean }> {
  const lines = source.split(/\r?\n/)
  let sigText = ""
  for (let i = defLine; i < Math.min(defLine + 20, lines.length); i++) {
    sigText += " " + lines[i]
    if (lines[i].includes("{")) break
  }

  const parenStart = sigText.indexOf("(")
  const parenEnd = sigText.lastIndexOf(")")
  if (parenStart < 0 || parenEnd < 0) return []

  const paramList = sigText.slice(parenStart + 1, parenEnd)
  const params = splitParamsFallback(paramList)

  return params.map((p) => {
    const trimmed = p.trim()
    const tokens = trimmed.replace(/[*()]/g, " ").trim().split(/\s+/)
    const name = tokens[tokens.length - 1] ?? ""
    const typeText = tokens.slice(0, -1).join(" ")
    // Heuristic: fn-ptr typedef if type doesn't contain primitive keywords
    const isFnPtrTypedef = !["void", "int", "char", "unsigned", "signed", "long", "short", "float", "double", "struct", "enum"].some((kw) => typeText.includes(kw))
      && tokens.length >= 2
    return { name, typeText, isFnPtrTypedef }
  })
}

function splitParamsFallback(paramList: string): string[] {
  const params: string[] = []
  let depth = 0, current = ""
  for (const ch of paramList) {
    if (ch === "(") { depth++; current += ch }
    else if (ch === ")") { depth--; current += ch }
    else if (ch === "," && depth === 0) { params.push(current); current = "" }
    else current += ch
  }
  if (current.trim()) params.push(current)
  return params
}

/**
 * Find the character offset of a call name token on a given line.
 */
function findCallNameChar(
  filePath: string,
  line0: number,
  callName: string,
  deps: AutoClassifierDeps,
): number {
  const source = deps.readFile(filePath)
  if (!source) return -1
  const lineText = source.split(/\r?\n/)[line0] ?? ""
  return lineText.indexOf(callName)
}
