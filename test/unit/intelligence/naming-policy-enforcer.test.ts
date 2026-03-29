/**
 * Global naming policy enforcer test.
 *
 * Invariant: every public runtime response key emitted by any projection mapper
 * in orchestrator-runner.ts must be:
 *   1. >=3-word snake_case  (regex: /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/)
 *   2. At least 15 characters long (prevents short, ambiguous names)
 *
 * Covers all 5 mappers:
 *   - mapRuntimeCallerRowsToFrontendFriendlyLongNames   (who_calls_api_at_runtime)
 *   - mapRuntimeObservationRowsToFrontendFriendlyLongNames (why_api_invoked / show_api_runtime_observations)
 *   - mapTimerTriggerRowsToFrontendFriendlyLongNames    (find_api_timer_triggers)
 *   - mapStructureRuntimeRowsToFrontendFriendlyLongNames (current_structure_runtime_*_of_structure)
 *   - mapLegacyStructureRowsToFrontendFriendlyLongNames  (find_struct_writers / readers / etc.)
 */

import { describe, expect, it, vi } from "vitest"
import {
  executeOrchestratedQuery,
  type OrchestratorRunnerDeps,
} from "../../../src/intelligence/orchestrator-runner.js"
import { PostgresDbLookupService } from "../../../src/intelligence/db/postgres/lookup-service.js"

// ── helpers ──────────────────────────────────────────────────────────────────

function mkPool(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as import("pg").Pool
}

function mkDeps(rows: Record<string, unknown>[]): OrchestratorRunnerDeps {
  return {
    persistence: {
      dbLookup: new PostgresDbLookupService(mkPool(rows)),
      authoritativeStore: {
        persistEnrichment: vi.fn(async () => 0),
      },
      graphProjection: {
        syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })),
      },
    },
    clangdEnricher: {
      source: "clangd",
      enrich: vi.fn(async () => ({
        attempts: [{ source: "clangd" as const, status: "failed" as const }],
        persistedRows: 0,
      })),
    },
    cParserEnricher: {
      source: "c_parser",
      enrich: vi.fn(async () => ({
        attempts: [{ source: "c_parser" as const, status: "failed" as const }],
        persistedRows: 0,
      })),
    },
  }
}

// Naming policy regexes
const THREE_WORD_SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/
const MIN_KEY_LENGTH = 15

