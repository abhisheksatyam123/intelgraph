/**
 * pattern-detector/index.ts — Public API for the parser-based indirect caller detector.
 */

export { detectIndirectCallers } from "./detector.js"
export { CALL_PATTERNS, INIT_PATTERNS, findCallPatternByApi, getAllApiNames } from "./registry.js"
export type {
  CallPattern,
  InitPattern,
  ClassifiedSite,
  PatternDetectionResult,
  DetectorInput,
  DetectorDeps,
  PatternConnectionKind,
} from "./types.js"

// Re-export parser types for callers that need them
export type { FunctionCall } from "./c-parser.js"
export { findEnclosingCall, findEnclosingConstruct } from "./c-parser.js"
