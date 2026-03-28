import { describe, expect, it, vi } from "vitest"
import { IndirectCallerIngestionService } from "../../../src/intelligence/db/ingestion/indirect-caller-ingestion-service.js"
import type { RuntimeCallerRow } from "../../../src/intelligence/contracts/common.js"

// ---------------------------------------------------------------------------
// WLAN-grounded runtime caller fixtures (from wlan-targets.ts ground truth)
// ---------------------------------------------------------------------------

const WLAN_RUNTIME_CALLERS: RuntimeCallerRow[] = [
  {
    targetApi: "wlan_bpf_filter_offload_handler",
    runtimeTrigger: "Incoming RX data packet from hardware matched BPF filter criteria",
    dispatchChain: ["offloadif_data_ind", "_offldmgr_protocol_data_handler", "_offldmgr_enhanced_data_handler"],
    immediateInvoker: "_offldmgr_enhanced_data_handler",
    dispatchSite: { filePath: "offload_mgr_ext.c", line: 1107 },
    confidence: 1.0,
    evidence: { sourceKind: "clangd_response", location: { filePath: "bpf_offload_int.c", line: 1093 } },
  },
  {
    targetApi: "wlan_bpf_notify_handler",
    runtimeTrigger: "BPF offload lifecycle event: offload manager transitions OFFLOAD_BPF",
    dispatchChain: ["offldmgr_deregister_data_offload", "offload_mgr notif dispatch"],
    immediateInvoker: "offload_mgr notif dispatch",
    dispatchSite: { filePath: "offload_mgr_ext.c", line: 524 },
    confidence: 0.9,
  },
  {
    targetApi: "unknown_symbol_not_in_snapshot",
    runtimeTrigger: "some trigger",
    dispatchChain: [],
    immediateInvoker: "some_fn",
    dispatchSite: { filePath: "some.c", line: 1 },
    confidence: 0.5,
  },
]

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

function mkPool(knownSymbols: string[] = ["wlan_bpf_filter_offload_handler", "wlan_bpf_notify_handler"]) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO runtime_observation")) return { rows: [] }
      if (sql.includes("BEGIN") || sql.includes("COMMIT") || sql.includes("ROLLBACK")) return { rows: [] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT name FROM symbol")) {
        const name = params?.[1] as string
        return { rows: knownSymbols.includes(name) ? [{ name }] : [] }
      }
      return { rows: [] }
    }),
    connect: vi.fn(async () => client),
  } as unknown as import("pg").Pool
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IndirectCallerIngestionService", () => {
  it("parseRuntimeCallers returns provided records directly", async () => {
    const pool = mkPool()
    const svc = new IndirectCallerIngestionService(pool)
    const batch = await svc.parseRuntimeCallers({
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      records: WLAN_RUNTIME_CALLERS,
    })
    expect(batch.rows).toHaveLength(3)
    expect(batch.rows[0]!.targetApi).toBe("wlan_bpf_filter_offload_handler")
  })

  it("parseRuntimeCallers returns empty batch when no records provided", async () => {
    const pool = mkPool()
    const svc = new IndirectCallerIngestionService(pool)
    const batch = await svc.parseRuntimeCallers({
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
    })
    expect(batch.rows).toHaveLength(0)
  })

  it("linkToSymbols resolves known WLAN symbols and flags unknown ones", async () => {
    const pool = mkPool()
    const svc = new IndirectCallerIngestionService(pool)
    const batch = { rows: WLAN_RUNTIME_CALLERS }
    const report = await svc.linkToSymbols(42, batch)
    expect(report.linked).toHaveLength(2)
    expect(report.unresolved).toHaveLength(1)
    expect(report.unresolved[0]!.targetApi).toBe("unknown_symbol_not_in_snapshot")
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toContain("unknown_symbol_not_in_snapshot")
  })

  it("linkToSymbols returns empty report for empty batch", async () => {
    const pool = mkPool()
    const svc = new IndirectCallerIngestionService(pool)
    const report = await svc.linkToSymbols(42, { rows: [] })
    expect(report.linked).toHaveLength(0)
    expect(report.unresolved).toHaveLength(0)
    expect(report.warnings).toHaveLength(0)
  })

  it("persistRuntimeChains writes linked rows and includes unresolved warnings", async () => {
    const pool = mkPool()
    const svc = new IndirectCallerIngestionService(pool)
    const linked = {
      linked: WLAN_RUNTIME_CALLERS.slice(0, 2),
      unresolved: WLAN_RUNTIME_CALLERS.slice(2),
      warnings: ["symbol not found in snapshot 42: unknown_symbol_not_in_snapshot"],
    }
    const report = await svc.persistRuntimeChains(42, linked)
    expect(report.snapshotId).toBe(42)
    expect(report.inserted.runtimeCallers).toBe(2)
    expect(report.warnings).toContain("symbol not found in snapshot 42: unknown_symbol_not_in_snapshot")
  })

  it("persistRuntimeChains handles empty linked set without error", async () => {
    const pool = mkPool()
    const svc = new IndirectCallerIngestionService(pool)
    const report = await svc.persistRuntimeChains(42, { linked: [], unresolved: [], warnings: [] })
    expect(report.inserted.runtimeCallers).toBe(0)
    expect(report.warnings).toHaveLength(0)
  })

  it("full pipeline: parse -> link -> persist produces correct counts for WLAN ground truth", async () => {
    const pool = mkPool()
    const svc = new IndirectCallerIngestionService(pool)
    const batch = await svc.parseRuntimeCallers({
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      records: WLAN_RUNTIME_CALLERS,
    })
    const linkReport = await svc.linkToSymbols(42, batch)
    const ingestReport = await svc.persistRuntimeChains(42, linkReport)
    expect(ingestReport.inserted.runtimeCallers).toBe(2)
    expect(ingestReport.warnings.length).toBeGreaterThan(0)
  })
})
