/**
 * snapshot-tool.ts
 * Standalone snapshot lifecycle tool — begin/check/commit/fail via IDbFoundation.
 * Registered into TOOLS array from intelligence/tools/index.ts.
 */
import { z } from "zod"
import type { IDbFoundation } from "../contracts/db-foundation.js"

let DB_FOUNDATION: IDbFoundation | null = null

export function setDbFoundation(db: IDbFoundation): void {
  DB_FOUNDATION = db
}

export const snapshotInputSchema = z.object({
  action: z.enum(["begin", "check", "commit", "fail"]).describe(
    "Snapshot lifecycle action: " +
    "begin=create new snapshot, " +
    "check=find latest ready snapshot for workspaceRoot, " +
    "commit=mark snapshot ready, " +
    "fail=mark snapshot failed",
  ),
  workspaceRoot: z.string().optional().describe("Workspace root path (required for begin and check)"),
  compileDbHash: z.string().optional().describe("Hash of compile_commands.json (required for begin)"),
  parserVersion: z.string().optional().describe("Parser version string (required for begin)"),
  snapshotId: z.number().int().positive().optional().describe("Snapshot ID (required for commit/fail)"),
  failReason: z.string().optional().describe("Failure reason (required for fail)"),
})

export async function executeSnapshotTool(args: z.infer<typeof snapshotInputSchema>): Promise<string> {
  if (!DB_FOUNDATION) {
    return "intelligence_snapshot: DB foundation not initialized. Set INTELLIGENCE_POSTGRES_URL to enable."
  }

  switch (args.action) {
    case "begin": {
      if (!args.workspaceRoot || !args.compileDbHash) {
        return "intelligence_snapshot begin: workspaceRoot and compileDbHash are required."
      }
      try {
        const ref = await DB_FOUNDATION.beginSnapshot({
          workspaceRoot: args.workspaceRoot,
          compileDbHash: args.compileDbHash,
          parserVersion: args.parserVersion ?? "1.0.0",
        })
        return [
          `Snapshot started:`,
          `  snapshotId:  ${ref.snapshotId}`,
          `  status:      ${ref.status}`,
          `  createdAt:   ${ref.createdAt}`,
        ].join("\n")
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `intelligence_snapshot: DB error during begin — ${msg}`
      }
    }

    case "check": {
      if (!args.workspaceRoot) return "intelligence_snapshot check: workspaceRoot is required."
      try {
        const ref = await DB_FOUNDATION.getLatestReadySnapshot(args.workspaceRoot)
        if (!ref) {
          return `No ready snapshot found for workspaceRoot=${args.workspaceRoot}`
        }
        return `Snapshot ready: snapshotId=${ref.snapshotId} workspaceRoot=${args.workspaceRoot} status=${ref.status}`
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `intelligence_snapshot: DB error during check — ${msg}`
      }
    }

    case "commit": {
      if (!args.snapshotId) return "intelligence_snapshot commit: snapshotId is required."
      await DB_FOUNDATION.commitSnapshot(args.snapshotId)
      return `Snapshot ${args.snapshotId} committed (status: ready).`
    }

    case "fail": {
      if (!args.snapshotId) return "intelligence_snapshot fail: snapshotId is required."
      await DB_FOUNDATION.failSnapshot(args.snapshotId, args.failReason ?? "unknown")
      return `Snapshot ${args.snapshotId} marked failed (reason: ${args.failReason ?? "unknown"}).`
    }
  }
}
