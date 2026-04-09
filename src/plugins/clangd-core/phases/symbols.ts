/**
 * phases/symbols.ts — Phase 1: symbol + type extraction via clangd LSP.
 *
 * Walks each discovered file, calls documentSymbol to get the LSP symbol
 * list, maps LSP symbol kinds to our internal kinds (function, struct,
 * enum, typedef, field, param), and yields symbol + type facts.
 *
 * Reusable across any C/C++ project — no project-specific knowledge.
 */

import type { SymbolRow } from "../../../intelligence/contracts/common.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

// LSP SymbolKind → internal kind
function mapLspSymbolKind(k: number): SymbolRow["kind"] {
  switch (k) {
    case 12: return "function"
    case 23: return "struct"
    case 10: return "enum"
    case 26: return "typedef"
    case 13: return "field"
    case 14: return "param"
    default: return "function"
  }
}

interface RawLspSymbol {
  name?: unknown
  kind?: unknown
  containerName?: unknown
  location?: { range?: { start?: { line?: unknown; character?: unknown } } }
  range?: { start?: { line?: unknown; character?: unknown } }
}

/**
 * Phase 1: extract symbols and types from each file via clangd LSP.
 * Populates fileSymbols map as a side effect for use by later phases.
 */
export async function* extractSymbols(
  ctx: PhaseCtx,
  files: string[],
  fileSymbols: FileSymbolMap,
) {
  for (const file of files) {
    if (ctx.signal.aborted) return

    const text = ctx.workspace.readFile(file)
    if (!text) continue

    const result = await ctx.lsp.documentSymbol(file, text)
    ctx.metrics.timing("lsp.documentSymbol", result.durationMs)
    if (result.error) {
      ctx.metrics.count(`lsp.documentSymbol.error.${result.error.class}`)
      continue
    }
    const raw = (result.value ?? []) as RawLspSymbol[]
    const symbolsForFile: SymbolRow[] = []

    for (const s of raw) {
      const range = s.range ?? s.location?.range
      const start = range?.start
      const symbolRow: SymbolRow = {
        kind: mapLspSymbolKind((s.kind as number) ?? 12),
        name: String(s.name ?? ""),
        qualifiedName: s.containerName
          ? `${String(s.containerName)}::${String(s.name)}`
          : undefined,
        location: {
          filePath: file,
          line: ((start?.line as number | undefined) ?? 0) + 1,
          column: ((start?.character as number | undefined) ?? 0) + 1,
        },
      }
      if (!symbolRow.name) continue
      symbolsForFile.push(symbolRow)

      yield ctx.symbol({ payload: symbolRow })
      ctx.metrics.count(`symbols.${symbolRow.kind}`)

      if (symbolRow.kind === "struct" || symbolRow.kind === "enum" || symbolRow.kind === "typedef") {
        yield ctx.type({
          payload: { kind: symbolRow.kind, spelling: symbolRow.name, symbolName: symbolRow.name },
        })
      }
    }

    fileSymbols.set(file, symbolsForFile)
  }
}
