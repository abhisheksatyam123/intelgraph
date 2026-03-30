/**
 * intelligence/tools/index.ts
 * Self-contained registration barrel for all intelligence-bounded-context tools.
 * Exports individual schemas/executors and the INTELLIGENCE_TOOLS ToolDef array.
 */
export { ingestInputSchema, executeIngestTool, setIngestDeps } from "./ingest-tool.js"
export { snapshotInputSchema, executeSnapshotTool, setDbFoundation } from "./snapshot-tool.js"

import type { ToolDef } from "../../core/types.js"
import { ingestInputSchema, executeIngestTool } from "./ingest-tool.js"
import { snapshotInputSchema, executeSnapshotTool } from "./snapshot-tool.js"

export const INTELLIGENCE_TOOLS: ToolDef[] = [
  {
    name: "intelligence_ingest",
    description:
      "Trigger full extraction + ingest pipeline for a workspace root. " +
      "Extracts symbols, types, and call edges via clangd, persists to Postgres, " +
      "commits the snapshot, and optionally syncs the Neo4j projection. " +
      "Returns snapshotId, inserted counts, and any warnings. " +
      "Requires INTELLIGENCE_POSTGRES_URL to be set.",
    inputSchema: ingestInputSchema,
    execute: async (args, _client, _tracker) => executeIngestTool(args),
  },
  {
    name: "intelligence_snapshot",
    description:
      "Manage intelligence snapshot lifecycle. " +
      "Use action=begin to create a new snapshot (returns snapshotId). " +
      "Use action=commit to mark a snapshot ready after ingestion. " +
      "Use action=fail to mark a snapshot failed with a reason. " +
      "Requires INTELLIGENCE_POSTGRES_URL to be set.",
    inputSchema: snapshotInputSchema,
    execute: async (args, _client, _tracker) => executeSnapshotTool(args),
  },
]
