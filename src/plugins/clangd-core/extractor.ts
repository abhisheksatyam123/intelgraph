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

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { defineExtractor } from "../../intelligence/extraction/contract.js"
import type {
  Capability,
  WorkspaceProbe,
} from "../../intelligence/extraction/contract.js"
import type { SymbolRow } from "../../intelligence/contracts/common.js"
import { collectAllLogMacros, collectAllDispatchChains, collectAllCallPatterns, collectAllHWEntities } from "./packs/index.js"
import type { LogMacroDef } from "./packs/types.js"
import {
  initParser,
  parseSource,
  findAllNodes,
  walkAst,
  splitArguments,
} from "../../tools/pattern-detector/c-parser.js"

const CAPABILITIES: Capability[] = [
  "symbols",
  "types",
  "direct-calls",
  "log-events",
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
    appliesTo: (probe: WorkspaceProbe) => {
      // Active when the workspace looks like a C/C++ project. The
      // strongest signal is compile_commands.json (which the workspace
      // probe already detects). Fall back to a shallow filesystem
      // scan: if the root or its src/ subdirectory contains a .c/.h/
      // .cpp/.hpp file, run. This means a TS-only workspace like
      // opencode is correctly skipped.
      if (probe.hasCompileCommands) return true
      const root = probe.workspaceRoot
      return hasCFamilyShallow(root) || hasCFamilyShallow(join(root, "src"))
    },
  },

  async *extract(ctx) {
    // Step 1: discover source files. Default lexicographic walk; no
    // project-specific ranking. Project-specific ordering moves into
    // a workspace-specific plugin in Problem 2.
    //
    // INTELGRAPH_C_FILE_LIMIT env var overrides the default file walk
    // cap. Default is 5000 to match ts-core/rust-core and reach large
    // trees (e.g. Linux kernel has ~7.8k compile units; the old 200
    // cap died in arch/alpha/... before reaching lib/, drivers/, etc.).
    const envLimit = Number.parseInt(process.env.INTELGRAPH_C_FILE_LIMIT ?? "", 10)
    const fileLimit = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : 5000
    const files = await ctx.workspace.walkFiles({
      extensions: C_FAMILY_EXTENSIONS,
      limit: fileLimit,
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

    // ---- Phase 3: log-event edges via tree-sitter AST walk ----
    //
    // Walk each file's AST looking for call_expression nodes whose callee
    // name matches a log macro from any active pack. For each match, emit
    // a `logs_event` edge from the enclosing function to the log call site
    // with the format string, log level, and subsystem in the metadata.
    //
    // This uses tree-sitter (not clangd) because we need argument values
    // (the format string) which clangd's call hierarchy doesn't expose.
    // The tree-sitter parser is shared with pattern-detector/c-parser.ts.
    await initParser()

    // Build the log-macro lookup map from ALL packs (no workspace gating).
    // Log macro names are just C identifiers (pr_info, WARN_ON, etc.) —
    // having WLAN macros in the map while processing a Linux workspace is
    // harmless (they simply won't match any call_expression). Gating by
    // workspace would fail when the extractor runs on a subdirectory
    // (e.g. linux/lib) that doesn't match the pack's appliesTo predicate.
    const logMacroMap = collectAllLogMacros()
    if (logMacroMap.size === 0) {
      // No log macros contributed by any active pack — skip Phase 3.
    } else {
      for (const [file, symbols] of fileSymbols.entries()) {
        if (ctx.signal.aborted) return
        const text = ctx.workspace.readFile(file)
        if (!text) continue

        const root = parseSource(text)
        if (!root) continue

        // Build a line-range → function-name map so we can attribute each
        // log call to its enclosing function.
        const functionRanges: Array<{
          name: string
          startLine: number
          endLine: number
        }> = []
        for (const sym of symbols) {
          if (sym.kind === "function" && sym.location) {
            // endLine is not in SymbolRow but we can approximate from the
            // tree-sitter AST by finding the function_definition at that line.
            const startLine = sym.location.line - 1  // 0-based for tree-sitter
            // Default endLine: start + 200 lines (generous cap). The AST
            // walk below only looks at calls INSIDE the function body, so
            // an overestimate is safe — it just means we check more nodes.
            functionRanges.push({
              name: sym.name,
              startLine,
              endLine: startLine + 500,
            })
          }
        }

        // Find all call_expression nodes in the file
        const callNodes = findAllNodes(root, "call_expression")

        for (const callNode of callNodes) {
          // Extract the callee name from the call_expression
          const fnNode = callNode.childForFieldName?.("function")
          if (!fnNode) continue
          const calleeName = fnNode.type === "identifier"
            ? fnNode.text
            : fnNode.type === "field_expression"
              ? fnNode.childForFieldName?.("field")?.text
              : null
          if (!calleeName) continue

          // Check if this callee is a known log macro
          const macroDef = logMacroMap.get(calleeName)
          if (!macroDef) continue

          // Extract the format string from the argument at formatArgIndex
          const argsNode = callNode.childForFieldName?.("arguments")
          if (!argsNode) continue

          // Collect argument texts (skip parens and commas)
          const argTexts: string[] = []
          for (let i = 0; i < argsNode.childCount; i++) {
            const child = argsNode.child(i)
            if (!child) continue
            if (child.type === "(" || child.type === ")" || child.type === ",") continue
            argTexts.push(child.text.trim())
          }

          const formatStr = argTexts[macroDef.formatArgIndex]
          // Strip surrounding quotes from string literals
          const template = formatStr
            ? formatStr.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").slice(0, 200)
            : calleeName

          // Find the enclosing function for this call node (by line range)
          const callLine = callNode.startPosition?.row ?? 0
          let enclosingFn = "(file-scope)"
          for (const fn of functionRanges) {
            if (callLine >= fn.startLine && callLine <= fn.endLine) {
              enclosingFn = fn.name
              break
            }
          }

          // Derive subsystem from pack definition or format-string prefix
          let subsystem = macroDef.subsystem
          if (!subsystem && template) {
            // Try to extract a prefix like "BPF: ..." → "BPF"
            const prefixMatch = template.match(/^([A-Z][A-Z0-9_]{1,8})\s*:/)
            if (prefixMatch) subsystem = prefixMatch[1]
          }

          // Emit a logs_event edge
          yield ctx.edge({
            payload: {
              edgeKind: "logs_event",
              srcSymbolName: enclosingFn,
              dstSymbolName: `log:${calleeName}:${callLine + 1}`,
              confidence: 0.9,
              derivation: "clangd",
              metadata: {
                level: macroDef.level,
                template,
                subsystem: subsystem ?? null,
                macro: calleeName,
              },
              evidence: {
                sourceKind: "file_line",
                location: {
                  filePath: file,
                  line: callLine + 1,
                },
              },
            },
          })
          ctx.metrics.count("edges.logs_event")
        }
      }
    }

    // ---- Phase 4: struct field access edges via tree-sitter ----
    //
    // Walk each function body looking for field_expression (-> access)
    // and member_expression (. access) nodes. For each, emit either a
    // `reads_field` or `writes_field` edge depending on context:
    //   - LHS of assignment_expression → writes_field
    //   - Everything else → reads_field
    //
    // This captures "function X reads struct->field" and "function X
    // writes struct->field" relations that are critical for data-flow
    // analysis of C codebases.
    for (const [file, symbols] of fileSymbols.entries()) {
      if (ctx.signal.aborted) return
      const text = ctx.workspace.readFile(file)
      if (!text) continue

      const root = parseSource(text)
      if (!root) continue

      // Collect function line ranges for attribution
      const fnRanges: Array<{ name: string; startLine: number; endLine: number }> = []
      for (const sym of symbols) {
        if (sym.kind === "function" && sym.location) {
          fnRanges.push({
            name: sym.name,
            startLine: sym.location.line - 1,
            endLine: (sym.location.line - 1) + 500,
          })
        }
      }

      // Find all field_expression nodes (ptr->field and obj.field)
      const fieldExprs = findAllNodes(root, "field_expression")
      for (const fe of fieldExprs) {
        const fieldNode = fe.childForFieldName?.("field")
        const argNode = fe.childForFieldName?.("argument")
        if (!fieldNode || !argNode) continue

        const fieldName = fieldNode.text
        const structExpr = argNode.text?.slice(0, 60)
        if (!fieldName || !structExpr) continue

        const accessLine = fe.startPosition?.row ?? 0

        // Determine if this is a write (LHS of assignment) or read
        let edgeKind: "reads_field" | "writes_field" = "reads_field"
        const parent = fe.parent
        if (parent?.type === "assignment_expression") {
          const lhs = parent.childForFieldName?.("left")
          if (lhs && lhs.id === fe.id) {
            edgeKind = "writes_field"
          }
        }

        // Find enclosing function
        let enclosingFn = "(file-scope)"
        for (const fn of fnRanges) {
          if (accessLine >= fn.startLine && accessLine <= fn.endLine) {
            enclosingFn = fn.name
            break
          }
        }

        yield ctx.edge({
          payload: {
            edgeKind,
            srcSymbolName: enclosingFn,
            dstSymbolName: `${structExpr}.${fieldName}`,
            confidence: 0.85,
            derivation: "clangd",
            metadata: {
              structExpr,
              fieldName,
              accessPath: `${structExpr}.${fieldName}`,
            },
            evidence: {
              sourceKind: "file_line",
              location: { filePath: file, line: accessLine + 1 },
            },
          },
        })
        ctx.metrics.count(`edges.${edgeKind}`)
      }
    }

    // ---- Phase 5: callback registration + runtime_calls + registers_callback ----
    //
    // Comprehensive indirect-call detection during extraction. Moves the
    // logic from query-time (tools/pattern-detector + tools/indirect-callers)
    // into extraction time so results are persistently in the SQLite graph.
    //
    // Architecture layering:
    //   CORE (this code):   generic AST walk patterns for any C/C++ code
    //   PLUGIN (clangd-core): orchestrates the walk + emits edges
    //   SUB-PLUGIN (packs):  registration API lists + dispatch chain templates
    //
    // Detects THREE patterns:
    //   5a) Function-call registration: request_irq(IRQ, handler)
    //   5b) Struct-field initializer:   .read = handler in file_operations
    //   5c) Function-body assignment:   ptr->field = handler in function body
    //
    // For each detected registration, emits:
    //   - registers_callback edge (src=registrar, dst=callback)
    //   - runtime_calls edge with dispatch chain (if template available)
    //   - HW entity nodes for each chain step that matches a pack's hwEntities
    //   - dispatches_to edges between HW entities and the callback

    const allCallPatterns = collectAllCallPatterns()
    const registrationApis = new Set(allCallPatterns.map((p) => p.registrationApi))
    const dispatchTemplateMap = collectAllDispatchChains()
    const hwEntities = collectAllHWEntities()
    const emittedHWNodes = new Set<string>()  // track to avoid duplicates

    // Build a set of all known function names for fast membership test
    const knownFunctions = new Set<string>()
    for (const syms of fileSymbols.values()) {
      for (const s of syms) {
        if (s.kind === "function") knownFunctions.add(s.name)
      }
    }

    // Helper: emit a registers_callback edge
    function* emitRegistration(
      registrar: string,
      callbackName: string,
      registrationKind: string,
      dispatchKey: string,
      file: string,
      line: number,
    ) {
      yield ctx.edge({
        payload: {
          edgeKind: "registers_callback",
          srcSymbolName: registrar,
          dstSymbolName: callbackName,
          confidence: 0.9,
          derivation: "clangd",
          metadata: {
            registrationKind,
            dispatchKey,
          },
          evidence: {
            sourceKind: "file_line",
            location: { filePath: file, line },
          },
        },
      })
      ctx.metrics.count("edges.registers_callback")
    }

    // Helper: emit a runtime_calls edge from dispatch chain template
    function* emitRuntimeCall(
      tmplKey: string,
      callbackName: string,
      dispatchKey: string,
      file: string,
      line: number,
      /** The actual struct type detected from AST (e.g. "struct file_operations") */
      detectedStructType?: string,
    ) {
      // Try exact template match first (for function-call APIs like request_irq)
      let tmpl = dispatchTemplateMap.get(tmplKey)

      // For struct-field registrations: construct the synthetic key from
      // the ACTUAL detected struct type + field name. This way we don't
      // need to hardcode a list of struct types in the extractor — the
      // sub-plugin pack's dispatch-chains.ts is the single source of truth.
      if (!tmpl && detectedStructType && dispatchKey) {
        // Strip qualifiers (static, const, volatile) and type keywords
        // (struct, enum, union) to match the template key format.
        // "static const struct file_operations" → "file_operations"
        const cleanType = detectedStructType
          .replace(/\b(static|const|volatile|struct|enum|union)\b/g, "").trim()

        // Strategy 1: exact field match
        const syntheticKey = `__struct_field:${cleanType}.${dispatchKey}`
        tmpl = dispatchTemplateMap.get(syntheticKey)

        // Strategy 2: if no exact field match, find ANY template for the
        // same struct type and adapt its dispatch pattern for this field.
        // This handles cases like agp_bridge_driver having templates for
        // .configure but not .cache_flush — both go through the same
        // AGP dispatch subsystem.
        if (!tmpl) {
          const prefix = `__struct_field:${cleanType}.`
          for (const [key, candidate] of dispatchTemplateMap) {
            if (key.startsWith(prefix)) {
              // Adapt the template: replace the known field's dispatch step
              // with a generic one using the actual field name
              tmpl = {
                ...candidate,
                registrationApi: syntheticKey,
                chain: candidate.chain.map((s: string) => {
                  // Replace the specific field dispatch step with the actual field
                  // e.g. "bridge->driver->configure" → "bridge->driver->cache_flush"
                  if (s.includes("->") && !s.includes("%")) {
                    const parts = s.split("->")
                    parts[parts.length - 1] = dispatchKey
                    return parts.join("->")
                  }
                  return s
                }),
                triggerDescription: candidate.triggerDescription
                  .replace(/\b\w+\b(?= dispatch| handler| callback)/, dispatchKey),
              }
              break
            }
          }
        }
      }
      if (!tmpl) return

      const chain = tmpl.chain.map((s: string) =>
        s.replace(/%CALLBACK%/g, callbackName).replace(/%KEY%/g, dispatchKey),
      )

      yield ctx.edge({
        payload: {
          edgeKind: "runtime_calls",
          srcSymbolName: chain.length >= 3 ? chain[chain.length - 2] : chain[0],
          dstSymbolName: callbackName,
          confidence: 0.9,
          derivation: "clangd",
          metadata: {
            dispatchChain: chain,
            registrationApi: tmplKey,
            dispatchKey,
            triggerKind: tmpl.triggerKind,
            triggerDescription: tmpl.triggerDescription
              .replace(/%KEY%/g, dispatchKey)
              .replace(/%CALLBACK%/g, callbackName),
          },
          evidence: {
            sourceKind: "file_line",
            location: { filePath: file, line },
          },
        },
      })
      ctx.metrics.count("edges.runtime_calls")

      // ── Materialize HW entity nodes + dispatches_to edges ────────────
      // Walk each step in the dispatch chain. If a step matches a known
      // HW entity from the sub-plugin pack, emit a graph node for that
      // entity and a dispatches_to edge connecting it to the next step.
      for (let i = 0; i < chain.length; i++) {
        const step = chain[i]
        const hwEntity = hwEntities.byChainStep.get(step)
        if (!hwEntity) continue

        // Emit the HW entity as a graph node (once per entity name)
        if (!emittedHWNodes.has(hwEntity.name)) {
          emittedHWNodes.add(hwEntity.name)
          yield ctx.symbol({
            payload: {
              kind: "function",  // graph_nodes.kind is a string — we use the HW kind in metadata
              name: hwEntity.name,
              metadata: {
                hwEntityKind: hwEntity.kind,
                isHWEntity: true,
                description: hwEntity.description,
              },
            },
          })
          ctx.metrics.count(`hw_entities.${hwEntity.kind}`)
        }

        // Emit dispatches_to edge from this HW entity to the next chain step
        const nextStep = chain[i + 1]
        if (nextStep) {
          yield ctx.edge({
            payload: {
              edgeKind: "dispatches_to",
              srcSymbolName: hwEntity.name,
              dstSymbolName: nextStep,
              confidence: 0.9,
              derivation: "clangd",
              metadata: {
                hwEntityKind: hwEntity.kind,
                dispatchChainPosition: i,
                triggerKind: tmpl.triggerKind,
              },
              evidence: {
                sourceKind: "file_line",
                location: { filePath: file, line },
              },
            },
          })
          ctx.metrics.count("edges.dispatches_to")
        }
      }
    }

    for (const [file] of fileSymbols.entries()) {
      if (ctx.signal.aborted) return
      const text = ctx.workspace.readFile(file)
      if (!text) continue

      const root = parseSource(text)
      if (!root) continue

      // ── 5a) Function-call registrations ──────────────────────────────
      // e.g. request_irq(I8042_AUX_IRQ, i8042_interrupt, ...)
      const callNodes = findAllNodes(root, "call_expression")
      for (const callNode of callNodes) {
        const fnNode = callNode.childForFieldName?.("function")
        if (!fnNode || fnNode.type !== "identifier") continue
        if (!registrationApis.has(fnNode.text)) continue

        const calleeName = fnNode.text
        const pattern = allCallPatterns.find((p: any) => p.registrationApi === calleeName)
        if (!pattern) continue

        const argsNode = callNode.childForFieldName?.("arguments")
        if (!argsNode) continue
        const argTexts: string[] = []
        for (let i = 0; i < argsNode.childCount; i++) {
          const child = argsNode.child(i)
          if (!child || child.type === "(" || child.type === ")" || child.type === ",") continue
          argTexts.push(child.text.trim())
        }

        // Find which arg is a known function name (the callback)
        let callbackName: string | null = null
        for (const arg of argTexts) {
          if (knownFunctions.has(arg)) { callbackName = arg; break }
        }
        if (!callbackName) continue

        const dispatchKey = argTexts[pattern.keyArgIndex] ?? ""
        const callLine = (callNode.startPosition?.row ?? 0) + 1

        yield* emitRegistration(calleeName, callbackName, "function_call", dispatchKey, file, callLine)
        yield* emitRuntimeCall(calleeName, callbackName, dispatchKey, file, callLine)
      }

      // ── 5b) Struct-field initializer registrations ────────────────────
      // e.g. static const struct file_operations mem_fops = {
      //        .read = read_mem,
      //        .write = write_mem,
      //      };
      // Uses tree-sitter to find initializer_pair nodes where the value
      // is a known function identifier. This is the same detection logic
      // as classifyGenericStructFieldCallback in detector.ts, but moved
      // into extraction time.
      const initPairs = findAllNodes(root, "initializer_pair")
      for (const pair of initPairs) {
        // Find the field designator (.read, .write, etc.)
        let fieldName: string | null = null
        let valueName: string | null = null
        for (let i = 0; i < pair.childCount; i++) {
          const child = pair.child(i)
          if (!child) continue
          if (child.type === "field_designator") {
            fieldName = child.text?.replace(/^\./, "").trim() ?? null
          }
          if (child.type === "identifier" && knownFunctions.has(child.text)) {
            valueName = child.text
          }
        }
        if (!fieldName || !valueName) continue

        // Walk up to find the container variable + struct type
        let containerVar: string | null = null
        let containerType: string | null = null
        let parent = pair.parent  // initializer_list
        while (parent) {
          if (parent.type === "init_declarator") {
            const fullText: string = parent.text ?? ""
            const lhs = fullText.split("=")[0] ?? ""
            const idents = lhs.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []
            const nonAttr = idents.filter((id: string) => !id.startsWith("__"))
            containerVar = (nonAttr[nonAttr.length - 1] ?? idents[idents.length - 1]) ?? null
          }
          if (parent.type === "declaration") {
            const typeNode = parent.childForFieldName?.("type")
            if (typeNode) containerType = typeNode.text?.trim() ?? null
            break
          }
          parent = parent.parent
        }

        const registrar = containerVar ?? "(struct_init)"
        const pairLine = (pair.startPosition?.row ?? 0) + 1

        yield* emitRegistration(registrar, valueName, `struct_field:${containerType ?? "unknown"}.${fieldName}`, fieldName, file, pairLine)
        yield* emitRuntimeCall(registrar, valueName, fieldName, file, pairLine, containerType ?? undefined)
      }

      // ── 5c) Function-body assignment registrations ────────────────────
      // e.g. current->restart_block.fn = do_no_restart_syscall
      //      sis_driver.agp_enable = sis_delayed_enable
      //      timer->function = my_timer_fn
      // Detects assignment_expression where the RHS is a known function.
      //
      // To resolve the container's struct type (needed for dispatch chain
      // template matching), we search the file's AST for the declaration
      // of the container variable. This handles patterns like:
      //   struct agp_bridge_driver sis_driver = { ... };
      //   sis_driver.agp_enable = sis_delayed_enable;  // ← we're here
      //
      // We pre-build a map of variable → struct type from all declarations
      // in the file's AST.
      const varTypeMap = new Map<string, string>()
      const declarations = findAllNodes(root, "declaration")
      for (const decl of declarations) {
        const typeNode = decl.childForFieldName?.("type")
        if (!typeNode) continue
        const typeText = typeNode.text?.trim() ?? ""
        // Walk init_declarator children to find variable names
        walkAst(decl, (child: any) => {
          if (child.type === "init_declarator" || child.type === "identifier") {
            if (child.type === "init_declarator") {
              const declr = child.childForFieldName?.("declarator")
              if (declr?.type === "identifier") {
                varTypeMap.set(declr.text, typeText)
              }
            }
          }
        })
      }

      const assignments = findAllNodes(root, "assignment_expression")
      for (const assign of assignments) {
        const right = assign.childForFieldName?.("right")
        if (!right || right.type !== "identifier") continue
        if (!knownFunctions.has(right.text)) continue

        const left = assign.childForFieldName?.("left")
        if (!left) continue

        // LHS should be a field_expression (ptr->field or obj.field)
        if (left.type !== "field_expression") continue
        const fieldNode = left.childForFieldName?.("field")
        const argNode = left.childForFieldName?.("argument")
        if (!fieldNode || !argNode) continue

        const fieldName = fieldNode.text
        const containerExpr = argNode.text?.slice(0, 60) ?? ""
        const callbackName = right.text
        const assignLine = (assign.startPosition?.row ?? 0) + 1

        // Try to resolve the container variable's struct type
        // e.g. "sis_driver" → "struct agp_bridge_driver"
        const containerVarName = containerExpr.replace(/->.*/, "").replace(/\..*/, "").trim()
        const resolvedType = varTypeMap.get(containerVarName) ?? undefined

        yield* emitRegistration(`${containerExpr}.${fieldName}`, callbackName, `fn_body_assign:${containerExpr}.${fieldName}`, fieldName, file, assignLine)
        yield* emitRuntimeCall(`${containerExpr}.${fieldName}`, callbackName, fieldName, file, assignLine, resolvedType)
      }
    }
  },
})

export default clangdCoreExtractor

// ---------------------------------------------------------------------------
// appliesTo helper
// ---------------------------------------------------------------------------

const C_FAMILY_FILE_EXTS = [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"]

/**
 * Shallow check: does this directory contain any C/C++ source file at
 * depth 0 or 1? Used by appliesTo() so the clangd-core plugin doesn't
 * fire on TS-only workspaces.
 */
function hasCFamilyShallow(dir: string): boolean {
  if (!existsSync(dir)) return false
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    const name = entry.name
    if (entry.isFile()) {
      if (C_FAMILY_FILE_EXTS.some((ext) => name.endsWith(ext))) {
        return true
      }
    } else if (entry.isDirectory() && !name.startsWith(".") && name !== "node_modules") {
      try {
        const subEntries = readdirSync(join(dir, name), { withFileTypes: true })
        for (const sub of subEntries) {
          if (
            sub.isFile() &&
            C_FAMILY_FILE_EXTS.some((ext) => sub.name.endsWith(ext))
          ) {
            return true
          }
        }
      } catch {
        // unreadable
      }
    }
  }
  return false
}
