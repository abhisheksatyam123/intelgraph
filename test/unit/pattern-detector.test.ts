import { describe, it, expect, vi } from "vitest"
import { detectIndirectCallers } from "../../src/tools/pattern-detector/detector.js"
import { CALL_PATTERNS, INIT_PATTERNS, findCallPatternByApi, getAllApiNames } from "../../src/tools/pattern-detector/registry.js"
import type { DetectorDeps } from "../../src/tools/pattern-detector/types.js"

// ── Pattern registry ─────────────────────────────────────────────────────────

describe("pattern registry", () => {
  it("has at most 5 call patterns (registry is minimal fast-path only)", () => {
    // The registry should only contain entries that the auto-classifier cannot
    // handle: macro-wrapped APIs, struct initializer patterns, type-erased callbacks.
    // This test is intentionally RED until the registry is reduced from 19 entries.
    expect(CALL_PATTERNS.length).toBeLessThanOrEqual(5)
  })

  it("has 1 init pattern", () => {
    expect(INIT_PATTERNS).toHaveLength(1)
  })

  it("all call patterns have required fields", () => {
    for (const p of CALL_PATTERNS) {
      expect(p.name).toBeTruthy()
      expect(p.registrationApi).toBeTruthy()
      expect(p.connectionKind).toBeTruthy()
      expect(p.keyArgIndex).toBeGreaterThanOrEqual(0)
      expect(p.keyDescription).toBeTruthy()
    }
  })

  it("findCallPatternByApi finds known patterns", () => {
    // offldmgr_register_data_offload is now handled by the auto-classifier
    expect(findCallPatternByApi("offldmgr_register_data_offload")).toBeUndefined()
    // IRQ patterns remain in registry as fast-path overrides
    expect(findCallPatternByApi("cmnos_irq_register_dynamic")?.name).toBe("irq_dynamic")
    expect(findCallPatternByApi("nonexistent")).toBeUndefined()
  })

  it("getAllApiNames returns all API names", () => {
    const names = getAllApiNames()
    // offldmgr_register_data_offload is now handled by auto-classifier
    expect(names).not.toContain("offldmgr_register_data_offload")
    // IRQ and WMI remain as fast-path overrides
    expect(names).toContain("cmnos_irq_register_dynamic")
    expect(names).toContain("wmi_unified_register_event_handler")
    expect(names.length).toBeLessThanOrEqual(5)
  })
})

// ── detectIndirectCallers (integration with mock LSP + real fixture files) ───

