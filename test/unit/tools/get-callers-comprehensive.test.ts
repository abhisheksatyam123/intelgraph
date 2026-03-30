/**
 * get-callers-comprehensive.test.ts
 *
 * Comprehensive test suite for the unified get_callers waterfall.
 *
 * Coverage map:
 *   A. canonicalizeSymbol / symbolAliasVariants helpers
 *   B. Waterfall step ordering and fallthrough
 *      B1. Step 1 (lsp_runtime_flow) succeeds → stops
 *      B2. Step 1 fails → Step 2 (intelligence_query_runtime) succeeds → stops
 *      B3. Steps 1+2 fail → Step 3 (intelligence_query_static) succeeds → stops
 *      B4. Steps 1+2+3 fail → Step 4 (lsp_indirect_callers) succeeds → stops
 *      B5. Steps 1–4 fail → Step 5 (lsp_incoming_calls) succeeds → stops
 *      B6. All steps fail → source="none", empty callers
 *   C. DB step gating
 *      C1. intelligenceDeps=null → DB steps skipped entirely
 *      C2. snapshotId=0 → DB steps skipped entirely
 *      C3. snapshotId missing → DB steps skipped
 *   D. intelligence_query_runtime (Step 2) — all invocation types
 *      D1. runtime_direct_call → callerRole=runtime_caller
 *      D2. runtime_dispatch_table_call → callerRole=runtime_caller
 *      D3. runtime_callback_registration_call → callerRole=runtime_caller
 *      D4. runtime_function_pointer_call → callerRole=runtime_caller
 *      D5. unknown type → callerRole=registrar (goes to registrars[])
 *   E. intelligence_query_static (Step 3) — edge kind mapping
 *      E1. edge_kind=calls → direct_call → callerRole=direct_caller
 *      E2. edge_kind=indirect_calls → interface_registration → callerRole=registrar
 *      E3. edge_kind=registers_callback → interface_registration → callerRole=registrar
 *      E4. edge_kind=dispatches_to → interface_registration → callerRole=registrar
 *      E5. mixed edges → callers[] and registrars[] split correctly
 *   F. lsp_indirect_callers (Step 4) — connectionKind mapping
 *      F1. timer_callback → runtime_callback_registration_call
 *      F2. hw_interrupt → runtime_function_pointer_call
 *      F3. ring_signal → runtime_function_pointer_call
 *      F4. api_call → direct_call → callerRole=direct_caller
 *      F5. multiple nodes: some with dispatch, some without
 *   G. lsp_incoming_calls (Step 5) — edge cases
 *      G1. range fallback (no selectionRange)
 *      G2. non-file:// URI passthrough
 *      G3. multiple callers
 *   H. Symbol resolution fallbacks
 *      H1. prepareCallHierarchy returns empty → hover fallback
 *      H2. prepareCallHierarchy + hover both fail → symbol@file:line fallback
 *      H3. prepareCallHierarchy throws → hover fallback
 *   I. Response shape invariants
 *      I1. callers[] never contains registrar role
 *      I2. registrars[] never contains runtime_caller or direct_caller role
 *      I3. callers sorted by confidence desc, then name asc
 *      I4. deduplication: same name+invocationType → one entry
 *      I5. provenance.stepsAttempted always includes all attempted steps in order
 *   J. DB cleared / empty snapshot scenario
 *      J1. Both DB steps return not_found → falls through to lsp_indirect_callers
 *   K. Alias variants
 *      K1. aliasVariantsTriedForDb=true when snapshotId provided
 *      K2. aliasVariantsTried contains all expected variants
 *      K3. aliasVariantsTriedForDb=false when no snapshotId
 *   L. WLAN firmware canonical scenarios (end-to-end)
 *      L1. GTK offload handler via timer_callback
 *      L2. WMI dispatch table handler
 *      L3. HW interrupt handler
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  canonicalizeSymbol,
  symbolAliasVariants,
  resolveCallers,
  type GetCallersResponse,
  type CallerEntry,
} from "../../../src/tools/get-callers.js"

// ── Mock executeOrchestratedQuery ─────────────────────────────────────────────

vi.mock("../../../src/intelligence/index.js", () => ({
  executeOrchestratedQuery: vi.fn(async () => ({
    status: "not_found",
    data: { nodes: [], edges: [] },
    provenance: { path: "db_miss_deterministic", deterministicAttempts: [], llmUsed: false },
  })),
  validateQueryRequest: vi.fn(() => ({ ok: true, errors: [] })),
  QUERY_INTENTS: ["who_calls_api", "who_calls_api_at_runtime", "what_api_calls"],
}))

import { executeOrchestratedQuery } from "../../../src/intelligence/index.js"
const mockDb = vi.mocked(executeOrchestratedQuery)

// ── Shared not_found DB response ──────────────────────────────────────────────

const DB_NOT_FOUND = {
  snapshotId: -1,
  intent: "who_calls_api" as const,
  status: "not_found" as const,
  data: { nodes: [], edges: [] },
  provenance: { path: "db_miss_deterministic" as const, deterministicAttempts: [], llmUsed: false },
}

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeClient(overrides: Partial<{
  prepareCallHierarchy: any
  hover: any
  incomingCalls: any
  root: string
}> = {}) {
  return {
    root: overrides.root ?? "/workspace",
    openFile: vi.fn(async () => true),
    prepareCallHierarchy: overrides.prepareCallHierarchy ?? vi.fn(async () => [
      { name: "target_fn", uri: "file:///workspace/src/target.c", selectionRange: { start: { line: 9 } } },
    ]),
    hover: overrides.hover ?? vi.fn(async () => ({ contents: { value: "function target_fn" } })),
    incomingCalls: overrides.incomingCalls ?? vi.fn(async () => []),
    references: vi.fn(async () => []),
  } as any
}

function makeBackend(overrides: Partial<{
  collectIndirectCallers: any
  reasonEngine: any
}> = {}) {
  return {
    patterns: {
      collectIndirectCallers: overrides.collectIndirectCallers ?? vi.fn(async () => ({
        seed: null,
        nodes: [],
      })),
      formatIndirectCallerTree: vi.fn(() => ""),
    },
    reasonEngine: overrides.reasonEngine ?? {
      run: vi.fn(async () => ({
        reasonPaths: [],
        cacheHit: false,
        usedLlm: false,
        cacheMismatchedFiles: [],
        rejected: false,
      })),
    },
    indirectCallerCache: {
      computeKey: vi.fn(() => "key"),
      read: vi.fn(() => null),
      write: vi.fn(),
    },
  } as any
}

function makeTracker() {
  return {
    state: { isReady: true },
    statusSuffix: () => "",
    fileSuffix: () => "",
    fileState: () => "idle",
    fileStates: new Map(),
  } as any
}

const BASE = { file: "/workspace/src/target.c", line: 10, character: 5 }

// ── DB response builders ──────────────────────────────────────────────────────

function dbRuntimeHit(nodes: Record<string, unknown>[], intent = "who_calls_api_at_runtime" as const) {
  return {
    snapshotId: 1,
    intent,
    status: "hit" as const,
    data: { nodes, edges: [] },
    provenance: { path: "db_hit" as const, deterministicAttempts: [], llmUsed: false },
  }
}

function dbStaticHit(nodes: Record<string, unknown>[], edges: Record<string, unknown>[], intent = "who_calls_api" as const) {
  return {
    snapshotId: 1,
    intent,
    status: "hit" as const,
    data: { nodes, edges },
    provenance: { path: "db_hit" as const, deterministicAttempts: [], llmUsed: false },
  }
}

// ── A. canonicalizeSymbol / symbolAliasVariants ───────────────────────────────

describe("A. canonicalizeSymbol", () => {
  it("strips single leading underscore", () => {
    expect(canonicalizeSymbol("_foo")).toBe("foo")
  })
  it("strips double leading underscore", () => {
    expect(canonicalizeSymbol("__foo")).toBe("foo")
  })
  it("strips triple leading underscore", () => {
    expect(canonicalizeSymbol("___foo")).toBe("foo")
  })
  it("strips ___RAM suffix", () => {
    expect(canonicalizeSymbol("foo___RAM")).toBe("foo")
  })
  it("strips ___PATCH suffix", () => {
    expect(canonicalizeSymbol("foo___PATCH")).toBe("foo")
  })
  it("strips both leading _ and ___RAM", () => {
    expect(canonicalizeSymbol("_foo___RAM")).toBe("foo")
    expect(canonicalizeSymbol("__wlan_bpf_filter_offload_handler___RAM")).toBe("wlan_bpf_filter_offload_handler")
  })
  it("leaves canonical names unchanged", () => {
    expect(canonicalizeSymbol("wlan_bpf_filter_offload_handler")).toBe("wlan_bpf_filter_offload_handler")
    expect(canonicalizeSymbol("main")).toBe("main")
  })
  it("handles empty string", () => {
    expect(canonicalizeSymbol("")).toBe("")
  })
  it("handles whitespace-only string", () => {
    expect(canonicalizeSymbol("  ")).toBe("")
  })
  it("preserves internal underscores", () => {
    expect(canonicalizeSymbol("wlan_bpf_enable_data_path")).toBe("wlan_bpf_enable_data_path")
  })
})

describe("A. symbolAliasVariants", () => {
  it("returns canonical name first", () => {
    expect(symbolAliasVariants("_foo___RAM")[0]).toBe("foo")
  })
  it("includes all 5 standard variants for a canonical name", () => {
    const v = symbolAliasVariants("my_handler")
    expect(v).toContain("my_handler")
    expect(v).toContain("_my_handler")
    expect(v).toContain("__my_handler")
    expect(v).toContain("my_handler___RAM")
    expect(v).toContain("_my_handler___RAM")
  })
  it("includes original name when different from canonical", () => {
    const v = symbolAliasVariants("_my_handler")
    expect(v).toContain("_my_handler")
    expect(v).toContain("my_handler")
  })
  it("does not duplicate canonical when original equals canonical", () => {
    const v = symbolAliasVariants("my_handler")
    expect(v.filter((x) => x === "my_handler").length).toBe(1)
  })
  it("handles ___RAM input — canonical is first, original included", () => {
    const v = symbolAliasVariants("my_handler___RAM")
    expect(v[0]).toBe("my_handler")
    expect(v).toContain("my_handler___RAM")
  })
})

// ── B. Waterfall step ordering ────────────────────────────────────────────────

describe("B. Waterfall step ordering", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("B1: lsp_runtime_flow succeeds → stops, source=lsp_runtime_flow", async () => {
    // prepareReasonQuery calls readFileSync(args.file) — must use a real file
    const tmpDir = mkdtempSync(join(tmpdir(), "get-callers-b1-"))
    mkdirSync(join(tmpDir, "src"), { recursive: true })
    const realFile = join(tmpDir, "src", "target.c")
    writeFileSync(realFile, "void target_fn(void) {}\n", "utf8")

    try {
      const backend = makeBackend({
        reasonEngine: {
          run: vi.fn(async () => ({
            reasonPaths: [{
              targetSymbol: "target_fn",
              invocationReason: {
                runtimeTrigger: "test trigger",
                dispatchChain: ["caller_a", "runtime_invoker", "target_fn"],
                dispatchSite: { file: "/workspace/src/dispatch.c", line: 42, snippet: "fn()" },
                registrationGate: null,
              },
              runtimeFlow: {
                targetApi: "target_fn",
                runtimeTrigger: "test trigger",
                dispatchChain: ["caller_a", "runtime_invoker", "target_fn"],
                dispatchSite: { file: "/workspace/src/dispatch.c", line: 42, snippet: "fn()" },
                immediateInvoker: "runtime_invoker",
              },
            }],
            cacheHit: true, usedLlm: false, cacheMismatchedFiles: [], rejected: false,
          })),
        },
      })
      const client = makeClient({
        prepareCallHierarchy: vi.fn(async () => [{
          name: "target_fn",
          uri: `file://${realFile}`,
          selectionRange: { start: { line: 0 } },
        }]),
      })
      const result = await resolveCallers(client, makeTracker(), backend, null, {
        file: realFile, line: 1, character: 5,
      })
      expect(result.source).toBe("lsp_runtime_flow")
      expect(result.callers[0]!.name).toBe("runtime_invoker")
      expect(result.provenance.stepsAttempted[0]).toBe("lsp_runtime_flow")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("B2: Step 1 fails → Step 2 (intelligence_query_runtime) succeeds", async () => {
    mockDb.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return dbRuntimeHit([{
          runtime_caller_api_name: "db_runtime_caller",
          runtime_caller_invocation_type_classification: "runtime_direct_call",
          runtime_relation_confidence_score: 0.9,
        }])
      }
      return DB_NOT_FOUND
    })
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.source).toBe("intelligence_query_runtime")
    expect(result.callers[0]!.name).toBe("db_runtime_caller")
    expect(result.provenance.stepsAttempted).toContain("lsp_runtime_flow")
    expect(result.provenance.stepsAttempted).toContain("intelligence_query_runtime")
  })

  it("B3: Steps 1+2 fail → Step 3 (intelligence_query_static) succeeds", async () => {
    // Step 2 returns not_found, Step 3 returns hit
    mockDb
      .mockResolvedValueOnce(DB_NOT_FOUND) // who_calls_api_at_runtime
      .mockImplementationOnce(async () => dbStaticHit(
        [
          { id: "n1", symbol: "static_caller", kind: "function", filePath: "/workspace/src/a.c", lineNumber: 5 },
          { id: "n2", symbol: "target_fn", kind: "api" },
        ],
        [{ from: "n1", to: "n2", kind: "calls", confidence: 0.8 }],
      ))

    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.source).toBe("intelligence_query_static")
    expect(result.callers[0]!.name).toBe("static_caller")
    expect(result.provenance.stepsAttempted).toContain("intelligence_query_static")
  })

  it("B4: Steps 1+2+3 fail → Step 4 (lsp_indirect_callers) succeeds", async () => {
    mockDb.mockResolvedValue(DB_NOT_FOUND)
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [{
          name: "registrar_fn",
          file: "/workspace/src/reg.c",
          line: 5,
          sourceText: "register_handler(ctx, target_fn)",
          classification: { patternName: "generic", registrationApi: "register_handler", connectionKind: "interface_registration" },
          resolvedChain: {
            confidenceLevel: "high",
            store: { containerType: "ctx_t", confidence: "high" },
            dispatch: { dispatchFunction: "dispatch_fn", dispatchFile: "/workspace/src/dispatch.c", dispatchLine: 99, confidence: "high" },
            trigger: { triggerKind: null, triggerKey: null, confidence: "low" },
          },
        }],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, {} as any, { ...BASE, snapshotId: 1 })
    expect(result.source).toBe("lsp_indirect_callers")
    expect(result.callers[0]!.name).toBe("dispatch_fn")
    expect(result.provenance.stepsAttempted).toContain("lsp_indirect_callers")
  })

  it("B5: Steps 1–4 fail → Step 5 (lsp_incoming_calls) succeeds", async () => {
    mockDb.mockResolvedValue(DB_NOT_FOUND)
    const client = makeClient({
      incomingCalls: vi.fn(async () => [{
        from: { name: "direct_caller", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 4 } } },
      }]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.source).toBe("lsp_incoming_calls")
    expect(result.callers[0]!.name).toBe("direct_caller")
    expect(result.provenance.stepsAttempted).toContain("lsp_incoming_calls")
  })

  it("B6: All steps fail → source=none, empty callers", async () => {
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), null, BASE)
    expect(result.source).toBe("none")
    expect(result.callers).toHaveLength(0)
    expect(result.registrars).toHaveLength(0)
  })
})

// ── C. DB step gating ─────────────────────────────────────────────────────────

describe("C. DB step gating", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("C1: intelligenceDeps=null → DB steps never called", async () => {
    await resolveCallers(makeClient(), makeTracker(), makeBackend(), null, { ...BASE, snapshotId: 1 })
    expect(mockDb).not.toHaveBeenCalled()
  })

  it("C2: snapshotId=0 → DB steps never called", async () => {
    await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 0 })
    expect(mockDb).not.toHaveBeenCalled()
  })

  it("C3: snapshotId not provided → DB steps never called", async () => {
    await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, BASE)
    expect(mockDb).not.toHaveBeenCalled()
  })

  it("C4: snapshotId>0 + intelligenceDeps provided → DB steps called", async () => {
    await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 5 })
    expect(mockDb).toHaveBeenCalled()
  })
})

// ── D. intelligence_query_runtime — all invocation types ─────────────────────

describe("D. intelligence_query_runtime — invocation type mapping", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  const runtimeTypes: Array<[string, string]> = [
    ["runtime_direct_call", "runtime_caller"],
    ["runtime_dispatch_table_call", "runtime_caller"],
    ["runtime_callback_registration_call", "runtime_caller"],
    ["runtime_function_pointer_call", "runtime_caller"],
  ]

  for (const [invType, expectedRole] of runtimeTypes) {
    it(`D: ${invType} → callerRole=${expectedRole}`, async () => {
      mockDb.mockImplementationOnce(async (req: any) => {
        if (req.intent === "who_calls_api_at_runtime") {
          return dbRuntimeHit([{
            runtime_caller_api_name: "caller_fn",
            runtime_caller_invocation_type_classification: invType,
            runtime_relation_confidence_score: 0.85,
          }])
        }
        return DB_NOT_FOUND
      })
      const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
      expect(result.source).toBe("intelligence_query_runtime")
      expect(result.callers).toHaveLength(1)
      expect(result.callers[0]!.callerRole).toBe(expectedRole)
      expect(result.callers[0]!.invocationType).toBe(invType)
    })
  }

  it("D5: unknown invocation type → callerRole=registrar → goes to registrars[]", async () => {
    mockDb.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return dbRuntimeHit([{
          runtime_caller_api_name: "mystery_fn",
          runtime_caller_invocation_type_classification: "some_unknown_type",
          runtime_relation_confidence_score: 0.5,
        }])
      }
      return DB_NOT_FOUND
    })
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    // unknown type → role=registrar → goes to registrars[], not callers[]
    // But the DB step returns nodes.length > 0, so it stops at intelligence_query_runtime
    expect(result.source).toBe("intelligence_query_runtime")
    // registrar role → in registrars[], not callers[]
    const allEntries = [...result.callers, ...result.registrars]
    const entry = allEntries.find((e) => e.name === "mystery_fn")
    expect(entry).toBeDefined()
    expect(entry!.callerRole).toBe("registrar")
  })

  it("D: confidence score preserved from DB row", async () => {
    mockDb.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return dbRuntimeHit([{
          runtime_caller_api_name: "caller_fn",
          runtime_caller_invocation_type_classification: "runtime_direct_call",
          runtime_relation_confidence_score: 0.73,
        }])
      }
      return DB_NOT_FOUND
    })
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.callers[0]!.confidence).toBe(0.73)
  })

  it("D: symbol names canonicalized from DB (leading underscore stripped)", async () => {
    mockDb.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return dbRuntimeHit([{
          runtime_caller_api_name: "_offldmgr_enhanced_data_handler",
          runtime_caller_invocation_type_classification: "runtime_dispatch_table_call",
          runtime_relation_confidence_score: 0.97,
        }])
      }
      return DB_NOT_FOUND
    })
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.callers[0]!.name).toBe("offldmgr_enhanced_data_handler")
  })
})

// ── E. intelligence_query_static — edge kind mapping ─────────────────────────

describe("E. intelligence_query_static — edge kind mapping", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  function staticScenario(edgeKind: string) {
    return async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") return DB_NOT_FOUND
      if (req.intent === "who_calls_api") {
        return dbStaticHit(
          [
            { id: "n1", symbol: "caller_fn", kind: "function", filePath: "/workspace/src/a.c", lineNumber: 5 },
            { id: "n2", symbol: "target_fn", kind: "api" },
          ],
          [{ from: "n1", to: "n2", kind: edgeKind, confidence: 0.75 }],
        )
      }
      return DB_NOT_FOUND
    }
  }

  it("E1: edge_kind=calls → invocationType=direct_call → callerRole=direct_caller", async () => {
    mockDb.mockImplementation(staticScenario("calls"))
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.source).toBe("intelligence_query_static")
    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.invocationType).toBe("direct_call")
    expect(result.callers[0]!.callerRole).toBe("direct_caller")
    mockDb.mockReset()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("E2: edge_kind=indirect_calls → interface_registration → callerRole=registrar", async () => {
    mockDb.mockImplementation(staticScenario("indirect_calls"))
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.source).toBe("intelligence_query_static")
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.invocationType).toBe("interface_registration")
    expect(result.registrars[0]!.callerRole).toBe("registrar")
    mockDb.mockReset()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("E3: edge_kind=registers_callback → interface_registration → callerRole=registrar", async () => {
    mockDb.mockImplementation(staticScenario("registers_callback"))
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.callerRole).toBe("registrar")
    mockDb.mockReset()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("E4: edge_kind=dispatches_to → interface_registration → callerRole=registrar", async () => {
    mockDb.mockImplementation(staticScenario("dispatches_to"))
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.callerRole).toBe("registrar")
    mockDb.mockReset()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("E5: mixed edges → callers[] and registrars[] split correctly", async () => {
    mockDb.mockImplementation(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") return DB_NOT_FOUND
      if (req.intent === "who_calls_api") {
        return dbStaticHit(
          [
            { id: "n1", symbol: "direct_fn", kind: "function", filePath: "/workspace/src/a.c", lineNumber: 1 },
            { id: "n2", symbol: "registrar_fn", kind: "function", filePath: "/workspace/src/b.c", lineNumber: 2 },
            { id: "n3", symbol: "target_fn", kind: "api" },
          ],
          [
            { from: "n1", to: "n3", kind: "calls", confidence: 0.9 },
            { from: "n2", to: "n3", kind: "registers_callback", confidence: 0.7 },
          ],
        )
      }
      return DB_NOT_FOUND
    })
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.source).toBe("intelligence_query_static")
    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.name).toBe("direct_fn")
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.name).toBe("registrar_fn")
    mockDb.mockReset()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })
})

// ── F. lsp_indirect_callers — connectionKind mapping ─────────────────────────

describe("F. lsp_indirect_callers — connectionKind mapping", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  function makeIndirectNode(connectionKind: string, withDispatch = false) {
    return {
      name: "registrar_fn",
      file: "/workspace/src/reg.c",
      line: 10,
      sourceText: "register(ctx, target_fn)",
      classification: {
        patternName: "generic",
        registrationApi: "register_api",
        connectionKind,
      },
      resolvedChain: withDispatch ? {
        confidenceLevel: "high",
        store: { containerType: "ctx_t", confidence: "high" },
        dispatch: {
          dispatchFunction: "dispatch_fn",
          dispatchFile: "/workspace/src/dispatch.c",
          dispatchLine: 50,
          confidence: "high",
        },
        trigger: { triggerKind: null, triggerKey: null, confidence: "low" },
      } : null,
    }
  }

  it("F1: timer_callback connectionKind → runtime_callback_registration_call (no dispatch → registrar)", async () => {
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [makeIndirectNode("timer_callback", false)],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, null, BASE)
    expect(result.source).toBe("lsp_indirect_callers")
    // No dispatch resolved → goes to registrars
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.invocationType).toBe("runtime_callback_registration_call")
    expect(result.registrars[0]!.callerRole).toBe("registrar")
  })

  it("F2: hw_interrupt connectionKind → runtime_function_pointer_call (no dispatch → registrar)", async () => {
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [makeIndirectNode("hw_interrupt", false)],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, null, BASE)
    expect(result.registrars[0]!.invocationType).toBe("runtime_function_pointer_call")
  })

  it("F3: ring_signal connectionKind → runtime_function_pointer_call (no dispatch → registrar)", async () => {
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [makeIndirectNode("ring_signal", false)],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, null, BASE)
    expect(result.registrars[0]!.invocationType).toBe("runtime_function_pointer_call")
  })

  it("F4: api_call connectionKind → direct_call invocationType, but no dispatch → goes to registrars[]", async () => {
    // When resolvedChain is null, indirectGraphToCallers always emits callerRole=registrar
    // regardless of connectionKind. The invocationType is still mapped from connectionKind.
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [makeIndirectNode("api_call", false)],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, null, BASE)
    // No dispatch resolved → registrar role regardless of connectionKind
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.invocationType).toBe("direct_call")
    expect(result.registrars[0]!.callerRole).toBe("registrar")
  })

  it("F5: dispatch resolved → dispatch_fn is runtime_caller, not registrar", async () => {
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [makeIndirectNode("interface_registration", true)],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, null, BASE)
    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.name).toBe("dispatch_fn")
    expect(result.callers[0]!.callerRole).toBe("runtime_caller")
    expect(result.callers[0]!.invocationType).toBe("runtime_dispatch_table_call")
    expect(result.registrars).toHaveLength(0)
  })

  it("F5: multiple nodes — some with dispatch (runtime_caller), some without (registrar)", async () => {
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [
          makeIndirectNode("interface_registration", true),   // has dispatch → runtime_caller
          {
            name: "plain_registrar",
            file: "/workspace/src/reg2.c",
            line: 20,
            sourceText: "register2(ctx, target_fn)",
            classification: { patternName: "generic2", registrationApi: "register2", connectionKind: "interface_registration" },
            resolvedChain: null,
          },
        ],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, null, BASE)
    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.name).toBe("dispatch_fn")
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.name).toBe("plain_registrar")
  })
})

// ── G. lsp_incoming_calls — edge cases ───────────────────────────────────────

describe("G. lsp_incoming_calls — edge cases", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("G1: range fallback when selectionRange absent", async () => {
    const client = makeClient({
      incomingCalls: vi.fn(async () => [{
        from: {
          name: "caller_with_range",
          uri: "file:///workspace/src/a.c",
          range: { start: { line: 14 } },
          // no selectionRange
        },
      }]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    expect(result.callers[0]!.lineNumber).toBe(15) // 0-based 14 → 1-based 15
  })

  it("G2: non-file:// URI passed through as-is", async () => {
    const client = makeClient({
      incomingCalls: vi.fn(async () => [{
        from: {
          name: "caller_fn",
          uri: "/workspace/src/a.c",  // no file:// prefix
          selectionRange: { start: { line: 0 } },
        },
      }]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    expect(result.callers[0]!.filePath).toBe("/workspace/src/a.c")
  })

  it("G3: multiple callers all returned as direct_caller", async () => {
    const client = makeClient({
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
        { from: { name: "caller_b", uri: "file:///workspace/src/b.c", selectionRange: { start: { line: 0 } } } },
        { from: { name: "caller_c", uri: "file:///workspace/src/c.c", selectionRange: { start: { line: 0 } } } },
      ]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    expect(result.callers).toHaveLength(3)
    for (const c of result.callers) {
      expect(c.callerRole).toBe("direct_caller")
      expect(c.invocationType).toBe("direct_call")
      expect(c.confidence).toBe(1.0)
    }
  })

  it("G4: caller with no from field is skipped", async () => {
    const client = makeClient({
      incomingCalls: vi.fn(async () => [
        { from: null },
        { from: { name: "valid_caller", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
      ]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.name).toBe("valid_caller")
  })
})

// ── H. Symbol resolution fallbacks ───────────────────────────────────────────

describe("H. Symbol resolution fallbacks", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("H1: prepareCallHierarchy returns empty → hover fallback used", async () => {
    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => []),
      hover: vi.fn(async () => ({ contents: { value: "function hover_resolved_fn" } })),
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_fn", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
      ]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    expect(result.targetApi).toBe("hover_resolved_fn")
  })

  it("H2: prepareCallHierarchy returns null → hover fallback used", async () => {
    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => null),
      hover: vi.fn(async () => ({ contents: { value: "void hover_fn" } })),
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_fn", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
      ]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    expect(result.targetApi).toBe("hover_fn")
  })

  it("H3: both prepareCallHierarchy and hover fail → symbol@file:line fallback", async () => {
    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => { throw new Error("LSP error") }),
      hover: vi.fn(async () => { throw new Error("hover error") }),
      incomingCalls: vi.fn(async () => []),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    expect(result.targetApi).toMatch(/^symbol@/)
  })

  it("H4: hover with string contents — regex extracts first keyword match", async () => {
    // The hover regex: /(?:function|method|void|int|bool|static)\s+(\w+)/i
    // On "void my_fn" → captures "my_fn"
    // On "static int my_fn" → captures "int" (first keyword match is "static", captures next word "int")
    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => []),
      hover: vi.fn(async () => ({ contents: "void my_hover_fn" })),
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_fn", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
      ]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    // "void my_hover_fn" → regex matches "void", captures "my_hover_fn"
    expect(result.targetApi).toBe("my_hover_fn")
  })
})

// ── I. Response shape invariants ──────────────────────────────────────────────

describe("I. Response shape invariants", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("I1: callers[] never contains registrar role", async () => {
    const client = makeClient({
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
      ]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    for (const c of result.callers) {
      expect(c.callerRole).not.toBe("registrar")
    }
  })

  it("I2: registrars[] never contains runtime_caller or direct_caller role", async () => {
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [{
          name: "registrar_fn",
          file: "/workspace/src/reg.c",
          line: 5,
          sourceText: "register(ctx, target_fn)",
          classification: { patternName: "generic", registrationApi: "register_api", connectionKind: "interface_registration" },
          resolvedChain: null,
        }],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, null, BASE)
    for (const r of result.registrars) {
      expect(r.callerRole).not.toBe("runtime_caller")
      expect(r.callerRole).not.toBe("direct_caller")
    }
  })

  it("I3: callers sorted by confidence desc, then name asc as tiebreak", async () => {
    const client = makeClient({
      incomingCalls: vi.fn(async () => [
        { from: { name: "zzz_caller", uri: "file:///workspace/src/z.c", selectionRange: { start: { line: 0 } } } },
        { from: { name: "aaa_caller", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
        { from: { name: "mmm_caller", uri: "file:///workspace/src/m.c", selectionRange: { start: { line: 0 } } } },
      ]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    // All have confidence=1.0, so sorted alphabetically
    expect(result.callers[0]!.name).toBe("aaa_caller")
    expect(result.callers[1]!.name).toBe("mmm_caller")
    expect(result.callers[2]!.name).toBe("zzz_caller")
  })

  it("I4: deduplication — same name+invocationType → one entry", async () => {
    const client = makeClient({
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } } },
      ]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, BASE)
    expect(result.callers).toHaveLength(1)
  })

  it("I5: provenance.stepsAttempted always in waterfall order", async () => {
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), null, BASE)
    const steps = result.provenance.stepsAttempted
    const runtimeFlowIdx = steps.indexOf("lsp_runtime_flow")
    const indirectIdx = steps.indexOf("lsp_indirect_callers")
    const incomingIdx = steps.indexOf("lsp_incoming_calls")
    expect(runtimeFlowIdx).toBeLessThan(indirectIdx)
    expect(indirectIdx).toBeLessThan(incomingIdx)
  })

  it("I6: response always has targetApi, targetFile, targetLine, callers, registrars, source, provenance", async () => {
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), null, BASE)
    expect(result).toHaveProperty("targetApi")
    expect(result).toHaveProperty("targetFile")
    expect(result).toHaveProperty("targetLine")
    expect(result).toHaveProperty("callers")
    expect(result).toHaveProperty("registrars")
    expect(result).toHaveProperty("source")
    expect(result).toHaveProperty("provenance")
    expect(result.provenance).toHaveProperty("stepsAttempted")
    expect(result.provenance).toHaveProperty("stepUsed")
    expect(result.provenance).toHaveProperty("aliasVariantsTriedForDb")
    expect(result.provenance).toHaveProperty("aliasVariantsTried")
  })
})

// ── J. DB cleared / empty snapshot ───────────────────────────────────────────

describe("J. DB cleared / empty snapshot", () => {
  it("J1: both DB steps return not_found → falls through to lsp_indirect_callers", async () => {
    mockDb.mockResolvedValue(DB_NOT_FOUND)
    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "target_fn", file: "/workspace/src/target.c", line: 10 },
        nodes: [{
          name: "registrar_fn",
          file: "/workspace/src/reg.c",
          line: 5,
          sourceText: "register(ctx, target_fn)",
          classification: { patternName: "generic", registrationApi: "register_api", connectionKind: "interface_registration" },
          resolvedChain: {
            confidenceLevel: "medium",
            store: { containerType: "ctx_t", confidence: "medium" },
            dispatch: { dispatchFunction: "dispatch_fn", dispatchFile: "/workspace/src/d.c", dispatchLine: 10, confidence: "medium" },
            trigger: { triggerKind: null, triggerKey: null, confidence: "low" },
          },
        }],
      })),
    })
    const result = await resolveCallers(makeClient(), makeTracker(), backend, {} as any, { ...BASE, snapshotId: 99 })
    expect(result.source).toBe("lsp_indirect_callers")
    expect(result.callers[0]!.name).toBe("dispatch_fn")
    expect(result.provenance.stepsAttempted).toContain("intelligence_query_runtime")
    expect(result.provenance.stepsAttempted).toContain("intelligence_query_static")
  })

  it("J2: DB cleared → all DB steps return not_found → lsp_incoming_calls is final fallback", async () => {
    mockDb.mockResolvedValue(DB_NOT_FOUND)
    const client = makeClient({
      incomingCalls: vi.fn(async () => [{
        from: { name: "direct_caller", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 0 } } },
      }]),
    })
    const result = await resolveCallers(client, makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 99 })
    expect(result.source).toBe("lsp_incoming_calls")
    expect(result.callers[0]!.name).toBe("direct_caller")
  })
})

// ── K. Alias variants ─────────────────────────────────────────────────────────

describe("K. Alias variants", () => {
  beforeEach(() => {
    mockDb.mockClear()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("K1: aliasVariantsTriedForDb=true when snapshotId provided", async () => {
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    expect(result.provenance.aliasVariantsTriedForDb).toBe(true)
  })

  it("K2: aliasVariantsTried contains all expected variants for target_fn", async () => {
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    const variants = result.provenance.aliasVariantsTried
    expect(variants).toContain("target_fn")
    expect(variants).toContain("_target_fn")
    expect(variants).toContain("__target_fn")
    expect(variants).toContain("target_fn___RAM")
    expect(variants).toContain("_target_fn___RAM")
  })

  it("K3: aliasVariantsTriedForDb=false when no snapshotId", async () => {
    const result = await resolveCallers(makeClient(), makeTracker(), makeBackend(), null, BASE)
    expect(result.provenance.aliasVariantsTriedForDb).toBe(false)
    expect(result.provenance.aliasVariantsTried).toHaveLength(0)
  })

  it("K4: DB query called with apiNameAliases array when snapshotId provided", async () => {
    await resolveCallers(makeClient(), makeTracker(), makeBackend(), {} as any, { ...BASE, snapshotId: 1 })
    // Find the first call that has actual query args (intent + snapshotId)
    const realCalls = mockDb.mock.calls.filter((c) => c[0] && typeof c[0] === "object" && "intent" in (c[0] as any))
    expect(realCalls.length).toBeGreaterThan(0)
    const firstRealCall = realCalls[0]![0] as any
    expect(Array.isArray(firstRealCall.apiNameAliases)).toBe(true)
    expect(firstRealCall.apiNameAliases.length).toBeGreaterThan(1)
  })
})

// ── L. WLAN firmware canonical scenarios ─────────────────────────────────────

describe("L. WLAN firmware canonical scenarios", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "get-callers-wlan-"))
    mkdirSync(join(tmpDir, "src"), { recursive: true })
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    mockDb.mockReset()
    mockDb.mockResolvedValue(DB_NOT_FOUND)
  })

  it("L1: GTK offload handler via timer_callback — DB runtime path", async () => {
    // gtk_offload_rekey_handler is invoked by a timer callback
    // DB stores: runtime_caller=gtk_timer_dispatch, type=runtime_callback_registration_call
    const gtkFile = join(tmpDir, "src", "gtk_offload.c")
    writeFileSync(gtkFile, "void gtk_offload_rekey_handler(void) {}\n", "utf8")

    mockDb.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return dbRuntimeHit([{
          runtime_caller_api_name: "gtk_timer_dispatch",
          runtime_called_api_name: "gtk_offload_rekey_handler",
          runtime_caller_invocation_type_classification: "runtime_callback_registration_call",
          runtime_relation_confidence_score: 0.92,
        }])
      }
      return DB_NOT_FOUND
    })

    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => [{
        name: "gtk_offload_rekey_handler",
        uri: `file://${gtkFile}`,
        selectionRange: { start: { line: 0 } },
      }]),
    })

    const result = await resolveCallers(client, makeTracker(), makeBackend(), {} as any, {
      file: gtkFile, line: 1, character: 5, snapshotId: 1,
    })

    expect(result.source).toBe("intelligence_query_runtime")
    expect(result.targetApi).toBe("gtk_offload_rekey_handler")
    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.name).toBe("gtk_timer_dispatch")
    expect(result.callers[0]!.callerRole).toBe("runtime_caller")
    expect(result.callers[0]!.invocationType).toBe("runtime_callback_registration_call")
    expect(result.callers[0]!.confidence).toBe(0.92)
  })

  it("L2: WMI dispatch table handler — DB runtime path", async () => {
    // wmi_unified_cmd_handler is invoked via dispatch table
    // DB stores: runtime_caller=wmi_dispatch_table_invoke, type=runtime_dispatch_table_call
    const wmiFile = join(tmpDir, "src", "wmi_handler.c")
    writeFileSync(wmiFile, "void wmi_unified_cmd_handler(void) {}\n", "utf8")

    mockDb.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return dbRuntimeHit([{
          runtime_caller_api_name: "_wmi_dispatch_table_invoke",
          runtime_called_api_name: "wmi_unified_cmd_handler",
          runtime_caller_invocation_type_classification: "runtime_dispatch_table_call",
          runtime_relation_confidence_score: 0.98,
        }])
      }
      return DB_NOT_FOUND
    })

    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => [{
        name: "wmi_unified_cmd_handler",
        uri: `file://${wmiFile}`,
        selectionRange: { start: { line: 0 } },
      }]),
    })

    const result = await resolveCallers(client, makeTracker(), makeBackend(), {} as any, {
      file: wmiFile, line: 1, character: 5, snapshotId: 1,
    })

    expect(result.source).toBe("intelligence_query_runtime")
    expect(result.callers).toHaveLength(1)
    // Leading underscore must be stripped
    expect(result.callers[0]!.name).toBe("wmi_dispatch_table_invoke")
    expect(result.callers[0]!.invocationType).toBe("runtime_dispatch_table_call")
    expect(result.callers[0]!.confidence).toBe(0.98)
  })

  it("L3: HW interrupt handler — lsp_indirect_callers path with hw_interrupt connectionKind", async () => {
    // wlan_intr_handler registered via hw interrupt — no dispatch resolved
    const intrFile = join(tmpDir, "src", "intr_handler.c")
    writeFileSync(intrFile, "void wlan_intr_handler(void) {}\n", "utf8")

    const backend = makeBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "wlan_intr_handler", file: intrFile, line: 1 },
        nodes: [{
          name: "wlan_intr_register",
          file: join(tmpDir, "src", "intr_reg.c"),
          line: 55,
          sourceText: "cmnos_intr_register(WLAN_INTR, wlan_intr_handler)",
          classification: {
            patternName: "hw_interrupt",
            registrationApi: "cmnos_intr_register",
            connectionKind: "hw_interrupt",
          },
          resolvedChain: null,
        }],
      })),
    })

    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => [{
        name: "wlan_intr_handler",
        uri: `file://${intrFile}`,
        selectionRange: { start: { line: 0 } },
      }]),
      incomingCalls: vi.fn(async () => []),
    })

    const result = await resolveCallers(client, makeTracker(), backend, null, {
      file: intrFile, line: 1, character: 5,
    })

    expect(result.source).toBe("lsp_indirect_callers")
    expect(result.targetApi).toBe("wlan_intr_handler")
    // No dispatch resolved → registrar
    expect(result.callers).toHaveLength(0)
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.name).toBe("wlan_intr_register")
    expect(result.registrars[0]!.invocationType).toBe("runtime_function_pointer_call")
    expect(result.registrars[0]!.callerRole).toBe("registrar")
  })

  it("L4: function pointer call — DB runtime path with runtime_function_pointer_call", async () => {
    // offload_handler invoked via function pointer stored in struct
    const offloadFile = join(tmpDir, "src", "offload.c")
    writeFileSync(offloadFile, "void offload_handler(void) {}\n", "utf8")

    mockDb.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return dbRuntimeHit([{
          runtime_caller_api_name: "offload_ctx_dispatch",
          runtime_called_api_name: "offload_handler",
          runtime_caller_invocation_type_classification: "runtime_function_pointer_call",
          runtime_relation_confidence_score: 0.88,
        }])
      }
      return DB_NOT_FOUND
    })

    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => [{
        name: "offload_handler",
        uri: `file://${offloadFile}`,
        selectionRange: { start: { line: 0 } },
      }]),
    })

    const result = await resolveCallers(client, makeTracker(), makeBackend(), {} as any, {
      file: offloadFile, line: 1, character: 5, snapshotId: 1,
    })

    expect(result.source).toBe("intelligence_query_runtime")
    expect(result.callers[0]!.name).toBe("offload_ctx_dispatch")
    expect(result.callers[0]!.callerRole).toBe("runtime_caller")
    expect(result.callers[0]!.invocationType).toBe("runtime_function_pointer_call")
  })

  it("L5: direct call — lsp_incoming_calls path (always available)", async () => {
    // Simple direct call — no indirect patterns, no DB
    const simpleFile = join(tmpDir, "src", "simple.c")
    writeFileSync(simpleFile, "void simple_api(void) {}\n", "utf8")

    const client = makeClient({
      prepareCallHierarchy: vi.fn(async () => [{
        name: "simple_api",
        uri: `file://${simpleFile}`,
        selectionRange: { start: { line: 0 } },
      }]),
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_a", uri: `file://${join(tmpDir, "src", "a.c")}`, selectionRange: { start: { line: 9 } } } },
        { from: { name: "caller_b", uri: `file://${join(tmpDir, "src", "b.c")}`, selectionRange: { start: { line: 19 } } } },
      ]),
    })

    const result = await resolveCallers(client, makeTracker(), makeBackend(), null, {
      file: simpleFile, line: 1, character: 5,
    })

    expect(result.source).toBe("lsp_incoming_calls")
    expect(result.callers).toHaveLength(2)
    expect(result.callers.every((c) => c.callerRole === "direct_caller")).toBe(true)
    expect(result.callers.every((c) => c.invocationType === "direct_call")).toBe(true)
    expect(result.callers.every((c) => c.confidence === 1.0)).toBe(true)
  })
})
