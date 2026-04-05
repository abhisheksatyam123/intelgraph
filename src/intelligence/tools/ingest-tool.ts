/**
 * ingest-tool.ts
 * MCP tool that triggers the full extraction + ingest pipeline for a workspace.
 * Flow: beginSnapshot → extractSymbols/Types/Edges → materializeSnapshot → commitSnapshot
 *       → (optional) runtime caller ingestion → syncFromAuthoritative → return report
 */
import { z } from "zod"
import type { IDbFoundation } from "../contracts/db-foundation.js"
import type { IExtractionAdapter } from "../contracts/extraction-adapter.js"
import type { IIndirectCallerIngestion } from "../contracts/indirect-caller-ingestion.js"
import type { RuntimeCallerRow } from "../contracts/common.js"
import type { GraphProjectionRepository } from "../contracts/orchestrator.js"
import type { IndirectCallerGraph } from "../../tools/indirect-callers.js"

// ---------------------------------------------------------------------------
// Dep singleton
// ---------------------------------------------------------------------------

interface IngestDeps {
  db: IDbFoundation
  extractor: IExtractionAdapter
  projection: GraphProjectionRepository
  ingestion?: IIndirectCallerIngestion
  indirectCallerResolver?: (sym: { name: string; file?: string; line?: number }) => Promise<IndirectCallerGraph | null>
}

let INGEST_DEPS: IngestDeps | null = null