describe("detectIndirectCallers", () => {
  const FIXTURE_DIR = __dirname + "/../fixtures/indirect-callers"
  const HANDLERS = FIXTURE_DIR + "/handlers.c"
  const REGISTRATIONS = FIXTURE_DIR + "/registrations.c"

  const readFixture = (path: string): string => {
    try { return require("fs").readFileSync(path, "utf8") } catch { return "" }
  }

  const findLineAndChar = (filePath: string, token: string): { line: number; char: number } => {
    const content = readFixture(filePath)
    const lines = content.split(/\n/)
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].indexOf(token)
      if (idx !== -1) return { line: i, char: idx }
    }
    return { line: -1, char: -1 }
  }

  it("classifies offload_data registration via auto-classifier (no longer in registry)", async () => {
    const target = findLineAndChar(HANDLERS, "wlan_bpf_filter_offload_handler(")
    const reg = findLineAndChar(REGISTRATIONS, "wlan_bpf_filter_offload_handler")
    expect(target.line).toBeGreaterThanOrEqual(0)
    expect(reg.line).toBeGreaterThanOrEqual(0)

    // offldmgr_register_data_offload is no longer in the registry.
    // Without autoClassifier deps, the site is unclassified.
    const deps: DetectorDeps = {
      lspClient: {
        prepareCallHierarchy: vi.fn().mockImplementation(async (file: string, line: number) => {
          if (file === HANDLERS && line === target.line) {
            return [{ name: "wlan_bpf_filter_offload_handler", uri: `file://${HANDLERS}`, selectionRange: { start: { line: target.line, character: 0 } } }]
          }
          if (file === REGISTRATIONS) {
            return [{ name: "setup_offloads", uri: `file://${REGISTRATIONS}`, selectionRange: { start: { line: reg.line, character: 0 } } }]
          }
          return []
        }),
        references: vi.fn().mockResolvedValue([
          { uri: `file://${HANDLERS}`, range: { start: { line: target.line, character: 0 } } },
          { uri: `file://${REGISTRATIONS}`, range: { start: { line: reg.line, character: reg.char } } },
        ]),
      },
      readFile: readFixture,
      // No autoClassifier deps → site is unclassified (auto-classifier not invoked)
    }

    const result = await detectIndirectCallers(
      { file: HANDLERS, line: target.line + 1, character: 1 },
      deps,
    )

    expect(result.seed?.name).toBe("wlan_bpf_filter_offload_handler")
    // Without autoClassifier, the site is unclassified (enclosingCall is set but matchedPattern is null)
    expect(result.sites).toHaveLength(1)
    expect(result.unclassifiedSites).toHaveLength(1)
    expect(result.unclassifiedSites[0].enclosingCall?.name).toBe("offldmgr_register_data_offload")
  })

  it("classifies irq_dynamic registration via parser", async () => {
    const target = findLineAndChar(HANDLERS, "wsi_high_prio_irq_route(")
    const reg = findLineAndChar(REGISTRATIONS, "wsi_high_prio_irq_route")
    expect(target.line).toBeGreaterThanOrEqual(0)
    expect(reg.line).toBeGreaterThanOrEqual(0)

    const deps: DetectorDeps = {
      lspClient: {
        prepareCallHierarchy: vi.fn().mockImplementation(async (file: string, line: number) => {
          if (file === HANDLERS && line === target.line) {
            return [{ name: "wsi_high_prio_irq_route", uri: `file://${HANDLERS}`, selectionRange: { start: { line: target.line, character: 0 } } }]
          }
          if (file === REGISTRATIONS) {
            return [{ name: "setup_irqs", uri: `file://${REGISTRATIONS}`, selectionRange: { start: { line: reg.line, character: 0 } } }]
          }
          return []
        }),
        references: vi.fn().mockResolvedValue([
          { uri: `file://${HANDLERS}`, range: { start: { line: target.line, character: 0 } } },
          { uri: `file://${REGISTRATIONS}`, range: { start: { line: reg.line, character: reg.char } } },
        ]),
      },
      readFile: readFixture,
    }

    const result = await detectIndirectCallers(
      { file: HANDLERS, line: target.line + 1, character: 1 },
      deps,
    )

    expect(result.matchedSites).toHaveLength(1)
    expect(result.matchedSites[0].matchedPattern?.name).toBe("irq_dynamic")
    expect(result.matchedSites[0].dispatchKey).toBe("A_INUM_WSI")
    expect(result.matchedSites[0].connectionKind).toBe("hw_interrupt")
  })

  it("handles multi-line registration calls via parser (auto-classifier path)", async () => {
    const target = findLineAndChar(HANDLERS, "wal_tqm_hipri_status_intr_sig_hdlr(")
    const reg = findLineAndChar(REGISTRATIONS, "wal_tqm_hipri_status_intr_sig_hdlr")
    expect(target.line).toBeGreaterThanOrEqual(0)
    expect(reg.line).toBeGreaterThanOrEqual(0)

    // wlan_thread_register_signal_wrapper is no longer in the registry.
    // Without autoClassifier deps, the site is unclassified but enclosingCall is set.
    const deps: DetectorDeps = {
      lspClient: {
        prepareCallHierarchy: vi.fn().mockImplementation(async (file: string, line: number) => {
          if (file === HANDLERS && line === target.line) {
            return [{ name: "wal_tqm_hipri_status_intr_sig_hdlr", uri: `file://${HANDLERS}`, selectionRange: { start: { line: target.line, character: 0 } } }]
          }
          if (file === REGISTRATIONS) {
            return [{ name: "setup_thread_signals", uri: `file://${REGISTRATIONS}`, selectionRange: { start: { line: reg.line, character: 0 } } }]
          }
          return []
        }),
        references: vi.fn().mockResolvedValue([
          { uri: `file://${HANDLERS}`, range: { start: { line: target.line, character: 0 } } },
          { uri: `file://${REGISTRATIONS}`, range: { start: { line: reg.line, character: reg.char } } },
        ]),
      },
      readFile: readFixture,
    }

    const result = await detectIndirectCallers(
      { file: HANDLERS, line: target.line + 1, character: 1 },
      deps,
    )

    // Parser correctly finds the enclosing call even without registry match
    expect(result.sites).toHaveLength(1)
    expect(result.unclassifiedSites).toHaveLength(1)
    expect(result.unclassifiedSites[0].enclosingCall?.name).toBe("wlan_thread_register_signal_wrapper")
    // The dispatch key is still extractable from the enclosing call args
    const args = result.unclassifiedSites[0].enclosingCall?.args ?? []
    expect(args.some((a: string) => a.includes("WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR"))).toBe(true)
  })

  it("returns empty when no references found", async () => {
    const deps: DetectorDeps = {
      lspClient: {
        prepareCallHierarchy: vi.fn().mockResolvedValue([{ name: "fn", uri: "file:///a.c", selectionRange: { start: { line: 0, character: 0 } } }]),
        references: vi.fn().mockResolvedValue([]),
      },
      readFile: () => "",
    }

    const result = await detectIndirectCallers(
      { file: "/a.c", line: 1, character: 1 },
      deps,
    )

    expect(result.sites).toHaveLength(0)
    expect(result.matchedSites).toHaveLength(0)
  })

  it("skips definition site", async () => {
    const target = findLineAndChar(HANDLERS, "wlan_bpf_filter_offload_handler(")
    const reg = findLineAndChar(REGISTRATIONS, "wlan_bpf_filter_offload_handler")
    expect(target.line).toBeGreaterThanOrEqual(0)
    expect(reg.line).toBeGreaterThanOrEqual(0)

    const deps: DetectorDeps = {
      lspClient: {
        prepareCallHierarchy: vi.fn().mockResolvedValue([
          { name: "wlan_bpf_filter_offload_handler", uri: `file://${HANDLERS}`, selectionRange: { start: { line: target.line, character: 0 } } },
        ]),
        references: vi.fn().mockResolvedValue([
          { uri: `file://${HANDLERS}`, range: { start: { line: target.line, character: 0 } } },
          { uri: `file://${REGISTRATIONS}`, range: { start: { line: reg.line, character: reg.char } } },
        ]),
      },
      readFile: readFixture,
    }

    const result = await detectIndirectCallers({ file: HANDLERS, line: target.line + 1, character: 1 }, deps)
    const defSites = result.sites.filter((s) => s.filePath === HANDLERS)
    expect(defSites).toHaveLength(0)
    // The registration site is found (not skipped), but unclassified (no registry match, no auto-classifier)
    expect(result.sites).toHaveLength(1)
    expect(result.unclassifiedSites).toHaveLength(1)
  })

  it("reports null classification for non-matching calls", async () => {
    // The mock returns a result for prepareCallHierarchy (so the site is added),
    // but the enclosing call at line 77 ("int x = 42;") has no function call,
    // so the parser finds nothing and the site gets null classification.
    const deps: DetectorDeps = {
      lspClient: {
        prepareCallHierarchy: vi.fn().mockResolvedValue([
          { name: "fn", uri: "file:///a.c", selectionRange: { start: { line: 0, character: 0 } } },
        ]),
        references: vi.fn().mockResolvedValue([
          { uri: "file:///a.c", range: { start: { line: 0, character: 0 } } }, // definition
          { uri: `file://${REGISTRATIONS}`, range: { start: { line: 77, character: 4 } } },
        ]),
      },
      readFile: readFixture,
    }

    const result = await detectIndirectCallers({ file: "/a.c", line: 1, character: 1 }, deps)
    // Site is added (prepareCallHierarchy returned a result), but classified as null
    // because "int x = 42;" has no matching call/init pattern
    expect(result.sites).toHaveLength(1)
    expect(result.sites[0].matchedPattern).toBeNull()
    expect(result.unclassifiedSites).toHaveLength(1)
  })
})

