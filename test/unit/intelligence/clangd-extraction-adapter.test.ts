import { describe, expect, it, vi } from "vitest"
import { ClangdExtractionAdapter } from "../../../src/intelligence/db/extraction/clangd-extraction-adapter.js"
import type { ExtractionInput } from "../../../src/intelligence/contracts/extraction-adapter.js"

// ---------------------------------------------------------------------------
// Mock LSP client
// ---------------------------------------------------------------------------

function mkLsp(overrides: Partial<{
  documentSymbol: (f: string) => Promise<unknown[]>
  incomingCalls: () => Promise<unknown[]>
  outgoingCalls: () => Promise<unknown[]>
}> = {}) {
  return {
    documentSymbol: vi.fn(overrides.documentSymbol ?? (async () => [])),
    incomingCalls: vi.fn(overrides.incomingCalls ?? (async () => [])),
    outgoingCalls: vi.fn(overrides.outgoingCalls ?? (async () => [])),
  }
}

// WLAN-representative symbol fixtures
const WLAN_SYMBOLS = [
  { name: "wlan_bpf_filter_offload_handler", kind: 12, range: { start: { line: 82, character: 0 } } },
  { name: "wlan_bpf_enable_data_path", kind: 12, range: { start: { line: 200, character: 0 } } },
  { name: "bpf_vdev_t", kind: 23, range: { start: { line: 10, character: 0 } } },
  { name: "offload_type_e", kind: 10, range: { start: { line: 5, character: 0 } } },
]

const WLAN_CALLS = [
  { to: { name: "offldmgr_register_data_offload" } },
  { to: { name: "wlan_vdev_register_notif_handler" } },
]

const WLAN_INPUT: ExtractionInput = {
  workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
  files: [
    "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload.c",
    "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc/wlan/protocol/src/offloads/src/l2/bpf/bpf_offload_int.c",
  ],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClangdExtractionAdapter", () => {
  it("extractSymbols returns symbols from documentSymbol for each file", async () => {
    const lsp = mkLsp({ documentSymbol: async () => WLAN_SYMBOLS })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols(WLAN_INPUT)
    // 2 files × 4 symbols each = 8
    expect(batch.symbols).toHaveLength(8)
    expect(lsp.documentSymbol).toHaveBeenCalledTimes(2)
    const names = batch.symbols.map((s) => s.name)
    expect(names).toContain("wlan_bpf_filter_offload_handler")
    expect(names).toContain("bpf_vdev_t")
  })

  it("extractSymbols maps LSP kind 12 to function", async () => {
    const lsp = mkLsp({ documentSymbol: async () => [{ name: "my_fn", kind: 12, range: { start: { line: 0, character: 0 } } }] })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols({ ...WLAN_INPUT, files: [WLAN_INPUT.files![0]!] })
    expect(batch.symbols[0]!.kind).toBe("function")
  })

  it("extractSymbols maps LSP kind 23 to struct", async () => {
    const lsp = mkLsp({ documentSymbol: async () => [{ name: "bpf_vdev_t", kind: 23, range: { start: { line: 0, character: 0 } } }] })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols({ ...WLAN_INPUT, files: [WLAN_INPUT.files![0]!] })
    expect(batch.symbols[0]!.kind).toBe("struct")
  })

  it("extractSymbols skips files that throw", async () => {
    let call = 0
    const lsp = mkLsp({
      documentSymbol: async () => {
        call++
        if (call === 1) throw new Error("parse error")
        return WLAN_SYMBOLS
      },
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols(WLAN_INPUT)
    // first file skipped, second file has 4 symbols
    expect(batch.symbols).toHaveLength(4)
  })

  it("extractTypes returns only struct/enum/typedef symbols", async () => {
    const lsp = mkLsp({ documentSymbol: async () => WLAN_SYMBOLS })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractTypes({ ...WLAN_INPUT, files: [WLAN_INPUT.files![0]!] })
    // bpf_vdev_t (struct) + offload_type_e (enum) = 2
    expect(batch.types).toHaveLength(2)
    const kinds = batch.types.map((t) => t.kind)
    expect(kinds).toContain("struct")
    expect(kinds).toContain("enum")
  })

  it("extractEdges returns calls edges from outgoingCalls for function symbols", async () => {
    const lsp = mkLsp({
      documentSymbol: async () => [
        { name: "wlan_bpf_filter_offload_handler", kind: 12, range: { start: { line: 82, character: 0 } } },
      ],
      outgoingCalls: async () => WLAN_CALLS,
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractEdges({ ...WLAN_INPUT, files: [WLAN_INPUT.files![0]!] })
    expect(batch.edges).toHaveLength(2)
    expect(batch.edges[0]!.edgeKind).toBe("calls")
    expect(batch.edges[0]!.srcSymbolName).toBe("wlan_bpf_filter_offload_handler")
    expect(batch.edges[0]!.dstSymbolName).toBe("offldmgr_register_data_offload")
    expect(batch.edges[0]!.derivation).toBe("clangd")
  })

  it("extractEdges skips non-function symbols", async () => {
    const lsp = mkLsp({
      documentSymbol: async () => [
        { name: "bpf_vdev_t", kind: 23, range: { start: { line: 10, character: 0 } } },
      ],
      outgoingCalls: async () => WLAN_CALLS,
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractEdges({ ...WLAN_INPUT, files: [WLAN_INPUT.files![0]!] })
    expect(batch.edges).toHaveLength(0)
    expect(lsp.outgoingCalls).not.toHaveBeenCalled()
  })

  it("materializeSnapshot returns dry-run report when no pgPool", async () => {
    const lsp = mkLsp()
    const adapter = new ClangdExtractionAdapter(lsp)
    const report = await adapter.materializeSnapshot(42, {
      symbolBatch: { symbols: [] },
      typeBatch: { types: [], fields: [] },
      edgeBatch: { edges: [] },
    })
    expect(report.snapshotId).toBe(42)
    expect(report.warnings[0]).toContain("dry run")
  })

  it("materializeSnapshot writes to Postgres when pgPool provided", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as import("pg").Pool
    const lsp = mkLsp()
    const adapter = new ClangdExtractionAdapter(lsp, pool)
    const report = await adapter.materializeSnapshot(42, {
      symbolBatch: { symbols: [{ kind: "function", name: "wlan_bpf_filter_offload_handler" }] },
      typeBatch: { types: [], fields: [] },
      edgeBatch: { edges: [] },
    })
    expect(report.snapshotId).toBe(42)
    expect(report.inserted.symbols).toBe(1)
  })
})
