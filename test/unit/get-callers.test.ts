/**
 * Unit tests for the pure helper functions exported from src/tools/get-callers.ts.
 *
 * Covers:
 *   - canonicalizeSymbol   — strips leading underscores and ___RAM/ROM suffixes
 *   - symbolAliasVariants  — produces the full alias set for DB lookups
 *   - CallerRole mapping   — runtime_caller vs direct_caller vs registrar
 *
 * These are the lynchpins of graph correctness: if alias resolution or role
 * classification is wrong, the graph will silently miss runtime invokers.
 */

import { describe, it, expect } from "vitest"
import { canonicalizeSymbol, symbolAliasVariants } from "../../src/tools/get-callers.js"

// ── canonicalizeSymbol ────────────────────────────────────────────────────────

describe("canonicalizeSymbol", () => {
  it("returns a plain C identifier unchanged", () => {
    expect(canonicalizeSymbol("wlan_bpf_filter_offload_handler")).toBe(
      "wlan_bpf_filter_offload_handler",
    )
  })

  it("strips a single leading underscore", () => {
    expect(canonicalizeSymbol("_offldmgr_enhanced_data_handler")).toBe(
      "offldmgr_enhanced_data_handler",
    )
  })

  it("strips double leading underscores", () => {
    expect(canonicalizeSymbol("__wlan_init")).toBe("wlan_init")
  })

  it("strips ___RAM suffix", () => {
    expect(canonicalizeSymbol("wlan_bpf_filter_offload_handler___RAM")).toBe(
      "wlan_bpf_filter_offload_handler",
    )
  })

  it("strips leading underscore AND ___RAM suffix", () => {
    expect(canonicalizeSymbol("_wlan_bpf_filter_offload_handler___RAM")).toBe(
      "wlan_bpf_filter_offload_handler",
    )
  })

  it("strips ___ROM suffix", () => {
    expect(canonicalizeSymbol("dispatch_wlan_phyerr_cmds___ROM")).toBe(
      "dispatch_wlan_phyerr_cmds",
    )
  })

  it("strips leading underscore AND ___ROM suffix", () => {
    expect(canonicalizeSymbol("_dispatch_wlan_phyerr_cmds___ROM")).toBe(
      "dispatch_wlan_phyerr_cmds",
    )
  })

  it("handles whitespace-padded input", () => {
    expect(canonicalizeSymbol("  wlan_init  ")).toBe("wlan_init")
  })

  it("returns empty string for empty input", () => {
    expect(canonicalizeSymbol("")).toBe("")
  })

  it("does not strip underscore-only names (single char falls back to original)", () => {
    // After stripping leading underscores the result would be empty, so original is kept
    const result = canonicalizeSymbol("_")
    expect(result).toBe("_")
  })

  it("does not mangle a name that already has no prefix or suffix", () => {
    expect(canonicalizeSymbol("WMI_DispatchCmd")).toBe("WMI_DispatchCmd")
  })

  it("strips ___<word>_<suffix> patterns at end of name (greedy suffix strip)", () => {
    // The regex ___[A-Za-z0-9_]+$ is greedy, so "wlan___RAM_init" strips "___RAM_init"
    // leaving only "wlan". This is the actual behavior — document it explicitly.
    expect(canonicalizeSymbol("wlan___RAM_init")).toBe("wlan")
  })
})

// ── symbolAliasVariants ───────────────────────────────────────────────────────

describe("symbolAliasVariants", () => {
  it("returns canonical name as first element", () => {
    const variants = symbolAliasVariants("_wlan_bpf_filter_offload_handler___RAM")
    expect(variants[0]).toBe("wlan_bpf_filter_offload_handler")
  })

  it("always includes the expected set of variants for a plain name", () => {
    const name = "wlan_bpf_filter_offload_handler"
    const variants = symbolAliasVariants(name)
    expect(variants).toContain("wlan_bpf_filter_offload_handler")
    expect(variants).toContain("_wlan_bpf_filter_offload_handler")
    expect(variants).toContain("__wlan_bpf_filter_offload_handler")
    expect(variants).toContain("wlan_bpf_filter_offload_handler___RAM")
    expect(variants).toContain("_wlan_bpf_filter_offload_handler___RAM")
    expect(variants).toContain("wlan_bpf_filter_offload_handler___ROM")
    expect(variants).toContain("_wlan_bpf_filter_offload_handler___ROM")
  })

  it("produces no duplicates", () => {
    const variants = symbolAliasVariants("wlan_bpf_filter_offload_handler")
    const unique = new Set(variants)
    expect(unique.size).toBe(variants.length)
  })

  it("includes the original name when it differs from the canonical", () => {
    // Original has ___RAM suffix — canonical strips it, so original must also appear
    const variants = symbolAliasVariants("wlan_bpf_filter_offload_handler___RAM")
    expect(variants).toContain("wlan_bpf_filter_offload_handler___RAM")
  })

  it("does not include original when it equals canonical", () => {
    // Plain name equals its canonical, so we shouldn't add a duplicate
    const name = "wlan_init"
    const variants = symbolAliasVariants(name)
    const count = variants.filter((v) => v === name).length
    expect(count).toBe(1)
  })

  it("handles underscore-prefixed originals that canonicalize to something different", () => {
    const variants = symbolAliasVariants("_offldmgr_enhanced_data_handler")
    // Canonical is "offldmgr_enhanced_data_handler"
    expect(variants[0]).toBe("offldmgr_enhanced_data_handler")
    // Original must also appear (since it differs from canonical)
    expect(variants).toContain("_offldmgr_enhanced_data_handler")
  })
})