// ── Auto-classifier ───────────────────────────────────────────────────────────
//
// These tests verify the auto-classifier that uses tree-sitter AST analysis
// to detect fn-ptr args and extract callbackParamName from the registration
// API body. No LSP hover() needed — tree-sitter gives us parameter types.

describe("auto-classifier", () => {
  // Inline source strings for testing — no fixture files needed
  const UNKNOWN_REG_BODY = `
void unknown_register_fn(struct ctx *c, int key, cb_fn_t my_callback, void *arg)
{
    c->handlers[key].fn = my_callback;
    c->handlers[key].arg = arg;
}
`

  const MACRO_BODY = `
#define macro_register(ctx, sig_id, handler, arg, wrapper) \
    real_register_fn(ctx, sig_id, handler, arg, wrapper)
`

  const REAL_FN_BODY = `
void real_register_fn(struct ctx *c, int sig_id, sig_fn_t sig_handler, void *arg, void *wrapper)
{
    c->signals[sig_id].sig_handler = sig_handler;
    c->signals[sig_id].arg = arg;
}
`

  // Caller source: the call is on line 5 (0-based)
  const CALLER_SOURCE = [
    "/* caller.c */",
    "void setup(struct ctx *c) {",
    "    int x = 1;",
    "    int y = 2;",
    "    int z = 3;",
    "    unknown_register_fn(ctx, MY_KEY, my_callback, NULL);",
    "}",
  ].join("\n")

  it("detects fn-ptr arg via tree-sitter parameter type analysis", async () => {
    const { autoClassifyCall } = await import(
      "../../src/tools/pattern-detector/auto-classifier.js"
    )

    const mockDeps = {
      lspClientFull: {
        // hover not needed — tree-sitter handles fn-ptr detection
        definition: vi.fn().mockResolvedValue([
          { uri: "file:///workspace/src/reg.c", range: { start: { line: 1, character: 0 } } },
        ]),
      },
      readFile: vi.fn().mockImplementation((p: string) => {
        if (p.includes("caller.c")) return CALLER_SOURCE
        return UNKNOWN_REG_BODY  // definition file
      }),
    }

    // Simulate a FunctionCall for "unknown_register_fn(ctx, MY_KEY, my_callback, NULL)"
    const mockCall = {
      name: "unknown_register_fn",
      nameLine: 5,
      nameCol: 4,
      args: ["ctx", "MY_KEY", "my_callback", "NULL"],
      fullText: "unknown_register_fn(ctx, MY_KEY, my_callback, NULL)",
      nodeType: "call_expression",
    }

    const result = await autoClassifyCall(
      mockCall,
      "my_callback",
      "/workspace/src/caller.c",
      5,
      4,
      mockDeps,
    )

    expect(result).not.toBeNull()
    expect(result!.matchedPattern?.name).toMatch(/^auto:/)
    // callbackParamName extracted from tree-sitter AST of the registration body
    expect(result!.callbackParamName).toBeTruthy()
    expect(result!.dispatchKey).toBe("MY_KEY")
  })

  it("derives connectionKind from call name tokens", async () => {
    const { deriveConnectionKind } = await import(
      "../../src/tools/pattern-detector/auto-classifier.js"
    )

    expect(deriveConnectionKind("cmnos_irq_register_dynamic")).toBe("hw_interrupt")
    // timer maps to api_call (PatternConnectionKind has no timer_expiry)
    expect(deriveConnectionKind("A_INIT_TIMER")).toBe("api_call")
    expect(deriveConnectionKind("wlan_thread_register_signal_wrapper")).toBe("event")
    expect(deriveConnectionKind("wlan_vdev_register_notif_handler")).toBe("event")
    expect(deriveConnectionKind("unknown_register_fn")).toBe("api_call")
  })

  it("extracts dispatchKey from adjacent ALL_CAPS arg", async () => {
    const { extractDispatchKey } = await import(
      "../../src/tools/pattern-detector/auto-classifier.js"
    )

    // fn-ptr at index 2, ALL_CAPS key at index 1
    expect(extractDispatchKey(["ctx", "MY_KEY", "my_callback", "NULL"], 2)).toBe("MY_KEY")
    // fn-ptr at index 1, ALL_CAPS key at index 0
    expect(extractDispatchKey(["A_INUM_WSI", "irq_handler"], 1)).toBe("A_INUM_WSI")
    // no ALL_CAPS adjacent → null
    expect(extractDispatchKey(["ctx", "my_callback", "arg"], 1)).toBeNull()
  })

  it("follows macro expansion to underlying function body", async () => {
    const { autoClassifyCall } = await import(
      "../../src/tools/pattern-detector/auto-classifier.js"
    )

    // Caller source with macro call on line 10 (0-based)
    const MACRO_CALLER = Array(10).fill("").join("\n") +
      "\n    macro_register(ctx, SIG_ID, my_handler, NULL, wrapper);"

    let definitionCallCount = 0
    const mockDeps = {
      lspClientFull: {
        definition: vi.fn().mockImplementation(async () => {
          definitionCallCount++
          if (definitionCallCount === 1) {
            // First call: resolves to macro definition
            return [{ uri: "file:///workspace/src/macro.h", range: { start: { line: 1, character: 0 } } }]
          }
          // Second call: resolves to real function body
          return [{ uri: "file:///workspace/src/real_fn.c", range: { start: { line: 1, character: 0 } } }]
        }),
      },
      readFile: vi.fn().mockImplementation((p: string) => {
        if (p.includes("macro.h")) return MACRO_BODY
        if (p.includes("real_fn.c")) return REAL_FN_BODY
        if (p.includes("caller.c")) return MACRO_CALLER
        return ""
      }),
    }

    const mockCall = {
      name: "macro_register",
      nameLine: 10,
      nameCol: 4,
      args: ["ctx", "SIG_ID", "my_handler", "NULL", "wrapper"],
      fullText: "macro_register(ctx, SIG_ID, my_handler, NULL, wrapper)",
      nodeType: "call_expression",
    }

    const result = await autoClassifyCall(
      mockCall,
      "my_handler",
      "/workspace/src/caller.c",
      10,
      4,
      mockDeps,
    )

    expect(result).not.toBeNull()
    // callbackParamName should come from the real function body, not the macro
    expect(result!.callbackParamName).toBe("sig_handler")
    // definition() should have been called at least twice (macro + real fn)
    expect(definitionCallCount).toBeGreaterThanOrEqual(2)
  })

  it("returns null gracefully when definition() fails", async () => {
    const { autoClassifyCall } = await import(
      "../../src/tools/pattern-detector/auto-classifier.js"
    )

    const mockDeps = {
      lspClientFull: {
        definition: vi.fn().mockRejectedValue(new Error("LSP unavailable")),
      },
      readFile: vi.fn().mockReturnValue(""),
    }

    const mockCall = {
      name: "unknown_register_fn",
      nameLine: 5,
      nameCol: 4,
      args: ["ctx", "MY_KEY", "my_callback", "NULL"],
      fullText: "unknown_register_fn(ctx, MY_KEY, my_callback, NULL)",
      nodeType: "call_expression",
    }

    const result = await autoClassifyCall(
      mockCall,
      "my_callback",
      "/workspace/src/caller.c",
      5,
      4,
      mockDeps,
    )

    // Graceful degradation — returns null, does not throw
    expect(result).toBeNull()
  })
})
