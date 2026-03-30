import { z } from "zod"
import type { LspClient } from "../lsp/index.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"

/** All runtime dependencies needed to serve MCP tool calls. */
export interface BackendDeps {
  getClient: () => Promise<LspClient>
  tracker: IndexTracker
  backend: UnifiedBackend
}

/**
 * ToolDef — contract for a single MCP tool registration.
 * Shared between src/tools/ and src/intelligence/tools/ to avoid
 * cross-boundary imports.
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema: z.ZodTypeAny
  execute: (args: any, client: LspClient, tracker: IndexTracker) => Promise<string>
}
