/**
 * intelligence/init.ts
 * Reads INTELLIGENCE_NEO4J_URL from env
 * and auto-initialises the intelligence backend at startup.
 *
 * Call initIntelligenceBackend() once during server startup.
 * Returns true if backend was initialised, false if required env var is missing.
 */
import { createIntelligenceBackend } from "./backend-factory.js"
import type { LspClientForExtraction } from "./backend-factory.js"
import { createSqliteIntelligenceBackend } from "./sqlite-backend-factory.js"
import type { IntelligenceBackend } from "./backend-factory.js"
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
 * Gracefully shut down the Neo4j intelligence backend.
 * Called when the HTTP daemon is idle or receives a termination signal.
 */
export async function shutdownIntelligenceBackend(): Promise<void> {
  if (!_backend) return
  const b = _backend
  _backend = null
  await b.close()
}

function shouldRetryNeo4jInit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /ECONNREFUSED|Failed to connect to server|Connection refused|Connection was closed by server/i.test(msg)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function createBackendWithRetry(
  neo4j: { neo4jUrl: string; neo4jUser: string; neo4jPassword: string },
  enrichers: Pick<Parameters<typeof createIntelligenceBackend>[1], "clangdEnricher" | "cParserEnricher" | "llmEnricher">,
  lspClient?: LspClientForExtraction,
) {
  const maxAttempts = 20
  let lastErr: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await createIntelligenceBackend(neo4j, enrichers, lspClient)
    } catch (err) {
      lastErr = err
      if (!shouldRetryNeo4jInit(err) || attempt === maxAttempts) {
        throw err
      }
      const delayMs = Math.min(1000 * attempt, 5000)
      getLogger().warn("intelligence backend: Neo4j not ready yet, retrying", { attempt, maxAttempts, delayMs })
      await sleep(delayMs)
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "Neo4j init failed"))
}

export async function initIntelligenceBackend(
  enrichers?: {
    clangdEnricher?: ClangdEnricher
    cParserEnricher?: CParserEnricher
  },
  lspClient?: LspClientForExtraction,
): Promise<boolean> {
  const neo4jUrl = process.env.INTELLIGENCE_NEO4J_URL
  const neo4jUser = process.env.INTELLIGENCE_NEO4J_USER ?? "neo4j"
  const neo4jPassword = process.env.INTELLIGENCE_NEO4J_PASSWORD ?? "neo4j1234"
  const sqliteDbPath =
    process.env.INTELLIGENCE_DB_PATH ?? join(".clangd-mcp", "intelligence.db")

  const noopEnricher = {
    source: "clangd" as const,
    enrich: async () => ({ attempts: [{ source: "clangd" as const, status: "failed" as const }], persistedRows: 0 }),
  }
  const noopCParser = {
    source: "c_parser" as const,
    enrich: async () => ({ attempts: [{ source: "c_parser" as const, status: "failed" as const }], persistedRows: 0 }),
  }
  const resolvedEnrichers = {
    clangdEnricher: enrichers?.clangdEnricher ?? noopEnricher,
    cParserEnricher: enrichers?.cParserEnricher ?? noopCParser,
  }

  let backend: IntelligenceBackend
  if (neo4jUrl) {
    getLogger().info("intelligence backend: using Neo4j (INTELLIGENCE_NEO4J_URL set)", {
      neo4jUrl,
    })
    backend = await createBackendWithRetry(
      { neo4jUrl, neo4jUser, neo4jPassword },
      resolvedEnrichers,
      lspClient,
    )
    let migrationsReady = false
    let migrationAttempt = 0
    while (!migrationsReady) {
      migrationAttempt += 1
      try {
        await backend.db.runMigrations()
        migrationsReady = true
      } catch (err) {
        if (!shouldRetryNeo4jInit(err) || migrationAttempt >= 20) throw err
        const delayMs = Math.min(1000 * migrationAttempt, 5000)
        getLogger().warn("intelligence backend: migration retry; Neo4j not ready", {
          attempt: migrationAttempt,
          delayMs,
        })
        await sleep(delayMs)
      }
    }
  } else {
    getLogger().info(
      "intelligence backend: using embedded SQLite (set INTELLIGENCE_NEO4J_URL to override)",
      { dbPath: sqliteDbPath },
    )
    backend = await createSqliteIntelligenceBackend(
      { dbPath: sqliteDbPath },
      resolvedEnrichers,
      lspClient,
    )
    // initSchema already ran inside createSqliteIntelligenceBackend, but
    // call runMigrations for parity with the Neo4j path.
    await backend.db.runMigrations()
  }

  // Store backend for graceful shutdown on daemon idle/exit
  _backend = backend

  setIntelligenceDeps(backend.deps)
  setDbFoundation(backend.db)

  // Build an indirect caller resolver closure only when a real language client is
  // available — it needs prepareCallHierarchy and references in addition to
  // the three methods declared in LspClientForExtraction.
  const fullLspClient = lspClient as (ILanguageClient | undefined)
  const indirectCallerResolver =
    fullLspClient && typeof (fullLspClient as any).prepareCallHierarchy === "function"
      ? async (sym: { name: string; file?: string; line?: number }) => {
          if (!sym.file || !sym.line) return null
          try {
            return await collectIndirectCallers(fullLspClient as ILanguageClient, {
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

  // The runner needs a full ILanguageClient. If the caller passed a
  // narrow LspClientForExtraction (no openFile/prepareCallHierarchy/etc.),
  // wrap it with no-op stubs so the LspService doesn't crash on first
  // use. In production the caller passes the real LspClient and this
  // shim is unused.
  const lspForRunner: ILanguageClient =
    fullLspClient ?? (lspClient as unknown as ILanguageClient | undefined) ?? {
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
    } as unknown as ILanguageClient

  setIngestDeps({
    db: backend.db,
    lsp: lspForRunner,
    sink: backend.sink,
    plugins: BUILT_IN_EXTRACTORS,
    projection: backend.deps.persistence.graphProjection,
    ingestion: backend.ingestion,
    indirectCallerResolver,
  })

  getLogger().info("intelligence backend: initialised", { neo4jUrl })
  return true
}
