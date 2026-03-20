/**
 * tools.ts — MCP tool definitions and human-readable formatters.
 *
 * Each tool maps to one or more LSP operations on the shared LspClient.
 * Outputs are plain text (not raw JSON) so agents can read them directly.
 */

import { z } from "zod"
import path from "path"
import { fileURLToPath } from "url"
import type { LspClient } from "../lsp/index.js"
import type { IndexTracker } from "../tracking/index.js"
import { readFileSync } from "fs"
import { classifyIncomingCalls, collectIndirectCallers, formatIndirectCallerTree } from "./indirect-callers.js"

// ── Symbol kind number → readable name ───────────────────────────────────────
const SYMBOL_KIND: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package",
  5: "Class", 6: "Method", 7: "Property", 8: "Field",
  9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function",
  13: "Variable", 14: "Constant", 15: "String", 16: "Number",
  17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
}

// Highlight kind: 1=Text, 2=Read, 3=Write
const HIGHLIGHT_KIND: Record<number, string> = { 1: "text", 2: "read", 3: "write" }

// Folding range kind
const FOLD_KIND: Record<string, string> = {
  comment: "comment", imports: "imports", region: "region",
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function displayPath(uriOrPath: string, root: string): string {
  try {
    const abs = uriOrPath.startsWith("file://") ? fileURLToPath(uriOrPath) : uriOrPath
    return path.relative(root, abs)
  } catch {
    return uriOrPath
  }
}

function fmtLocation(loc: any, root: string): string {
  if (!loc) return "(unknown location)"
  const uri = loc.uri ?? loc.targetUri ?? ""
  const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
  const line = range?.start?.line != null ? range.start.line + 1 : "?"
  const col  = range?.start?.character != null ? range.start.character + 1 : "?"
  return `${displayPath(uri, root)}:${line}:${col}`
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function formatHover(result: any): string {
  if (!result) return "No hover information available."
  const content = result.contents
  if (typeof content === "string") return content
  if (content?.value) return content.value
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === "string" ? c : c?.value ?? "")).join("\n")
  }
  return "No hover information available."
}

export function formatDefinition(results: any[], root: string, label = "Definition"): string {
  if (!results.length) return `No ${label.toLowerCase()} found.`
  return results.map((r: any) => `${label}: ${fmtLocation(r, root)}`).join("\n")
}

export function formatReferences(results: any[], root: string): string {
  if (!results.length) return "No references found."
  const lines = results.map((r: any) => `  ${fmtLocation(r, root)}`)
  return `References (${results.length}):\n${lines.join("\n")}`
}

export function formatDocumentSymbol(results: any[]): string {
  if (!results.length) return "No symbols found."
  function renderSymbol(sym: any, indent = 0): string {
    const prefix = "  ".repeat(indent)
    const kind   = SYMBOL_KIND[sym.kind] ?? `Kind(${sym.kind})`
    const detail = sym.detail ? ` — ${sym.detail}` : ""
    const line   = sym.range?.start?.line != null ? `:${sym.range.start.line + 1}` : ""
    let out = `${prefix}[${kind}] ${sym.name}${detail}${line}`
    if (sym.children?.length) {
      out += "\n" + sym.children.map((c: any) => renderSymbol(c, indent + 1)).join("\n")
    }
    return out
  }
  return results.map((s: any) => renderSymbol(s)).join("\n")
}

export function formatWorkspaceSymbol(results: any[], root: string): string {
  if (!results.length) return "No symbols found."
  return results
    .map((s: any) => {
      const kind = SYMBOL_KIND[s.kind] ?? `Kind(${s.kind})`
      return `[${kind}] ${s.name}  ${fmtLocation(s.location, root)}`
    })
    .join("\n")
}

export function formatIncomingCalls(results: any[], root: string): string {
  if (!results.length) return "No incoming calls."
  return classifyIncomingCalls(results)
    .map((call: any) => {
      const from = call.from ?? call.caller
      const kind = SYMBOL_KIND[from?.kind] ?? "?"
      const loc  = fmtLocation({ uri: from?.uri, range: from?.selectionRange ?? from?.range }, root)
      const tags = Array.isArray(call.tags) && call.tags.length ? ` [${call.tags.join(",")}]` : ""
      return `  <- [${kind}]${tags} ${from?.name ?? "(unknown)"}  at ${loc}`
    })
    .join("\n")
}

