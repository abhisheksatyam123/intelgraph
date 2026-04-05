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
import { setIntelligenceDeps } from "../tools/index.js"
import { setDbFoundation, setIngestDeps } from "./tools/index.js"
import { getLogger } from "../logging/logger.js"
import type { ClangdEnricher, CParserEnricher } from "./index.js"
import type { LspClient } from "../lsp/index.js"
import { collectIndirectCallers } from "../tools/indirect-callers.js"

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

  if (!neo4jUrl) {
    getLogger().info("intelligence backend: INTELLIGENCE_NEO4J_URL not set — skipping auto-init")
    return false
  }

  const noopEnricher = {
    source: "clangd" as const,
    enrich: async () => ({ attempts: [{ source: "clangd" as const, status: "failed" as const }], persistedRows: 0 }),
  }
  const noopCParser = {
    source: "c_parser" as const,
    enrich: async () => ({ attempts: [{ source: "c_parser" as const, status: "failed" as const }], persistedRows: 0 }),
  }

  const backend = await createBackendWithRetry(
    { neo4jUrl, neo4jUser, neo4jPassword },
    {
      clangdEnricher: enrichers?.clangdEnricher ?? noopEnricher,
      cParserEnricher: enrichers?.cParserEnricher ?? noopCParser,
    },
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

  setIntelligenceDeps(backend.deps)
  setDbFoundation(backend.db)

  // Build an indirect caller resolver closure only when a real LspClient is
  // available — it needs prepareCallHierarchy and references in addition to
  // the three methods declared in LspClientForExtraction.
  const fullLspClient = lspClient as (LspClient | undefined)
  const indirectCallerResolver =
    fullLspClient && typeof (fullLspClient as any).prepareCallHierarchy === "function"
      ? async (sym: { name: string; file?: string; line?: number }) => {
          if (!sym.file || !sym.line) return null
          try {
            return await collectIndirectCallers(fullLspClient as LspClient, {
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

  setIngestDeps({
    db: backend.db,
    extractor: backend.extractor,
    projection: backend.deps.persistence.graphProjection,
    ingestion: backend.ingestion,
    indirectCallerResolver,
  })

  getLogger().info("intelligence backend: initialised", { neo4jUrl })
  return true
}
