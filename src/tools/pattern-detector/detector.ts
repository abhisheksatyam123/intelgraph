/**
 * pattern-detector/detector.ts — Parser-based indirect caller detector.
 *
 * Given a target callback function, this module:
 *   1. Calls LSP references() to find all sites where the function is used.
 *   2. Reads the FULL source file at each site.
 *   3. Uses the C parser (findEnclosingCall) to find the enclosing call.
 *   4. Classifies by call name lookup in the registry (fast path).
 *   5. On registry miss: auto-classifier via LSP hover() + definition() (slow path).
 *   6. Extracts the dispatch key from the correct argument position.
 *
 * The parser handles multi-line calls, nested parens, strings, comments,
 * and macros — no fragile line-based regex needed.
 */

import { fileURLToPath } from "url"
import { findEnclosingCall, findEnclosingConstruct } from "./c-parser.js"
import { CALL_PATTERNS, INIT_PATTERNS } from "./registry.js"
import { autoClassifyCall } from "./auto-classifier.js"
import type {
  ClassifiedSite,
  DetectorDeps,
  DetectorInput,
  CallPattern,
  InitPattern,
  PatternDetectionResult,
  PatternConnectionKind,
} from "./types.js"
import type { FunctionCall } from "./c-parser.js"

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Detect indirect callers for a target callback function.
 *
 * Uses LSP references() to find all sites where the callback is referenced,
 * then uses the C parser to find the enclosing call and classify it.
 */
