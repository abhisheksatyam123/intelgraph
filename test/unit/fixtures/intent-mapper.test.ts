import { describe, it, expect } from "vitest"

import {
  deduplicateRelations,
  generateContractFromRelations,
  mapIntentToArray,
  normalizeEdge,
  selectIntentsForApi,
} from "../../../src/fixtures/intent-mapper"
import type { ApiFixture, Relation } from "../../../src/fixtures/intent-mapper"

describe("intent-mapper", () => {
  describe("mapIntentToArray", () => {
    it("maps who_calls_api to calls_in_direct", () => {
      expect(mapIntentToArray("who_calls_api")).toBe("calls_in_direct")
    })

    it("maps who_calls_api_at_runtime to calls_in_runtime", () => {
      expect(mapIntentToArray("who_calls_api_at_runtime")).toBe("calls_in_runtime")
    })

    it("maps what_api_calls to calls_out", () => {
      expect(mapIntentToArray("what_api_calls")).toBe("calls_out")
    })

    it("maps show_registration_chain to registrations_in", () => {
      expect(mapIntentToArray("show_registration_chain")).toBe("registrations_in")
    })

    it("maps find_callback_registrars to registrations_in", () => {
      expect(mapIntentToArray("find_callback_registrars")).toBe("registrations_in")
    })

    it("maps find_api_logs to logs", () => {
      expect(mapIntentToArray("find_api_logs")).toBe("logs")
    })

    it("maps find_api_struct_writes to structures", () => {
      expect(mapIntentToArray("find_api_struct_writes")).toBe("structures")
    })

    it("maps find_struct_owners to owns", () => {
      expect(mapIntentToArray("find_struct_owners")).toBe("owns")
    })
  })

  describe("selectIntentsForApi", () => {
    it("returns default intents for any API", () => {
      const fixture: ApiFixture = {
        kind: "api",
        kind_verbose: "application_programming_interface",
        canonical_name: "test_api",
        aliases: [],
        source: { file: "test.c", line: 1 },
        description: "test",
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

      const intents = selectIntentsForApi("test_api", fixture)
      expect(intents).toContain("who_calls_api")
      expect(intents).toContain("who_calls_api_at_runtime")
      expect(intents).toContain("what_api_calls")
      expect(intents).toContain("show_registration_chain")
      expect(intents).toContain("find_callback_registrars")
      expect(intents).toHaveLength(10)
    })
  })

  describe("normalizeEdge", () => {
    it("normalizes edge with all fields", () => {
      const edge = {
        caller: "caller_fn",
        callee: "callee_fn",
        edge_kind: "call_direct",
        edge_kind_verbose: "static_direct_calls",
        derivation: "clangd",
        confidence: 0.95,
      }

      const normalized = normalizeEdge(edge, "calls_out", "what_api_calls")
      expect(normalized.caller).toBe("caller_fn")
      expect(normalized.callee).toBe("callee_fn")
      expect(normalized.edge_kind).toBe("call_direct")
      expect(normalized.derivation).toBe("clangd")
      expect(normalized.confidence).toBe(0.95)
      expect(normalized.source_intent).toBe("what_api_calls")
      expect(normalized.bucket).toBe("calls_out")
    })

    it("applies defaults for missing fields", () => {
      const edge = {
        caller: "caller_fn",
        callee: "callee_fn",
      }

      const normalized = normalizeEdge(edge, "calls_out", "what_api_calls")
      expect(normalized.edge_kind).toBe("unknown")
      expect(normalized.derivation).toBe("clangd")
      expect(normalized.confidence).toBe(0.5)
    })
  })

  describe("deduplicateRelations", () => {
    it("keeps single relation when no duplicates", () => {
      const relations: Relation[] = [
        {
          caller: "a",
          callee: "b",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "clangd",
          confidence: 0.9,
        },
      ]

      const result = deduplicateRelations(relations)
      expect(result.size).toBe(1)
      expect(result.get("a|b|call_direct")).toEqual(relations[0])
    })

    it("prefers higher confidence when duplicates exist", () => {
      const relations: Relation[] = [
        {
          caller: "a",
          callee: "b",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "c_parser",
          confidence: 0.7,
        },
        {
          caller: "a",
          callee: "b",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "clangd",
          confidence: 0.95,
        },
      ]

      const result = deduplicateRelations(relations)
      expect(result.size).toBe(1)
      const kept = result.get("a|b|call_direct")!
      expect(kept.derivation).toBe("clangd")
      expect(kept.confidence).toBe(0.95)
    })

    it("prefers clangd when confidence is equal", () => {
      const relations: Relation[] = [
        {
          caller: "a",
          callee: "b",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "c_parser",
          confidence: 0.9,
        },
        {
          caller: "a",
          callee: "b",
          edge_kind: "call_direct",
          edge_kind_verbose: "call",
          derivation: "clangd",
          confidence: 0.9,
        },
      ]

      const result = deduplicateRelations(relations)
      expect(result.size).toBe(1)
      const kept = result.get("a|b|call_direct")!
      expect(kept.derivation).toBe("clangd")
    })

    it("handles relations with struct instead of caller/callee", () => {
      const relations: Relation[] = [
        {
          api: "api_fn",
          struct: "my_struct",
          edge_kind: "read",
          edge_kind_verbose: "read_struct",
          derivation: "clangd",
          confidence: 0.85,
        },
      ]

      const result = deduplicateRelations(relations)
      expect(result.size).toBe(1)
      expect(result.get("api_fn|my_struct|read")).toEqual(relations[0])
    })
  })

  describe("generateContractFromRelations", () => {
    it("generates contract with call_direct when calls_out present", () => {
      const relations = {
        calls_in_direct: [],
        calls_in_runtime: [],
        calls_out: [
          {
            caller: "a",
            callee: "b",
            edge_kind: "call_direct",
            edge_kind_verbose: "call",
            derivation: "clangd" as const,
            confidence: 0.9,
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
      expect(contract.required_relation_kinds).toContain("call_direct")
      expect(contract.required_directions).toContain("outgoing")
      expect(contract.minimum_counts.calls_out).toBe(1)
    })

    it("generates contract with call_runtime when calls_in_runtime present", () => {
      const relations = {
        calls_in_direct: [],
        calls_in_runtime: [
          {
            caller: "a",
            callee: "b",
            edge_kind: "call_runtime",
            edge_kind_verbose: "call",
            derivation: "runtime" as const,
            confidence: 0.95,
          },
        ],
        calls_out: [],
        registrations_in: [],
        registrations_out: [],
        structures: [],
        logs: [],
        owns: [],
        uses: [],
      }

      const contract = generateContractFromRelations(relations)
      expect(contract.required_relation_kinds).toContain("call_runtime")
      expect(contract.required_directions).toContain("incoming")
      expect(contract.minimum_counts.calls_in_runtime).toBe(1)
    })

    it("generates contract with read/write kinds when structures present", () => {
      const relations = {
        calls_in_direct: [],
        calls_in_runtime: [],
        calls_out: [],
        registrations_in: [],
        registrations_out: [],
        structures: [
          {
            api: "fn",
            struct: "my_struct",
            edge_kind: "read",
            edge_kind_verbose: "read",
            derivation: "clangd" as const,
            confidence: 0.9,
          },
          {
            api: "fn",
            struct: "my_struct",
            edge_kind: "write",
            edge_kind_verbose: "write",
            derivation: "clangd" as const,
            confidence: 0.9,
          },
        ],
        logs: [],
        owns: [],
        uses: [],
      }

      const contract = generateContractFromRelations(relations)
      expect(contract.required_relation_kinds).toContain("read")
      expect(contract.required_relation_kinds).toContain("write")
      expect(contract.minimum_counts.structures).toBe(1)
    })

    it("generates contract with emit_log when logs present", () => {
      const relations = {
        calls_in_direct: [],
        calls_in_runtime: [],
        calls_out: [],
        registrations_in: [],
        registrations_out: [],
        structures: [],
        logs: [
          {
            api_name: "fn",
            level: "INFO",
            template: "test log",
            subsystem: "TEST",
            edge_kind: "emit_log",
            edge_kind_verbose: "emit_log",
            derivation: "clangd" as const,
            confidence: 0.9,
          },
        ],
        owns: [],
        uses: [],
      }

      const contract = generateContractFromRelations(relations)
      expect(contract.required_relation_kinds).toContain("emit_log")
      expect(contract.minimum_counts.logs).toBe(1)
    })

    it("generates empty contract when all relations are empty", () => {
      const relations = {
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

      const contract = generateContractFromRelations(relations)
      expect(contract.required_relation_kinds).toHaveLength(0)
      expect(contract.required_directions).toHaveLength(0)
      expect(Object.keys(contract.minimum_counts)).toHaveLength(0)
    })
  })
})
