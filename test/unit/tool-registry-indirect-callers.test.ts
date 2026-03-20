import { describe, expect, it } from "vitest"
import { classifyIncomingCalls } from "../../src/tools/indirect-callers.js"
import { formatIndirectCallers } from "../../src/tools/indirect-callers.impl.js"

describe("indirect caller helpers", () => {
  it("classifies static registrations and direct calls deterministically", () => {
    const calls = [
      {
        from: {
          name: "dispatch_entries",
          kind: 13,
          uri: "/tmp/sample.c",
          selectionRange: { start: { line: 3, character: 1 } },
        },
        fromRanges: [{ start: { line: 10, character: 2 } }],
      },
      {
        from: {
          name: "caller_fn",
          kind: 12,
          uri: "/tmp/sample.c",
          selectionRange: { start: { line: 20, character: 1 } },
        },
        fromRanges: [{ start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }],
      },
    ]

    // classifyIncomingCalls no longer takes a profile argument
    const classified = classifyIncomingCalls(calls)
    // dispatch_entries (kind=13) → registration-dispatch-table
    const dispatchEntry = classified.find(c => c.from.name === "dispatch_entries")
    expect(dispatchEntry?.classification).toBe("registration-dispatch-table")
    // caller_fn (kind=12, unknown API, no source) → conservative registration-call
    const callerEntry = classified.find(c => c.from.name === "caller_fn")
    expect(callerEntry?.classification).toBe("registration-call")
  })

  it("formats indirect caller tree with grouped sections", () => {
    const text = formatIndirectCallers({
      seed: { name: "target" },
      nodes: [
        {
          id: "1",
          name: "owner",
          classification: "registration-call",
          kind: 12,
          uri: "/tmp/a.c",
          location: "a.c:12:3",
          registrationApi: "owner_register_api",
          sourceContext: [],
          fromRanges: [],
        },
        {
          id: "2",
          name: "parent",
          classification: "direct",
          kind: 12,
          uri: "/tmp/b.c",
          location: "b.c:30:7",
          registrationApi: null,
          sourceContext: [],
          fromRanges: [],
        },
      ],
    })

    expect(text).toContain("Callers of target")
    expect(text).toContain("Direct callers (1):")
    expect(text).toContain("Registration-call registrations (1):")
    expect(text).toContain("<- [Function] owner")
    expect(text).toContain("via: owner_register_api")
    expect(text).toContain("<- [Function] parent")
  })
})