export function formatOutgoingCalls(results: any[], root: string): string {
  if (!results.length) return "No outgoing calls."
  return results
    .map((call: any) => {
      const to   = call.to ?? call.callee
      const kind = SYMBOL_KIND[to?.kind] ?? "?"
      const loc  = fmtLocation({ uri: to?.uri, range: to?.selectionRange ?? to?.range }, root)
      return `  -> [${kind}] ${to?.name ?? "(unknown)"}  at ${loc}`
    })
    .join("\n")
}

export function formatTypeHierarchy(results: any[], root: string, arrow: string): string {
  if (!results.length) return `No ${arrow === "↑" ? "supertypes" : "subtypes"} found.`
  return results
    .map((item: any) => {
      const kind = SYMBOL_KIND[item.kind] ?? "?"
      const loc  = fmtLocation({ uri: item.uri, range: item.selectionRange ?? item.range }, root)
      return `  ${arrow} [${kind}] ${item.name}  at ${loc}`
    })
    .join("\n")
}

export function formatDiagnostics(diagMap: Map<string, any[]>, root: string): string {
  const lines: string[] = []
  for (const [filePath, diags] of diagMap.entries()) {
    if (!diags.length) continue
    lines.push(`${displayPath(filePath, root)}:`)
    for (const d of diags) {
      const severityMap: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" }
      const sev  = severityMap[d.severity ?? 1] ?? "ERROR"
      const line = d.range?.start?.line      != null ? d.range.start.line + 1      : "?"
      const col  = d.range?.start?.character != null ? d.range.start.character + 1 : "?"
      lines.push(`  ${sev} [${line}:${col}] ${d.message}`)
    }
  }
  return lines.length ? lines.join("\n") : "No diagnostics."
}

export function formatCodeAction(results: any[]): string {
  if (!results.length) return "No code actions available."
  return results
    .map((action: any) => {
      const kind     = action.kind     ? ` [${action.kind}]`                    : ""
      const disabled = action.disabled ? ` (disabled: ${action.disabled.reason})` : ""
      return `* ${action.title}${kind}${disabled}`
    })
    .join("\n")
}

export function formatDocumentHighlight(results: any[], filePath: string, root: string): string {
  if (!results.length) return "No highlights found."
  const rel = displayPath(filePath, root)
  return results
    .map((h: any) => {
      const kind  = HIGHLIGHT_KIND[h.kind ?? 1] ?? "text"
      const line  = h.range?.start?.line      != null ? h.range.start.line + 1      : "?"
      const col   = h.range?.start?.character != null ? h.range.start.character + 1 : "?"
      const eline = h.range?.end?.line        != null ? h.range.end.line + 1        : "?"
      const ecol  = h.range?.end?.character   != null ? h.range.end.character + 1   : "?"
      return `  [${kind}] ${rel}:${line}:${col} – ${eline}:${ecol}`
    })
    .join("\n")
}

export function formatFoldingRange(results: any[], filePath: string, root: string): string {
  if (!results.length) return "No folding ranges found."
  const rel = displayPath(filePath, root)
  return results
    .map((r: any) => {
      const kind  = r.kind ? ` (${FOLD_KIND[r.kind] ?? r.kind})` : ""
      const start = (r.startLine ?? 0) + 1
      const end   = (r.endLine   ?? 0) + 1
      return `  ${rel}:${start}–${end}${kind}`
    })
    .join("\n")
}

export function formatSignatureHelp(result: any): string {
  if (!result?.signatures?.length) return "No signature help available."
  const active = result.activeSignature ?? 0
  const lines: string[] = []
  result.signatures.forEach((sig: any, i: number) => {
    const marker = i === active ? "▶" : " "
    lines.push(`${marker} ${sig.label}`)
    if (sig.documentation) {
      const doc = typeof sig.documentation === "string"
        ? sig.documentation
        : sig.documentation?.value ?? ""
      if (doc) lines.push(`  ${doc}`)
    }
    if (sig.parameters?.length) {
      const activeParam = result.activeParameter ?? sig.activeParameter ?? 0
      sig.parameters.forEach((p: any, pi: number) => {
        const pmarker = pi === activeParam && i === active ? "  → " : "    "
        const label   = typeof p.label === "string" ? p.label
          : Array.isArray(p.label) ? sig.label.slice(p.label[0], p.label[1]) : ""
        const pdoc    = typeof p.documentation === "string" ? p.documentation
          : p.documentation?.value ?? ""
        lines.push(`${pmarker}param[${pi}]: ${label}${pdoc ? ` — ${pdoc}` : ""}`)
      })
    }
  })
  return lines.join("\n")
}