export function setIngestDeps(deps: IngestDeps | null): void {
  INGEST_DEPS = deps
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const ingestInputSchema = z.object({
  workspaceRoot: z.string().optional().describe("Absolute path to workspace root (defaults to WLAN_WORKSPACE_ROOT when omitted/empty)"),
  compileDbHash: z.string().optional().describe("Hash of compile_commands.json (auto-computed if omitted)"),
  parserVersion: z.string().optional().describe("Parser version string (default: 1.0.0)"),
  fileLimit: z.number().int().positive().optional().describe("Max files to extract (default: 200)"),
  syncProjection: z.boolean().optional().describe("Sync Neo4j projection after ingest (default: true)"),
  maxRuntimeTargets: z.number().int().positive().optional().describe("Max function symbols to resolve indirect callers for (default: 200)"),
})

// ---------------------------------------------------------------------------
// Graph → RuntimeCallerRow conversion
// ---------------------------------------------------------------------------

/**
 * Convert an IndirectCallerGraph to RuntimeCallerRow[] records for a given
 * target symbol.  One row is emitted per IndirectCallerNode that has at least
 * an enclosing-function name and a file location.
 */
function graphNodesToRuntimeCallerRows(
  targetApi: string,
  graph: IndirectCallerGraph,
): RuntimeCallerRow[] {
  const rows: RuntimeCallerRow[] = []

  for (const node of graph.nodes) {
    if (!node.name || !node.file) continue

    const chain = node.resolvedChain

    // Build dispatchChain from the mediated path stages
    const dispatchChain: string[] = []
    if (node.classification?.registrationApi) {
      dispatchChain.push(node.classification.registrationApi)
    }
    if (chain?.store.containerType) {
      dispatchChain.push(chain.store.containerType)
    }
    if (chain?.dispatch.dispatchFunction) {
      dispatchChain.push(chain.dispatch.dispatchFunction)
    }

    // Derive runtimeTrigger from resolved chain trigger or fall back to classification
    const runtimeTrigger =
      chain?.trigger.triggerKind ??
      chain?.trigger.triggerKey ??
      node.classification?.patternName ??
      "unknown"

    // Confidence: scale confidenceScore (1–5) to 0–1, or use 0.5 as fallback
    const confidence = chain ? Math.min(chain.confidenceScore / 5.0, 1.0) : 0.5

    rows.push({
      targetApi,
      immediateInvoker: node.name,
      dispatchChain,
      dispatchSite: {
        filePath: node.file,
        line: node.line,
      },
      runtimeTrigger,
      confidence,
    })
  }

  return rows
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeIngestTool(args: z.infer<typeof ingestInputSchema>): Promise<string> {
  if (!INGEST_DEPS) {
    return "intelligence_ingest: backend not initialized. Set INTELLIGENCE_NEO4J_URL to enable."
  }
  const { db: DB_FOUNDATION, extractor: EXTRACTION_ADAPTER, projection: GRAPH_PROJECTION } = INGEST_DEPS

  const lines: string[] = []
  const start = performance.now()
  const root = args.workspaceRoot?.trim() || process.env.WLAN_WORKSPACE_ROOT?.trim()
  if (!root) {
    return "intelligence_ingest: workspaceRoot missing. Provide workspaceRoot or set WLAN_WORKSPACE_ROOT."
  }

  let snapshotId = -1

  try {
    const meta = await DB_FOUNDATION.beginSnapshot({
      workspaceRoot: root,
      compileDbHash: args.compileDbHash ?? "auto",
      parserVersion: args.parserVersion ?? "1.0.0",
    })
    snapshotId = meta.snapshotId
    lines.push(`Snapshot started: id=${snapshotId}`)

    const input = {
      workspaceRoot: root,
    }

    const [symbolBatch, typeBatch, edgeBatch] = await Promise.all([
      EXTRACTION_ADAPTER.extractSymbols(input),
      EXTRACTION_ADAPTER.extractTypes(input),
      EXTRACTION_ADAPTER.extractEdges(input),
    ])

    lines.push(`Extracted: symbols=${symbolBatch.symbols.length} types=${typeBatch.types.length} edges=${edgeBatch.edges.length}`)

    const report = await EXTRACTION_ADAPTER.materializeSnapshot(snapshotId, {
      symbolBatch,
      typeBatch,
      edgeBatch,
    })

    lines.push(`Persisted: symbols=${report.inserted.symbols} types=${report.inserted.types} edges=${report.inserted.edges}`)

    // Phase 2: Runtime caller ingestion via C-parser + clangd indirect caller resolution
    // Only run if an indirect caller resolver is available
    if (INGEST_DEPS.ingestion && INGEST_DEPS.indirectCallerResolver) {
      const functionSymbols = symbolBatch.symbols
        .filter(s => s.kind === "function")
        .slice(0, args.maxRuntimeTargets ?? 200)

      let runtimeInserted = 0
      for (const sym of functionSymbols) {
        try {
          const graph = await INGEST_DEPS.indirectCallerResolver(sym)
          if (!graph || graph.nodes.length === 0) continue

          const records = graphNodesToRuntimeCallerRows(sym.name, graph)
          if (records.length === 0) continue

          const batch = await INGEST_DEPS.ingestion.parseRuntimeCallers({ workspaceRoot: root, records })
          const linked = await INGEST_DEPS.ingestion.linkToSymbols(snapshotId, batch)
          const runtimeReport = await INGEST_DEPS.ingestion.persistRuntimeChains(snapshotId, linked)
          runtimeInserted += runtimeReport.inserted.runtimeCallers ?? 0
        } catch (err) {
          console.warn(`[ingest] runtime caller resolution failed for ${sym.name}:`, err)
        }
      }

      if (runtimeInserted > 0) {
        lines.push(`Runtime callers inserted: ${runtimeInserted}`)
      }
    }

    await DB_FOUNDATION.commitSnapshot(snapshotId)
    lines.push(`Snapshot committed: id=${snapshotId} status=ready`)

    if (args.syncProjection !== false && GRAPH_PROJECTION) {
      const res = await GRAPH_PROJECTION.syncFromAuthoritative(snapshotId)
      lines.push(`Projection synced: nodes=${res.nodesUpserted} edges=${res.edgesUpserted}`)
    }

    if (report.warnings.length > 0) {
      lines.push(`Warnings (${report.warnings.length}):`)
      for (const w of report.warnings) lines.push(`- ${w}`)
    }

    lines.push(`Done in ${(performance.now() - start).toFixed(1)}ms`)
    return lines.join("\n")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (snapshotId > 0) {
      await DB_FOUNDATION.failSnapshot(snapshotId, msg)
    }
    return `intelligence_ingest: failed: ${msg}`
  }
}
