import { describe, expect, it, vi } from "vitest"
import { PostgresDbLookupService } from "../../../src/intelligence/db/postgres/lookup-service.js"
import type { QueryRequest } from "../../../src/intelligence/contracts/orchestrator.js"

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

function mkPool(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as import("pg").Pool
}

const BASE_SNAP = 42

// ---------------------------------------------------------------------------
// Helper to build a minimal valid request
// ---------------------------------------------------------------------------

function req(overrides: Partial<QueryRequest>): QueryRequest {
  return {
    intent: "who_calls_api",
    snapshotId: BASE_SNAP,
    apiName: "wlan_bpf_filter_offload_handler",
    ...overrides,
  } as QueryRequest
}

// ---------------------------------------------------------------------------
// Tests — one per intent group
// ---------------------------------------------------------------------------

describe("PostgresDbLookupService", () => {
  it("returns hit=true when rows exist for who_calls_api", async () => {
    const pool = mkPool([{ caller: "wlan_bpf_enable_data_path", callee: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "who_calls_api" }))
    expect(res.hit).toBe(true)
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.caller).toBe("wlan_bpf_enable_data_path")
  })

  it("returns hit=false when no rows for who_calls_api", async () => {
    const pool = mkPool([])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "who_calls_api" }))
    expect(res.hit).toBe(false)
    expect(res.rows).toHaveLength(0)
  })

  it("who_calls_api_at_runtime uses same query path as who_calls_api", async () => {
    const pool = mkPool([{ caller: "offloadif_data_ind", callee: "wlan_bpf_filter_offload_handler", edge_kind: "indirect_calls", confidence: 0.9, derivation: "runtime" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "who_calls_api_at_runtime" }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("dst_symbol_name = $2"),
      expect.arrayContaining([BASE_SNAP, "wlan_bpf_filter_offload_handler"]),
    )
  })

  it("what_api_calls queries by src_symbol_name", async () => {
    const pool = mkPool([{ caller: "wlan_bpf_filter_offload_handler", callee: "offldmgr_register_data_offload", edge_kind: "calls", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "what_api_calls" }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_symbol_name = $2"),
      expect.arrayContaining([BASE_SNAP, "wlan_bpf_filter_offload_handler"]),
    )
  })

  it("why_api_invoked queries runtime_observation table", async () => {
    const pool = mkPool([{ target_api: "wlan_bpf_filter_offload_handler", runtime_trigger: "Incoming RX data packet", dispatch_chain: [], immediate_invoker: "_offldmgr_enhanced_data_handler", confidence: 1.0 }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "why_api_invoked" }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("runtime_observation"),
      expect.anything(),
    )
  })

  it("show_registration_chain queries registers_callback edges", async () => {
    const pool = mkPool([{ registrar: "wlan_bpf_enable_data_path", callback: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "show_registration_chain" }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("registers_callback"),
      expect.anything(),
    )
  })

  it("find_callback_registrars queries registers_callback edges", async () => {
    const pool = mkPool([{ registrar: "wlan_bpf_enable_data_path", callback: "wlan_bpf_filter_offload_handler", edge_kind: "registers_callback", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "find_callback_registrars" }))
    expect(res.hit).toBe(true)
  })

  it("show_dispatch_sites queries dispatches_to edges by src", async () => {
    const pool = mkPool([{ dispatcher: "_offldmgr_enhanced_data_handler", target: "wlan_bpf_filter_offload_handler", edge_kind: "dispatches_to", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "show_dispatch_sites" }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_symbol_name = $2"),
      expect.anything(),
    )
  })

  it("where_struct_initialized queries operates_on_struct by structName", async () => {
    const pool = mkPool([{ initializer: "wlan_bpf_offload_vdev_init", struct_name: "bpf_vdev_t", edge_kind: "operates_on_struct", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "where_struct_initialized", structName: "bpf_vdev_t", apiName: undefined }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("operates_on_struct"),
      expect.arrayContaining(["bpf_vdev_t"]),
    )
  })

  it("where_struct_modified queries writes_field by structName", async () => {
    const pool = mkPool([{ writer: "wlan_bpf_enable_data_path", target: "bpf_vdev_t", edge_kind: "writes_field", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "where_struct_modified", structName: "bpf_vdev_t", apiName: undefined }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("writes_field"),
      expect.arrayContaining(["bpf_vdev_t"]),
    )
  })

  it("find_struct_owners queries operates_on_struct + writes_field", async () => {
    const pool = mkPool([{ owner: "wlan_bpf_enable_data_path", struct_name: "bpf_vdev_t", edge_kind: "operates_on_struct", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "find_struct_owners", structName: "bpf_vdev_t", apiName: undefined }))
    expect(res.hit).toBe(true)
  })

  it("find_struct_readers queries reads_field", async () => {
    const pool = mkPool([{ reader: "wlan_bpf_traffic_timer_handler", target: "bpf_vdev_t", edge_kind: "reads_field", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "find_struct_readers", structName: "bpf_vdev_t", apiName: undefined }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("reads_field"),
      expect.anything(),
    )
  })

  it("find_struct_writers queries writes_field", async () => {
    const pool = mkPool([{ writer: "wlan_bpf_enable_data_path", target: "bpf_vdev_t", edge_kind: "writes_field", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "find_struct_writers", structName: "bpf_vdev_t", apiName: undefined }))
    expect(res.hit).toBe(true)
  })

  it("find_field_access_path queries by fieldName", async () => {
    const pool = mkPool([{ accessor: "wlan_bpf_enable_data_path", field: "data_handler", edge_kind: "writes_field", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "find_field_access_path", fieldName: "data_handler", apiName: undefined }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("reads_field"),
      expect.arrayContaining(["data_handler"]),
    )
  })

  it("find_api_by_log_pattern queries symbol table with ILIKE", async () => {
    const pool = mkPool([{ api_name: "wlan_bpf_filter_offload_handler", file_path: "bpf_offload.c", line: 83, kind: "function" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "find_api_by_log_pattern", pattern: "bpf_filter", apiName: undefined }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ILIKE"),
      expect.arrayContaining([BASE_SNAP, "%bpf_filter%"]),
    )
  })

  it("show_runtime_flow_for_trace queries by traceId", async () => {
    const pool = mkPool([{ target_api: "wlan_bpf_filter_offload_handler", runtime_trigger: "RX packet", dispatch_chain: [], immediate_invoker: "_offldmgr_enhanced_data_handler", confidence: 1.0 }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "show_runtime_flow_for_trace", traceId: "trace-001", apiName: undefined }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("trace_id"),
      expect.arrayContaining(["trace-001"]),
    )
  })

  it("show_api_runtime_observations queries runtime_observation by apiName", async () => {
    const pool = mkPool([{ target_api: "wlan_bpf_filter_offload_handler", runtime_trigger: "RX packet", dispatch_chain: [], immediate_invoker: "_offldmgr_enhanced_data_handler", confidence: 1.0 }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "show_api_runtime_observations" }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("target_api = $2"),
      expect.arrayContaining(["wlan_bpf_filter_offload_handler"]),
    )
  })

  it("show_cross_module_path queries by srcApi and dstApi", async () => {
    const pool = mkPool([{ src: "offloadif_data_ind", dst: "wlan_bpf_filter_offload_handler", edge_kind: "calls", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "show_cross_module_path", srcApi: "offloadif_data_ind", dstApi: "wlan_bpf_filter_offload_handler", apiName: undefined }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_symbol_name = $2"),
      expect.arrayContaining(["offloadif_data_ind", "wlan_bpf_filter_offload_handler"]),
    )
  })

  it("show_hot_call_paths queries calls/indirect_calls by src", async () => {
    const pool = mkPool([{ caller: "wlan_bpf_filter_offload_handler", callee: "offldmgr_register_data_offload", edge_kind: "calls", confidence: 1.0, derivation: "clangd" }])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup(req({ intent: "show_hot_call_paths" }))
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("src_symbol_name = $2"),
      expect.anything(),
    )
  })

  it("returns hit=false for unknown intent gracefully", async () => {
    const pool = mkPool([])
    const svc = new PostgresDbLookupService(pool)
    // force an unknown intent via cast
    const res = await svc.lookup({ intent: "unknown_intent" as never, snapshotId: BASE_SNAP })
    expect(res.hit).toBe(false)
    expect(pool.query).not.toHaveBeenCalled()
  })
})