export function formatRename(workspaceEdit: any, root: string): string {
  if (!workspaceEdit) return "Rename not possible at this position."
  const lines: string[] = ["Rename would change:"]
  // documentChanges (preferred)
  if (workspaceEdit.documentChanges?.length) {
    for (const change of workspaceEdit.documentChanges) {
      const file = displayPath(change.textDocument?.uri ?? "", root)
      const edits = change.edits ?? []
      lines.push(`  ${file}: ${edits.length} edit(s)`)
      for (const e of edits) {
        const line = e.range?.start?.line != null ? e.range.start.line + 1 : "?"
        const col  = e.range?.start?.character != null ? e.range.start.character + 1 : "?"
        lines.push(`    line ${line}:${col} → "${e.newText}"`)
      }
    }
  } else if (workspaceEdit.changes) {
    // flat changes map
    for (const [uri, edits] of Object.entries(workspaceEdit.changes as Record<string, any[]>)) {
      const file = displayPath(uri, root)
      lines.push(`  ${file}: ${edits.length} edit(s)`)
      for (const e of edits) {
        const line = e.range?.start?.line != null ? e.range.start.line + 1 : "?"
        const col  = e.range?.start?.character != null ? e.range.start.character + 1 : "?"
        lines.push(`    line ${line}:${col} → "${e.newText}"`)
      }
    }
  } else {
    lines.push("  (no changes)")
  }
  return lines.join("\n")
}

export function formatFormat(edits: any[], filePath: string, root: string): string {
  if (!edits.length) return "No formatting changes needed."
  const rel = displayPath(filePath, root)
  return `${rel}: ${edits.length} formatting edit(s)\n` +
    edits.slice(0, 10).map((e: any) => {
      const sl = e.range?.start?.line != null ? e.range.start.line + 1 : "?"
      const el = e.range?.end?.line   != null ? e.range.end.line + 1   : "?"
      const preview = e.newText.slice(0, 60).replace(/\n/g, "↵")
      return `  lines ${sl}–${el}: "${preview}${e.newText.length > 60 ? "…" : ""}"`
    }).join("\n") +
    (edits.length > 10 ? `\n  … and ${edits.length - 10} more` : "")
}

export function formatInlayHints(hints: any[], filePath: string, root: string): string {
  if (!hints.length) return "No inlay hints in this range."
  const rel = displayPath(filePath, root)
  return hints
    .map((h: any) => {
      const line  = h.position?.line      != null ? h.position.line + 1      : "?"
      const col   = h.position?.character != null ? h.position.character + 1 : "?"
      const label = Array.isArray(h.label)
        ? h.label.map((p: any) => (typeof p === "string" ? p : p.value ?? "")).join("")
        : String(h.label ?? "")
      const kind  = h.kind === 1 ? "type" : h.kind === 2 ? "param" : "hint"
      return `  [${kind}] ${rel}:${line}:${col}  ${label}`
    })
    .join("\n")
}

// ── Tool registry ─────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string
  description: string
  inputSchema: z.ZodTypeAny
  execute: (args: any, client: LspClient, tracker: IndexTracker) => Promise<string>
}

// Shared schemas
const positionSchema = z.object({
  file:      z.string().describe("Absolute path to the C/C++ source file"),
  line:      z.number().int().min(1).describe("Line number (1-based)"),
  character: z.number().int().min(1).describe("Character offset (1-based)"),
})

const fileOnlySchema = z.object({
  file: z.string().describe("Absolute path to the C/C++ source file"),
})

const incomingCallSchema = positionSchema

