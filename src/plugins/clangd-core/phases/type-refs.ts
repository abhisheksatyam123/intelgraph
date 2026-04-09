/**
 * phases/type-refs.ts — Phase 7: references_type + field_of_type + aggregates
 * edges via tree-sitter.
 *
 * Emits:
 *   - `references_type`: function parameters/return types reference structs/enums
 *   - `field_of_type`: struct fields reference their declared types
 *   - `aggregates`: struct aggregates another struct (rolled up from field_of_type)
 *
 * Generic C/C++ logic — no project-specific knowledge.
 */

import { parseSource, findAllNodes, walkAst } from "../../../tools/pattern-detector/c-parser.js"
import type { FileSymbolMap, PhaseCtx } from "./types.js"

export async function* extractTypeRefs(
  ctx: PhaseCtx,
  fileSymbols: FileSymbolMap,
) {
  // Build a set of known struct/enum/typedef names for matching
  const knownTypes = new Set<string>()
  for (const syms of fileSymbols.values()) {
    for (const s of syms) {
      if (s.kind === "struct" || s.kind === "enum" || s.kind === "typedef") {
        knownTypes.add(s.name)
      }
    }
  }
  if (knownTypes.size === 0) return

  for (const [file, symbols] of fileSymbols.entries()) {
    if (ctx.signal.aborted) return
    const text = ctx.workspace.readFile(file)
    if (!text) continue

    const root = parseSource(text)
    if (!root) continue

    // ── references_type: function declarations ──────────────────────────
    // For each function_definition, scan its parameter types and return
    // type for known struct/enum/typedef names.
    const funcDefs = findAllNodes(root, "function_definition")
    for (const funcDef of funcDefs) {
      // Get function name from the declarator
      let funcName: string | null = null
      const declarator = funcDef.childForFieldName?.("declarator")
      if (declarator) {
        // Walk down to find the identifier (handles pointer declarators)
        walkAst(declarator, (n: any) => {
          if (!funcName && n.type === "identifier") funcName = n.text
        })
      }
      if (!funcName) continue

      // Scan the entire function signature text for type references
      const sigEnd = funcDef.childForFieldName?.("body")?.startPosition?.row ?? funcDef.endPosition?.row ?? 0
      const sigStartRow = funcDef.startPosition?.row ?? 0
      const sigText = text.split("\n").slice(sigStartRow, sigEnd + 1).join(" ")

      const emittedTypes = new Set<string>()
      for (const typeName of knownTypes) {
        if (sigText.includes(typeName) && !emittedTypes.has(typeName)) {
          emittedTypes.add(typeName)
          yield ctx.edge({
            payload: {
              edgeKind: "references_type",
              srcSymbolName: funcName,
              dstSymbolName: typeName,
              confidence: 0.85,
              derivation: "clangd",
              evidence: {
                sourceKind: "file_line",
                location: { filePath: file, line: sigStartRow + 1 },
              },
            },
          })
          ctx.metrics.count("edges.references_type")
        }
      }
    }

    // ── field_of_type + aggregates: struct field declarations ────────────
    // For each struct_specifier, find its field_declaration_list and
    // extract the type of each field.
    const structSpecs = findAllNodes(root, "struct_specifier")
    const emittedAggregates = new Set<string>()

    for (const spec of structSpecs) {
      // Get struct name
      let structName: string | null = null
      for (let i = 0; i < spec.childCount; i++) {
        const child = spec.child(i)
        if (child?.type === "type_identifier") { structName = child.text; break }
      }
      if (!structName) continue

      // Find field_declaration_list
      const fieldList = spec.children?.find((c: any) => c.type === "field_declaration_list")
      if (!fieldList) continue

      const fieldDecls = findAllNodes(fieldList, "field_declaration")
      for (const fd of fieldDecls) {
        // Extract field name
        let fieldName: string | null = null
        const fdDeclarator = fd.childForFieldName?.("declarator")
        if (fdDeclarator) {
          walkAst(fdDeclarator, (n: any) => {
            if (!fieldName && n.type === "field_identifier") fieldName = n.text
          })
        }
        if (!fieldName) continue

        // Extract field type — look for type_identifier or primitive_type
        let fieldType: string | null = null
        const typeNode = fd.childForFieldName?.("type")
        if (typeNode) {
          // Check if it references a known struct/enum/typedef
          walkAst(typeNode, (n: any) => {
            if (!fieldType && n.type === "type_identifier" && knownTypes.has(n.text)) {
              fieldType = n.text
            }
          })
        }

        if (fieldType) {
          // field_of_type: structName.fieldName → fieldType
          yield ctx.edge({
            payload: {
              edgeKind: "field_of_type",
              srcSymbolName: `${structName}.${fieldName}`,
              dstSymbolName: fieldType,
              confidence: 0.85,
              derivation: "clangd",
              metadata: { containment: "direct" },
              evidence: {
                sourceKind: "file_line",
                location: { filePath: file, line: (fd.startPosition?.row ?? 0) + 1 },
              },
            },
          })
          ctx.metrics.count("edges.field_of_type")

          // aggregates: structName → fieldType (deduplicated per struct)
          const aggKey = `${structName}:${fieldType}`
          if (!emittedAggregates.has(aggKey)) {
            emittedAggregates.add(aggKey)
            yield ctx.edge({
              payload: {
                edgeKind: "aggregates",
                srcSymbolName: structName,
                dstSymbolName: fieldType,
                confidence: 0.85,
                derivation: "clangd",
                evidence: {
                  sourceKind: "file_line",
                  location: { filePath: file, line: (spec.startPosition?.row ?? 0) + 1 },
                },
              },
            })
            ctx.metrics.count("edges.aggregates")
          }
        }
      }
    }
  }
}
