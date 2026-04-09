/**
 * intelligence/tools/index.ts
 * Self-contained registration barrel for all intelligence-bounded-context tools.
 * Exports individual schemas/executors and the INTELLIGENCE_TOOLS ToolDef array.
 */
export { ingestInputSchema, executeIngestTool, setIngestDeps } from "./ingest-tool.js"
export { snapshotInputSchema, executeSnapshotTool, setDbFoundation } from "./snapshot-tool.js"
export { extractFileInputSchema, executeExtractFileTool, setExtractFileDeps } from "./extract-file-tool.js"

import type { ToolDef } from "../../core/types.js"
import { ingestInputSchema, executeIngestTool } from "./ingest-tool.js"
import { snapshotInputSchema, executeSnapshotTool } from "./snapshot-tool.js"
import { extractFileInputSchema, executeExtractFileTool } from "./extract-file-tool.js"

export const INTELLIGENCE_TOOLS: ToolDef[] = [
  {
    name: "intelligence_ingest",
    description:
      "Trigger full extraction + ingest pipeline for a workspace root. " +
      "Extracts symbols, types, and call edges via clangd, persists to SQLite storage, " +
      "commits the snapshot, and optionally syncs the projection. " +
      "Returns snapshotId, inserted counts, and any warnings.",
    inputSchema: ingestInputSchema,
    execute: async (args, _client, _tracker) => executeIngestTool(args),
  },
  {
    name: "intelligence_snapshot",
    description:
      "Manage intelligence snapshot lifecycle. " +
      "Use action=begin to create a new snapshot (returns snapshotId). " +
      "Use action=commit to mark a snapshot ready after ingestion. " +
      "Use action=fail to mark a snapshot failed with a reason.",
    inputSchema: snapshotInputSchema,
    execute: async (args, _client, _tracker) => executeSnapshotTool(args),
  },
  {
    name: "intelligence_extract_file",
    description:
      "Incrementally re-extract a single file. Call on file save to keep " +
      "the intelligence graph current without full rebuilds. Purges stale " +
      "nodes/edges for the file, re-parses with tree-sitter, and inserts " +
      "updated facts. Typically ~100-200ms per file.",
    inputSchema: extractFileInputSchema,
    execute: async (args, _client, _tracker) => executeExtractFileTool(args),
  },
]