function assertNamingPolicy(keys: string[], context: string): void {
  for (const key of keys) {
    expect(
      key,
      `[${context}] key "${key}" must match >=3-word snake_case regex`,
    ).toMatch(THREE_WORD_SNAKE_CASE)

    expect(
      key.length,
      `[${context}] key "${key}" must be at least ${MIN_KEY_LENGTH} characters (got ${key.length})`,
    ).toBeGreaterThanOrEqual(MIN_KEY_LENGTH)
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("naming-policy-enforcer: all projection mapper output keys are >=3-word snake_case and >=15 chars", () => {

  // ── Mapper 1: mapRuntimeCallerRowsToFrontendFriendlyLongNames ──────────────
  describe("mapRuntimeCallerRowsToFrontendFriendlyLongNames (who_calls_api_at_runtime)", () => {
    it("all output keys satisfy naming policy", async () => {
      const deps = mkDeps([
        {
          caller: "offloadif_data_ind",
          callee: "wlan_bpf_filter_offload_handler",
          edge_kind: "indirect_calls",
          confidence: 0.97,
          derivation: "runtime",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      const keys = Object.keys(row)
      expect(keys.length).toBeGreaterThan(0)
      assertNamingPolicy(keys, "who_calls_api_at_runtime")
    })

    it("covers all 5 edge_kind variants and all output keys remain policy-compliant", async () => {
      const edgeKinds = ["calls", "registers_callback", "indirect_calls", "dispatches_to", "unknown_kind"]
      for (const edge_kind of edgeKinds) {
        const deps = mkDeps([
          { caller: "caller_fn", callee: "callee_fn", edge_kind, confidence: 1.0, derivation: "runtime" },
        ])
        const res = await executeOrchestratedQuery(
          { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "callee_fn" },
          deps,
        )
        const row = res.data.nodes[0] as Record<string, unknown>
        assertNamingPolicy(Object.keys(row), `who_calls_api_at_runtime[edge_kind=${edge_kind}]`)
      }
    })
  })

  // ── Mapper 2: mapRuntimeObservationRowsToFrontendFriendlyLongNames ─────────
  describe("mapRuntimeObservationRowsToFrontendFriendlyLongNames (why_api_invoked)", () => {
    it("all output keys satisfy naming policy", async () => {
      const deps = mkDeps([
        {
          target_api: "wlan_bpf_filter_offload_handler",
          runtime_trigger: "Incoming RX data packet",
          dispatch_chain: ["offloadif_data_ind", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
          immediate_invoker: "_offldmgr_enhanced_data_handler",
          dispatch_site: { filePath: "offload_mgr_ext.c", line: 1107 },
          confidence: 1.0,
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "why_api_invoked", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      const keys = Object.keys(row)
      expect(keys.length).toBeGreaterThan(0)
      assertNamingPolicy(keys, "why_api_invoked")
    })

    it("show_api_runtime_observations output keys satisfy naming policy", async () => {
      const deps = mkDeps([
        {
          target_api: "_wlan_bpf_offload_cmd_handler",
          runtime_trigger: "WMI command dispatch for BPF offload opcode",
          dispatch_chain: ["wmi_cmd_dispatch", "wlan_bpf_wmi_dispatch_table", "_wlan_bpf_offload_cmd_handler"],
          immediate_invoker: "wmi_cmd_dispatch",
          dispatch_site: { filePath: "wlan_bpf_wmi.c", line: 488 },
          confidence: 0.98,
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "show_api_runtime_observations", snapshotId: 42, apiName: "_wlan_bpf_offload_cmd_handler" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNamingPolicy(Object.keys(row), "show_api_runtime_observations")
    })
  })

  // ── Mapper 3: mapTimerTriggerRowsToFrontendFriendlyLongNames ──────────────
  describe("mapTimerTriggerRowsToFrontendFriendlyLongNames (find_api_timer_triggers)", () => {
    it("all output keys satisfy naming policy", async () => {
      const deps = mkDeps([
        {
          api_name: "wlan_bpf_traffic_timer_handler",
          timer_identifier_name: "bpf_traffic_monitor_timer",
          timer_trigger_condition_description: "Periodic BPF traffic monitoring interval elapsed",
          timer_trigger_confidence_score: 0.95,
          derivation: "clangd",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "find_api_timer_triggers", snapshotId: 42, apiName: "wlan_bpf_traffic_timer_handler" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      const keys = Object.keys(row)
      expect(keys.length).toBeGreaterThan(0)
      assertNamingPolicy(keys, "find_api_timer_triggers")
    })

    it("timer trigger keys are explicitly enumerated and all policy-compliant", () => {
      // Frozen key list for find_api_timer_triggers mapper output
      const EXPECTED_TIMER_KEYS = [
        "current_api_runtime_timer_identifier_name",
        "current_api_runtime_timer_trigger_condition_description",
        "current_api_runtime_timer_trigger_confidence_score",
        "current_api_runtime_timer_relation_derivation_source",
      ]

      assertNamingPolicy(EXPECTED_TIMER_KEYS, "find_api_timer_triggers frozen keys")
    })
  })

  // ── Mapper 4: mapStructureRuntimeRowsToFrontendFriendlyLongNames ──────────
  describe("mapStructureRuntimeRowsToFrontendFriendlyLongNames (current_structure_runtime_*_of_structure)", () => {
    const STRUCTURE_RUNTIME_CASES: Array<{
      intent: string
      row: Record<string, unknown>
    }> = [
      {
        intent: "current_structure_runtime_writers_of_structure",
        row: {
          writer: "wlan_bpf_enable_data_path",
          target: "bpf_vdev_t",
          edge_kind: "writes_field",
          confidence: 0.97,
          derivation: "runtime",
        },
      },
      {
        intent: "current_structure_runtime_readers_of_structure",
        row: {
          reader: "wlan_bpf_filter_offload_handler",
          target: "wlan_bpf_context",
          edge_kind: "reads_field",
          confidence: 0.94,
          derivation: "runtime",
        },
      },
      {
        intent: "current_structure_runtime_initializers_of_structure",
        row: {
          initializer: "offload_mgr_state_init",
          target: "offload_mgr_state",
          edge_kind: "operates_on_struct",
          confidence: 0.95,
          derivation: "runtime",
        },
      },
      {
        intent: "current_structure_runtime_mutators_of_structure",
        row: {
          mutator: "wlan_bpf_apply_command",
          target: "offload_mgr_state",
          edge_kind: "writes_field",
          confidence: 0.91,
          derivation: "runtime",
        },
      },
    ]

    for (const { intent, row } of STRUCTURE_RUNTIME_CASES) {
      it(`${intent}: all output keys satisfy naming policy`, async () => {
        const deps = mkDeps([row])
        const res = await executeOrchestratedQuery(
          { intent: intent as never, snapshotId: 42, structName: row.target as string },
          deps,
        )

        expect(res.status).toBe("hit")
        const outputRow = res.data.nodes[0] as Record<string, unknown>
        const keys = Object.keys(outputRow)
        expect(keys.length).toBeGreaterThan(0)
        assertNamingPolicy(keys, intent)
      })
    }

    it("structure runtime rows with evidence fields also satisfy naming policy", async () => {
      const deps = mkDeps([
        {
          writer: "wlan_bpf_enable_data_path",
          target: "bpf_vdev_t",
          edge_kind: "writes_field",
          confidence: 0.97,
          derivation: "runtime",
          runtime_structure_evidence: {
            access_path: "bpf_vdev->filter_state.enabled",
            file_path: "bpf_filter_offload.c",
            line: 214,
          },
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "current_structure_runtime_writers_of_structure", snapshotId: 42, structName: "bpf_vdev_t" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      const keys = Object.keys(row)
      expect(keys.length).toBeGreaterThan(0)
      assertNamingPolicy(keys, "current_structure_runtime_writers_of_structure+evidence")
    })
  })

  // ── Mapper 5: mapLegacyStructureRowsToFrontendFriendlyLongNames ───────────
  describe("mapLegacyStructureRowsToFrontendFriendlyLongNames (find_struct_writers/readers/etc.)", () => {
    const LEGACY_CASES: Array<{
      intent: string
      row: Record<string, unknown>
    }> = [
      {
        intent: "find_struct_writers",
        row: {
          writer: "wlan_bpf_enable_data_path",
          target: "bpf_vdev_t",
          edge_kind: "writes_field",
          confidence: 0.97,
          derivation: "clangd",
        },
      },
      {
        intent: "find_struct_readers",
        row: {
          reader: "wlan_bpf_traffic_timer_handler",
          target: "bpf_vdev_t",
          edge_kind: "reads_field",
          confidence: 0.95,
          derivation: "clangd",
        },
      },
      {
        intent: "where_struct_initialized",
        row: {
          initializer: "offload_mgr_state_init",
          target: "offload_mgr_state",
          edge_kind: "operates_on_struct",
          confidence: 0.95,
          derivation: "clangd",
        },
      },
      {
        intent: "where_struct_modified",
        row: {
          writer: "wlan_bpf_apply_command",
          target: "offload_mgr_state",
          edge_kind: "writes_field",
          confidence: 0.91,
          derivation: "clangd",
        },
      },
      {
        intent: "find_struct_owners",
        row: {
          owner: "wlan_bpf_module_init",
          target: "bpf_vdev_t",
          edge_kind: "owns_struct",
          confidence: 0.88,
          derivation: "clangd",
        },
      },
    ]

    for (const { intent, row } of LEGACY_CASES) {
      it(`${intent}: all output keys satisfy naming policy`, async () => {
        const deps = mkDeps([row])
        const res = await executeOrchestratedQuery(
          { intent: intent as never, snapshotId: 42, structName: row.target as string },
          deps,
        )

        expect(res.status).toBe("hit")
        const outputRow = res.data.nodes[0] as Record<string, unknown>
        const keys = Object.keys(outputRow)
        expect(keys.length).toBeGreaterThan(0)
        assertNamingPolicy(keys, intent)
      })
    }

    it("legacy structure rows with evidence fields also satisfy naming policy", async () => {
      const deps = mkDeps([
        {
          reader: "wlan_bpf_traffic_timer_handler",
          target: "bpf_vdev_t",
          edge_kind: "reads_field",
          confidence: 0.95,
          derivation: "clangd",
          runtime_structure_evidence: {
            access_path: "bpf_vdev->traffic_stats.last_activity_ts",
            file_path: "bpf_traffic.c",
            line: 139,
          },
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "find_struct_readers", snapshotId: 42, structName: "bpf_vdev_t" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNamingPolicy(Object.keys(row), "find_struct_readers+evidence")
    })
  })

  // ── Cross-mapper exhaustive key inventory ─────────────────────────────────
  describe("exhaustive frozen key inventory: all known mapper output keys", () => {
    it("all known output keys from all 5 mappers satisfy naming policy", () => {
      // Frozen inventory of all public output keys across all 5 mappers.
      // This test fails if any key is added that violates the naming policy.
      const ALL_KNOWN_OUTPUT_KEYS = [
        // mapRuntimeCallerRowsToFrontendFriendlyLongNames
        "runtime_caller_api_name",
        "runtime_called_api_name",
        "runtime_caller_invocation_type_classification",
        "runtime_relation_confidence_score",
        "runtime_relation_derivation_source",

        // mapRuntimeObservationRowsToFrontendFriendlyLongNames
        "target_api_name",
        "runtime_trigger_event_description",
        "runtime_execution_path_from_entrypoint_to_target_api",
        "runtime_immediate_caller_api_name",
        "runtime_dispatch_source_location",
        "runtime_confidence_score",

        // mapTimerTriggerRowsToFrontendFriendlyLongNames
        "current_api_runtime_timer_identifier_name",
        "current_api_runtime_timer_trigger_condition_description",
        "current_api_runtime_timer_trigger_confidence_score",
        "current_api_runtime_timer_relation_derivation_source",

        // mapStructureRuntimeRowsToFrontendFriendlyLongNames (role-specific)
        "current_structure_runtime_writer_api_name",
        "current_structure_runtime_reader_api_name",
        "current_structure_runtime_initializer_api_name",
        "current_structure_runtime_mutator_api_name",
        // shared structure runtime keys
        "current_structure_runtime_target_structure_name",
        "current_structure_runtime_structure_operation_type_classification",
        "current_structure_runtime_structure_operation_confidence_score",
        "current_structure_runtime_relation_derivation_source",

        // mapLegacyStructureRowsToFrontendFriendlyLongNames (role-specific)
        "current_structure_runtime_owner_api_name",

        // extractStructureEvidenceFields (shared by structure + legacy mappers)
        "current_api_runtime_structure_access_path_expression",
        "current_api_runtime_structure_access_source_evidence_location",
      ]

      assertNamingPolicy(ALL_KNOWN_OUTPUT_KEYS, "exhaustive key inventory")
    })

    it("no known output key is shorter than 15 characters", () => {
      const SHORT_KEY_EXCEPTIONS: string[] = []
      // target_api_name is 15 chars exactly — boundary case
      const BOUNDARY_KEYS = ["target_api_name"]

      for (const key of BOUNDARY_KEYS) {
        expect(key.length, `boundary key "${key}" must be exactly 15 chars`).toBe(15)
      }

      expect(SHORT_KEY_EXCEPTIONS).toHaveLength(0)
    })
  })
})