export async function detectIndirectCallers(
  input: DetectorInput,
  deps: DetectorDeps,
): Promise<PatternDetectionResult> {
  const { file, line, character, maxNodes = 50 } = input
  const { lspClient, readFile } = deps

  // Step 1: resolve target symbol via prepareCallHierarchy
  const seedItems = await lspClient.prepareCallHierarchy(file, line - 1, character - 1)
  const seed = seedItems?.[0] ?? null

  const seedName = seed?.name ?? "(unknown)"
  const seedFile = seed?.uri?.startsWith("file://")
    ? fileURLToPath(seed.uri)
    : (seed?.uri ?? file)

  // Step 2: find all reference sites via LSP references()
  const refs = await lspClient.references(file, line - 1, character - 1)
  if (!refs?.length) {
    return {
      seed: { name: seedName, file: seedFile, line },
      sites: [],
      matchedSites: [],
      unclassifiedSites: [],
    }
  }

  // Step 3: classify each reference site using the C parser
  const sites: ClassifiedSite[] = []
  const seenKeys = new Set<string>()

  for (const ref of refs) {
    if (sites.length >= maxNodes) break

    const refUri = ref.uri ?? ""
    const refLine = ref.range?.start?.line ?? 0
    const refChar = ref.range?.start?.character ?? 0
    const absPath = refUri.startsWith("file://") ? fileURLToPath(refUri) : refUri

    // Skip the definition site
    if (absPath === seedFile && refLine === line - 1) continue

    // Dedup by file:line
    const dedupKey = `${absPath}:${refLine}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    // Read the full source file and use the parser to find the enclosing call
    const source = readFile(absPath)
    if (!source) continue

    const classified = await classifyReferenceSite(source, refLine, refChar, seedName, absPath, deps)
    sites.push(classified)
  }

  const matchedSites = sites.filter((s) => s.matchedPattern !== null)
  const unclassifiedSites = sites.filter((s) => s.matchedPattern === null)

  return {
    seed: { name: seedName, file: seedFile, line },
    sites,
    matchedSites,
    unclassifiedSites,
  }
}

// ---------------------------------------------------------------------------
// Reference site classification
// ---------------------------------------------------------------------------

/**
 * Classify a single reference site using the C parser.
 *
 * 1. findEnclosingCall — handles function call registrations
 *    a. Registry fast-path: known call name → immediate classification
 *    b. Auto-classifier: unknown call name → LSP hover + definition
 * 2. findEnclosingConstruct — fallback for struct initializer dispatch tables
 * 3. null classification if neither matches
 */
async function classifyReferenceSite(
  source: string,
  refLine0: number,
  refChar0: number,
  callbackName: string,
  filePath: string,
  deps: DetectorDeps,
): Promise<ClassifiedSite> {
  // Try function call first (most patterns)
  const call = findEnclosingCall(source, refLine0, refChar0)
  if (call) {
    // Registry fast-path
    const registryResult = classifyFunctionCallFromRegistry(call, callbackName, filePath, refLine0, refChar0)
    if (registryResult.matchedPattern !== null) return registryResult

    // Auto-classifier slow-path (only when deps.autoClassifier is provided)
    if (deps.autoClassifier) {
      const autoResult = await autoClassifyCall(
        call,
        callbackName,
        filePath,
        refLine0,
        refChar0,
        deps.autoClassifier,
      )
      if (autoResult) return autoResult
    }

    // Return the unclassified call site (enclosingCall is set for diagnostics)
    return registryResult
  }

  // Try struct initializer (WMI dispatch table, etc.)
  const construct = findEnclosingConstruct(source, refLine0, refChar0)
  if (construct && construct.nodeType === "initializer_list") {
    return classifyInitializer(construct, callbackName, filePath, refLine0, refChar0)
  }

  // No enclosing call or initializer found
  return {
    callbackName,
    filePath,
    line: refLine0,
    character: refChar0,
    sourceText: source.split(/\r?\n/)[refLine0]?.trim().slice(0, 200) ?? "",
    matchedPattern: null,
    dispatchKey: null,
    connectionKind: "custom",
    viaRegistrationApi: null,
    enclosingCall: call ?? construct,
  }
}

/**
 * Classify a function call against the call-name registry (fast path).
 * Returns a ClassifiedSite with matchedPattern=null if not in registry.
 */
function classifyFunctionCallFromRegistry(
  call: FunctionCall,
  callbackName: string,
  filePath: string,
  refLine0: number,
  refChar0: number,
): ClassifiedSite {
  const pattern = CALL_PATTERNS.find((p) => p.registrationApi === call.name)

  if (pattern) {
    const dispatchKey = extractKeyFromCall(call, pattern.keyArgIndex)
    return {
      callbackName,
      filePath,
      line: refLine0,
      character: refChar0,
      sourceText: call.fullText,
      matchedPattern: pattern,
      dispatchKey,
      connectionKind: pattern.connectionKind,
      viaRegistrationApi: pattern.registrationApi,
      enclosingCall: call,
    }
  }

  // Not in registry — return unclassified (auto-classifier may upgrade this)
  return {
    callbackName,
    filePath,
    line: refLine0,
    character: refChar0,
    sourceText: call.fullText,
    matchedPattern: null,
    dispatchKey: null,
    connectionKind: "custom",
    viaRegistrationApi: null,
    enclosingCall: call,
  }
}

/**
 * Classify a struct initializer against the init-pattern registry.
 */
function classifyInitializer(
  init: FunctionCall,
  callbackName: string,
  filePath: string,
  refLine0: number,
  refChar0: number,
): ClassifiedSite {
  for (const pattern of INIT_PATTERNS) {
    if (init.args.length > pattern.markerArgIndex) {
      const markerArg = init.args[pattern.markerArgIndex].trim()
      if (pattern.markerRegex.test(markerArg)) {
        const dispatchKey = init.args.length > pattern.keyArgIndex
          ? init.args[pattern.keyArgIndex].trim()
          : null
        return {
          callbackName,
          filePath,
          line: refLine0,
          character: refChar0,
          sourceText: init.fullText,
          matchedPattern: pattern,
          dispatchKey,
          connectionKind: pattern.connectionKind,
          viaRegistrationApi: pattern.registrationApi,
          enclosingCall: init,
        }
      }
    }
  }

  return {
    callbackName,
    filePath,
    line: refLine0,
    character: refChar0,
    sourceText: init.fullText,
    matchedPattern: null,
    dispatchKey: null,
    connectionKind: "custom",
    viaRegistrationApi: null,
    enclosingCall: init,
  }
}

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

/**
 * Extract the dispatch key from a function call at the given argument index.
 * Returns trimmed key text or null if the index is out of range.
 */
function extractKeyFromCall(call: FunctionCall, keyArgIndex: number): string | null {
  if (keyArgIndex >= 0 && keyArgIndex < call.args.length) {
    return call.args[keyArgIndex].trim()
  }
  return null
}
