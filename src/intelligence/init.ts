/**
 * intelligence/init.ts
 * Reads INTELLIGENCE_POSTGRES_URL + INTELLIGENCE_NEO4J_URL from env
 * and auto-initialises the intelligence backend at startup.
 *
 * Call initIntelligenceBackend() once during server startup.
 * Returns true if backend was initialised, false if env vars are missing.
 */
import { createIntelligenceBackend } from "./backend-factory.js"
import { setIntelligenceDeps } from "../tools/index.js"
import { setDbFoundation, setIngestDeps } from "./tools/index.js"
import { ClangdExtractionAdapter } from "./db/extraction/clangd-extraction-adapter.js"
import { getLogger } from "../logging/logger.js"
import type { ClangdEnricher, CParserEnricher } from "./index.js"
import type { ClangdLspClient } from "./db/extraction/clangd-extraction-adapter.js"

export async function initIntelligenceBackend(
  enrichers?: {
    clangdEnricher?: ClangdEnricher
    cParserEnricher?: CParserEnricher
    lspClient?: ClangdLspClient
  },
): Promise<boolean> {
  const pgUrl = process.env.INTELLIGENCE_POSTGRES_URL
  const neo4jUrl = process.env.INTELLIGENCE_NEO4J_URL
  const neo4jUser = process.env.INTELLIGENCE_NEO4J_USER ?? "neo4j"
  const neo4jPassword = process.env.INTELLIGENCE_NEO4J_PASSWORD ?? "neo4j"

  if (!pgUrl || !neo4jUrl) {
    getLogger().info("intelligence backend: INTELLIGENCE_POSTGRES_URL or INTELLIGENCE_NEO4J_URL not set — skipping auto-init")
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

  const backend = await createIntelligenceBackend(
    { postgresUrl: pgUrl, neo4jUrl, neo4jUser, neo4jPassword },
    {
      clangdEnricher: enrichers?.clangdEnricher ?? noopEnricher,
      cParserEnricher: enrichers?.cParserEnricher ?? noopCParser,
    },
  )

  await backend.db.runMigrations()

  setIntelligenceDeps(backend.deps)
  setDbFoundation(backend.db)

  // Wire ingest tool deps — extractor uses lspClient if provided
  const extractor = new ClangdExtractionAdapter(
    enrichers?.lspClient ?? {
      documentSymbol: async () => [],
      incomingCalls: async () => [],
      outgoingCalls: async () => [],
    },
    backend.deps.persistence.authoritativeStore as never,
  )
  setIngestDeps({
    db: backend.db,
    extractor,
    projection: backend.deps.persistence.graphProjection,
  })

  getLogger().info("intelligence backend: initialised", { pgUrl, neo4jUrl })
  return true
}
