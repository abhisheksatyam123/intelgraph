import { describe, expect, it, vi } from "vitest"
import { executeOrchestratedQuery, classifyRuntimeInvocationType, type OrchestratorRunnerDeps } from "../../../src/intelligence/orchestrator-runner.js"
import { validateResponseShape } from "../../../src/intelligence/contracts/orchestrator.js"
import { PostgresDbLookupService } from "../../../src/intelligence/db/postgres/lookup-service.js"

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
      enrich: vi.fn(async () => ({ attempts: [{ source: "clangd" as const, status: "failed" as const }], persistedRows: 0 })),
    },
    cParserEnricher: {
      source: "c_parser",
      enrich: vi.fn(async () => ({ attempts: [{ source: "c_parser" as const, status: "failed" as const }], persistedRows: 0 })),
    },
  }
}

describe("runtime-only projection", () => {
  it("freezes API-centric runtime contract examples for callback, dispatch, and timer WLAN APIs", async () => {
    const callbackDeps = mkDeps([
      {
        target_api: "wlan_bpf_filter_offload_handler",
        runtime_trigger: "Incoming RX data packet",
        dispatch_chain: ["offloadif_data_ind", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
        immediate_invoker: "_offldmgr_enhanced_data_handler",
        dispatch_site: { filePath: "offload_mgr_ext.c", line: 1107 },
        confidence: 1,
      },
      {
        caller: "offloadif_data_ind",
        callee: "wlan_bpf_filter_offload_handler",
        edge_kind: "indirect_calls",
        confidence: 0.97,
        derivation: "runtime",
      },
      {
        callee_api_name: "dbglog_printf",
        callee_invocation_type: "direct_call",
        callee_invocation_confidence: 1,
        read_structure_name: "wlan_bpf_context",
        read_structure_access_operation_type: "reads_field",
        structure_access_confidence: 0.91,
        structure_name_normalization_rule: "typedef_preserved",
        structure_access_path_expression: "bpf_ctx->filter_rules[rule_index]",
        written_structure_name: "bpf_vdev_t",
        written_structure_access_operation_type: "writes_field",
        written_structure_access_confidence: 0.94,
        written_structure_access_source_evidence_location: "bpf_filter_offload.c:214",
        log_message_template_text: "BPF filter matched for vdev %u",
        log_message_subsystem_name: "bpf_offload",
        log_severity_level: "INFO",
        log_source_file_path_and_line_number: "bpf_filter_offload.c:221",
        timer_registration_api_name: null,
        timer_callback_api_name: null,
        timer_trigger_kind: null,
        timer_confidence: null,
      },
    ])

    const callbackObservation = await executeOrchestratedQuery(
      { intent: "why_api_invoked", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      callbackDeps,
    )
    const callbackCaller = await executeOrchestratedQuery(
      { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      callbackDeps,
    )

    const callbackObservationRow = callbackObservation.data.nodes[0] as Record<string, unknown>
    const callbackCallerRow = callbackCaller.data.nodes[1] as Record<string, unknown>

    expect(callbackObservationRow).toEqual({
      target_api_name: "wlan_bpf_filter_offload_handler",
      runtime_trigger_event_description: "Incoming RX data packet",
      runtime_execution_path_from_entrypoint_to_target_api: [
        "offloadif_data_ind",
        "_offldmgr_enhanced_data_handler",
        "wlan_bpf_filter_offload_handler",
      ],
      runtime_immediate_caller_api_name: "_offldmgr_enhanced_data_handler",
      runtime_dispatch_source_location: { filePath: "offload_mgr_ext.c", line: 1107 },
      runtime_confidence_score: 1,
    })
    expect(callbackCallerRow).toEqual({
      runtime_caller_api_name: "offloadif_data_ind",
      runtime_called_api_name: "wlan_bpf_filter_offload_handler",
      runtime_caller_invocation_type_classification: "runtime_function_pointer_call",
      runtime_relation_confidence_score: 0.97,
      runtime_relation_derivation_source: "runtime",
    })

    const frozenCallbackExample = {
      target_api_name: "wlan_bpf_filter_offload_handler",
      runtime_trigger_event_description: "Incoming RX data packet",
      runtime_execution_path_from_entrypoint_to_target_api: [
        "offloadif_data_ind",
        "_offldmgr_enhanced_data_handler",
        "wlan_bpf_filter_offload_handler",
      ],
      runtime_immediate_caller_api_name: "_offldmgr_enhanced_data_handler",
      runtime_dispatch_source_location: { filePath: "offload_mgr_ext.c", line: 1107 },
      runtime_confidence_score: 1,
      current_api_runtime_callee_api_name: "dbglog_printf",
      current_api_runtime_callee_invocation_type: "direct_call",
      current_api_runtime_callee_invocation_confidence_score: 1,
      current_api_runtime_read_structure_name: "wlan_bpf_context",
      current_api_runtime_read_structure_access_operation_type: "reads_field",
      current_api_runtime_structure_access_confidence_score: 0.91,
      current_api_runtime_structure_name_normalization_rule: "typedef_preserved",
      current_api_runtime_structure_access_path_expression: "bpf_ctx->filter_rules[rule_index]",
      current_api_runtime_written_structure_name: "bpf_vdev_t",
      current_api_runtime_written_structure_access_operation_type: "writes_field",
      current_api_runtime_written_structure_access_confidence_score: 0.94,
      current_api_runtime_written_structure_access_source_evidence_location: "bpf_filter_offload.c:214",
      current_api_runtime_log_message_template_text: "BPF filter matched for vdev %u",
      current_api_runtime_log_message_subsystem_name: "bpf_offload",
      current_api_runtime_log_severity_level: "INFO",
      current_api_runtime_log_source_file_path_and_line_number: "bpf_filter_offload.c:221",
      current_api_runtime_timer_registration_api_name: null,
      current_api_runtime_timer_callback_api_name: null,
      current_api_runtime_timer_trigger_kind: null,
      current_api_runtime_timer_confidence_score: null,
    } satisfies Record<string, unknown>

    expect(frozenCallbackExample.current_api_runtime_callee_api_name).toBe("dbglog_printf")
    expect(frozenCallbackExample.current_api_runtime_log_message_template_text).toContain("BPF filter")

    const dispatchObservation = {
      target_api_name: "_wlan_bpf_offload_cmd_handler",
      runtime_trigger_event_description: "WMI command dispatch for BPF offload opcode",
      runtime_execution_path_from_entrypoint_to_target_api: ["wmi_cmd_dispatch", "wlan_bpf_wmi_dispatch_table", "_wlan_bpf_offload_cmd_handler"],
      runtime_immediate_caller_api_name: "wmi_cmd_dispatch",
      runtime_dispatch_source_location: { filePath: "wlan_bpf_wmi.c", line: 488 },
      runtime_confidence_score: 0.98,
      current_api_runtime_callee_api_name: "wlan_bpf_apply_command",
      current_api_runtime_callee_invocation_type: "dispatch_table_entry",
      current_api_runtime_callee_invocation_confidence_score: 0.96,
      current_api_runtime_read_structure_name: "offload_mgr_state",
      current_api_runtime_read_structure_access_operation_type: "reads_field",
      current_api_runtime_structure_access_confidence_score: 0.88,
      current_api_runtime_structure_name_normalization_rule: "typedef_preserved",
      current_api_runtime_structure_access_path_expression: "offload_mgr->cmd_handlers[cmd_id]",
      current_api_runtime_written_structure_name: "offload_mgr_state",
      current_api_runtime_written_structure_access_operation_type: "writes_field",
      current_api_runtime_written_structure_access_confidence_score: 0.9,
      current_api_runtime_written_structure_access_source_evidence_location: "wlan_bpf_wmi.c:501",
      current_api_runtime_log_message_template_text: "Handling BPF WMI command %u",
      current_api_runtime_log_message_subsystem_name: "wmi",
      current_api_runtime_log_severity_level: "DEBUG",
      current_api_runtime_log_source_file_path_and_line_number: "wlan_bpf_wmi.c:496",
      current_api_runtime_timer_registration_api_name: null,
      current_api_runtime_timer_callback_api_name: null,
      current_api_runtime_timer_trigger_kind: null,
      current_api_runtime_timer_confidence_score: null,
    } satisfies Record<string, unknown>

    const timerObservation = {
      target_api_name: "wlan_bpf_traffic_timer_handler",
      runtime_trigger_event_description: "Periodic traffic watchdog timer expiry",
      runtime_execution_path_from_entrypoint_to_target_api: ["qdf_timer_mod", "qdf_timer_handler", "wlan_bpf_traffic_timer_handler"],
      runtime_immediate_caller_api_name: "qdf_timer_handler",
      runtime_dispatch_source_location: { filePath: "qdf_timer.c", line: 173 },
      runtime_confidence_score: 0.99,
      current_api_runtime_callee_api_name: "wlan_bpf_evaluate_traffic_state",
      current_api_runtime_callee_invocation_type: "timer_callback",
      current_api_runtime_callee_invocation_confidence_score: 0.99,
      current_api_runtime_read_structure_name: "bpf_vdev_t",
      current_api_runtime_read_structure_access_operation_type: "reads_field",
      current_api_runtime_structure_access_confidence_score: 0.93,
      current_api_runtime_structure_name_normalization_rule: "typedef_preserved",
      current_api_runtime_structure_access_path_expression: "bpf_vdev->traffic_stats.last_activity_ts",
      current_api_runtime_written_structure_name: "bpf_vdev_t",
      current_api_runtime_written_structure_access_operation_type: "writes_field",
      current_api_runtime_written_structure_access_confidence_score: 0.87,
      current_api_runtime_written_structure_access_source_evidence_location: "bpf_traffic.c:144",
      current_api_runtime_log_message_template_text: "Traffic timer fired for vdev %u",
      current_api_runtime_log_message_subsystem_name: "bpf_timer",
      current_api_runtime_log_severity_level: "TRACE",
      current_api_runtime_log_source_file_path_and_line_number: "bpf_traffic.c:139",
      current_api_runtime_timer_registration_api_name: "wlan_bpf_start_traffic_timer",
      current_api_runtime_timer_callback_api_name: "wlan_bpf_traffic_timer_handler",
      current_api_runtime_timer_trigger_kind: "periodic_timer_expiry",
      current_api_runtime_timer_confidence_score: 0.99,
    } satisfies Record<string, unknown>

    for (const example of [frozenCallbackExample, dispatchObservation, timerObservation]) {
      expect(validateResponseShape({
        snapshotId: 42,
        intent: "show_api_runtime_observations",
        status: "hit",
        data: { nodes: [example], edges: [] },
        provenance: { path: "db_hit", deterministicAttempts: [], llmUsed: false },
      })).toEqual([])

      for (const key of Object.keys(example)) {
        expect(key).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+){2,}$/)
      }
    }
  })

  it("why_api_invoked returns runtime-only fields with frontend-friendly long names", async () => {
    const deps = mkDeps([
      {
        target_api: "wlan_bpf_filter_offload_handler",
        runtime_trigger: "Incoming RX data packet",
        dispatch_chain: ["offloadif_data_ind", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
        immediate_invoker: "_offldmgr_enhanced_data_handler",
        dispatch_site: { filePath: "offload_mgr_ext.c", line: 1107 },
        confidence: 1.0,
        registrar: "wlan_bpf_enable_data_path",
        registration_api: "offldmgr_register_data_offload",
      },
    ])

    const res = await executeOrchestratedQuery(
      { intent: "why_api_invoked", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("hit")
    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row.runtime_trigger_event_description).toBeTruthy()
    expect(row.runtime_immediate_caller_api_name).toBe("_offldmgr_enhanced_data_handler")
    expect(row.runtime_execution_path_from_entrypoint_to_target_api).toBeTruthy()
    expect(row.registrar).toBeUndefined()
    expect(row.registration_api).toBeUndefined()
  })

  it("freezes structure-centric runtime contract examples for three WLAN structures", async () => {
    const writerDeps = mkDeps([
      {
        writer: "wlan_bpf_enable_data_path",
        target: "bpf_vdev_t",
        edge_kind: "writes_field",
        confidence: 0.97,
        derivation: "runtime",
      },
    ])
    const readerDeps = mkDeps([
      {
        reader: "wlan_bpf_filter_offload_handler",
        target: "wlan_bpf_context",
        edge_kind: "reads_field",
        confidence: 0.94,
        derivation: "runtime",
      },
    ])
    const initializerDeps = mkDeps([
      {
        initializer: "offload_mgr_state_init",
        target: "offload_mgr_state",
        edge_kind: "operates_on_struct",
        confidence: 0.95,
        derivation: "runtime",
      },
    ])
    const mutatorDeps = mkDeps([
      {
        mutator: "wlan_bpf_apply_command",
        target: "offload_mgr_state",
        edge_kind: "writes_field",
        confidence: 0.91,
        derivation: "runtime",
      },
    ])

    const writerResponse = await executeOrchestratedQuery(
      { intent: "current_structure_runtime_writers_of_structure", snapshotId: 42, structName: "bpf_vdev_t" },
      writerDeps,
    )
    const readerResponse = await executeOrchestratedQuery(
      { intent: "current_structure_runtime_readers_of_structure", snapshotId: 42, structName: "wlan_bpf_context" },
      readerDeps,
    )
    const initializerResponse = await executeOrchestratedQuery(
      { intent: "current_structure_runtime_initializers_of_structure", snapshotId: 42, structName: "offload_mgr_state" },
      initializerDeps,
    )
    const mutatorResponse = await executeOrchestratedQuery(
      { intent: "current_structure_runtime_mutators_of_structure", snapshotId: 42, structName: "offload_mgr_state" },
      mutatorDeps,
    )

    expect(writerResponse.data.nodes[0]).toEqual({
      current_structure_runtime_writer_api_name: "wlan_bpf_enable_data_path",
      current_structure_runtime_target_structure_name: "bpf_vdev_t",
      current_structure_runtime_structure_operation_type_classification: "writes_field",
      current_structure_runtime_structure_operation_confidence_score: 0.97,
      current_structure_runtime_relation_derivation_source: "runtime",
    })
    expect(readerResponse.data.nodes[0]).toEqual({
      current_structure_runtime_reader_api_name: "wlan_bpf_filter_offload_handler",
      current_structure_runtime_target_structure_name: "wlan_bpf_context",
      current_structure_runtime_structure_operation_type_classification: "reads_field",
      current_structure_runtime_structure_operation_confidence_score: 0.94,
      current_structure_runtime_relation_derivation_source: "runtime",
    })
    expect(initializerResponse.data.nodes[0]).toEqual({
      current_structure_runtime_initializer_api_name: "offload_mgr_state_init",
      current_structure_runtime_target_structure_name: "offload_mgr_state",
      current_structure_runtime_structure_operation_type_classification: "operates_on_struct",
      current_structure_runtime_structure_operation_confidence_score: 0.95,
      current_structure_runtime_relation_derivation_source: "runtime",
    })
    expect(mutatorResponse.data.nodes[0]).toEqual({
      current_structure_runtime_mutator_api_name: "wlan_bpf_apply_command",
      current_structure_runtime_target_structure_name: "offload_mgr_state",
      current_structure_runtime_structure_operation_type_classification: "writes_field",
      current_structure_runtime_structure_operation_confidence_score: 0.91,
      current_structure_runtime_relation_derivation_source: "runtime",
    })

    const frozenStructureExamples: Array<{ intent: string, row: Record<string, unknown> }> = [
      {
        intent: "current_structure_runtime_writers_of_structure",
        row: {
          current_structure_runtime_writer_api_name: "wlan_bpf_enable_data_path",
          current_structure_runtime_target_structure_name: "bpf_vdev_t",
          current_structure_runtime_structure_operation_type_classification: "writes_field",
          current_structure_runtime_structure_operation_confidence_score: 0.97,
          current_structure_runtime_relation_derivation_source: "runtime",
        },
      },
      {
        intent: "current_structure_runtime_readers_of_structure",
        row: {
          current_structure_runtime_reader_api_name: "wlan_bpf_filter_offload_handler",
          current_structure_runtime_target_structure_name: "wlan_bpf_context",
          current_structure_runtime_structure_operation_type_classification: "reads_field",
          current_structure_runtime_structure_operation_confidence_score: 0.94,
          current_structure_runtime_relation_derivation_source: "runtime",
        },
      },
      {
        intent: "current_structure_runtime_initializers_of_structure",
        row: {
          current_structure_runtime_initializer_api_name: "offload_mgr_state_init",
          current_structure_runtime_target_structure_name: "offload_mgr_state",
          current_structure_runtime_structure_operation_type_classification: "operates_on_struct",
          current_structure_runtime_structure_operation_confidence_score: 0.95,
          current_structure_runtime_relation_derivation_source: "runtime",
        },
      },
      {
        intent: "current_structure_runtime_mutators_of_structure",
        row: {
          current_structure_runtime_mutator_api_name: "wlan_bpf_apply_command",
          current_structure_runtime_target_structure_name: "offload_mgr_state",
          current_structure_runtime_structure_operation_type_classification: "writes_field",
          current_structure_runtime_structure_operation_confidence_score: 0.91,
          current_structure_runtime_relation_derivation_source: "runtime",
        },
      },
    ]

    for (const example of frozenStructureExamples) {
      expect(validateResponseShape({
        snapshotId: 42,
        intent: example.intent as never,
        status: "hit",
        data: { nodes: [example.row], edges: [] },
        provenance: { path: "db_hit", deterministicAttempts: [], llmUsed: false },
      })).toEqual([])

      for (const key of Object.keys(example.row)) {
        expect(key).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+){2,}$/)
      }
    }
  })

  it("who_calls_api_at_runtime returns long-name runtime caller fields", async () => {
    const deps = mkDeps([
      {
        caller: "offloadif_data_ind",
        callee: "wlan_bpf_filter_offload_handler",
        edge_kind: "indirect_calls",
        confidence: 0.9,
        derivation: "runtime",
        registrar: "wlan_bpf_enable_data_path",
      },
    ])

    const res = await executeOrchestratedQuery(
      { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
      deps,
    )

    expect(res.status).toBe("hit")
    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row.runtime_caller_api_name).toBe("offloadif_data_ind")
    expect(row.runtime_called_api_name).toBe("wlan_bpf_filter_offload_handler")
    expect(row.runtime_caller_invocation_type_classification).toBe("runtime_function_pointer_call")
    expect(row.runtime_relation_confidence_score).toBe(0.9)
    expect(row.registrar).toBeUndefined()
  })

  it("structure-centric runtime intents return long, descriptive keys", async () => {
    const deps = mkDeps([
      {
        writer: "wlan_bpf_enable_data_path",
        target: "bpf_vdev_t",
        edge_kind: "writes_field",
        confidence: 1.0,
        derivation: "runtime",
      },
    ])

    const res = await executeOrchestratedQuery(
      { intent: "current_structure_runtime_writers_of_structure", snapshotId: 42, structName: "bpf_vdev_t" },
      deps,
    )

    expect(res.status).toBe("hit")
    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row.current_structure_runtime_writer_api_name).toBe("wlan_bpf_enable_data_path")
    expect(row.current_structure_runtime_target_structure_name).toBe("bpf_vdev_t")
    expect(row.current_structure_runtime_structure_operation_type_classification).toBe("writes_field")
    expect(row.current_structure_runtime_structure_operation_confidence_score).toBe(1)

    for (const k of Object.keys(row)) {
      expect(k.split("_").length).toBeGreaterThanOrEqual(3)
    }
  })

  it("legacy structure intents are projected to the same long-name compatibility shape", async () => {
    const deps = mkDeps([
      {
        reader: "wlan_bpf_traffic_timer_handler",
        target: "bpf_vdev_t",
        edge_kind: "reads_field",
        confidence: 0.95,
        derivation: "clangd",
      },
    ])

    const res = await executeOrchestratedQuery(
      { intent: "find_struct_readers", snapshotId: 42, structName: "bpf_vdev_t" },
      deps,
    )

    expect(res.status).toBe("hit")
    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row.current_structure_runtime_reader_api_name).toBe("wlan_bpf_traffic_timer_handler")
    expect(row.current_structure_runtime_target_structure_name).toBe("bpf_vdev_t")
    expect(row.current_structure_runtime_structure_operation_type_classification).toBe("reads_field")
    expect(row.current_structure_runtime_structure_operation_confidence_score).toBe(0.95)
  })

  it("structure-centric rows with runtime_structure_evidence include access_path and source_location fields", async () => {
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
    expect(row.current_api_runtime_structure_access_path_expression).toBe("bpf_vdev->filter_state.enabled")
    expect(row.current_api_runtime_structure_access_source_evidence_location).toBe("bpf_filter_offload.c:214")
    expect(row.current_structure_runtime_writer_api_name).toBe("wlan_bpf_enable_data_path")
    expect(row.current_structure_runtime_target_structure_name).toBe("bpf_vdev_t")

    for (const k of Object.keys(row)) {
      expect(k).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+){2,}$/)
    }
  })

  it("structure-centric rows with source_location string use it directly", async () => {
    const deps = mkDeps([
      {
        reader: "wlan_bpf_filter_offload_handler",
        target: "wlan_bpf_context",
        edge_kind: "reads_field",
        confidence: 0.94,
        derivation: "runtime",
        runtime_structure_evidence: {
          access_path: "bpf_ctx->filter_rules[rule_index]",
          source_location: "bpf_filter_offload.c:221",
        },
      },
    ])

    const res = await executeOrchestratedQuery(
      { intent: "current_structure_runtime_readers_of_structure", snapshotId: 42, structName: "wlan_bpf_context" },
      deps,
    )

    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row.current_api_runtime_structure_access_path_expression).toBe("bpf_ctx->filter_rules[rule_index]")
    expect(row.current_api_runtime_structure_access_source_evidence_location).toBe("bpf_filter_offload.c:221")
  })

  it("structure-centric rows without runtime_structure_evidence omit evidence fields", async () => {
    const deps = mkDeps([
      {
        writer: "wlan_bpf_enable_data_path",
        target: "bpf_vdev_t",
        edge_kind: "writes_field",
        confidence: 0.97,
        derivation: "runtime",
      },
    ])

    const res = await executeOrchestratedQuery(
      { intent: "current_structure_runtime_writers_of_structure", snapshotId: 42, structName: "bpf_vdev_t" },
      deps,
    )

    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row).not.toHaveProperty("current_api_runtime_structure_access_path_expression")
    expect(row).not.toHaveProperty("current_api_runtime_structure_access_source_evidence_location")
  })

  it("structure-centric rows with null runtime_structure_evidence omit evidence fields", async () => {
    const deps = mkDeps([
      {
        initializer: "offload_mgr_state_init",
        target: "offload_mgr_state",
        edge_kind: "operates_on_struct",
        confidence: 0.95,
        derivation: "runtime",
        runtime_structure_evidence: null,
      },
    ])

    const res = await executeOrchestratedQuery(
      { intent: "current_structure_runtime_initializers_of_structure", snapshotId: 42, structName: "offload_mgr_state" },
      deps,
    )

    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row).not.toHaveProperty("current_api_runtime_structure_access_path_expression")
    expect(row).not.toHaveProperty("current_api_runtime_structure_access_source_evidence_location")
  })

  it("legacy structure intents with runtime_structure_evidence include evidence fields", async () => {
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

    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row.current_api_runtime_structure_access_path_expression).toBe("bpf_vdev->traffic_stats.last_activity_ts")
    expect(row.current_api_runtime_structure_access_source_evidence_location).toBe("bpf_traffic.c:139")
    expect(row.current_structure_runtime_reader_api_name).toBe("wlan_bpf_traffic_timer_handler")
  })

  it("legacy structure intents without runtime_structure_evidence omit evidence fields", async () => {
    const deps = mkDeps([
      {
        reader: "wlan_bpf_traffic_timer_handler",
        target: "bpf_vdev_t",
        edge_kind: "reads_field",
        confidence: 0.95,
        derivation: "clangd",
      },
    ])

    const res = await executeOrchestratedQuery(
      { intent: "find_struct_readers", snapshotId: 42, structName: "bpf_vdev_t" },
      deps,
    )

    const row = res.data.nodes[0] as Record<string, unknown>
    expect(row).not.toHaveProperty("current_api_runtime_structure_access_path_expression")
    expect(row).not.toHaveProperty("current_api_runtime_structure_access_source_evidence_location")
  })

  describe("classifyRuntimeInvocationType", () => {
    it("maps 'calls' to runtime_direct_call", () => {
      expect(classifyRuntimeInvocationType("calls")).toBe("runtime_direct_call")
    })

    it("maps 'registers_callback' to runtime_callback_registration_call", () => {
      expect(classifyRuntimeInvocationType("registers_callback")).toBe("runtime_callback_registration_call")
    })

    it("maps 'indirect_calls' to runtime_function_pointer_call", () => {
      expect(classifyRuntimeInvocationType("indirect_calls")).toBe("runtime_function_pointer_call")
    })

    it("maps 'dispatches_to' to runtime_dispatch_table_call", () => {
      expect(classifyRuntimeInvocationType("dispatches_to")).toBe("runtime_dispatch_table_call")
    })

    it("maps unknown edge kinds to runtime_unknown_call_path", () => {
      expect(classifyRuntimeInvocationType("unknown_edge")).toBe("runtime_unknown_call_path")
      expect(classifyRuntimeInvocationType("")).toBe("runtime_unknown_call_path")
      expect(classifyRuntimeInvocationType("reads_field")).toBe("runtime_unknown_call_path")
    })

    it("who_calls_api_at_runtime uses runtime_caller_invocation_type_classification with classified values", async () => {
      const cases: Array<{ edge_kind: string; expected: string }> = [
        { edge_kind: "calls", expected: "runtime_direct_call" },
        { edge_kind: "registers_callback", expected: "runtime_callback_registration_call" },
        { edge_kind: "indirect_calls", expected: "runtime_function_pointer_call" },
        { edge_kind: "dispatches_to", expected: "runtime_dispatch_table_call" },
        { edge_kind: "some_other_kind", expected: "runtime_unknown_call_path" },
      ]

      for (const { edge_kind, expected } of cases) {
        const deps = mkDeps([
          { caller: "caller_fn", callee: "callee_fn", edge_kind, confidence: 1.0, derivation: "runtime" },
        ])
        const res = await executeOrchestratedQuery(
          { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "callee_fn" },
          deps,
        )
        const row = res.data.nodes[0] as Record<string, unknown>
        expect(row.runtime_caller_invocation_type_classification).toBe(expected)
        expect(row).not.toHaveProperty("runtime_call_relation_kind")
      }
    })
  })

  describe("runtime_facet_completeness_status_map", () => {
    const EXPECTED_FACET_KEYS = [
      "runtime_callers_facet_completeness_status",
      "runtime_callees_facet_completeness_status",
      "runtime_structure_access_facet_completeness_status",
      "runtime_logs_facet_completeness_status",
      "runtime_timers_facet_completeness_status",
    ] as const

    it("response includes runtime_facet_completeness_status_map with all 5 long-name keys", async () => {
      const deps = mkDeps([
        { caller: "caller_fn", callee: "callee_fn", edge_kind: "calls", confidence: 1.0, derivation: "runtime" },
      ])
      const res = await executeOrchestratedQuery(
        { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "callee_fn" },
        deps,
      )

      expect(res.runtime_facet_completeness_status_map).toBeDefined()
      for (const key of EXPECTED_FACET_KEYS) {
        expect(res.runtime_facet_completeness_status_map).toHaveProperty(key)
      }
    })

    it("status=hit maps all facets to runtime_facet_data_fully_available", async () => {
      const deps = mkDeps([
        { caller: "caller_fn", callee: "callee_fn", edge_kind: "calls", confidence: 1.0, derivation: "runtime" },
      ])
      const res = await executeOrchestratedQuery(
        { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "callee_fn" },
        deps,
      )

      expect(res.status).toBe("hit")
      const map = res.runtime_facet_completeness_status_map!
      for (const key of EXPECTED_FACET_KEYS) {
        expect(map[key]).toBe("runtime_facet_data_fully_available")
      }
    })

    it("status=not_found maps all facets to runtime_facet_data_not_yet_ingested", async () => {
      const emptyPool = mkPool([])
      const depsWithLlm: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: new PostgresDbLookupService(emptyPool),
          authoritativeStore: { persistEnrichment: vi.fn(async () => 0) },
          graphProjection: { syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })) },
        },
        clangdEnricher: {
          source: "clangd",
          enrich: vi.fn(async () => ({ attempts: [{ source: "clangd" as const, status: "failed" as const }], persistedRows: 0 })),
        },
        cParserEnricher: {
          source: "c_parser",
          enrich: vi.fn(async () => ({ attempts: [{ source: "c_parser" as const, status: "failed" as const }], persistedRows: 0 })),
        },
        llmEnricher: {
          source: "llm",
          canRun: vi.fn(() => true),
          enrich: vi.fn(async () => ({ attempts: [{ source: "llm" as const, status: "failed" as const }], persistedRows: 0 })),
        },
      }
      const res = await executeOrchestratedQuery(
        { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "callee_fn" },
        depsWithLlm,
      )

      expect(res.status).toBe("not_found")
      const map = res.runtime_facet_completeness_status_map!
      for (const key of EXPECTED_FACET_KEYS) {
        expect(map[key]).toBe("runtime_facet_data_not_yet_ingested")
      }
    })

    it("all 5 facet key names are >=3-word snake_case", () => {
      for (const key of EXPECTED_FACET_KEYS) {
        expect(key).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+){2,}$/)
      }
    })

    it("structure-centric hit response includes completeness map with fully_available status", async () => {
      const deps = mkDeps([
        { writer: "wlan_bpf_enable_data_path", target: "bpf_vdev_t", edge_kind: "writes_field", confidence: 0.97, derivation: "runtime" },
      ])
      const res = await executeOrchestratedQuery(
        { intent: "current_structure_runtime_writers_of_structure", snapshotId: 42, structName: "bpf_vdev_t" },
        deps,
      )

      expect(res.status).toBe("hit")
      expect(res.runtime_facet_completeness_status_map).toBeDefined()
      expect(res.runtime_facet_completeness_status_map!.runtime_structure_access_facet_completeness_status).toBe("runtime_facet_data_fully_available")
    })
  })

  describe("registration-chain field leak regression", () => {
    const REGISTRATION_CHAIN_FIELDS = [
      "registrar",
      "registration_api",
      "registration_site",
      "callback_registration_function",
    ] as const

    function assertNoRegistrationChainFields(row: Record<string, unknown>): void {
      for (const field of REGISTRATION_CHAIN_FIELDS) {
        expect(row, `field "${field}" must not appear in runtime-only output`).not.toHaveProperty(field)
      }
    }

    it("who_calls_api_at_runtime strips all registration-chain fields", async () => {
      const deps = mkDeps([
        {
          caller: "offloadif_data_ind",
          callee: "wlan_bpf_filter_offload_handler",
          edge_kind: "indirect_calls",
          confidence: 0.97,
          derivation: "runtime",
          registrar: "wlan_bpf_enable_data_path",
          registration_api: "offldmgr_register_data_offload",
          registration_site: "bpf_init.c:42",
          callback_registration_function: "wlan_bpf_register_callback",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "who_calls_api_at_runtime", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNoRegistrationChainFields(row)
      // Verify runtime fields are still present
      expect(row.runtime_caller_api_name).toBe("offloadif_data_ind")
      expect(row.runtime_called_api_name).toBe("wlan_bpf_filter_offload_handler")
    })

    it("why_api_invoked strips all registration-chain fields", async () => {
      const deps = mkDeps([
        {
          target_api: "wlan_bpf_filter_offload_handler",
          runtime_trigger: "Incoming RX data packet",
          dispatch_chain: ["offloadif_data_ind", "wlan_bpf_filter_offload_handler"],
          immediate_invoker: "offloadif_data_ind",
          dispatch_site: { filePath: "offload_mgr_ext.c", line: 1107 },
          confidence: 1.0,
          registrar: "wlan_bpf_enable_data_path",
          registration_api: "offldmgr_register_data_offload",
          registration_site: "bpf_init.c:42",
          callback_registration_function: "wlan_bpf_register_callback",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "why_api_invoked", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNoRegistrationChainFields(row)
      // Verify runtime fields are still present
      expect(row.runtime_trigger_event_description).toBe("Incoming RX data packet")
      expect(row.runtime_immediate_caller_api_name).toBe("offloadif_data_ind")
    })

    it("current_structure_runtime_writers_of_structure strips all registration-chain fields", async () => {
      const deps = mkDeps([
        {
          writer: "wlan_bpf_enable_data_path",
          target: "bpf_vdev_t",
          edge_kind: "writes_field",
          confidence: 0.97,
          derivation: "runtime",
          registrar: "wlan_bpf_module_init",
          registration_api: "wlan_bpf_register_writer",
          registration_site: "bpf_init.c:88",
          callback_registration_function: "wlan_bpf_register_callback",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "current_structure_runtime_writers_of_structure", snapshotId: 42, structName: "bpf_vdev_t" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNoRegistrationChainFields(row)
      expect(row.current_structure_runtime_writer_api_name).toBe("wlan_bpf_enable_data_path")
    })

    it("current_structure_runtime_readers_of_structure strips all registration-chain fields", async () => {
      const deps = mkDeps([
        {
          reader: "wlan_bpf_filter_offload_handler",
          target: "wlan_bpf_context",
          edge_kind: "reads_field",
          confidence: 0.94,
          derivation: "runtime",
          registrar: "wlan_bpf_module_init",
          registration_api: "wlan_bpf_register_reader",
          registration_site: "bpf_init.c:99",
          callback_registration_function: "wlan_bpf_register_callback",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "current_structure_runtime_readers_of_structure", snapshotId: 42, structName: "wlan_bpf_context" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNoRegistrationChainFields(row)
      expect(row.current_structure_runtime_reader_api_name).toBe("wlan_bpf_filter_offload_handler")
    })

    it("current_structure_runtime_initializers_of_structure strips all registration-chain fields", async () => {
      const deps = mkDeps([
        {
          initializer: "offload_mgr_state_init",
          target: "offload_mgr_state",
          edge_kind: "operates_on_struct",
          confidence: 0.95,
          derivation: "runtime",
          registrar: "offload_mgr_module_init",
          registration_api: "offload_mgr_register_init",
          registration_site: "offload_mgr.c:55",
          callback_registration_function: "offload_mgr_register_callback",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "current_structure_runtime_initializers_of_structure", snapshotId: 42, structName: "offload_mgr_state" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNoRegistrationChainFields(row)
      expect(row.current_structure_runtime_initializer_api_name).toBe("offload_mgr_state_init")
    })

    it("current_structure_runtime_mutators_of_structure strips all registration-chain fields", async () => {
      const deps = mkDeps([
        {
          mutator: "wlan_bpf_apply_command",
          target: "offload_mgr_state",
          edge_kind: "writes_field",
          confidence: 0.91,
          derivation: "runtime",
          registrar: "offload_mgr_module_init",
          registration_api: "offload_mgr_register_mutator",
          registration_site: "offload_mgr.c:77",
          callback_registration_function: "offload_mgr_register_callback",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "current_structure_runtime_mutators_of_structure", snapshotId: 42, structName: "offload_mgr_state" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNoRegistrationChainFields(row)
      expect(row.current_structure_runtime_mutator_api_name).toBe("wlan_bpf_apply_command")
    })

    it("find_api_timer_triggers strips all registration-chain fields", async () => {
      const deps = mkDeps([
        {
          api_name: "wlan_bpf_traffic_timer_handler",
          timer_identifier_name: "bpf_traffic_monitor_timer",
          timer_trigger_condition_description: "Periodic BPF traffic monitoring interval elapsed",
          timer_trigger_confidence_score: 0.95,
          derivation: "clangd",
          registrar: "wlan_bpf_module_init",
          registration_api: "qdf_timer_init",
          registration_site: "bpf_traffic.c:33",
          callback_registration_function: "wlan_bpf_register_timer_callback",
        },
      ])

      const res = await executeOrchestratedQuery(
        { intent: "find_api_timer_triggers", snapshotId: 42, apiName: "wlan_bpf_traffic_timer_handler" },
        deps,
      )

      expect(res.status).toBe("hit")
      const row = res.data.nodes[0] as Record<string, unknown>
      assertNoRegistrationChainFields(row)
      expect(row.current_api_runtime_timer_identifier_name).toBe("bpf_traffic_monitor_timer")
    })
  })

  describe("find_api_timer_triggers projection", () => {
    it("projects timer trigger rows to long-name frontend fields", async () => {
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
      expect(row.current_api_runtime_timer_identifier_name).toBe("bpf_traffic_monitor_timer")
      expect(row.current_api_runtime_timer_trigger_condition_description).toBe("Periodic BPF traffic monitoring interval elapsed")
      expect(row.current_api_runtime_timer_trigger_confidence_score).toBe(0.95)
      expect(row.current_api_runtime_timer_relation_derivation_source).toBe("clangd")
    })

    it("timer trigger projection output keys are all >=3-word snake_case", async () => {
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

      const row = res.data.nodes[0] as Record<string, unknown>
      for (const key of Object.keys(row)) {
        expect(key).toMatch(/^[a-z0-9]+(?:_[a-z0-9]+){2,}$/)
      }
    })

    it("find_api_timer_triggers response passes validateResponseShape", async () => {
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

      expect(validateResponseShape(res)).toEqual([])
    })
  })
})
