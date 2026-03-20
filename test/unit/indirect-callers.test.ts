import { describe, expect, it } from "vitest"
import {
  formatIncomingCalls,
} from "../../src/tools/index.ts"
import {
  classifyIncomingCall,
  formatIndirectCallers,
  IndirectCallersEngine,
  findRingTrigger,
} from "../../src/tools/indirect-callers.ts"

function range(line: number, character: number, width = 6) {
  return {
    start: { line, character },
    end: { line, character: character + width },
  }
}

// ── Classification ────────────────────────────────────────────────────────────

describe("indirect caller classification", () => {
  it("classifies dispatch-table owners as registration-dispatch-table", () => {
    const call = {
      from: {
        name: "dispatch_entries",
        kind: 13,
        uri: "file:///workspace/src/callbacks.c",
        selectionRange: range(10, 2),
      },
      fromRanges: [range(12, 8)],
    }
    // Tier 1: from.kind == 13 → dispatch table regardless of targetName
    expect(classifyIncomingCall(call, "my_handler")).toBe("registration-dispatch-table")
  })

  it("classifies known WLAN registration APIs as registration-call", () => {
    const call = {
      from: {
        name: "offldmgr_register_data_offload",
        kind: 12,
        uri: "file:///workspace/src/callbacks.c",
        selectionRange: range(20, 2),
      },
      fromRanges: [range(21, 18)],
    }
    // Tier 2: from.name in WLAN_REGISTRATION_APIS
    expect(classifyIncomingCall(call, "my_handler")).toBe("registration-call")
  })

  it("classifies struct field assignments as registration-struct", () => {
    const call = {
      from: {
        name: "configure_callbacks",
        kind: 12,
        uri: "/tmp/indirect-callers-struct.c",
        selectionRange: range(1, 0),
      },
      fromRanges: [range(2, 17)],
    }
    // Tier 3: source line has ".field = " pattern
    expect(classifyIncomingCall(call, "my_handler")).toBe("registration-struct")
  })

  it("classifies plain call expressions as direct", () => {
    const call = {
      from: {
        name: "some_caller",
        kind: 12,
        uri: "/tmp/indirect-callers-direct.c",
        selectionRange: range(1, 0),
      },
      fromRanges: [range(2, 2)],
    }
    // Tier 3: source line has "target_handler(" pattern
    expect(classifyIncomingCall(call, "target_handler")).toBe("direct")
  })

  it("Tier 1 takes priority over Tier 2 — kind=13 always dispatch-table", () => {
    // Even if the name were in WLAN_REGISTRATION_APIS, kind=13 wins
    const call = {
      from: { name: "cmnos_timer_setfn", kind: 13, uri: "file:///x.c", selectionRange: range(0, 0) },
      fromRanges: [],
    }
    expect(classifyIncomingCall(call, "my_fn")).toBe("registration-dispatch-table")
  })

  it("falls back to registration-call when Tier 3 is inconclusive", () => {
    // No source file, no fromRanges → contexts empty → conservative fallback
    const call = {
      from: { name: "unknown_fn", kind: 12, uri: undefined, selectionRange: range(0, 0) },
      fromRanges: [],
    }
    expect(classifyIncomingCall(call, "my_fn")).toBe("registration-call")
  })
})

// ── Incoming call formatter (lsp_incoming_calls) ──────────────────────────────

describe("incoming call formatter", () => {
  it("formats readable kind labels and classification tags", () => {
    const text = formatIncomingCalls([
      {
        from: {
          name: "register_handler",
          kind: 12,
          uri: "file:///workspace/src/callbacks.c",
          selectionRange: range(14, 2),
        },
      },
      {
        from: {
          name: "dispatch_entries",
          kind: 13,
          uri: "file:///workspace/src/callbacks.c",
          selectionRange: range(28, 2),
        },
      },
    ], "/workspace")

    // dispatch_entries (kind=13) → dispatch-table tag
    expect(text).toContain("[dispatch-table,variable]")
    expect(text).toContain("dispatch_entries")
    // register_handler (kind=12, unknown API) → reg-call tag (conservative fallback)
    expect(text).toContain("register_handler")
  })

  it("returns the empty-state message when there are no incoming calls", () => {
    expect(formatIncomingCalls([], "/workspace")).toBe("No incoming calls.")
  })
})

