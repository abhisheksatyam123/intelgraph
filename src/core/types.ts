import { z } from "zod"
import type { ILanguageClient } from "../lsp/types.js"
import type { IndexTracker } from "../tracking/index.js"
import type { UnifiedBackend } from "../backend/unified-backend.js"

/** All runtime dependencies needed to serve MCP tool calls. */
export interface BackendDeps {
  getClient: () => Promise<ILanguageClient>
  tracker: IndexTracker
  backend: UnifiedBackend
}

/**
 * ToolDef — contract for a single MCP tool registration.
 * Shared between src/tools/ and src/intelligence/tools/ to avoid
 * cross-boundary imports.
 *
 * Tools receive an `ILanguageClient` so they remain decoupled from any
 * specific LSP server implementation (clangd, rust-analyzer, pyright, ...).
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema: z.ZodTypeAny
  execute: (args: any, client: ILanguageClient, tracker: IndexTracker) => Promise<string>
}
