/**
 * ingest-tool.ts
 * MCP tool that triggers the full extraction + ingest pipeline for a workspace.
 * Flow: beginSnapshot → extractSymbols/Types/Edges → materializeSnapshot → commitSnapshot
 *       → syncFromAuthoritative → return report
 */
import { z } from "zod"
import type { IDbFoundation } from "../contracts/db-foundation.js"
import type { IExtractionAdapter } from "../contracts/extraction-adapter.js"
import type { GraphProjectionRepository } from "../contracts/orchestrator.js"

let DB_FOUNDATION: IDbFoundation | null = null
let EXTRACTION_ADAPTER: IExtractionAdapter | null = null
let GRAPH_PROJECTION: GraphProjectionRepository | null = null

export function setIngestDeps(deps: {
  db: IDbFoundation
  extractor: IExtractionAdapter
  projection: GraphProjectionRepository
} | null): void {
  if (!deps) {
    DB_FOUNDATION = null
    EXTRACTION_ADAPTER = null
    GRAPH_PROJECTION = null
    return
  }
  DB_FOUNDATION = deps.db
  EXTRACTION_ADAPTER = deps.extractor
  GRAPH_PROJECTION = deps.projection
}

export const ingestInputSchema = z.object({
  workspaceRoot: z.string().describe("Absolute path to workspace root"),
  compileDbHash: z.string().optional().describe("Hash of compile_commands.json (auto-computed if omitted)"),
  parserVersion: z.string().optional().describe("Parser version string (default: 1.0.0)"),
  fileLimit: z.number().int().positive().optional().describe("Max files to extract (default: 200)"),
  syncProjection: z.boolean().optional().describe("Sync Neo4j projection after ingest (default: true)"),
})

export async function executeIngestTool(args: z.infer<typeof ingestInputSchema>): Promise<string> {
  if (!DB_FOUNDATION || !EXTRACTION_ADAPTER) {
    return "intelligence_ingest: backend not initialized. Set INTELLIGENCE_POSTGRES_URL to enable."
  }

  const lines: string[] = []
  const start = performance.now()

  // 1) Begin snapshot
  const ref = await DB_FOUNDATION.beginSnapshot({
    workspaceRoot: args.workspaceRoot,
    compileDbHash: args.compileDbHash ?? `auto-${Date.now()}`,
    parserVersion: args.parserVersion ?? "1.0.0",
  })
  lines.push(`Snapshot started: id=${ref.snapshotId}`)

  try {
    const input = { workspaceRoot: args.workspaceRoot, fileLimit: args.fileLimit ?? 200 }

    // 2) Extract symbols, types, edges in parallel
    const [symBatch, typeBatch, edgeBatch] = await Promise.all([
      EXTRACTION_ADAPTER.extractSymbols(input),
      EXTRACTION_ADAPTER.extractTypes(input),
      EXTRACTION_ADAPTER.extractEdges(input),
    ])
    lines.push(`Extracted: symbols=${symBatch.symbols.length} types=${typeBatch.types.length} edges=${edgeBatch.edges.length}`)

    // 3) Materialize into Postgres
    const report = await EXTRACTION_ADAPTER.materializeSnapshot(ref.snapshotId, {
      symbolBatch: symBatch,
      typeBatch,
      edgeBatch,
    })
    lines.push(`Persisted: symbols=${report.inserted.symbols} types=${report.inserted.types} edges=${report.inserted.edges}`)
    if (report.warnings.length > 0) {
      lines.push(`Warnings (${report.warnings.length}): ${report.warnings.slice(0, 3).join("; ")}`)
    }

    // 4) Commit snapshot
    await DB_FOUNDATION.commitSnapshot(ref.snapshotId)
    lines.push(`Snapshot committed: id=${ref.snapshotId} status=ready`)

    // 5) Sync Neo4j projection
    if (args.syncProjection !== false && GRAPH_PROJECTION) {
      const sync = await GRAPH_PROJECTION.syncFromAuthoritative(ref.snapshotId)
      lines.push(`Projection synced: nodes=${sync.nodesUpserted} edges=${sync.edgesUpserted}`)
    }

    const ms = Math.round(performance.now() - start)
    lines.push(`Done in ${ms}ms`)
    return lines.join("\n")
  } catch (err) {
    await DB_FOUNDATION.failSnapshot(ref.snapshotId, String(err))
    return `intelligence_ingest: failed — snapshot ${ref.snapshotId} marked failed.\n${String(err)}`
  }
}