// ── Indirect caller formatter (lsp_indirect_callers) ─────────────────────────

describe("indirect caller formatter — flat grouped output", () => {
  it("renders grouped sections with correct headers", () => {
    const text = formatIndirectCallers({
      seed: { name: "target_handler" },
      nodes: [
        {
          id: "n1",
          name: "dispatch_entries",
          kind: 13,
          uri: "file:///workspace/src/callbacks.c",
          location: "src/callbacks.c:29:3",
          classification: "registration-dispatch-table",
          registrationApi: null,
          sourceContext: ["{ my_handler, WMI_BPF_GET_CAPABILITY_CMDID, 0 }"],
          fromRanges: [range(28, 2)],
        },
        {
          id: "n2",
          name: "wlan_bpf_offload_pdev_init",
          kind: 12,
          uri: "file:///workspace/src/bpf.c",
          location: "src/bpf.c:210:5",
          classification: "registration-call",
          registrationApi: "offldmgr_register_data_offload",
          sourceContext: [],
          fromRanges: [range(209, 4)],
        },
        {
          id: "n3",
          name: "wlan_bpf_offload_vdev_filter_handle",
          kind: 12,
          uri: "file:///workspace/src/bpf.c",
          location: "src/bpf.c:161:5",
          classification: "direct",
          registrationApi: null,
          sourceContext: [],
          fromRanges: [range(160, 4)],
        },
      ],
    })

    expect(text).toContain("Callers of target_handler")
    expect(text).toContain("3 total")
    expect(text).toContain("Direct callers (1):")
    expect(text).toContain("Dispatch-table registrations (1):")
    expect(text).toContain("Registration-call registrations (1):")
    expect(text).toContain("wlan_bpf_offload_vdev_filter_handle")
    expect(text).toContain("dispatch_entries")
    expect(text).toContain("wlan_bpf_offload_pdev_init")
    expect(text).toContain("via: offldmgr_register_data_offload")
    expect(text).toContain("event: WMI_BPF_GET_CAPABILITY_CMDID")
  })

  it("returns none-found message for empty nodes", () => {
    const text = formatIndirectCallers({ seed: { name: "my_fn" }, nodes: [] })
    expect(text).toContain("none found")
  })

  it("returns not-resolved message when seed is null", () => {
    const text = formatIndirectCallers({ seed: null, nodes: [] })
    expect(text).toContain("not resolved")
  })

  it("shows only sections that have nodes", () => {
    const text = formatIndirectCallers({
      seed: { name: "fn" },
      nodes: [{
        id: "x",
        name: "caller",
        kind: 12,
        uri: null,
        location: "a.c:1:1",
        classification: "direct",
        registrationApi: null,
        sourceContext: [],
        fromRanges: [],
      }],
    })
    expect(text).toContain("Direct callers (1):")
    expect(text).not.toContain("Dispatch-table")
    expect(text).not.toContain("Registration-call")
  })
})

// ── Engine — flat single-pass ─────────────────────────────────────────────────

