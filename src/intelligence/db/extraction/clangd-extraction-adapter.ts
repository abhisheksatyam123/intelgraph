import { readdir, stat } from "fs/promises"
import { join, extname } from "path"
import type { IExtractionAdapter } from "../../contracts/extraction-adapter.js"
import type {
  ExtractionInput,
  SymbolBatch,
  TypeBatch,
  EdgeBatch,
  ExtractionBatches,
} from "../../contracts/extraction-adapter.js"
import type { IngestReport, SymbolRow, EdgeRow } from "../../contracts/common.js"
import { PostgresSnapshotIngestWriter } from "../postgres/ingest-writer.js"
import type pg from "pg"

// ---------------------------------------------------------------------------
// Clangd LSP client interface (minimal surface we need)
// ---------------------------------------------------------------------------

export interface ClangdLspClient {
  documentSymbol(filePath: string): Promise<Array<Record<string, unknown>>>
  incomingCalls(filePath: string, line: number, character: number): Promise<Array<Record<string, unknown>>>
  outgoingCalls(filePath: string, line: number, character: number): Promise<Array<Record<string, unknown>>>
}

// ---------------------------------------------------------------------------
// C file discovery
// ---------------------------------------------------------------------------

const C_EXTS = new Set([".c", ".h", ".cpp", ".cc", ".cxx", ".hpp"])

async function collectFiles(dir: string, limit = 500): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    if (out.length >= limit) return
    const entries = await readdir(d, { withFileTypes: true })
    for (const e of entries) {
      if (out.length >= limit) break
      const full = join(d, e.name)
      if (e.isDirectory() && !e.name.startsWith(".")) {
        await walk(full)
      } else if (e.isFile() && C_EXTS.has(extname(e.name))) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

// ---------------------------------------------------------------------------
// Symbol kind mapping from LSP SymbolKind numbers
// ---------------------------------------------------------------------------

function mapKind(k: number): SymbolRow["kind"] {
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

// ---------------------------------------------------------------------------
// ClangdExtractionAdapter
// ---------------------------------------------------------------------------

export class ClangdExtractionAdapter implements IExtractionAdapter {
  constructor(
    private lsp: ClangdLspClient,
    private pgPool?: pg.Pool,
  ) {}

  async extractSymbols(input: ExtractionInput): Promise<SymbolBatch> {
    const files = input.files ?? await collectFiles(input.workspaceRoot, 200)
    const symbols: SymbolRow[] = []

    for (const file of files) {
      try {
        const raw = await this.lsp.documentSymbol(file)
        for (const s of raw) {
          const loc = (s.location as Record<string, unknown> | undefined)
          const range = (s.range as Record<string, unknown> | undefined) ??
                        (loc?.range as Record<string, unknown> | undefined)
          const start = range?.start as Record<string, unknown> | undefined
          symbols.push({
            kind: mapKind((s.kind as number) ?? 12),
            name: String(s.name ?? ""),
            qualifiedName: s.containerName ? `${s.containerName}::${s.name}` : undefined,
            location: {
              filePath: file,
              line: ((start?.line as number) ?? 0) + 1,
              column: ((start?.character as number) ?? 0) + 1,
            },
          })
        }
      } catch {
        // skip files that fail to parse
      }
    }

    return { symbols }
  }

  async extractTypes(input: ExtractionInput): Promise<TypeBatch> {
    // Types are derived from struct/union/enum symbols
    const { symbols } = await this.extractSymbols(input)
    const types = symbols
      .filter((s) => s.kind === "struct" || s.kind === "enum" || s.kind === "typedef")
      .map((s) => ({
        kind: s.kind as "struct" | "enum" | "typedef",
        spelling: s.name,
        symbolName: s.name,
      }))
    return { types, fields: [] }
  }

  async extractEdges(input: ExtractionInput): Promise<EdgeBatch> {
    const { symbols } = await this.extractSymbols(input)
    const edges: EdgeRow[] = []

    for (const sym of symbols) {
      if (sym.kind !== "function" || !sym.location) continue
      try {
        const calls = await this.lsp.outgoingCalls(
          sym.location.filePath,
          sym.location.line - 1,
          (sym.location.column ?? 1) - 1,
        )
        for (const call of calls) {
          const item = (call.to ?? call) as Record<string, unknown>
          const name = String(item.name ?? "")
          if (!name) continue
          edges.push({
            edgeKind: "calls",
            srcSymbolName: sym.name,
            dstSymbolName: name,
            confidence: 1.0,
            derivation: "clangd",
            evidence: {
              sourceKind: "clangd_response",
              location: sym.location,
            },
          })
        }
      } catch {
        // skip
      }
    }

    return { edges }
  }

  async materializeSnapshot(snapshotId: number, batches: ExtractionBatches): Promise<IngestReport> {
    if (!this.pgPool) {
      return {
        snapshotId,
        inserted: { symbols: 0, types: 0, fields: 0, edges: 0, runtimeCallers: 0, logs: 0 },
        warnings: ["no pgPool configured — dry run only"],
      }
    }
    const writer = new PostgresSnapshotIngestWriter(this.pgPool)
    return writer.writeSnapshotBatch(snapshotId, {
      symbols: batches.symbolBatch.symbols,
      types: batches.typeBatch.types,
      fields: batches.typeBatch.fields,
      edges: batches.edgeBatch.edges,
    })
  }
}
