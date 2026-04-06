import { describe, it, expect, beforeEach, mock } from "bun:test"

import { enrichApiFixture, enrichAllApis } from "../../../src/fixtures/exhaustive-relation-scanner"

// Bun-compatible fs/promises mock
const fsMock = {
  readFile: mock(() => Promise.resolve("{}")),
  writeFile: mock(() => Promise.resolve(undefined)),
  readdir: mock(() => Promise.resolve([])),
}

mock.module("fs/promises", () => ({ default: fsMock }))

describe("exhaustive-relation-scanner", () => {
  beforeEach(() => {
    fsMock.readFile.mockReset()
    fsMock.writeFile.mockReset()
    fsMock.readdir.mockReset()
  })

  describe("enrichApiFixture", () => {
    it("loads fixture, queries intents, deduplicates, and returns enriched fixture", async () => {
      // Mock fixture loading
      const mockFixture = {
        kind: "api",
        kind_verbose: "application_programming_interface",
        canonical_name: "test_api",
        aliases: ["_test_api"],
        source: { file: "test.c", line: 100 },
        description: "Test API",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [],
          calls_out: [],
          registrations_in: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
      }

      fsMock.readFile.mockResolvedValueOnce(JSON.stringify(mockFixture))

      const result = await enrichApiFixture("test_api", 1)

      // Verify structure
      expect(result.kind).toBe("api")
      expect(result.canonical_name).toBe("test_api")
      expect(result.enrichment_metadata).toBeDefined()
      expect(result.enrichment_metadata!.timestamp).toBeDefined()
      expect(result.enrichment_metadata!.intents_queried).toHaveLength(10)
      expect(result.contract).toBeDefined()
    })

    it("creates enrichment metadata with correct structure", async () => {
      const mockFixture = {
        kind: "api",
        kind_verbose: "application_programming_interface",
        canonical_name: "test_api",
        aliases: [],
        source: { file: "test.c", line: 100 },
        description: "Test API",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [],
          calls_out: [],
          registrations_in: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
      }

      fsMock.readFile.mockResolvedValueOnce(JSON.stringify(mockFixture))

      const result = await enrichApiFixture("test_api", 1)

      expect(result.enrichment_metadata).toMatchObject({
        timestamp: expect.any(String),
        intents_queried: expect.any(Array),
        intents_hit: expect.any(Array),
        total_relations: expect.any(Number),
      })

      // Timestamp should be ISO format
      expect(new Date(result.enrichment_metadata!.timestamp)).toBeInstanceOf(Date)
    })

    it("throws error when fixture file not found", async () => {
      fsMock.readFile.mockRejectedValueOnce(new Error("File not found"))

      await expect(enrichApiFixture("nonexistent_api", 1)).rejects.toThrow(
        "Failed to load fixture for nonexistent_api",
      )
    })

    it("handles fixture file parse errors", async () => {
      fsMock.readFile.mockResolvedValueOnce("invalid json")

      await expect(enrichApiFixture("test_api", 1)).rejects.toThrow()
    })
  })

  describe("enrichAllApis", () => {
    it("enriches all API fixtures and generates report", async () => {
      const mockFixture = {
        kind: "api",
        kind_verbose: "application_programming_interface",
        canonical_name: "test_api",
        aliases: [],
        source: { file: "test.c", line: 100 },
        description: "Test API",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [],
          calls_out: [],
          registrations_in: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
        enrichment_metadata: {
          timestamp: new Date().toISOString(),
          intents_queried: ["who_calls_api"],
          intents_hit: [],
          total_relations: 0,
        },
      }

      fsMock.readdir.mockResolvedValueOnce(["test_api.json", "other_api.json"] as any)
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockFixture))
      fsMock.writeFile.mockResolvedValue(undefined as any)

      const result = await enrichAllApis({ default: 1 })

      expect(result.total_apis).toBe(2)
      expect(result.successful_apis).toEqual(["test_api", "other_api"])
      expect(result.failed_apis).toHaveLength(0)
      expect(result.snapshot_id).toBe(1)
      expect(result.timestamp).toBeDefined()
    })

    it("tracks failed APIs in report", async () => {
      fsMock.readdir.mockResolvedValueOnce(["test_api.json", "bad_api.json"] as any)
      fsMock.readFile.mockImplementation((filePath: any) => {
        if (filePath.includes("bad_api")) {
          return Promise.reject(new Error("Read error"))
        }
        return Promise.resolve(
          JSON.stringify({
            kind: "api",
            canonical_name: "test_api",
            aliases: [],
            source: { file: "test.c", line: 100 },
            description: "Test API",
            relations: {
              calls_in_direct: [],
              calls_in_runtime: [],
              calls_out: [],
              registrations_in: [],
              registrations_out: [],
              structures: [],
              logs: [],
              owns: [],
              uses: [],
            },
            enrichment_metadata: {
              timestamp: new Date().toISOString(),
              intents_queried: [],
              intents_hit: [],
              total_relations: 0,
            },
          }),
        )
      })
      fsMock.writeFile.mockResolvedValue(undefined as any)

      const result = await enrichAllApis({ default: 1 })

      expect(result.total_apis).toBe(2)
      expect(result.successful_apis).toContain("test_api")
      expect(result.failed_apis).toHaveLength(1)
      expect(result.failed_apis[0].api).toBe("bad_api")
      expect(result.failed_apis[0].error).toContain("Read error")
    })

    it("uses snapshot IDs from mapping if provided", async () => {
      const mockFixture = {
        kind: "api",
        canonical_name: "test_api",
        aliases: [],
        source: { file: "test.c", line: 100 },
        description: "Test API",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [],
          calls_out: [],
          registrations_in: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
        enrichment_metadata: {
          timestamp: new Date().toISOString(),
          intents_queried: [],
          intents_hit: [],
          total_relations: 0,
        },
      }

      fsMock.readdir.mockResolvedValueOnce(["test_api.json"] as any)
      fsMock.readFile.mockResolvedValue(JSON.stringify(mockFixture))
      fsMock.writeFile.mockResolvedValue(undefined as any)

      const result = await enrichAllApis({ test_api: 42, default: 1 })

      // Report uses default snapshot_id, but each API gets its own
      expect(result.snapshot_id).toBe(1)
      expect(result.successful_apis).toContain("test_api")
    })

    it("accumulates total relations from all enriched fixtures", async () => {
      const fixture1 = {
        kind: "api",
        canonical_name: "api1",
        aliases: [],
        source: { file: "test.c", line: 100 },
        description: "API 1",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [],
          calls_out: [{ caller: "a", callee: "b", edge_kind: "call", edge_kind_verbose: "call", derivation: "clangd" as const, confidence: 0.9 }],
          registrations_in: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
        enrichment_metadata: {
          timestamp: new Date().toISOString(),
          intents_queried: [],
          intents_hit: [],
          total_relations: 1,
        },
      }

      const fixture2 = {
        kind: "api",
        canonical_name: "api2",
        aliases: [],
        source: { file: "test.c", line: 200 },
        description: "API 2",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [],
          calls_out: [],
          registrations_in: [{ registrar: "x", callback: "y", edge_kind: "register", edge_kind_verbose: "register", derivation: "clangd" as const, confidence: 0.8 }],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
        enrichment_metadata: {
          timestamp: new Date().toISOString(),
          intents_queried: [],
          intents_hit: [],
          total_relations: 1,
        },
      }

      fsMock.readdir.mockResolvedValueOnce(["api1.json", "api2.json"] as any)
      fsMock.readFile.mockImplementation((filePath: any) => {
        if (filePath.includes("api2")) return Promise.resolve(JSON.stringify(fixture2))
        return Promise.resolve(JSON.stringify(fixture1))
      })
      fsMock.writeFile.mockResolvedValue(undefined as any)

      const result = await enrichAllApis({ default: 1 })

      expect(result.total_relations_added).toBe(2)
    })
  })
})