describe("IndirectCallersEngine — flat single-pass", () => {
  it("returns all incoming calls classified, no recursion", async () => {
    let incomingCallsCallCount = 0

    const engine = new IndirectCallersEngine({
      root: "/workspace",
      prepareCallHierarchy: async () => [{
        name: "target_handler",
        kind: 12,
        uri: "file:///workspace/root.c",
        selectionRange: range(9, 4),
      }],
      incomingCalls: async () => {
        incomingCallsCallCount++
        return [
          {
            from: { name: "direct_caller", kind: 12, uri: "file:///workspace/a.c", selectionRange: range(5, 2) },
            fromRanges: [range(6, 4)],
          },
          {
            from: { name: "dispatch_table", kind: 13, uri: "file:///workspace/b.c", selectionRange: range(10, 2) },
            fromRanges: [range(11, 4)],
          },
        ]
      },
    } as any)

    const graph = await engine.run("/workspace/root.c", 9, 4)

    // Exactly ONE incomingCalls call — no recursion
    expect(incomingCallsCallCount).toBe(1)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.seed?.name).toBe("target_handler")
  })

  it("respects maxNodes limit", async () => {
    const engine = new IndirectCallersEngine({
      root: "/workspace",
      prepareCallHierarchy: async () => [{ name: "fn", kind: 12, uri: "file:///workspace/x.c", selectionRange: range(0, 0) }],
      incomingCalls: async () => Array.from({ length: 10 }, (_, i) => ({
        from: { name: `caller_${i}`, kind: 12, uri: `file:///workspace/c${i}.c`, selectionRange: range(i, 0) },
        fromRanges: [],
      })),
    } as any, { maxNodes: 3 })

    const graph = await engine.run("/workspace/x.c", 0, 0)
    expect(graph.nodes.length).toBeLessThanOrEqual(3)
  })

  it("returns empty graph when prepareCallHierarchy returns nothing", async () => {
    const engine = new IndirectCallersEngine({
      root: "/workspace",
      prepareCallHierarchy: async () => [],
      incomingCalls: async () => [],
    } as any)

    const graph = await engine.run("/workspace/x.c", 0, 0)
    expect(graph.seed).toBeNull()
    expect(graph.nodes).toHaveLength(0)
  })

  it("deduplicates nodes with the same id", async () => {
    const engine = new IndirectCallersEngine({
      root: "/workspace",
      prepareCallHierarchy: async () => [{ name: "fn", kind: 12, uri: "file:///workspace/x.c", selectionRange: range(0, 0) }],
      incomingCalls: async () => [
        // Same uri:name:line:char → same id → deduplicated
        { from: { name: "dup", kind: 12, uri: "file:///workspace/a.c", selectionRange: range(5, 0) }, fromRanges: [range(5, 0)] },
        { from: { name: "dup", kind: 12, uri: "file:///workspace/a.c", selectionRange: range(5, 0) }, fromRanges: [range(5, 0)] },
      ],
    } as any)

    const graph = await engine.run("/workspace/x.c", 0, 0)
    expect(graph.nodes).toHaveLength(1)
  })
})

// ── Ring-triggered handler patterns ──────────────────────────────────────────

describe("ring-triggered handler classification", () => {
  it("classifies wlan_thread_register_signal_wrapper_internal as registration-call", () => {
    const call = {
      from: { name: "wlan_thread_register_signal_wrapper_internal", kind: 12, uri: undefined, selectionRange: range(0, 0) },
      fromRanges: [],
    }
    expect(classifyIncomingCall(call, "my_ring_handler")).toBe("registration-call")
  })

  it("classifies wlan_thread_register_signal_wrapper_sim as registration-call", () => {
    const call = {
      from: { name: "wlan_thread_register_signal_wrapper_sim", kind: 12, uri: undefined, selectionRange: range(0, 0) },
      fromRanges: [],
    }
    expect(classifyIncomingCall(call, "my_ring_handler")).toBe("registration-call")
  })

  it("classifies wlan_thread_register_signal as registration-call", () => {
    const call = {
      from: { name: "wlan_thread_register_signal", kind: 12, uri: undefined, selectionRange: range(0, 0) },
      fromRanges: [],
    }
    expect(classifyIncomingCall(call, "my_ring_handler")).toBe("registration-call")
  })

  it("classifies cmnos_irq_register_dynamic as registration-call", () => {
    const call = {
      from: { name: "cmnos_irq_register_dynamic", kind: 12, uri: undefined, selectionRange: range(0, 0) },
      fromRanges: [],
    }
    expect(classifyIncomingCall(call, "my_isr")).toBe("registration-call")
  })

  it("classifies cmnos_isr_attach as registration-call", () => {
    const call = {
      from: { name: "cmnos_isr_attach", kind: 12, uri: undefined, selectionRange: range(0, 0) },
      fromRanges: [],
    }
    expect(classifyIncomingCall(call, "my_isr")).toBe("registration-call")
  })

  it("classifies cmnos_dsr_attach as registration-call", () => {
    const call = {
      from: { name: "cmnos_dsr_attach", kind: 12, uri: undefined, selectionRange: range(0, 0) },
      fromRanges: [],
    }
    expect(classifyIncomingCall(call, "my_dsr")).toBe("registration-call")
  })
})

