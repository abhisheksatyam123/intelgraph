/**
 * phases/types.ts — shared types for clangd-core extraction phases.
 *
 * Each phase is an async generator that yields extraction facts via the
 * ctx helpers. This file defines the shared context that phases receive
 * so they don't depend on each other's internals.
 */

import type { SymbolRow } from "../../../intelligence/contracts/common.js"

/** Per-file symbol cache shared across phases. */
export type FileSymbolMap = Map<string, SymbolRow[]>

/** Extraction context type (subset of the full IExtractorContext). */
export type PhaseCtx = {
  signal: AbortSignal
  workspace: {
    readFile: (path: string) => string | null
  }
  lsp: {
    documentSymbol: (file: string, text: string) => Promise<any>
    outgoingCalls: (file: string, text: string, line: number, char: number) => Promise<any>
  }
  metrics: {
    count: (name: string, n?: number) => void
    timing: (name: string, ms: number) => void
  }
  symbol: (opts: { payload: any }) => any
  type: (opts: { payload: any }) => any
  edge: (opts: { payload: any }) => any
}
