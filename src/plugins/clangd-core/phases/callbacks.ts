/**
 * phases/callbacks.ts — Phase 5: callback registration + runtime_calls +
 * HW entity materialization.
 *
 * Detects three patterns of indirect function invocation:
 *   5a) Function-call registration: request_irq(IRQ, handler)
 *   5b) Struct-field initializer:   .read = handler in file_operations
 *   5c) Function-body assignment:   ptr->field = handler
 *
 * For each detected registration, emits:
 *   - registers_callback edge (registrar → callback)
 *   - runtime_calls edge with dispatch chain (if template matches)
 *   - HW entity nodes + dispatches_to edges (if pack defines HW entities
 *     matching chain steps)
 *
 * Generic C/C++ logic. Project knowledge comes from the pack parameters:
 *   - callPatterns: which APIs register callbacks
 *   - dispatchTemplateMap: which APIs have known dispatch chains
 *   - hwEntities: which chain steps are HW blocks/interrupts/timers/etc.
 */

import {
  parseSource,
  findAllNodes,
  walkAst,
} from "../../../tools/pattern-detector/c-parser.js"
import type { CallPattern } from "../packs/types.js"
import type { DispatchChainTemplate, HWEntityDef } from "../packs/types.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

/** Pack-provided data for Phase 5. */
export interface CallbackPhaseConfig {
  callPatterns: CallPattern[]
  dispatchTemplateMap: Map<string, DispatchChainTemplate>
  hwEntities: {
    byName: Map<string, HWEntityDef>
    byChainStep: Map<string, HWEntityDef>
  }
}

export async function* extractCallbacks(
  ctx: PhaseCtx,
  fileSymbols: FileSymbolMap,
  config: CallbackPhaseConfig,
) {
  const { callPatterns, dispatchTemplateMap, hwEntities } = config
  const registrationApis = new Set(callPatterns.map((p) => p.registrationApi))
  const emittedHWNodes = new Set<string>()

  // Build set of all known function names for fast membership test
  const knownFunctions = new Set<string>()
  for (const syms of fileSymbols.values()) {
    for (const s of syms) {
      if (s.kind === "function") knownFunctions.add(s.name)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

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
        metadata: { registrationKind, dispatchKey },
        evidence: { sourceKind: "file_line", location: { filePath: file, line } },
      },
    })
    ctx.metrics.count("edges.registers_callback")
  }

  function* emitRuntimeCall(
    tmplKey: string,
    callbackName: string,
    dispatchKey: string,
    file: string,
    line: number,
    detectedStructType?: string,
  ) {
    // Try exact template match
    let tmpl = dispatchTemplateMap.get(tmplKey)

    // Struct-field match using actual detected type
    if (!tmpl && detectedStructType && dispatchKey) {
      const cleanType = detectedStructType
        .replace(/\b(static|const|volatile|struct|enum|union)\b/g, "").trim()
      const syntheticKey = `__struct_field:${cleanType}.${dispatchKey}`
      tmpl = dispatchTemplateMap.get(syntheticKey)

      // Generic struct-type fallback: adapt another field's template
      if (!tmpl) {
        const prefix = `__struct_field:${cleanType}.`
        for (const [key, candidate] of dispatchTemplateMap) {
          if (key.startsWith(prefix)) {
            tmpl = {
              ...candidate,
              registrationApi: syntheticKey,
              chain: candidate.chain.map((s: string) => {
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

    // Emit the runtime_calls edge
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
        evidence: { sourceKind: "file_line", location: { filePath: file, line } },
      },
    })
    ctx.metrics.count("edges.runtime_calls")

    // Materialize HW entity nodes + dispatches_to edges
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]
      const hwEntity = hwEntities.byChainStep.get(step)
      if (!hwEntity) continue

      if (!emittedHWNodes.has(hwEntity.name)) {
        emittedHWNodes.add(hwEntity.name)
        yield ctx.symbol({
          payload: {
            kind: "function",
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
            evidence: { sourceKind: "file_line", location: { filePath: file, line } },
          },
        })
        ctx.metrics.count("edges.dispatches_to")
      }
    }
  }

  // ── Per-file extraction ──────────────────────────────────────────────────

  for (const [file] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    const root = parseSource(text)
    if (!root) continue

    // ── 5a) Function-call registrations ──────────────────────────────────
    const callNodes = findAllNodes(root, "call_expression")
    for (const callNode of callNodes) {
      const fnNode = callNode.childForFieldName?.("function")
      if (!fnNode || fnNode.type !== "identifier") continue
      if (!registrationApis.has(fnNode.text)) continue

      const calleeName = fnNode.text
      const pattern = callPatterns.find((p: any) => p.registrationApi === calleeName)
      if (!pattern) continue

      const argsNode = callNode.childForFieldName?.("arguments")
      if (!argsNode) continue
      const argTexts: string[] = []
      for (let i = 0; i < argsNode.childCount; i++) {
        const child = argsNode.child(i)
        if (!child || child.type === "(" || child.type === ")" || child.type === ",") continue
        argTexts.push(child.text.trim())
      }

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

    // ── 5b) Struct-field initializer registrations ──────────────────────
    const initPairs = findAllNodes(root, "initializer_pair")
    for (const pair of initPairs) {
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

      let containerVar: string | null = null
      let containerType: string | null = null
      let parent = pair.parent
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

    // ── 5c) Function-body assignment registrations ──────────────────────
    // Pre-build var → type map from all declarations in this file
    const varTypeMap = new Map<string, string>()
    const declarations = findAllNodes(root, "declaration")
    for (const decl of declarations) {
      const typeNode = decl.childForFieldName?.("type")
      if (!typeNode) continue
      const typeText = typeNode.text?.trim() ?? ""
      walkAst(decl, (child: any) => {
        if (child.type === "init_declarator") {
          const declr = child.childForFieldName?.("declarator")
          if (declr?.type === "identifier") varTypeMap.set(declr.text, typeText)
        }
      })
    }

    const assignments = findAllNodes(root, "assignment_expression")
    for (const assign of assignments) {
      const right = assign.childForFieldName?.("right")
      if (!right || right.type !== "identifier") continue
      if (!knownFunctions.has(right.text)) continue

      const left = assign.childForFieldName?.("left")
      if (!left || left.type !== "field_expression") continue
      const fieldNode = left.childForFieldName?.("field")
      const argNode = left.childForFieldName?.("argument")
      if (!fieldNode || !argNode) continue

      const fieldName = fieldNode.text
      const containerExpr = argNode.text?.slice(0, 60) ?? ""
      const callbackName = right.text
      const assignLine = (assign.startPosition?.row ?? 0) + 1

      const containerVarName = containerExpr.replace(/->.*/, "").replace(/\..*/, "").trim()
      const resolvedType = varTypeMap.get(containerVarName) ?? undefined

      yield* emitRegistration(`${containerExpr}.${fieldName}`, callbackName, `fn_body_assign:${containerExpr}.${fieldName}`, fieldName, file, assignLine)
      yield* emitRuntimeCall(`${containerExpr}.${fieldName}`, callbackName, fieldName, file, assignLine, resolvedType)
    }
  }
}