describe("ring trigger formatter output", () => {
  it("shows triggered-by line when ringTrigger is present", () => {
    const text = formatIndirectCallers({
      seed: { name: "wal_tqm_hipri_status_intr_sig_hdlr" },
      nodes: [{
        id: "n1",
        name: "wlan_tqm_thrd_sig_register",
        kind: 12,
        uri: "file:///workspace/tqm_thread.c",
        location: "tqm_thread.c:122:5",
        classification: "registration-call",
        registrationApi: "wlan_thread_register_signal_wrapper_internal",
        sourceContext: [
          "wlan_thread_register_signal_wrapper(thread_ctxt, WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR, wal_tqm_hipri_status_intr_sig_hdlr, me, tqm_thread_dsr_wrapper)",
        ],
        fromRanges: [range(121, 4)],
        ringTrigger: {
          interruptId:   "A_INUM_TQM_STATUS_HI",
          file:          "/workspace/tqm_thread.c",
          line:          310,
          sourceContext: "cmnos_irq_register(A_INUM_TQM_STATUS_HI, me, WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR);",
        },
      }],
    })

    expect(text).toContain("via: wlan_thread_register_signal_wrapper_internal")
    expect(text).toContain("signal: WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR")
    expect(text).toContain("triggered by: A_INUM_TQM_STATUS_HI")
    expect(text).toContain("HW ring interrupt → signal → this handler")
  })

  it("shows search hint when ringTrigger is null (rg unavailable or no match)", () => {
    const text = formatIndirectCallers({
      seed: { name: "my_ring_handler" },
      nodes: [{
        id: "n1",
        name: "tqm_thread_init",
        kind: 12,
        uri: null,
        location: "tqm_thread.c:122:5",
        classification: "registration-call",
        registrationApi: "wlan_thread_register_signal_wrapper_internal",
        sourceContext: [
          "wlan_thread_register_signal_wrapper(ctxt, WLAN_THREAD_SIG_TQM_LOWPRI_STATUS_HW_INTR, my_ring_handler, me, wrapper)",
        ],
        fromRanges: [],
        ringTrigger: null,
      }],
    })

    expect(text).toContain("signal: WLAN_THREAD_SIG_TQM_LOWPRI_STATUS_HW_INTR")
    expect(text).toContain("triggered by: [search cmnos_irq_register")
    expect(text).toContain("WLAN_THREAD_SIG_TQM_LOWPRI_STATUS_HW_INTR")
  })

  it("shows interrupt ID directly for cmnos_irq_register_dynamic nodes", () => {
    const text = formatIndirectCallers({
      seed: { name: "wlan_thread_isr_rx_sifs" },
      nodes: [{
        id: "n1",
        name: "be_thread_irq_init",
        kind: 12,
        uri: null,
        location: "be_thread.c:126:5",
        classification: "registration-call",
        registrationApi: "cmnos_irq_register_dynamic",
        sourceContext: [
          "cmnos_irq_register_dynamic(A_INUM_WMAC0_RX_SIFS, wlan_thread_isr_rx_sifs);",
        ],
        fromRanges: [],
        ringTrigger: {
          interruptId:   "A_INUM_WMAC0_RX_SIFS",
          file:          "/workspace/be_thread.c",
          line:          126,
          sourceContext: "cmnos_irq_register_dynamic(A_INUM_WMAC0_RX_SIFS, wlan_thread_isr_rx_sifs);",
        },
      }],
    })

    expect(text).toContain("via: cmnos_irq_register_dynamic")
    expect(text).toContain("triggered by: A_INUM_WMAC0_RX_SIFS")
  })
})

describe("findRingTrigger", () => {
  it("returns null for empty signalId", () => {
    expect(findRingTrigger("", "/workspace")).toBeNull()
  })

  it("returns null for empty root", () => {
    expect(findRingTrigger("WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR", "")).toBeNull()
  })

  it("returns null when root does not exist", () => {
    // Non-existent root — rg will fail gracefully
    const result = findRingTrigger("WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR", "/nonexistent/path/xyz")
    expect(result).toBeNull()
  })
})
