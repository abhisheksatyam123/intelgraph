/**
 * get-callers.test.ts — Unit tests for the unified get_callers endpoint.
 *
 * Tests cover:
 *   - canonicalizeSymbol / symbolAliasVariants helpers
 *   - resolveCallers waterfall: each step succeeds / falls through
 *   - Response shape: callers sorted by confidence, provenance populated
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

// Mock executeOrchestratedQuery so we can control DB responses
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
const mockExecuteOrchestratedQuery = vi.mocked(executeOrchestratedQuery)

// ── Helper factories ──────────────────────────────────────────────────────────

function makeMockClient(overrides: Partial<{
  prepareCallHierarchy: any
  hover: any
  incomingCalls: any
}> = {}) {
  return {
    root: "/workspace",
    openFile: vi.fn(async () => true),
    prepareCallHierarchy: overrides.prepareCallHierarchy ?? vi.fn(async () => [
      { name: "my_handler", uri: "file:///workspace/src/handler.c", selectionRange: { start: { line: 9 } } },
    ]),
    hover: overrides.hover ?? vi.fn(async () => ({ contents: { value: "function my_handler" } })),
    incomingCalls: overrides.incomingCalls ?? vi.fn(async () => []),
    references: vi.fn(async () => []),
  } as any
}

function makeMockBackend(overrides: Partial<{
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

function makeMockTracker() {
  return {
    state: { isReady: true },
    statusSuffix: () => "",
    fileSuffix: () => "",
    fileState: () => "idle",
    fileStates: new Map(),
  } as any
}

// ── canonicalizeSymbol ────────────────────────────────────────────────────────

describe("canonicalizeSymbol", () => {
  it("strips leading underscores", () => {
    expect(canonicalizeSymbol("_foo")).toBe("foo")
    expect(canonicalizeSymbol("__foo")).toBe("foo")
    expect(canonicalizeSymbol("___foo")).toBe("foo")
  })

  it("strips ___RAM suffix", () => {
    expect(canonicalizeSymbol("foo___RAM")).toBe("foo")
    expect(canonicalizeSymbol("foo___PATCH")).toBe("foo")
  })

  it("strips both leading _ and ___RAM suffix", () => {
    expect(canonicalizeSymbol("_foo___RAM")).toBe("foo")
    expect(canonicalizeSymbol("__wlan_bpf_filter_offload_handler___RAM")).toBe("wlan_bpf_filter_offload_handler")
  })

  it("leaves canonical names unchanged", () => {
    expect(canonicalizeSymbol("wlan_bpf_filter_offload_handler")).toBe("wlan_bpf_filter_offload_handler")
    expect(canonicalizeSymbol("main")).toBe("main")
  })

  it("handles empty string", () => {
    expect(canonicalizeSymbol("")).toBe("")
    expect(canonicalizeSymbol("  ")).toBe("")
  })
})

// ── symbolAliasVariants ───────────────────────────────────────────────────────

describe("symbolAliasVariants", () => {
  it("returns canonical name first", () => {
    const variants = symbolAliasVariants("_foo___RAM")
    expect(variants[0]).toBe("foo")
  })

  it("includes all expected variants", () => {
    const variants = symbolAliasVariants("my_handler")
    expect(variants).toContain("my_handler")
    expect(variants).toContain("_my_handler")
    expect(variants).toContain("__my_handler")
    expect(variants).toContain("my_handler___RAM")
    expect(variants).toContain("_my_handler___RAM")
  })

  it("includes original name when different from canonical", () => {
    const variants = symbolAliasVariants("_my_handler")
    expect(variants).toContain("_my_handler")
    expect(variants).toContain("my_handler")
  })

  it("does not duplicate canonical when original equals canonical", () => {
    const variants = symbolAliasVariants("my_handler")
    const count = variants.filter((v) => v === "my_handler").length
    expect(count).toBe(1)
  })
})

// ── resolveCallers waterfall ──────────────────────────────────────────────────

describe("resolveCallers", () => {
  const baseArgs = {
    file: "/workspace/src/handler.c",
    line: 10,
    character: 5,
  }

  beforeEach(() => {
    // Reset mock to default not_found response before each test
    mockExecuteOrchestratedQuery.mockResolvedValue({
      snapshotId: -1,
      intent: "who_calls_api" as const,
      status: "not_found" as const,
      data: { nodes: [], edges: [] },
      provenance: { path: "db_miss_deterministic" as const, deterministicAttempts: [], llmUsed: false },
    })
  })

  it("returns empty callers with source=none when all steps fail", async () => {
    const client = makeMockClient({
      incomingCalls: vi.fn(async () => []),
    })
    const backend = makeMockBackend()
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, baseArgs)

    expect(result.targetApi).toBe("my_handler")
    expect(result.callers).toHaveLength(0)
    expect(result.source).toBe("none")
    expect(result.provenance.stepsAttempted).toContain("lsp_runtime_flow")
    expect(result.provenance.stepsAttempted).toContain("lsp_indirect_callers")
    expect(result.provenance.stepsAttempted).toContain("lsp_incoming_calls")
  })

  it("uses lsp_incoming_calls as last resort when other steps fail", async () => {
    const client = makeMockClient({
      incomingCalls: vi.fn(async () => [
        {
          from: {
            name: "direct_caller",
            uri: "file:///workspace/src/caller.c",
            selectionRange: { start: { line: 19 } },
          },
        },
      ]),
    })
    const backend = makeMockBackend()
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, baseArgs)

    expect(result.source).toBe("lsp_incoming_calls")
    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.name).toBe("direct_caller")
    expect(result.callers[0]!.invocationType).toBe("direct_call")
    expect(result.callers[0]!.confidence).toBe(1.0)
  })

  it("uses lsp_indirect_callers when it finds callers before lsp_incoming_calls", async () => {
    const client = makeMockClient({
      incomingCalls: vi.fn(async () => [
        { from: { name: "direct_caller", uri: "file:///workspace/src/caller.c", selectionRange: { start: { line: 5 } } } },
      ]),
    })
    const backend = makeMockBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "my_handler", file: "/workspace/src/handler.c", line: 10 },
        nodes: [
          {
            name: "registrar_fn",
            file: "/workspace/src/reg.c",
            line: 42,
            sourceText: "offldmgr_register_data_offload(ctx, my_handler)",
            classification: {
              patternName: "offldmgr",
              registrationApi: "offldmgr_register_data_offload",
              dispatchKey: "data_offload",
              connectionKind: "interface_registration",
            },
            resolvedChain: {
              confidenceScore: 3,
              confidenceLevel: "high",
              store: { containerType: "offload_ctx_t", confidence: "high" },
              dispatch: {
                dispatchFunction: "offldmgr_dispatch_data_path",
                dispatchFile: "/workspace/src/offload_mgr.c",
                dispatchLine: 499,
                confidence: "high",
              },
              trigger: { triggerKind: null, triggerKey: null, confidence: "low" },
            },
          },
        ],
      })),
    })
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, baseArgs)

    expect(result.source).toBe("lsp_indirect_callers")
    expect(result.callers).toHaveLength(1)
    // dispatch function should be the primary caller, not the registrar
    expect(result.callers[0]!.name).toBe("offldmgr_dispatch_data_path")
    expect(result.callers[0]!.invocationType).toBe("runtime_dispatch_table_call")
    expect(result.callers[0]!.viaRegistrationApi).toBe("offldmgr_register_data_offload")
    expect(result.callers[0]!.confidence).toBe(0.9)
  })

  it("falls back to registrar when no dispatch chain resolved", async () => {
    const client = makeMockClient({
      incomingCalls: vi.fn(async () => []),
    })
    const backend = makeMockBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "my_handler", file: "/workspace/src/handler.c", line: 10 },
        nodes: [
          {
            name: "registrar_fn",
            file: "/workspace/src/reg.c",
            line: 42,
            sourceText: "register_handler(ctx, my_handler)",
            classification: {
              patternName: "generic",
              registrationApi: "register_handler",
              dispatchKey: "handler",
              connectionKind: "interface_registration",
            },
            resolvedChain: null,
          },
        ],
      })),
    })
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, baseArgs)

    expect(result.source).toBe("lsp_indirect_callers")
    // Registrar goes into result.registrars, NOT result.callers
    expect(result.callers).toHaveLength(0)
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.name).toBe("registrar_fn")
    expect(result.registrars[0]!.callerRole).toBe("registrar")
    expect(result.registrars[0]!.invocationType).toBe("interface_registration")
  })

  it("uses intelligence_query_runtime when DB has runtime callers", async () => {
    // Mock executeOrchestratedQuery to return runtime callers for who_calls_api_at_runtime
    mockExecuteOrchestratedQuery.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return {
          snapshotId: 1,
          intent: "who_calls_api_at_runtime" as const,
          status: "hit" as const,
          data: {
            nodes: [
              {
                runtime_caller_api_name: "offldmgr_dispatch_data_path",
                runtime_caller_invocation_type_classification: "runtime_dispatch_table_call",
                runtime_relation_confidence_score: 0.95,
              },
            ],
            edges: [],
          },
          provenance: { path: "db_hit" as const, deterministicAttempts: [], llmUsed: false },
        }
      }
      return {
        snapshotId: 1,
        intent: req.intent,
        status: "not_found" as const,
        data: { nodes: [], edges: [] },
        provenance: { path: "db_miss_deterministic" as const, deterministicAttempts: [], llmUsed: false },
      }
    })

    const client = makeMockClient()
    const backend = makeMockBackend()
    const tracker = makeMockTracker()
    // Pass a non-null intelligenceDeps so the DB path is attempted
    const mockDeps = {} as any

    const result = await resolveCallers(client, tracker, backend, mockDeps, {
      ...baseArgs,
      snapshotId: 1,
    })

    expect(result.source).toBe("intelligence_query_runtime")
    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.name).toBe("offldmgr_dispatch_data_path")
    expect(result.callers[0]!.invocationType).toBe("runtime_dispatch_table_call")
    expect(result.callers[0]!.confidence).toBe(0.95)
    expect(result.provenance.aliasVariantsTriedForDb).toBe(true)
  })

  it("sorts callers by confidence descending", async () => {
    const client = makeMockClient({
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 1 } } } },
        { from: { name: "caller_b", uri: "file:///workspace/src/b.c", selectionRange: { start: { line: 2 } } } },
      ]),
    })
    const backend = makeMockBackend()
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, baseArgs)

    // All lsp_incoming_calls have confidence 1.0 — sorted alphabetically as tiebreak
    expect(result.callers[0]!.name).toBe("caller_a")
    expect(result.callers[1]!.name).toBe("caller_b")
  })

  it("deduplicates callers with same name and invocation type", async () => {
    const client = makeMockClient({
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 1 } } } },
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 1 } } } },
      ]),
    })
    const backend = makeMockBackend()
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, baseArgs)

    expect(result.callers).toHaveLength(1)
    expect(result.callers[0]!.name).toBe("caller_a")
  })

  it("populates provenance correctly", async () => {
    const client = makeMockClient({
      incomingCalls: vi.fn(async () => [
        { from: { name: "caller_a", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 1 } } } },
      ]),
    })
    const backend = makeMockBackend()
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, baseArgs)

    expect(result.provenance.stepUsed).toBe("lsp_incoming_calls")
    expect(result.provenance.stepsAttempted).toContain("lsp_runtime_flow")
    expect(result.provenance.stepsAttempted).toContain("lsp_indirect_callers")
    expect(result.provenance.stepsAttempted).toContain("lsp_incoming_calls")
    expect(result.provenance.aliasVariantsTriedForDb).toBe(false) // no snapshotId
  })

  it("canonicalizes symbol names in all paths", async () => {
    const client = makeMockClient({
      prepareCallHierarchy: vi.fn(async () => [
        { name: "_my_handler___RAM", uri: "file:///workspace/src/handler.c", selectionRange: { start: { line: 9 } } },
      ]),
      incomingCalls: vi.fn(async () => [
        { from: { name: "_direct_caller___RAM", uri: "file:///workspace/src/a.c", selectionRange: { start: { line: 1 } } } },
      ]),
    })
    const backend = makeMockBackend()
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, baseArgs)

    expect(result.targetApi).toBe("my_handler")
    expect(result.callers[0]!.name).toBe("direct_caller")
  })
})

// ── BPF offload handler → enhanced_data_handler end-to-end ───────────────────
// This is the canonical WLAN firmware indirect-call scenario:
//   wlan_bpf_filter_offload_handler  ← registered via offldmgr_register_data_offload
//   _offldmgr_enhanced_data_handler  ← actual runtime invoker (dispatch function)
//
// The system must return "offldmgr_enhanced_data_handler" (canonical) as the caller,
// NOT "wlan_bpf_enable_data_path" (the registrar).

describe("wlan_bpf_filter_offload_handler → offldmgr_enhanced_data_handler", () => {
  let tmpDir: string
  let bpfFile: string

  beforeEach(() => {
    // Create a real temp file so prepareReasonQuery's readFileSync doesn't throw
    tmpDir = mkdtempSync(join(tmpdir(), "get-callers-bpf-"))
    mkdirSync(join(tmpDir, "src", "offloads"), { recursive: true })
    bpfFile = join(tmpDir, "src", "offloads", "bpf_offload.c")
    writeFileSync(bpfFile, "void wlan_bpf_filter_offload_handler(void) {}\n", "utf8")

    mockExecuteOrchestratedQuery.mockResolvedValue({
      snapshotId: -1,
      intent: "who_calls_api" as const,
      status: "not_found" as const,
      data: { nodes: [], edges: [] },
      provenance: { path: "db_miss_deterministic" as const, deterministicAttempts: [], llmUsed: false },
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("Path 1 (lsp_runtime_flow): returns offldmgr_enhanced_data_handler from LLM cache", async () => {
    // Simulate lsp_runtime_flow returning the runtime invoker from LLM cache
    const client = makeMockClient({
      prepareCallHierarchy: vi.fn(async () => [
        { name: "wlan_bpf_filter_offload_handler", uri: `file://${bpfFile}`, selectionRange: { start: { line: 0 } } },
      ]),
    })
    const backend = makeMockBackend({
      reasonEngine: {
        run: vi.fn(async () => ({
          reasonPaths: [
            {
              targetSymbol: "wlan_bpf_filter_offload_handler",
              invocationReason: {
                runtimeTrigger: "Incoming RX data packet matched BPF filter",
                dispatchChain: ["offloadif_data_ind", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
                dispatchSite: { file: "/workspace/wlan_proc/src/offload_mgr_ext.c", line: 1097, snippet: "ctx->data_handler(pkt)" },
                registrationGate: { registrarFn: "wlan_bpf_enable_data_path", registrationApi: "offldmgr_register_data_offload", conditions: [] },
              },
              runtimeFlow: {
                targetApi: "wlan_bpf_filter_offload_handler",
                runtimeTrigger: "Incoming RX data packet matched BPF filter",
                dispatchChain: ["offloadif_data_ind", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
                dispatchSite: { file: "/workspace/wlan_proc/src/offload_mgr_ext.c", line: 1097, snippet: "ctx->data_handler(pkt)" },
                immediateInvoker: "_offldmgr_enhanced_data_handler",
              },
            },
          ],
          cacheHit: true,
          usedLlm: false,
          cacheMismatchedFiles: [],
          rejected: false,
        })),
      },
    })
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, { file: bpfFile, line: 1, character: 5 })

    expect(result.source).toBe("lsp_runtime_flow")
    expect(result.targetApi).toBe("wlan_bpf_filter_offload_handler")
    expect(result.callers).toHaveLength(1)
    // Must be canonical (no leading underscore)
    expect(result.callers[0]!.name).toBe("offldmgr_enhanced_data_handler")
    expect(result.callers[0]!.invocationType).toBe("runtime_direct_call")
    expect(result.callers[0]!.confidence).toBe(0.9)
  })

  it("Path 2 (intelligence_query_runtime): returns offldmgr_enhanced_data_handler from DB", async () => {
    // Simulate DB returning runtime observation with _offldmgr_enhanced_data_handler
    // (stored with leading underscore as ingested from firmware)
    mockExecuteOrchestratedQuery.mockImplementationOnce(async (req: any) => {
      if (req.intent === "who_calls_api_at_runtime") {
        return {
          snapshotId: 42,
          intent: "who_calls_api_at_runtime" as const,
          status: "hit" as const,
          data: {
            nodes: [
              {
                // DB stores the raw firmware name with leading underscore
                runtime_caller_api_name: "_offldmgr_enhanced_data_handler",
                runtime_called_api_name: "wlan_bpf_filter_offload_handler",
                runtime_caller_invocation_type_classification: "runtime_dispatch_table_call",
                runtime_relation_confidence_score: 0.97,
                runtime_relation_derivation_source: "runtime",
              },
            ],
            edges: [],
          },
          provenance: { path: "db_hit" as const, deterministicAttempts: [], llmUsed: false },
        }
      }
      return { snapshotId: 42, intent: req.intent, status: "not_found" as const, data: { nodes: [], edges: [] }, provenance: { path: "db_miss_deterministic" as const, deterministicAttempts: [], llmUsed: false } }
    })

    const client = makeMockClient({
      prepareCallHierarchy: vi.fn(async () => [
        { name: "wlan_bpf_filter_offload_handler", uri: `file://${bpfFile}`, selectionRange: { start: { line: 0 } } },
      ]),
    })
    const backend = makeMockBackend()
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, {} as any, {
      ...{ file: bpfFile, line: 1, character: 5 },
      snapshotId: 42,
    })

    expect(result.source).toBe("intelligence_query_runtime")
    expect(result.targetApi).toBe("wlan_bpf_filter_offload_handler")
    expect(result.callers).toHaveLength(1)
    // DB returns "_offldmgr_enhanced_data_handler" — must be canonicalized
    expect(result.callers[0]!.name).toBe("offldmgr_enhanced_data_handler")
    expect(result.callers[0]!.callerRole).toBe("runtime_caller")
    expect(result.callers[0]!.invocationType).toBe("runtime_dispatch_table_call")
    expect(result.callers[0]!.confidence).toBe(0.97)
    // Alias variants must have been tried (snapshotId provided)
    expect(result.provenance.aliasVariantsTriedForDb).toBe(true)
    expect(result.provenance.aliasVariantsTried).toContain("wlan_bpf_filter_offload_handler")
    expect(result.provenance.aliasVariantsTried).toContain("_wlan_bpf_filter_offload_handler")
    expect(result.provenance.aliasVariantsTried).toContain("wlan_bpf_filter_offload_handler___RAM")
  })

  it("Path 4 (lsp_indirect_callers): returns offldmgr_enhanced_data_handler from resolved dispatch chain", async () => {
    // Simulate lsp_indirect_callers finding the registrar and resolving the dispatch chain
    // The pattern resolver returns _offldmgr_enhanced_data_handler as the dispatch function
    const client = makeMockClient({
      prepareCallHierarchy: vi.fn(async () => [
        { name: "wlan_bpf_filter_offload_handler", uri: `file://${bpfFile}`, selectionRange: { start: { line: 0 } } },
      ]),
      incomingCalls: vi.fn(async () => []),
    })
    const backend = makeMockBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "wlan_bpf_filter_offload_handler", file: "/workspace/wlan_proc/src/offloads/bpf_offload.c", line: 83 },
        nodes: [
          {
            // The registrar — wlan_bpf_enable_data_path calls offldmgr_register_data_offload
            name: "wlan_bpf_enable_data_path",
            file: "/workspace/wlan_proc/src/offloads/bpf_offload_int.c",
            line: 1095,
            sourceText: "offldmgr_register_data_offload(ctx, wlan_bpf_filter_offload_handler)",
            classification: {
              patternName: "offldmgr_data_offload",
              registrationApi: "offldmgr_register_data_offload",
              dispatchKey: "data_handler",
              connectionKind: "interface_registration",
            },
            // Pattern resolver resolved the dispatch chain:
            // data_handler field → _offldmgr_enhanced_data_handler (hardcoded hint)
            resolvedChain: {
              confidenceScore: 3,
              confidenceLevel: "high",
              store: {
                containerType: "offload_ctx_t",
                storeFile: "/workspace/wlan_proc/src/offloads/offload_mgr.c",
                storeLine: 450,
                confidence: "high",
                evidence: "store:offload_ctx_t.data_handler",
              },
              dispatch: {
                // Pattern resolver hardcodes this for data_handler field
                dispatchFunction: "_offldmgr_enhanced_data_handler",
                dispatchFile: "/workspace/wlan_proc/src/offloads/offload_mgr_ext.c",
                dispatchLine: 1096,  // 0-based
                invocationPattern: "ctx->data_handler(pkt, vdev_id)",
                confidence: "high",
                evidence: "hint:store-field:data_handler",
              },
              trigger: {
                triggerKind: null,
                triggerKey: null,
                triggerFile: null,
                triggerLine: null,
                confidence: "low",
                evidence: "",
              },
            },
          },
        ],
      })),
    })
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, { file: bpfFile, line: 1, character: 5 })

    expect(result.source).toBe("lsp_indirect_callers")
    expect(result.targetApi).toBe("wlan_bpf_filter_offload_handler")
    expect(result.callers).toHaveLength(1)
    // Pattern resolver returns "_offldmgr_enhanced_data_handler" — must be canonicalized
    expect(result.callers[0]!.name).toBe("offldmgr_enhanced_data_handler")
    expect(result.callers[0]!.callerRole).toBe("runtime_caller")
    expect(result.callers[0]!.invocationType).toBe("runtime_dispatch_table_call")
    expect(result.callers[0]!.confidence).toBe(0.9) // "high" → 0.9
    // viaRegistrationApi should be the registrar
    expect(result.callers[0]!.viaRegistrationApi).toBe("offldmgr_register_data_offload")
  })

  it("Fallback: returns registrar when dispatch chain not resolved (no source files)", async () => {
    // When resolve:true fails to find the dispatch function (no source files),
    // the registrar goes into result.registrars (NOT result.callers)
    const client = makeMockClient({
      prepareCallHierarchy: vi.fn(async () => [
        { name: "wlan_bpf_filter_offload_handler", uri: `file://${bpfFile}`, selectionRange: { start: { line: 0 } } },
      ]),
      incomingCalls: vi.fn(async () => []),
    })
    const backend = makeMockBackend({
      collectIndirectCallers: vi.fn(async () => ({
        seed: { name: "wlan_bpf_filter_offload_handler", file: "/workspace/wlan_proc/src/offloads/bpf_offload.c", line: 83 },
        nodes: [
          {
            name: "wlan_bpf_enable_data_path",
            file: "/workspace/wlan_proc/src/offloads/bpf_offload_int.c",
            line: 1095,
            sourceText: "offldmgr_register_data_offload(ctx, wlan_bpf_filter_offload_handler)",
            classification: {
              patternName: "offldmgr_data_offload",
              registrationApi: "offldmgr_register_data_offload",
              dispatchKey: "data_handler",
              connectionKind: "interface_registration",
            },
            resolvedChain: null,  // No source files — chain not resolved
          },
        ],
      })),
    })
    const tracker = makeMockTracker()

    const result = await resolveCallers(client, tracker, backend, null, { file: bpfFile, line: 1, character: 5 })

    expect(result.source).toBe("lsp_indirect_callers")
    // Registrar goes into result.registrars, NOT result.callers
    expect(result.callers).toHaveLength(0)
    expect(result.registrars).toHaveLength(1)
    expect(result.registrars[0]!.name).toBe("wlan_bpf_enable_data_path")
    expect(result.registrars[0]!.callerRole).toBe("registrar")
    expect(result.registrars[0]!.invocationType).toBe("interface_registration")
    expect(result.registrars[0]!.viaRegistrationApi).toBe("offldmgr_register_data_offload")
  })
})
