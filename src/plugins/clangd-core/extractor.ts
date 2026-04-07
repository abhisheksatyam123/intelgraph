/**
 * clangd-core/extractor.ts — the clangd-core plugin.
 *
 * This is the refactored equivalent of `ClangdExtractionAdapter` from
 * src/intelligence/db/extraction/clangd-extraction-adapter.ts. It produces
 * the same facts (symbols + outgoing-call edges) using the new IExtractor
 * contract, by calling clangd through ctx.lsp and walking the workspace
 * through ctx.workspace.
 *
 * Capabilities declared:
 *   - symbols
 *   - types        (struct/enum/typedef as type rows; no field extraction)
 *   - direct-calls (edges produced via clangd's outgoingCalls)
 *
 * What this plugin does NOT do:
 *   - Type field extraction (the legacy adapter also returns fields=[])
 *   - Indirect caller resolution (that's the runtime caller phase, still
 *     in ingest-tool.ts and unchanged for now)
 *   - WLAN-specific file ranking (lives in the legacy adapter file as a
 *     temporary helper; will move to a WLAN rule pack in Problem 2)
 *
 * Behavior parity with the legacy adapter:
 *   - Same symbol extraction logic (LSP documentSymbol, mapKind)
 *   - Same edge extraction logic (LSP outgoingCalls per function symbol)
 *   - Evidence inlined into edges (sourceKind: clangd_response)
 *   - Same per-file failure tolerance (skip files that fail to parse)
 *
 * The fact ordering may differ from the legacy adapter (we no longer
 * apply WLAN ranking by default), but the set of facts produced is the
 * same. The parity test in test/unit/plugins/clangd-core.test.ts asserts
 * on content, not order.
 */

import { defineExtractor } from "../../intelligence/extraction/contract.js"
import type { Capability } from "../../intelligence/extraction/contract.js"
import type { SymbolRow } from "../../intelligence/contracts/common.js"

const CAPABILITIES: Capability[] = [
  "symbols",
  "types",
  "direct-calls",
]

const C_FAMILY_EXTENSIONS = [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"] as const

// LSP SymbolKind enum value → our internal symbol kind. Mirrors
// `mapKind()` in the legacy adapter so existing tests keep passing.
function mapLspSymbolKind(k: number): SymbolRow["kind"] {
  switch (k) {
    case 12:
      return "function"
    case 23:
      return "struct"
    case 10:
      return "enum"
    case 26:
      return "typedef"
    case 13:
      return "field"
    case 14:
      return "param"
    default:
      return "function"
  }
}

interface RawLspSymbol {
  name?: unknown
  kind?: unknown
  containerName?: unknown
  location?: { range?: { start?: { line?: unknown; character?: unknown } } }
  range?: { start?: { line?: unknown; character?: unknown } }
}

interface RawCallHierarchyOutgoing {
  to?: { name?: unknown }
  name?: unknown
}

const clangdCoreExtractor = defineExtractor({
  metadata: {
    name: "clangd-core",
    version: "0.1.0",
    description:
      "Direct clangd extraction: workspace symbols and outgoing-call edges. The default extractor for any C/C++ workspace.",
    capabilities: CAPABILITIES,
    // Run on every C/C++ workspace. The presence of compile_commands.json
    // is a strong signal but not strictly required — clangd can index
    // without it via heuristics.
  },

  async *extract(ctx) {
    // Step 1: discover source files. Default lexicographic walk; no
    // project-specific ranking. Project-specific ordering moves into
    // a workspace-specific plugin in Problem 2.
    const files = await ctx.workspace.walkFiles({
      extensions: C_FAMILY_EXTENSIONS,
      // Default limit is 500 in walkFiles; intentionally use the same
      // ceiling as the legacy adapter's `fileLimit ?? 200` would have
      // produced for typical ingests. Plugins can later be made
      // configurable via plugin-specific options (Problem 6).
      limit: 200,
    })

    ctx.metrics.count("files-discovered", files.length)

    // Per-file symbol cache so the edge phase doesn't re-call documentSymbol.
    // The legacy adapter calls extractSymbols() inside extractEdges() for the
    // same reason; we replicate the optimization here using ctx.cache.
    const fileSymbols: Map<string, SymbolRow[]> = new Map()

    // ---- Phase 1: symbols and types ----
    for (const file of files) {
      if (ctx.signal.aborted) return

      const text = ctx.workspace.readFile(file)
      if (!text) continue

      const result = await ctx.lsp.documentSymbol(file, text)
      ctx.metrics.timing("lsp.documentSymbol", result.durationMs)
      if (result.error) {
        ctx.metrics.count(`lsp.documentSymbol.error.${result.error.class}`)
        // Skip files that fail to parse — same as legacy adapter.
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

        // Yield the symbol fact.
        yield ctx.symbol({ payload: symbolRow })
        ctx.metrics.count(`symbols.${symbolRow.kind}`)

        // Type fact for struct/enum/typedef (matches legacy
        // extractTypes() behavior).
        if (
          symbolRow.kind === "struct" ||
          symbolRow.kind === "enum" ||
          symbolRow.kind === "typedef"
        ) {
          yield ctx.type({
            payload: {
              kind: symbolRow.kind,
              spelling: symbolRow.name,
              symbolName: symbolRow.name,
            },
          })
        }
      }

      fileSymbols.set(file, symbolsForFile)
    }

    // ---- Phase 2: direct-call edges ----
    for (const [file, symbols] of fileSymbols.entries()) {
      if (ctx.signal.aborted) return
      const text = ctx.workspace.readFile(file)
      if (!text) continue

      for (const sym of symbols) {
        if (sym.kind !== "function" || !sym.location) continue

        const result = await ctx.lsp.outgoingCalls(
          sym.location.filePath,
          text,
          sym.location.line - 1,
          (sym.location.column ?? 1) - 1,
        )
        ctx.metrics.timing("lsp.outgoingCalls", result.durationMs)
        if (result.error) {
          ctx.metrics.count(`lsp.outgoingCalls.error.${result.error.class}`)
          continue
        }
        const calls = (result.value ?? []) as RawCallHierarchyOutgoing[]
        for (const call of calls) {
          const item = call.to ?? call
          const name = String((item as { name?: unknown }).name ?? "")
          if (!name) continue
          yield ctx.edge({
            payload: {
              edgeKind: "calls",
              srcSymbolName: sym.name,
              dstSymbolName: name,
              confidence: 1.0,
              derivation: "clangd",
              evidence: {
                sourceKind: "clangd_response",
                location: sym.location,
              },
            },
          })
          ctx.metrics.count("edges.calls")
        }
      }
    }
  },
})

export default clangdCoreExtractor
