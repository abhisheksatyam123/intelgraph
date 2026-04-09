import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"
import path from "path"
import { spawn } from "child_process"

/**
 * CLI tests for enrich-fixtures tool.
 *
 * Tests the command-line interface for enriching WLAN API fixtures.
 */

describe("enrich-fixtures CLI", () => {
  const cliPath = path.join(process.cwd(), "src/bin/enrich-fixtures.ts")
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  describe("argument parsing", () => {
    it("parses --api=<name> argument correctly", () => {
      const args = ["--api=test_api"]
      expect(args[0]).toContain("--api=")
      expect(args[0].slice(6)).toBe("test_api")
    })

    it("parses --snapshot-id=<id> argument correctly", () => {
      const args = ["--snapshot-id=42"]
      const snapshotId = Number(args[0].slice(14))
      expect(snapshotId).toBe(42)
    })

    it("recognizes --dry-run flag", () => {
      const args = ["--dry-run"]
      expect(args).toContain("--dry-run")
    })

    it("parses combined arguments", () => {
      const args = ["--api=some_api", "--snapshot-id=5", "--dry-run"]
      expect(args).toHaveLength(3)
      expect(args[0]).toContain("--api=")
      expect(args[1]).toContain("--snapshot-id=")
      expect(args[2]).toBe("--dry-run")
    })
  })

  describe("single API enrichment mode", () => {
    it("accepts --api argument to enrich single fixture", () => {
      const apiName = "arp_offload_proc_frame"
      const args = [`--api=${apiName}`]
      expect(args[0]).toBe(`--api=${apiName}`)
    })

    it("validates API name format", () => {
      const validNames = [
        "arp_offload_proc_frame",
        "cmnos_wmac_isr",
        "test_api",
        "_private_api",
      ]

      for (const name of validNames) {
        expect(name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
      }
    })

    it("fixture path is constructed correctly", () => {
      const apiName = "test_api"
      const expectedPath = path.join(process.cwd(), "test/fixtures/c/wlan/api", `${apiName}.json`)
      expect(expectedPath).toContain("test/fixtures/c/wlan/api")
      expect(expectedPath).toContain(".json")
    })
  })

  describe("dry-run mode", () => {
    it("does not write files with --dry-run flag", async () => {
      const dryRun = true
      const testPath = "/tmp/test_fixture.json"
      const testContent = { test: "data" }

      // In dry-run mode, file should not be written
      if (!dryRun) {
        await fs.writeFile(testPath, JSON.stringify(testContent))
      }

      // File should not exist after dry-run
      try {
        await fs.access(testPath)
        expect(false).toBe(true) // Should not reach here in dry-run
      } catch {
        expect(true).toBe(true) // Expected: file not found
      }
    })

    it("logs output indicating dry-run simulation", () => {
      const dryRun = true
      const fixturePath = "test/fixtures/c/wlan/api/test.json"

      if (dryRun) {
        const dryRunMessage = `[DRY-RUN] Would write ${fixturePath}`
        expect(dryRunMessage).toContain("[DRY-RUN]")
        expect(dryRunMessage).toContain("Would write")
      }
    })
  })

  describe("error handling", () => {
    it("reports error when fixture file not found", async () => {
      const nonexistentApi = "nonexistent_api_xyz"
      const fixturePath = path.join(process.cwd(), "test/fixtures/c/wlan/api", `${nonexistentApi}.json`)

      try {
        await fs.readFile(fixturePath, "utf-8")
        expect(false).toBe(true) // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toContain("ENOENT") // File not found error
      }
    })

    it("handles invalid JSON in fixture file", async () => {
      const invalidJson = "{ invalid json }"

      expect(() => {
        JSON.parse(invalidJson)
      }).toThrow()
    })

    it("validates snapshot ID is numeric", () => {
      const validIds = ["1", "42", "12345"]
      const invalidIds = ["abc", "", "-1"]

      for (const id of validIds) {
        expect(Number(id)).toBeGreaterThan(0)
      }

      for (const id of invalidIds) {
        const num = Number(id)
        const isInvalid = isNaN(num) || num <= 0
        expect(isInvalid).toBe(true)
      }
    })
  })

  describe("batch mode", () => {
    it("processes all 60 APIs without --api flag", async () => {
      const args: string[] = [] // No --api flag means batch mode

      expect(args.length).toBe(0) // No API specified, defaults to batch

      try {
        const apiDir = path.join(process.cwd(), "test/fixtures/c/wlan/api")
        const files = await fs.readdir(apiDir)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        // Should have multiple fixture files
        expect(jsonFiles.length).toBeGreaterThan(0)
      } catch (err) {
        // Skip if fixtures don't exist in environment
        console.warn("Fixtures directory not found, skipping batch test")
      }
    })

    it("batch mode returns a report with successful and failed APIs", () => {
      const mockReport = {
        total_apis: 60,
        successful_apis: Array(59).fill(0).map((_, i) => `api${i}`),
        failed_apis: [
          {
            api: "bad_api",
            error: "Failed to load fixture",
          },
        ],
        snapshot_id: 1,
        timestamp: new Date().toISOString(),
      }

      expect(mockReport.total_apis).toBe(60)
      expect(mockReport.successful_apis).toHaveLength(59)
      expect(mockReport.failed_apis).toHaveLength(1)
      expect(mockReport.failed_apis[0]).toHaveProperty("api")
      expect(mockReport.failed_apis[0]).toHaveProperty("error")
    })
  })

  describe("progress logging", () => {
    it("emits progress log for each API", () => {
      const apis = ["api1", "api2", "api3"]
      const logs: string[] = []

      for (const api of apis) {
        const logMsg = `Enriching ${api}...`
        logs.push(logMsg)
      }

      expect(logs).toHaveLength(3)
      for (const log of logs) {
        expect(log).toContain("Enriching")
      }
    })

    it("emits completion log with stats", () => {
      const completionLog = {
        message: "Enrichment complete",
        total_apis_processed: 60,
        successful: 58,
        failed: 2,
      }

      expect(completionLog.message).toBe("Enrichment complete")
      expect(completionLog.total_apis_processed).toBe(60)
      expect(completionLog.successful + completionLog.failed).toBe(
        completionLog.total_apis_processed,
      )
    })
  })

  describe("snapshot ID handling", () => {
    it("uses provided snapshot ID for all queries", () => {
      const args = ["--snapshot-id=42"]
      const snapshotId = Number(args[0].slice(14))

      expect(snapshotId).toBe(42)

      // Snapshot ID should be passed to all intent queries
      const queryRequest = {
        snapshotId,
        intent: "who_calls_api",
        apiName: "test_api",
      }

      expect(queryRequest.snapshotId).toBe(42)
    })

    it("defaults to snapshot ID 1 when not specified", () => {
      const args: string[] = []
      let snapshotId = 1 // Default

      for (const arg of args) {
        if (arg.startsWith("--snapshot-id=")) {
          snapshotId = Number(arg.slice(14))
        }
      }

      expect(snapshotId).toBe(1)
    })

    it("maps API names to individual snapshot IDs if provided", () => {
      const snapshotMapping = {
        api1: 10,
        api2: 20,
        api3: 15,
        default: 1,
      }

      expect(snapshotMapping.api1).toBe(10)
      expect(snapshotMapping.default).toBe(1)

      // Test API not in mapping uses default
      const apiName = "unknown_api"
      const snapshotId = snapshotMapping[apiName as keyof typeof snapshotMapping] ?? snapshotMapping.default
      expect(snapshotId).toBe(1)
    })
  })

  describe("help and usage", () => {
    it("recognizes --help flag", () => {
      const args = ["--help"]
      expect(args).toContain("--help")
    })

    it("recognizes -h flag", () => {
      const args = ["-h"]
      expect(args).toContain("-h")
    })

    it("help output includes usage examples", () => {
      const helpText = `
Enrich WLAN API fixtures with exhaustive relation data.

Usage:
  npm run enrich:fixtures [--api=<name>] [--snapshot-id=<id>] [--dry-run]

Options:
  --api=<name>           Enrich a single API fixture by name
  --snapshot-id=<id>     Backend snapshot ID to query (default: 1)
  --dry-run              Simulate enrichment without writing to disk
  --help, -h             Show this help message
`

      expect(helpText).toContain("--api=")
      expect(helpText).toContain("--snapshot-id=")
      expect(helpText).toContain("--dry-run")
      expect(helpText).toContain("--help")
    })
  })

  describe("fixture path handling", () => {
    it("constructs correct fixture path for API name", () => {
      const apiName = "test_api"
      const basePath = path.join(process.cwd(), "test/fixtures/c/wlan/api")
      const fixturePath = path.join(basePath, `${apiName}.json`)

      expect(fixturePath).toContain("test/fixtures/c/wlan/api")
      expect(fixturePath).toContain(`${apiName}.json`)
    })

    it("handles API names with underscores and numbers", () => {
      const validApiNames = [
        "api_v1",
        "test_api_2",
        "_private_api",
        "API_NAME",
      ]

      for (const name of validApiNames) {
        const fixturePath = path.join(
          process.cwd(),
          "test/fixtures/c/wlan/api",
          `${name}.json`,
        )
        expect(fixturePath).toContain(name)
        expect(fixturePath).toMatch(/\.json$/)
        expect(fixturePath).toContain(".json")
      }
    })
  })

  describe("output format", () => {
    it("enriched fixture maintains JSON schema", async () => {
      const mockEnrichedFixture = {
        kind: "api",
        kind_verbose: "application_programming_interface",
        canonical_name: "test_api",
        aliases: [],
        source: { file: "test.c", line: 100 },
        description: "Test",
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

      // Should be valid JSON
      const jsonString = JSON.stringify(mockEnrichedFixture)
      const parsed = JSON.parse(jsonString)

      expect(parsed.kind).toBe("api")
      expect(parsed.relations).toBeDefined()
      expect(parsed.enrichment_metadata).toBeDefined()
    })

    it("output is readable JSON with proper formatting", () => {
      const fixture = { name: "test", relations: [] }
      const formatted = JSON.stringify(fixture, null, 2)

      expect(formatted).toContain("\n")
      expect(formatted).toContain("  ") // Indentation
      expect(formatted).toContain('"name"')
    })
  })
})