// Helper: open file before position-based queries
async function withFile(
  client: LspClient,
  filePath: string,
  fn: () => Promise<string>,
): Promise<string> {
  try {
    const text = readFileSync(filePath, "utf8")
    const isFirstOpen = await client.openFile(filePath, text)
    if (isFirstOpen) await new Promise((r) => setTimeout(r, 300))
  } catch {
    // proceed anyway — clangd may have it indexed
  }
  return fn()
}

export const TOOLS: ToolDef[] = [

  // ── lsp_hover ──────────────────────────────────────────────────────────────
  {
    name: "lsp_hover",
    description:
      "Get type information, documentation, and signature for the symbol at the given position.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const result = await client.hover(args.file, args.line - 1, args.character - 1)
        return formatHover(result) + tracker.statusSuffix() + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_definition ────────────────────────────────────────────────────────
  {
    name: "lsp_definition",
    description:
      "Jump to the implementation/definition of the symbol. " +
      "For a function declared in a .h file, this jumps to the .c/.cpp body. " +
      "Use lsp_declaration to jump to the .h prototype instead.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.definition(args.file, args.line - 1, args.character - 1)
        return formatDefinition(results, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_declaration ───────────────────────────────────────────────────────
  {
    name: "lsp_declaration",
    description:
      "Jump to the forward declaration of the symbol (e.g. the prototype in a .h header file). " +
      "Distinct from lsp_definition which jumps to the implementation body.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.declaration(args.file, args.line - 1, args.character - 1)
        return formatDefinition(results, client.root, "Declaration") + tracker.statusSuffix()
      }),
  },

  // ── lsp_type_definition ───────────────────────────────────────────────────
  {
    name: "lsp_type_definition",
    description:
      "Jump to the type definition of the symbol under the cursor. " +
      "For a variable 'wlan_vdev_t *vdev', this jumps to 'struct wlan_vdev_t { ... }'. " +
      "Useful for navigating typedef chains and struct definitions.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.typeDefinition(args.file, args.line - 1, args.character - 1)
        return formatDefinition(results, client.root, "Type definition") + tracker.statusSuffix()
      }),
  },

  // ── lsp_references ────────────────────────────────────────────────────────
  {
    name: "lsp_references",
    description: "Find all references to the symbol at the given position across the workspace.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.references(args.file, args.line - 1, args.character - 1)
        return formatReferences(results, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_implementation ────────────────────────────────────────────────────
  {
    name: "lsp_implementation",
    description: "Find implementations of a virtual function or interface method.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.implementation(args.file, args.line - 1, args.character - 1)
        return formatDefinition(results, client.root, "Implementation") + tracker.statusSuffix()
      }),
  },

  // ── lsp_document_highlight ────────────────────────────────────────────────
  {
    name: "lsp_document_highlight",
    description:
      "Find all occurrences of the symbol within the current file, tagged as read/write/text. " +
      "Faster than lsp_references for local variable analysis within a single file.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.documentHighlight(args.file, args.line - 1, args.character - 1)
        return formatDocumentHighlight(results, args.file, client.root) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_document_symbol ───────────────────────────────────────────────────
  {
    name: "lsp_document_symbol",
    description:
      "List all symbols (functions, structs, variables, enums, etc.) defined in a file. " +
      "Use this to get a structural outline before reading the file.",
    inputSchema: fileOnlySchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.documentSymbol(args.file)
        return formatDocumentSymbol(results) + tracker.statusSuffix()
      }),
  },

  // ── lsp_workspace_symbol ──────────────────────────────────────────────────
  {
    name: "lsp_workspace_symbol",
    description: "Search for symbols by name across the entire workspace index.",
    inputSchema: z.object({
      query: z.string().describe("Symbol name or prefix to search for"),
    }),
    execute: async (args, client, tracker) => {
      const results = await client.workspaceSymbol(args.query)
      return formatWorkspaceSymbol(results, client.root) + tracker.statusSuffix()
    },
  },

  // ── lsp_folding_range ─────────────────────────────────────────────────────
  {
    name: "lsp_folding_range",
    description:
      "Get all foldable regions in a file: functions, #ifdef blocks, comment blocks, etc. " +
      "Use this to understand the high-level structure of a large file without reading it fully.",
    inputSchema: fileOnlySchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.foldingRange(args.file)
        return formatFoldingRange(results, args.file, client.root) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_signature_help ────────────────────────────────────────────────────
  {
    name: "lsp_signature_help",
    description:
      "Get the signature of the function being called at the cursor position, " +
      "with the active parameter highlighted. Use this when the cursor is inside a function call's argument list.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const result = await client.signatureHelp(args.file, args.line - 1, args.character - 1)
        return formatSignatureHelp(result) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_incoming_calls ────────────────────────────────────────────────────
  {
    name: "lsp_incoming_calls",
    description: "Find all callers of the function at the given position (who calls this?). " +
      "Each caller is tagged as [direct], [dispatch-table], [reg-call], or [struct-reg].",
    inputSchema: incomingCallSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.incomingCalls(args.file, args.line - 1, args.character - 1)
        return formatIncomingCalls(classifyIncomingCalls(results), client.root) + tracker.statusSuffix()
      }),
  },

  {
    name: "lsp_indirect_callers",
    description:
      "Find all direct callers and registration endpoints of the function at the given position. " +
      "Registration endpoints (dispatch-table entries, callback registrations, timer callbacks) " +
      "are shown as terminal nodes — they represent the event source that will invoke the function " +
      "at runtime. No recursion into who calls the registrar. " +
      "Groups results by: Direct callers / Dispatch-table registrations / " +
      "Registration-call registrations / Struct registrations / Signal-based registrations.",
    inputSchema: positionSchema.extend({
      maxNodes: z.number().int().min(1).max(500).default(15).optional()
                .describe("Maximum callers to return (default: 15)"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const graph = await collectIndirectCallers(client, args)
        return formatIndirectCallerTree(graph, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_outgoing_calls ────────────────────────────────────────────────────
  {
    name: "lsp_outgoing_calls",
    description: "Find all functions called by the function at the given position (what does this call?).",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.outgoingCalls(args.file, args.line - 1, args.character - 1)
        return formatOutgoingCalls(results, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_supertypes ────────────────────────────────────────────────────────
  {
    name: "lsp_supertypes",
    description:
      "Find the base types / parent classes of the type at the given position. " +
      "Navigates up the type hierarchy.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.supertypes(args.file, args.line - 1, args.character - 1)
        return formatTypeHierarchy(results, client.root, "↑") + tracker.statusSuffix()
      }),
  },

  // ── lsp_subtypes ──────────────────────────────────────────────────────────
  {
    name: "lsp_subtypes",
    description:
      "Find all derived types / child classes of the type at the given position. " +
      "Navigates down the type hierarchy.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.subtypes(args.file, args.line - 1, args.character - 1)
        return formatTypeHierarchy(results, client.root, "↓") + tracker.statusSuffix()
      }),
  },

  // ── lsp_rename ────────────────────────────────────────────────────────────
  {
    name: "lsp_rename",
    description:
      "Show all locations that would change when renaming the symbol at the given position. " +
      "Returns a full change manifest (file + line + new text) across the workspace. " +
      "Review the output before making any edits.",
    inputSchema: positionSchema.extend({
      newName: z.string().describe("The new name for the symbol"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        // First check rename is valid at this position
        const prep = await client.prepareRename(args.file, args.line - 1, args.character - 1)
        if (!prep) return "Rename not possible at this position (not a renameable symbol)."
        const edit = await client.rename(args.file, args.line - 1, args.character - 1, args.newName)
        return formatRename(edit, client.root) + tracker.statusSuffix()
      }),
  },

  // ── lsp_format ────────────────────────────────────────────────────────────
  {
    name: "lsp_format",
    description:
      "Get clang-format formatting edits for a file or a line range. " +
      "Returns the list of text edits needed — does NOT modify the file. " +
      "Apply the edits yourself after reviewing them.",
    inputSchema: fileOnlySchema.extend({
      startLine: z.number().int().min(1).optional().describe("Start line for range formatting (1-based, omit for whole file)"),
      endLine:   z.number().int().min(1).optional().describe("End line for range formatting (1-based, omit for whole file)"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        let edits: any[]
        if (args.startLine != null && args.endLine != null) {
          edits = await client.rangeFormatting(
            args.file,
            args.startLine - 1, 0,
            args.endLine - 1, 9999,
          )
        } else {
          edits = await client.formatting(args.file)
        }
        return formatFormat(edits, args.file, client.root) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_inlay_hints ───────────────────────────────────────────────────────
  {
    name: "lsp_inlay_hints",
    description:
      "Get inlay hints for a range of lines: inferred types for 'auto' variables, " +
      "parameter names at call sites, and return type annotations. " +
      "Extremely useful for understanding macro-heavy or template-heavy code.",
    inputSchema: fileOnlySchema.extend({
      startLine: z.number().int().min(1).describe("First line of the range (1-based)"),
      endLine:   z.number().int().min(1).describe("Last line of the range (1-based)"),
    }),
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const hints = await client.inlayHints(args.file, args.startLine - 1, args.endLine - 1)
        return formatInlayHints(hints, args.file, client.root) + tracker.fileSuffix(args.file)
      }),
  },

  // ── lsp_diagnostics ───────────────────────────────────────────────────────
  {
    name: "lsp_diagnostics",
    description: "Get compiler errors and warnings. Optionally limit to a specific file.",
    inputSchema: z.object({
      file: z.string().optional().describe("Optional: limit diagnostics to this file path"),
    }),
    execute: async (args, client, tracker) => {
      if (args.file) {
        await withFile(client, args.file, async () => "")
        await new Promise((r) => setTimeout(r, 500))
        const diags = client.getDiagnostics(args.file) as any[]
        const map = new Map([[args.file, diags]])
        return formatDiagnostics(map, client.root) + tracker.statusSuffix()
      }
      const map = client.getDiagnostics() as Map<string, any[]>
      return formatDiagnostics(map, client.root) + tracker.statusSuffix()
    },
  },

  // ── lsp_code_action ───────────────────────────────────────────────────────
  {
    name: "lsp_code_action",
    description: "Get available code actions (quick fixes, refactors) at the given position.",
    inputSchema: positionSchema,
    execute: async (args, client, tracker) =>
      withFile(client, args.file, async () => {
        const results = await client.codeAction(args.file, args.line - 1, args.character - 1)
        return formatCodeAction(results) + tracker.statusSuffix()
      }),
  },

  // ── lsp_file_status ───────────────────────────────────────────────────────
  {
    name: "lsp_file_status",
    description:
      "Get the current parse state of a specific file as reported by clangd. " +
      "States: idle (ready), queued, parsing, building preamble, building AST, indexing. " +
      "Use this to check if a file is ready before querying it.",
    inputSchema: fileOnlySchema,
    execute: async (args, _client, tracker) => {
      const state = tracker.fileState(args.file)
      if (!state) return `${args.file}: unknown (not yet opened or no status received)`
      return `${args.file}: ${state}`
    },
  },

  // ── lsp_index_status ──────────────────────────────────────────────────────
  {
    name: "lsp_index_status",
    description:
      "Query the current clangd background index status and per-file parse states. " +
      "Run this first to check if cross-file results will be complete.",
    inputSchema: z.object({}),
    execute: async (_args, client, tracker) => {
      const state = tracker.state
      const info  = await client.clangdInfo()
      const lines = [
        `Index ready:  ${state.isReady}`,
        `Progress:     ${state.percentage}%`,
        `Status:       ${state.message}`,
        `Updated:      ${state.updatedAt}`,
      ]

      // Per-file states (only non-idle)
      const busy = [...tracker.fileStates.entries()].filter(([, s]) => s !== "idle")
      if (busy.length) {
        lines.push("", `Active files (${busy.length}):`)
        for (const [f, s] of busy) {
          lines.push(`  ${s.padEnd(20)} ${f}`)
        }
      }

      // Structured clangd info
      if (info) {
        const bg = info.background_index_stats
        if (bg) {
          lines.push("", "Background index stats:")
          lines.push(`  Completed: ${bg.completed ?? "?"}`)
          lines.push(`  Total:     ${bg.total     ?? "?"}`)
          lines.push(`  Queue:     ${bg.queue_size ?? bg.queued ?? "?"}`)
        }
        const mem = info.memory_usage
        if (mem) {
          lines.push("", "Memory usage:")
          for (const [k, v] of Object.entries(mem)) {
            lines.push(`  ${k}: ${v}`)
          }
        }
      }

      return lines.join("\n")
    },
  },
]
