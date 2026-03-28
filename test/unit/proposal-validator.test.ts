import { describe, it, expect } from "vitest"
import { validateReasonProposals } from "../../src/tools/reason-engine/proposal-validator.js"
import type { ProposedReasonPath } from "../../src/tools/reason-engine/llm-advisor.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fully valid proposal — all three layers present and correct. */
function validProposal(overrides: Partial<ProposedReasonPath> = {}): ProposedReasonPath {
  return {
    registrarFn: "my_registrar",
    registrationApi: "register_callback",
    storageFieldPath: "ctx->handler",
    dispatchPattern: "fn-ptr-field",
    gates: ["ctx->enabled == true"],
    invocationReason: {
      runtimeTrigger: "An incoming network packet triggers the RX interrupt handler",
      dispatchChain: ["rx_interrupt_handler", "dispatch_callbacks", "my_target_fn"],
      dispatchSite: {
        file: "/workspace/src/dispatch.c",
        line: 42,
        snippet: "ctx->handler(ctx, pkt)",
      },
      registrationGate: {
        registrarFn: "my_registrar",
        registrationApi: "register_callback",
        conditions: ["ctx->enabled == true", "pkt->type == PKT_TYPE_DATA"],
      },
    },
    requiredFiles: ["/workspace/src/registrar.c", "/workspace/src/dispatch.c"],
    confidence: 0.9,
    rationale: "Handler registered in my_registrar; dispatch loop in dispatch_callbacks calls ctx->handler on each RX packet.",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proposal-validator", () => {

  // ── Accept ────────────────────────────────────────────────────────────────

  it("accepts a fully valid proposal", () => {
    const { accepted, rejected } = validateReasonProposals([validProposal()])
    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })

  it("accepts multiple valid proposals", () => {
    const { accepted, rejected } = validateReasonProposals([
      validProposal({ registrarFn: "registrar_a" }),
      validProposal({ registrarFn: "registrar_b" }),
    ])
    expect(accepted).toHaveLength(2)
    expect(rejected).toHaveLength(0)
  })

  it("accepts empty proposals array", () => {
    const { accepted, rejected } = validateReasonProposals([])
    expect(accepted).toHaveLength(0)
    expect(rejected).toHaveLength(0)
  })

  it("accepts undefined proposals", () => {
    const { accepted, rejected } = validateReasonProposals(undefined)
    expect(accepted).toHaveLength(0)
    expect(rejected).toHaveLength(0)
  })

  // ── Reject: basic quality gates ───────────────────────────────────────────

  it("rejects when requiredFiles is empty", () => {
    const { rejected } = validateReasonProposals([validProposal({ requiredFiles: [] })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-required-files")
  })

  it("rejects when confidence is below 0.5", () => {
    const { rejected } = validateReasonProposals([validProposal({ confidence: 0.4 })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("low-confidence")
  })

  it("accepts when confidence is exactly 0.5", () => {
    const { accepted } = validateReasonProposals([validProposal({ confidence: 0.5 })])
    expect(accepted).toHaveLength(1)
  })

  // ── Reject: missing invocationReason (the primary output) ─────────────────

  it("rejects when invocationReason is absent", () => {
    const p = validProposal()
    delete (p as any).invocationReason
    const { rejected } = validateReasonProposals([p])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-invocation-reason")
  })

  it("rejects when invocationReason is null", () => {
    const { rejected } = validateReasonProposals([validProposal({ invocationReason: null as any })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-invocation-reason")
  })

  // ── Reject: Layer C — runtimeTrigger ──────────────────────────────────────

  it("rejects when runtimeTrigger is empty string", () => {
    const { rejected } = validateReasonProposals([validProposal({
      invocationReason: { ...validProposal().invocationReason!, runtimeTrigger: "" },
    })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-runtime-trigger")
  })

  it("rejects when runtimeTrigger is too short (< 10 chars)", () => {
    const { rejected } = validateReasonProposals([validProposal({
      invocationReason: { ...validProposal().invocationReason!, runtimeTrigger: "RX pkt" },
    })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-runtime-trigger")
  })

  it("accepts when runtimeTrigger is exactly 10 chars", () => {
    const { accepted } = validateReasonProposals([validProposal({
      invocationReason: { ...validProposal().invocationReason!, runtimeTrigger: "1234567890" },
    })])
    expect(accepted).toHaveLength(1)
  })

  // ── Reject: Layer B — dispatchChain ───────────────────────────────────────

  it("rejects when dispatchChain is empty", () => {
    const { rejected } = validateReasonProposals([validProposal({
      invocationReason: { ...validProposal().invocationReason!, dispatchChain: [] },
    })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-dispatch-chain")
  })

  it("rejects when dispatchChain has only 1 entry (needs entry-point + target)", () => {
    const { rejected } = validateReasonProposals([validProposal({
      invocationReason: { ...validProposal().invocationReason!, dispatchChain: ["only_one"] },
    })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-dispatch-chain")
  })

  it("accepts when dispatchChain has exactly 2 entries", () => {
    const { accepted } = validateReasonProposals([validProposal({
      invocationReason: { ...validProposal().invocationReason!, dispatchChain: ["entry", "target"] },
    })])
    expect(accepted).toHaveLength(1)
  })

  // ── Reject: Layer B — dispatchSite ────────────────────────────────────────

  it("rejects when dispatchSite.file is empty", () => {
    const { rejected } = validateReasonProposals([validProposal({
      invocationReason: {
        ...validProposal().invocationReason!,
        dispatchSite: { file: "", line: 0, snippet: "" },
      },
    })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-dispatch-site")
  })

  it("rejects when dispatchSite is missing entirely", () => {
    const ir = { ...validProposal().invocationReason! }
    delete (ir as any).dispatchSite
    const { rejected } = validateReasonProposals([validProposal({ invocationReason: ir })])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe("missing-dispatch-site")
  })

  // ── Accept: registrationGate is optional ─────────────────────────────────────

  it("accepts missing registrationGate entirely", () => {
    const ir = { ...validProposal().invocationReason! }
    delete (ir as any).registrationGate
    const { accepted } = validateReasonProposals([validProposal({ invocationReason: ir })])
    expect(accepted).toHaveLength(1)
  })

  it("accepts empty registrationGate.registrarFn", () => {
    const { accepted } = validateReasonProposals([validProposal({
      invocationReason: {
        ...validProposal().invocationReason!,
        registrationGate: {
          registrarFn: "",
          registrationApi: "register_callback",
          conditions: ["cond"],
        },
      },
    })])
    expect(accepted).toHaveLength(1)
  })

  it("accepts empty registrationGate.conditions", () => {
    const { accepted } = validateReasonProposals([validProposal({
      invocationReason: {
        ...validProposal().invocationReason!,
        registrationGate: {
          registrarFn: "my_registrar",
          registrationApi: "register_callback",
          conditions: [],
        },
      },
    })])
    expect(accepted).toHaveLength(1)
  })

  // ── Mixed batch ───────────────────────────────────────────────────────────

  it("correctly partitions a mixed batch of valid and invalid proposals", () => {
    const proposals: ProposedReasonPath[] = [
      validProposal({ registrarFn: "good_a" }),
      validProposal({ requiredFiles: [] }),                          // missing-required-files
      validProposal({ registrarFn: "good_b" }),
      validProposal({ invocationReason: undefined as any }),         // missing-invocation-reason
      validProposal({ confidence: 0.3 }),                           // low-confidence
    ]
    const { accepted, rejected } = validateReasonProposals(proposals)
    expect(accepted).toHaveLength(2)
    expect(accepted.map(p => p.registrarFn)).toEqual(["good_a", "good_b"])
    expect(rejected).toHaveLength(3)
    expect(rejected.map(r => r.reason)).toEqual([
      "missing-required-files",
      "missing-invocation-reason",
      "low-confidence",
    ])
  })

  // ── Rejection reason priority ─────────────────────────────────────────────
  // When multiple things are wrong, the first check that fails is reported.

  it("reports missing-required-files before missing-invocation-reason", () => {
    const p = validProposal({ requiredFiles: [] })
    delete (p as any).invocationReason
    const { rejected } = validateReasonProposals([p])
    expect(rejected[0].reason).toBe("missing-required-files")
  })

  it("reports low-confidence before missing-invocation-reason", () => {
    const p = validProposal({ confidence: 0.1 })
    delete (p as any).invocationReason
    const { rejected } = validateReasonProposals([p])
    expect(rejected[0].reason).toBe("low-confidence")
  })
})
