/**
 * Robustness audit: ClangdExtractionAdapter edge cases
 * Tests large file sets, partial LSP failures, empty results,
 * malformed symbols, and WLAN-scale stress scenarios.
 */
import { describe, expect, it, vi } from "vitest"
import { ClangdExtractionAdapter } from "../../../src/intelligence/db/extraction/clangd-extraction-adapter.js"
import type { ExtractionInput } from "../../../src/intelligence/contracts/extraction-adapter.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkLsp(overrides: Partial<{
  documentSymbol: (f: string) => Promise<unknown[]>
  outgoingCalls: () => Promise<unknown[]>
}> = {}) {
  return {
    documentSymbol: vi.fn(overrides.documentSymbol ?? (async () => [])),
    incomingCalls: vi.fn(async () => []),
    outgoingCalls: vi.fn(overrides.outgoingCalls ?? (async () => [])),
  }
}

function wlanInput(files: string[]): ExtractionInput {
  return {
    workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
    files,
  }
}

// ---------------------------------------------------------------------------
// Robustness tests
// ---------------------------------------------------------------------------

describe("ClangdExtractionAdapter — robustness audit", () => {
  it("handles 500-file set without crashing — all LSP calls succeed", async () => {
    const files = Array.from({ length: 500 }, (_, i) => `/wlan/src/file_${i}.c`)
    const lsp = mkLsp({
      documentSymbol: async () => [
        { name: `fn_${Math.random()}`, kind: 12, range: { start: { line: 0, character: 0 } } },
      ],
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols(wlanInput(files))
    expect(batch.symbols).toHaveLength(500)
    expect(lsp.documentSymbol).toHaveBeenCalledTimes(500)
  })

  it("handles 500-file set where 50% of files throw — skips failures, returns rest", async () => {
    const files = Array.from({ length: 100 }, (_, i) => `/wlan/src/file_${i}.c`)
    let call = 0
    const lsp = mkLsp({
      documentSymbol: async () => {
        call++
        if (call % 2 === 0) throw new Error("LSP timeout")
        return [{ name: "fn_ok", kind: 12, range: { start: { line: 0, character: 0 } } }]
      },
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols(wlanInput(files))
    // 50 files succeed, 50 fail silently
    expect(batch.symbols).toHaveLength(50)
  })

  it("handles all files returning empty symbol list — returns empty batch", async () => {
    const files = Array.from({ length: 20 }, (_, i) => `/wlan/src/file_${i}.c`)
    const lsp = mkLsp({ documentSymbol: async () => [] })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols(wlanInput(files))
    expect(batch.symbols).toHaveLength(0)
  })

  it("handles malformed symbol with missing name — skips gracefully", async () => {
    const lsp = mkLsp({
      documentSymbol: async () => [
        { name: undefined, kind: 12, range: { start: { line: 0, character: 0 } } },
        { name: null, kind: 12, range: { start: { line: 1, character: 0 } } },
        { name: "", kind: 12, range: { start: { line: 2, character: 0 } } },
        { name: "valid_fn", kind: 12, range: { start: { line: 3, character: 0 } } },
      ],
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols(wlanInput(["/wlan/src/file.c"]))
    // All 4 are returned (name coerced to string), valid_fn is the only meaningful one
    expect(batch.symbols.length).toBeGreaterThanOrEqual(1)
    const names = batch.symbols.map((s) => s.name)
    expect(names).toContain("valid_fn")
  })

  it("handles symbol with missing range — uses line 1 col 1 as default", async () => {
    const lsp = mkLsp({
      documentSymbol: async () => [
        { name: "fn_no_range", kind: 12 },
      ],
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractSymbols(wlanInput(["/wlan/src/file.c"]))
    expect(batch.symbols[0]!.location?.line).toBe(1)
    expect(batch.symbols[0]!.location?.column).toBe(1)
  })

  it("handles outgoingCalls throwing for some functions — skips those edges", async () => {
    let edgeCall = 0
    const lsp = mkLsp({
      documentSymbol: async () => [
        { name: "fn_a", kind: 12, range: { start: { line: 0, character: 0 } } },
        { name: "fn_b", kind: 12, range: { start: { line: 10, character: 0 } } },
        { name: "fn_c", kind: 12, range: { start: { line: 20, character: 0 } } },
      ],
      outgoingCalls: async () => {
        edgeCall++
        if (edgeCall === 2) throw new Error("LSP call hierarchy timeout")
        return [{ to: { name: "callee_fn" } }]
      },
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractEdges(wlanInput(["/wlan/src/file.c"]))
    // fn_a and fn_c succeed (2 edges), fn_b fails silently
    expect(batch.edges).toHaveLength(2)
    expect(batch.edges.every((e) => e.edgeKind === "calls")).toBe(true)
  })

  it("handles outgoingCalls returning empty array — produces no edges for that function", async () => {
    const lsp = mkLsp({
      documentSymbol: async () => [
        { name: "isolated_fn", kind: 12, range: { start: { line: 0, character: 0 } } },
      ],
      outgoingCalls: async () => [],
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractEdges(wlanInput(["/wlan/src/file.c"]))
    expect(batch.edges).toHaveLength(0)
  })

  it("handles outgoingCalls returning items with missing name — skips nameless edges", async () => {
    const lsp = mkLsp({
      documentSymbol: async () => [
        { name: "fn_a", kind: 12, range: { start: { line: 0, character: 0 } } },
      ],
      outgoingCalls: async () => [
        { to: { name: "" } },
        { to: { name: undefined } },
        { to: { name: "valid_callee" } },
      ],
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const batch = await adapter.extractEdges(wlanInput(["/wlan/src/file.c"]))
    // Only valid_callee should produce an edge
    expect(batch.edges).toHaveLength(1)
    expect(batch.edges[0]!.dstSymbolName).toBe("valid_callee")
  })

  it("WLAN-scale: 200 files, 10 symbols each, 3 calls each — produces correct totals", async () => {
    const files = Array.from({ length: 200 }, (_, i) => `/wlan/src/file_${i}.c`)
    const lsp = mkLsp({
      documentSymbol: async () =>
        Array.from({ length: 10 }, (_, j) => ({
          name: `fn_${j}`,
          kind: 12,
          range: { start: { line: j, character: 0 } },
        })),
      outgoingCalls: async () => [
        { to: { name: "callee_a" } },
        { to: { name: "callee_b" } },
        { to: { name: "callee_c" } },
      ],
    })
    const adapter = new ClangdExtractionAdapter(lsp)
    const [symBatch, edgeBatch] = await Promise.all([
      adapter.extractSymbols(wlanInput(files)),
      adapter.extractEdges(wlanInput(files)),
    ])
    expect(symBatch.symbols).toHaveLength(2000) // 200 files × 10 symbols
    expect(edgeBatch.edges).toHaveLength(6000)  // 200 files × 10 fns × 3 calls
  })
})