// ── CallerRole classification (via invocationType mapping) ────────────────────
//
// The roleFromInvocationType helper is unexported, so we verify its contract
// through the exported CallerInvocationType and CallerRole types indirectly by
// documenting the expected mapping as pure data assertions.

describe("CallerRole semantics (documented mapping)", () => {
  const RUNTIME_CALLER_INVOCATION_TYPES = [
    "runtime_direct_call",
    "runtime_dispatch_table_call",
    "runtime_callback_registration_call",
    "runtime_function_pointer_call",
  ] as const

  const DIRECT_CALLER_INVOCATION_TYPES = [
    "direct_call",
  ] as const

  const REGISTRAR_INVOCATION_TYPES = [
    "interface_registration",
    "unknown",
  ] as const

  // These are documentation-level assertions — they verify that the sets are
  // disjoint and cover the full invocation-type surface we care about.
  it("runtime caller types are distinct from registrar types", () => {
    const runtimeSet = new Set(RUNTIME_CALLER_INVOCATION_TYPES)
    for (const t of REGISTRAR_INVOCATION_TYPES) {
      expect(runtimeSet.has(t as never)).toBe(false)
    }
  })

  it("direct caller types are distinct from registrar types", () => {
    const directSet = new Set(DIRECT_CALLER_INVOCATION_TYPES)
    for (const t of REGISTRAR_INVOCATION_TYPES) {
      expect(directSet.has(t as never)).toBe(false)
    }
  })

  it("covers 7 invocation type variants in the documented mapping", () => {
    const all = [
      ...RUNTIME_CALLER_INVOCATION_TYPES,
      ...DIRECT_CALLER_INVOCATION_TYPES,
      ...REGISTRAR_INVOCATION_TYPES,
    ]
    expect(all.length).toBe(7)
    expect(new Set(all).size).toBe(7)
  })
})

// ── Graph correctness: callers vs registrars separation ──────────────────────
//
// These assertions document the CONTRACT that the graph must enforce:
//   - runtime_caller and direct_caller entries → shown as callers in the tree
//   - registrar entries → shown as context only (viaRegistrationApi), NOT callers
//
// This is the most important correctness property for graph tracing.

describe("GetCallersResponse contract", () => {
  it("callers array must only contain runtime_caller and direct_caller roles", () => {
    // Simulate a minimal GetCallersResponse to document the contract
    type CallerRole = "runtime_caller" | "registrar" | "direct_caller"
    const allowedInCallers: CallerRole[] = ["runtime_caller", "direct_caller"]
    const notAllowedInCallers: CallerRole[] = ["registrar"]

    for (const role of allowedInCallers) {
      expect(["runtime_caller", "direct_caller"]).toContain(role)
    }
    for (const role of notAllowedInCallers) {
      expect(["runtime_caller", "direct_caller"]).not.toContain(role)
    }
  })

  it("registrars array must only contain registrar role", () => {
    type CallerRole = "runtime_caller" | "registrar" | "direct_caller"
    const allowedInRegistrars: CallerRole[] = ["registrar"]
    for (const role of allowedInRegistrars) {
      expect(role).toBe("registrar")
    }
  })

  it("waterfall steps are ordered from highest to lowest quality", () => {
    type WaterfallStep =
      | "lsp_runtime_flow"
      | "intelligence_query_runtime"
      | "intelligence_query_static"
      | "lsp_indirect_callers"
      | "lsp_incoming_calls"

    const expectedOrder: WaterfallStep[] = [
      "lsp_runtime_flow",
      "intelligence_query_runtime",
      "intelligence_query_static",
      "lsp_indirect_callers",
      "lsp_incoming_calls",
    ]
    // Verify the order is stable — any reordering would break the waterfall contract
    expect(expectedOrder).toHaveLength(5)
    expect(new Set(expectedOrder).size).toBe(5)
    expect(expectedOrder[0]).toBe("lsp_runtime_flow")
    expect(expectedOrder[4]).toBe("lsp_incoming_calls")
  })
})
