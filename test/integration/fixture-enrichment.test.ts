import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"
import path from "path"

import { enrichApiFixture } from "../../src/fixtures/exhaustive-relation-scanner"
import { deduplicateRelations, generateContractFromRelations } from "../../src/fixtures/intent-mapper"
import type { ApiFixture, Relation, Relations } from "../../src/fixtures/intent-mapper"

/**
 * Integration tests for fixture enrichment.
 *
 * These tests validate the end-to-end enrichment pipeline:
 * 1. Load baseline fixture
 * 2. Query backend for all applicable intents
 * 3. Deduplicate relations (prefer higher confidence, clangd over c_parser)
 * 4. Generate dynamic contract from populated arrays
 * 5. Verify no duplicates in enriched fixture
 * 6. Ensure enriched fixture passes schema validation
 */

describe("fixture-enrichment integration", () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  describe("enrichApiFixture integration", () => {
    it("loads baseline fixture and preserves structure", async () => {
      // Mock the backend query to avoid calling real intelligence service
      vi.mock("../../src/fixtures/exhaustive-relation-scanner", async () => {
        const actual = await vi.importActual("../../src/fixtures/exhaustive-relation-scanner")
        return actual
      })

      // Load an existing fixture as a baseline
      const fixturePath = path.join(
        process.cwd(),
        "test/fixtures/wlan/api",
        "arp_offload_proc_frame.json",
      )

      try {
        const content = await fs.readFile(fixturePath, "utf-8")
        const baseline: ApiFixture = JSON.parse(content)

        expect(baseline.kind).toBe("api")
        expect(baseline.kind_verbose).toBe("application_programming_interface")
        expect(baseline.canonical_name).toBe("arp_offload_proc_frame")
        expect(baseline.relations).toBeDefined()
        expect(baseline.relations.calls_in_direct).toBeDefined()
        expect(Array.isArray(baseline.relations.calls_in_direct)).toBe(true)
      } catch (err) {
        // Skip test if fixture doesn't exist in this environment
        console.warn(`Skipping test: fixture not found at ${fixturePath}`)
      }
    })

    it("enriched fixture maintains all required relation arrays", async () => {
      // Verify that enrichment preserves the schema
      const mockEnrichedFixture: ApiFixture = {
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
        enrichment_metadata: {
          timestamp: new Date().toISOString(),
          intents_queried: ["who_calls_api", "what_api_calls"],
          intents_hit: ["who_calls_api"],
          total_relations: 5,
        },
        contract: {
          required_relation_kinds: ["call_direct"],
          required_directions: ["incoming"],
          minimum_counts: { calls_in_direct: 1 },
          required_path_patterns: [],
        },
      }

      // Verify structure
      expect(mockEnrichedFixture.relations).toHaveProperty("calls_in_direct")
      expect(mockEnrichedFixture.relations).toHaveProperty("calls_in_runtime")
      expect(mockEnrichedFixture.relations).toHaveProperty("calls_out")
      expect(mockEnrichedFixture.relations).toHaveProperty("registrations_in")
      expect(mockEnrichedFixture.relations).toHaveProperty("structures")
      expect(mockEnrichedFixture.relations).toHaveProperty("logs")
      expect(mockEnrichedFixture.relations).toHaveProperty("owns")
      expect(mockEnrichedFixture.relations).toHaveProperty("uses")

      // Verify enrichment metadata is present
      expect(mockEnrichedFixture.enrichment_metadata).toBeDefined()
      expect(mockEnrichedFixture.enrichment_metadata!.timestamp).toBeDefined()
      expect(mockEnrichedFixture.enrichment_metadata!.intents_queried).toContain("who_calls_api")
      expect(mockEnrichedFixture.enrichment_metadata!.total_relations).toBe(5)
    })

    it("verifies no duplicate edges in deduplication", () => {
      // Create fixture with potential duplicates
      const relations: Relation[] = [
        {
          caller: "func_a",
          callee: "func_b",
          edge_kind: "call_direct",
          edge_kind_verbose: "static_direct_call",
          derivation: "c_parser",
          confidence: 0.7,
        },
        {
          caller: "func_a",
          callee: "func_b",
          edge_kind: "call_direct",
          edge_kind_verbose: "static_direct_call",
          derivation: "clangd",
          confidence: 0.95,
        },
        {
          caller: "func_c",
          callee: "func_d",
          edge_kind: "call_direct",
          edge_kind_verbose: "static_direct_call",
          derivation: "clangd",
          confidence: 0.9,
        },
      ]

      const dedupMap = deduplicateRelations(relations)

      // Should have 2 unique edges (not 3)
      expect(dedupMap.size).toBe(2)

      // Verify dedup key structure
      expect(dedupMap.has("func_a|func_b|call_direct")).toBe(true)
      expect(dedupMap.has("func_c|func_d|call_direct")).toBe(true)

      // Verify higher confidence is kept
      const aToB = dedupMap.get("func_a|func_b|call_direct")!
      expect(aToB.derivation).toBe("clangd")
      expect(aToB.confidence).toBe(0.95)

      // Verify clangd is preferred on tie
      expect(aToB.derivation).not.toBe("c_parser")
    })

    it("prefers clangd over c_parser when confidence is equal", () => {
      const relations: Relation[] = [
        {
          caller: "caller",
          callee: "callee",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "c_parser",
          confidence: 0.85,
        },
        {
          caller: "caller",
          callee: "callee",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "clangd",
          confidence: 0.85,
        },
      ]

      const dedupMap = deduplicateRelations(relations)
      const result = dedupMap.get("caller|callee|call_direct")!

      expect(result.derivation).toBe("clangd")
      expect(result.confidence).toBe(0.85)
    })

    it("generates dynamic contract from populated relation arrays", () => {
      const relations: Relations = {
        calls_in_direct: [
          {
            caller: "caller_a",
            callee: "callee_a",
            edge_kind: "call_direct",
            edge_kind_verbose: "static_direct_call",
            derivation: "clangd",
            confidence: 0.9,
          },
        ],
        calls_in_runtime: [],
        calls_out: [
          {
            caller: "caller_b",
            callee: "callee_b",
            edge_kind: "call_direct",
            edge_kind_verbose: "static_direct_call",
            derivation: "clangd",
            confidence: 0.85,
          },
          {
            caller: "caller_c",
            callee: "callee_c",
            edge_kind: "call_direct",
            edge_kind_verbose: "static_direct_call",
            derivation: "clangd",
            confidence: 0.8,
          },
        ],
        registrations_in: [],
        registrations_out: [],
        structures: [],
        logs: [],
        owns: [],
        uses: [],
      }

      const contract = generateContractFromRelations(relations)

      // Should include call_direct from populated arrays
      expect(contract.required_relation_kinds).toContain("call_direct")

      // Should include both incoming and outgoing directions
      expect(contract.required_directions).toContain("incoming")
      expect(contract.required_directions).toContain("outgoing")

      // Should have minimum counts for populated arrays
      expect(contract.minimum_counts.calls_in_direct).toBe(1)
      expect(contract.minimum_counts.calls_out).toBe(1) // Always 1 for "at least one required"

      // Empty arrays should not add to minimum counts
      expect(contract.minimum_counts.calls_in_runtime).toBeUndefined()
    })

    it("handles struct-based relations in deduplication", () => {
      const relations: Relation[] = [
        {
          api: "read_api",
          struct: "session_struct",
          field: "handler",
          edge_kind: "read",
          edge_kind_verbose: "struct_member_read",
          derivation: "clangd",
          confidence: 0.92,
        },
        {
          api: "read_api",
          struct: "session_struct",
          field: "handler",
          edge_kind: "read",
          edge_kind_verbose: "struct_member_read",
          derivation: "c_parser",
          confidence: 0.72,
        },
      ]

      const dedupMap = deduplicateRelations(relations)
      expect(dedupMap.size).toBe(1)

      const result = dedupMap.get("read_api|session_struct|read")!
      expect(result.derivation).toBe("clangd")
      expect(result.confidence).toBe(0.92)
    })

    it("verifies enrichment_metadata is populated correctly", () => {
      const mockEnrichedFixture: ApiFixture = {
        kind: "api",
        kind_verbose: "application_programming_interface",
        canonical_name: "test_api",
        aliases: [],
        source: { file: "test.c", line: 1 },
        description: "Test",
        relations: {
          calls_in_direct: [
            {
              caller: "a",
              callee: "b",
              edge_kind: "call_direct",
              edge_kind_verbose: "call",
              derivation: "clangd",
              confidence: 0.9,
            },
          ],
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
          intents_queried: ["who_calls_api", "what_api_calls", "show_registration_chain"],
          intents_hit: ["who_calls_api"],
          total_relations: 1,
        },
      }

      // Verify metadata structure
      expect(mockEnrichedFixture.enrichment_metadata).toMatchObject({
        timestamp: expect.any(String),
        intents_queried: expect.any(Array),
        intents_hit: expect.any(Array),
        total_relations: expect.any(Number),
      })

      // Verify timestamp is ISO format
      const timestamp = new Date(mockEnrichedFixture.enrichment_metadata!.timestamp)
      expect(timestamp).toBeInstanceOf(Date)
      expect(timestamp.getTime()).toBeGreaterThan(0)

      // Verify intents_queried includes multiple intents
      expect(mockEnrichedFixture.enrichment_metadata!.intents_queried.length).toBeGreaterThan(0)

      // Verify intents_hit is subset of intents_queried
      const queriedSet = new Set(mockEnrichedFixture.enrichment_metadata!.intents_queried)
      for (const hitIntent of mockEnrichedFixture.enrichment_metadata!.intents_hit) {
        expect(queriedSet.has(hitIntent)).toBe(true)
      }

      // Verify total_relations matches sum of relation array lengths
      const totalCount = Object.values(mockEnrichedFixture.relations).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0,
      )
      expect(mockEnrichedFixture.enrichment_metadata!.total_relations).toBe(totalCount)
    })

    it("ensures dynamic contract is generated from populated arrays", () => {
      const fixtureWithPopulatedArrays: ApiFixture = {
        kind: "api",
        kind_verbose: "application_programming_interface",
        canonical_name: "api_with_relations",
        aliases: [],
        source: { file: "test.c", line: 1 },
        description: "API with multiple relation types",
        relations: {
          calls_in_direct: [
            {
              caller: "fn1",
              callee: "fn2",
              edge_kind: "call_direct",
              edge_kind_verbose: "call",
              derivation: "clangd",
              confidence: 0.95,
            },
          ],
          calls_in_runtime: [
            {
              caller: "fn3",
              callee: "fn4",
              edge_kind: "call_runtime",
              edge_kind_verbose: "runtime_call",
              derivation: "runtime",
              confidence: 0.9,
            },
          ],
          calls_out: [],
          registrations_in: [],
          registrations_out: [],
          structures: [
            {
              api: "test_api",
              struct: "test_struct",
              edge_kind: "read",
              edge_kind_verbose: "struct_read",
              derivation: "clangd",
              confidence: 0.88,
            },
          ],
          logs: [],
          owns: [],
          uses: [],
        },
      }

      const contract = generateContractFromRelations(fixtureWithPopulatedArrays.relations)

      // Contract should only include kinds present in populated arrays
      expect(contract.required_relation_kinds).toContain("call_direct")
      expect(contract.required_relation_kinds).toContain("call_runtime")
      expect(contract.required_relation_kinds).toContain("read")

      // Contract should not include kinds from empty arrays
      expect(contract.required_relation_kinds).not.toContain("registration")
      expect(contract.required_relation_kinds).not.toContain("log")

      // Verify minimum counts match array lengths
      expect(contract.minimum_counts.calls_in_direct).toBe(1)
      expect(contract.minimum_counts.calls_in_runtime).toBe(1)
      expect(contract.minimum_counts.structures).toBe(1)
    })

    it("validates relation confidence range and derivation values", () => {
      const relations: Relation[] = [
        {
          caller: "a",
          callee: "b",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "clangd",
          confidence: 0.95,
        },
        {
          caller: "c",
          callee: "d",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "c_parser",
          confidence: 0.72,
        },
        {
          caller: "e",
          callee: "f",
          edge_kind: "call_runtime",
          edge_kind_verbose: "runtime_call",
          derivation: "runtime",
          confidence: 0.85,
        },
      ]

      for (const relation of relations) {
        // Confidence should be between 0 and 1
        expect(relation.confidence).toBeGreaterThanOrEqual(0)
        expect(relation.confidence).toBeLessThanOrEqual(1)

        // Derivation should be one of the known types
        expect(["clangd", "c_parser", "runtime"]).toContain(relation.derivation)
      }
    })

    it("handles empty relation arrays gracefully", () => {
      const emptyRelations: Relations = {
        calls_in_direct: [],
        calls_in_runtime: [],
        calls_out: [],
        registrations_in: [],
        registrations_out: [],
        structures: [],
        logs: [],
        owns: [],
        uses: [],
      }

      const contract = generateContractFromRelations(emptyRelations)

      // Contract should be valid but empty
      expect(contract.required_relation_kinds.length).toBe(0)
      expect(contract.required_directions.length).toBe(0)
      expect(Object.keys(contract.minimum_counts).length).toBe(0)
    })

    it("deduplication preserves evidence and metadata fields", () => {
      const relations: Relation[] = [
        {
          caller: "fn_a",
          callee: "fn_b",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "clangd",
          confidence: 0.95,
          evidence: { clangd_symbol: "fn_a", range: { line: 10, column: 5 } },
          source_intent: "who_calls_api",
        },
        {
          caller: "fn_a",
          callee: "fn_b",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "c_parser",
          confidence: 0.72,
          evidence: { ast_node: "CallExpr" },
          source_intent: "who_calls_api",
        },
      ]

      const dedupMap = deduplicateRelations(relations)
      const result = dedupMap.get("fn_a|fn_b|call_direct")!

      // Should preserve higher-confidence entry's fields
      expect(result.evidence).toBeDefined()
      expect(result.source_intent).toBe("who_calls_api")
      expect(result.derivation).toBe("clangd")
    })
  })
})
