import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// We test initIntelligenceBackend by mocking the backend-factory and tools
// ---------------------------------------------------------------------------

vi.mock("../../../src/intelligence/backend-factory.js", () => ({
  createIntelligenceBackend: vi.fn(async () => ({
    deps: {
      persistence: {
        dbLookup: { lookup: vi.fn() },
        authoritativeStore: { persistEnrichment: vi.fn() },
        graphProjection: { syncFromAuthoritative: vi.fn() },
      },
      clangdEnricher: { source: "clangd", enrich: vi.fn() },
      cParserEnricher: { source: "c_parser", enrich: vi.fn() },
    },
    db: {
      initSchema: vi.fn(async () => {}),
      runMigrations: vi.fn(async () => {}),
      beginSnapshot: vi.fn(),
      commitSnapshot: vi.fn(),
      failSnapshot: vi.fn(),
      withTransaction: vi.fn(),
    },
    ingestWriter: {},
    ingestion: {},
    close: vi.fn(async () => {}),
  })),
}))

vi.mock("../../../src/tools/index.js", () => ({
  setIntelligenceDeps: vi.fn(),
  setDbFoundation: vi.fn(),
  setIngestDeps: vi.fn(),
  TOOLS: [],
}))

vi.mock("../../../src/intelligence/tools/index.js", () => ({
  setDbFoundation: vi.fn(),
  setIngestDeps: vi.fn(),
  INTELLIGENCE_TOOLS: [],
}))

vi.mock("../../../src/logging/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { initIntelligenceBackend } from "../../../src/intelligence-init.js"
import { createIntelligenceBackend } from "../../../src/intelligence/backend-factory.js"
import { setIntelligenceDeps } from "../../../src/tools/index.js"
import { setDbFoundation } from "../../../src/intelligence/tools/index.js"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initIntelligenceBackend", () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.INTELLIGENCE_POSTGRES_URL
    delete process.env.INTELLIGENCE_NEO4J_URL
    delete process.env.INTELLIGENCE_NEO4J_USER
    delete process.env.INTELLIGENCE_NEO4J_PASSWORD
  })

  afterEach(() => {
    process.env = { ...origEnv }
  })

  it("returns false when INTELLIGENCE_POSTGRES_URL is not set", async () => {
    const result = await initIntelligenceBackend()
    expect(result).toBe(false)
    expect(createIntelligenceBackend).not.toHaveBeenCalled()
  })

  it("returns false when INTELLIGENCE_NEO4J_URL is not set", async () => {
    process.env.INTELLIGENCE_POSTGRES_URL = "postgres://localhost/test"
    const result = await initIntelligenceBackend()
    expect(result).toBe(false)
    expect(createIntelligenceBackend).not.toHaveBeenCalled()
  })

  it("returns true and calls setIntelligenceDeps when both env vars set", async () => {
    process.env.INTELLIGENCE_POSTGRES_URL = "postgres://localhost/test"
    process.env.INTELLIGENCE_NEO4J_URL = "bolt://localhost:7687"
    const result = await initIntelligenceBackend()
    expect(result).toBe(true)
    expect(createIntelligenceBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        postgresUrl: "postgres://localhost/test",
        neo4jUrl: "bolt://localhost:7687",
      }),
      expect.anything(),
    )
    expect(setIntelligenceDeps).toHaveBeenCalled()
    expect(setDbFoundation).toHaveBeenCalled()
  })

  it("uses default neo4j credentials when not set", async () => {
    process.env.INTELLIGENCE_POSTGRES_URL = "postgres://localhost/test"
    process.env.INTELLIGENCE_NEO4J_URL = "bolt://localhost:7687"
    await initIntelligenceBackend()
    expect(createIntelligenceBackend).toHaveBeenCalledWith(
      expect.objectContaining({ neo4jUser: "neo4j", neo4jPassword: "neo4j" }),
      expect.anything(),
    )
  })

  it("uses custom neo4j credentials when set", async () => {
    process.env.INTELLIGENCE_POSTGRES_URL = "postgres://localhost/test"
    process.env.INTELLIGENCE_NEO4J_URL = "bolt://localhost:7687"
    process.env.INTELLIGENCE_NEO4J_USER = "admin"
    process.env.INTELLIGENCE_NEO4J_PASSWORD = "secret"
    await initIntelligenceBackend()
    expect(createIntelligenceBackend).toHaveBeenCalledWith(
      expect.objectContaining({ neo4jUser: "admin", neo4jPassword: "secret" }),
      expect.anything(),
    )
  })

  it("calls runMigrations on the db foundation after init", async () => {
    process.env.INTELLIGENCE_POSTGRES_URL = "postgres://localhost/test"
    process.env.INTELLIGENCE_NEO4J_URL = "bolt://localhost:7687"
    await initIntelligenceBackend()
    const backend = await (createIntelligenceBackend as ReturnType<typeof vi.fn>).mock.results[0]?.value
    expect(backend.db.runMigrations).toHaveBeenCalled()
  })

  it("accepts custom enrichers and passes them to backend factory", async () => {
    process.env.INTELLIGENCE_POSTGRES_URL = "postgres://localhost/test"
    process.env.INTELLIGENCE_NEO4J_URL = "bolt://localhost:7687"
    const clangdEnricher = { source: "clangd" as const, enrich: vi.fn() }
    await initIntelligenceBackend({ clangdEnricher })
    expect(createIntelligenceBackend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clangdEnricher }),
    )
  })
})
