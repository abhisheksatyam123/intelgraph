/**
 * intelligence/init.ts
 * Initialises the intelligence backend at startup using the embedded
 * SQLite store. Reads INTELLIGENCE_DB_PATH from env (default
 * .clangd-mcp/intelligence.db). No external service required.
 *
 * Call initIntelligenceBackend() once during server startup. Returns
 * true after the backend is wired into the dep singletons.
 */
import { createIntelligenceBackend } from "./backend-factory.js"
import type { LspClientForExtraction, IntelligenceBackend } from "./backend-types.js"
import { setIntelligenceDeps } from "../tools/index.js"
import { setDbFoundation, setIngestDeps } from "./tools/index.js"
import { getLogger } from "../logging/logger.js"
import type { ClangdEnricher, CParserEnricher } from "./index.js"
import type { ILanguageClient } from "../lsp/types.js"
import { collectIndirectCallers } from "../tools/indirect-callers.js"
import { BUILT_IN_EXTRACTORS } from "../plugins/index.js"
import { join } from "node:path"

// ── Module-level backend storage for graceful shutdown ──────────────────────
let _backend: { close: () => Promise<void> } | null = null

/**
 * Gracefully shut down the intelligence backend.
 * Called when the HTTP daemon is idle or receives a termination signal.
 * Closes the SQLite database file (flushes WAL, releases locks).
 */
export async function shutdownIntelligenceBackend(): Promise<void> {
  if (!_backend) return
  const b = _backend
  _backend = null
  await b.close()
}

export async function initIntelligenceBackend(
  enrichers?: {
    clangdEnricher?: ClangdEnricher
    cParserEnricher?: CParserEnricher
  },
  lspClient?: LspClientForExtraction,
): Promise<boolean> {
  const sqliteDbPath =
    process.env.INTELLIGENCE_DB_PATH ?? join(".clangd-mcp", "intelligence.db")

  const noopEnricher = {
    source: "clangd" as const,
    enrich: async () => ({
      attempts: [{ source: "clangd" as const, status: "failed" as const }],
      persistedRows: 0,
    }),
  }
  const noopCParser = {
    source: "c_parser" as const,
    enrich: async () => ({
      attempts: [{ source: "c_parser" as const, status: "failed" as const }],
      persistedRows: 0,
    }),
  }
  const resolvedEnrichers = {
    clangdEnricher: enrichers?.clangdEnricher ?? noopEnricher,
    cParserEnricher: enrichers?.cParserEnricher ?? noopCParser,
  }

  getLogger().info("intelligence backend: initialising embedded SQLite store", {
    dbPath: sqliteDbPath,
  })

  const backend: IntelligenceBackend = await createIntelligenceBackend(
    { dbPath: sqliteDbPath },
    resolvedEnrichers,
    lspClient,
  )
  // initSchema runs inside createIntelligenceBackend; runMigrations is a
  // no-op alias today, called for forward compatibility.
  await backend.db.runMigrations()

  // Store backend for graceful shutdown on daemon idle/exit
  _backend = backend

  setIntelligenceDeps(backend.deps)
  setDbFoundation(backend.db)

  // Build an indirect caller resolver closure only when a real language
  // client is available — it needs prepareCallHierarchy and references in
  // addition to the three methods declared in LspClientForExtraction.
  const fullLspClient = lspClient as ILanguageClient | undefined
  const indirectCallerResolver =
    fullLspClient && typeof (fullLspClient as { prepareCallHierarchy?: unknown }).prepareCallHierarchy === "function"
      ? async (sym: { name: string; file?: string; line?: number }) => {
          if (!sym.file || !sym.line) return null
          try {
            return await collectIndirectCallers(fullLspClient, {
              file: sym.file,
              line: sym.line,
              character: 1,
              resolve: true,
            })
          } catch {
            return null
          }
        }
      : undefined

  // The runner needs a full ILanguageClient. If the caller passed a narrow
  // LspClientForExtraction (no openFile/prepareCallHierarchy/etc.), wrap
  // it with no-op stubs so the LspService doesn't crash on first use. In
  // production the caller passes the real LspClient and this shim is unused.
  const lspForRunner: ILanguageClient =
    fullLspClient ??
    (lspClient as unknown as ILanguageClient | undefined) ??
    ({
      root: "",
      indexTracker: {} as never,
      openFile: async () => false,
      getDiagnostics: () => new Map<string, unknown[]>(),
      hover: async () => null,
      definition: async () => [],
      declaration: async () => [],
      typeDefinition: async () => [],
      references: async () => [],
      implementation: async () => [],
      documentHighlight: async () => [],
      documentSymbol: async () => [],
      workspaceSymbol: async () => [],
      foldingRange: async () => [],
      signatureHelp: async () => null,
      prepareRename: async () => null,
      rename: async () => null,
      formatting: async () => [],
      rangeFormatting: async () => [],
      inlayHints: async () => [],
      prepareCallHierarchy: async () => [],
      incomingCalls: async () => [],
      outgoingCalls: async () => [],
      prepareTypeHierarchy: async () => [],
      supertypes: async () => [],
      subtypes: async () => [],
      codeAction: async () => [],
      semanticTokensFull: async () => null,
      serverInfo: async () => null,
      shutdown: async () => {},
    } as unknown as ILanguageClient)

  setIngestDeps({
    db: backend.db,
    lsp: lspForRunner,
    sink: backend.sink,
    plugins: BUILT_IN_EXTRACTORS,
    projection: backend.deps.persistence.graphProjection,
    ingestion: backend.ingestion,
    indirectCallerResolver,
  })

  getLogger().info("intelligence backend: initialised", { dbPath: sqliteDbPath })
  return true
}
