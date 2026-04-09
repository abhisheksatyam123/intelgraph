/**
 * phases/logs.ts — Phase 3: log-event edges via tree-sitter AST walk.
 *
 * Walks each file's AST looking for call_expression nodes whose callee
 * matches a log macro from any active pack. Emits logs_event edges with
 * format string, log level, and subsystem.
 *
 * Generic C/C++ logic — the log-macro list comes from the pack's
 * logMacros field, not from this module.
 */

import { parseSource, findAllNodes } from "../../../tools/pattern-detector/c-parser.js"
import type { LogMacroDef } from "../packs/types.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

export async function* extractLogs(
  ctx: PhaseCtx,
  fileSymbols: FileSymbolMap,
  logMacroMap: Map<string, LogMacroDef>,
) {
  if (logMacroMap.size === 0) return

  for (const [file, symbols] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    const root = parseSource(text)
    if (!root) continue

    // Function line ranges for attribution
    const fnRanges: Array<{ name: string; startLine: number; endLine: number }> = []
    for (const sym of symbols) {
      if (sym.kind === "function" && sym.location) {
        fnRanges.push({ name: sym.name, startLine: sym.location.line - 1, endLine: sym.location.line - 1 + 500 })
      }
    }

    const callNodes = findAllNodes(root, "call_expression")
    for (const callNode of callNodes) {
      const fnNode = callNode.childForFieldName?.("function")
      if (!fnNode) continue
      const calleeName = fnNode.type === "identifier"
        ? fnNode.text
        : fnNode.type === "field_expression"
          ? fnNode.childForFieldName?.("field")?.text
          : null
      if (!calleeName) continue

      const macroDef = logMacroMap.get(calleeName)
      if (!macroDef) continue

      const argsNode = callNode.childForFieldName?.("arguments")
      if (!argsNode) continue
      const argTexts: string[] = []
      for (let i = 0; i < argsNode.childCount; i++) {
        const child = argsNode.child(i)
        if (!child || child.type === "(" || child.type === ")" || child.type === ",") continue
        argTexts.push(child.text.trim())
      }

      const formatStr = argTexts[macroDef.formatArgIndex]
      const template = formatStr
        ? formatStr.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").slice(0, 200)
        : calleeName

      const callLine = callNode.startPosition?.row ?? 0
      let enclosingFn = "(file-scope)"
      for (const fn of fnRanges) {
        if (callLine >= fn.startLine && callLine <= fn.endLine) { enclosingFn = fn.name; break }
      }

      let subsystem = macroDef.subsystem
      if (!subsystem && template) {
        const m = template.match(/^([A-Z][A-Z0-9_]{1,8})\s*:/)
        if (m) subsystem = m[1]
      }

      yield ctx.edge({
        payload: {
          edgeKind: "logs_event",
          srcSymbolName: enclosingFn,
          dstSymbolName: `log:${calleeName}:${callLine + 1}`,
          confidence: 0.9,
          derivation: "clangd",
          metadata: { level: macroDef.level, template, subsystem: subsystem ?? null, macro: calleeName },
          evidence: { sourceKind: "file_line", location: { filePath: file, line: callLine + 1 } },
        },
      })
      ctx.metrics.count("edges.logs_event")
    }
  }
}
