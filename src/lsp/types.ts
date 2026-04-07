/**
 * types.ts — Language-agnostic LSP client interface.
 *
 * `ILanguageClient` is the contract every language server adapter must
 * satisfy. It abstracts the concrete `LspClient` so that consumers
 * (tools, backend, intelligence) can be wired against any LSP-compliant
 * server (clangd, rust-analyzer, pyright, gopls, etc.) without coupling
 * to a single implementation.
 *
 * Adding a new language server:
 *   1. Create a class that implements `ILanguageClient`
 *   2. Wire it through a factory in `src/core/lifecycle.ts`
 *   3. Configure spawn args via `WorkspaceConfig.server` / `args`
 */

import type { IndexTracker } from "../tracking/index.js"

export interface ILanguageClient {
  /** Absolute path to the workspace root */
  readonly root: string
  /** Shared index readiness tracker (background indexing progress) */
  readonly indexTracker: IndexTracker

  // ── File management ─────────────────────────────────────────────────────
  /** Open a file in the language server. Returns true if this was the first open. */
  openFile(filePath: string, text: string): Promise<boolean>
  /** Get diagnostics for a single file or all opened files. */
  getDiagnostics(filePath?: string): Map<string, any[]> | any[]

  // ── Standard LSP requests ───────────────────────────────────────────────
  hover(filePath: string, line: number, character: number): Promise<any>
  definition(filePath: string, line: number, character: number): Promise<any[]>
  declaration(filePath: string, line: number, character: number): Promise<any[]>
  typeDefinition(filePath: string, line: number, character: number): Promise<any[]>
  references(filePath: string, line: number, character: number): Promise<any[]>
  implementation(filePath: string, line: number, character: number): Promise<any[]>
  documentHighlight(filePath: string, line: number, character: number): Promise<any[]>
  documentSymbol(filePath: string): Promise<any[]>
  workspaceSymbol(query: string): Promise<any[]>
  foldingRange(filePath: string): Promise<any[]>
  signatureHelp(filePath: string, line: number, character: number): Promise<any>
  prepareRename(filePath: string, line: number, character: number): Promise<any>
  rename(filePath: string, line: number, character: number, newName: string): Promise<any>
  formatting(filePath: string): Promise<any[]>
  rangeFormatting(
    filePath: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ): Promise<any[]>
  inlayHints(filePath: string, startLine: number, endLine: number): Promise<any[]>
  prepareCallHierarchy(filePath: string, line: number, character: number): Promise<any[]>
  incomingCalls(filePath: string, line: number, character: number): Promise<any[]>
  outgoingCalls(filePath: string, line: number, character: number): Promise<any[]>
  prepareTypeHierarchy(filePath: string, line: number, character: number): Promise<any[]>
  supertypes(filePath: string, line: number, character: number): Promise<any[]>
  subtypes(filePath: string, line: number, character: number): Promise<any[]>
  codeAction(filePath: string, line: number, character: number): Promise<any[]>
  semanticTokensFull(filePath: string): Promise<any>

  // ── Optional server-specific extensions ─────────────────────────────────
  /**
   * Server-specific status info (e.g. clangd's `$/clangd/info`).
   * Returns null if the underlying server does not implement this extension.
   * Adapters should override this when they have a meaningful response.
   */
  serverInfo(): Promise<any>

  // ── Lifecycle ───────────────────────────────────────────────────────────
  shutdown(): Promise<void>
}
