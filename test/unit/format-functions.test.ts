import { describe, it, expect } from "vitest"
import {
  formatHover,
  formatDefinition,
  formatReferences,
  formatDocumentSymbol,
  formatWorkspaceSymbol,
  formatIncomingCalls,
  formatOutgoingCalls,
  formatTypeHierarchy,
  formatDiagnostics,
  formatCodeAction,
  formatDocumentHighlight,
  formatFoldingRange,
  formatSignatureHelp,
  formatRename,
} from "../../src/tools/index.js"

const ROOT = "/workspace"

// ── formatHover ──────────────────────────────────────────────────────────────

describe("formatHover", () => {
  it("returns fallback for null", () => {
    expect(formatHover(null)).toBe("No hover information available.")
  })

  it("returns fallback for undefined", () => {
    expect(formatHover(undefined)).toBe("No hover information available.")
  })

  it("returns string contents directly", () => {
    expect(formatHover({ contents: "int foo(void)" })).toBe("int foo(void)")
  })

  it("returns contents.value when present", () => {
    expect(formatHover({ contents: { value: "int foo(void)" } })).toBe("int foo(void)")
  })

  it("joins array of strings", () => {
    expect(formatHover({ contents: ["line1", "line2"] })).toBe("line1\nline2")
  })

  it("joins array of objects with .value", () => {
    expect(formatHover({ contents: [{ value: "v1" }, { value: "v2" }] })).toBe("v1\nv2")
  })

  it("handles mixed array of strings and objects", () => {
    expect(formatHover({ contents: ["plain", { value: "code" }] })).toBe("plain\ncode")
  })

  it("returns fallback for empty contents", () => {
    expect(formatHover({ contents: {} })).toBe("No hover information available.")
  })
})

// ── formatDefinition ─────────────────────────────────────────────────────────

describe("formatDefinition", () => {
  it("returns fallback for empty results", () => {
    expect(formatDefinition([], ROOT)).toBe("No definition found.")
  })

  it("formats single definition", () => {
    const result = formatDefinition(
      [{ uri: `file://${ROOT}/src/foo.c`, range: { start: { line: 10, character: 0 } } }],
      ROOT,
    )
    expect(result).toContain("Definition:")
    expect(result).toContain("src/foo.c:11:1")
  })

  it("uses custom label", () => {
    const result = formatDefinition(
      [{ uri: `file://${ROOT}/src/foo.c`, range: { start: { line: 0, character: 0 } } }],
      ROOT,
      "Declaration",
    )
    expect(result).toContain("Declaration:")
  })

  it("formats multiple definitions", () => {
    const results = [
      { uri: `file://${ROOT}/a.c`, range: { start: { line: 1, character: 0 } } },
      { uri: `file://${ROOT}/b.c`, range: { start: { line: 2, character: 0 } } },
    ]
    const lines = formatDefinition(results, ROOT).split("\n")
    expect(lines).toHaveLength(2)
  })
})

// ── formatReferences ─────────────────────────────────────────────────────────

describe("formatReferences", () => {
  it("returns fallback for empty results", () => {
    expect(formatReferences([], ROOT)).toBe("No references found.")
  })

  it("formats references with count", () => {
    const results = [
      { uri: `file://${ROOT}/a.c`, range: { start: { line: 5, character: 4 } } },
      { uri: `file://${ROOT}/b.c`, range: { start: { line: 10, character: 0 } } },
    ]
    const output = formatReferences(results, ROOT)
    expect(output).toContain("References (2):")
    expect(output).toContain("a.c:6:5")
    expect(output).toContain("b.c:11:1")
  })
})

// ── formatDocumentSymbol ─────────────────────────────────────────────────────

describe("formatDocumentSymbol", () => {
  it("returns fallback for empty results", () => {
    expect(formatDocumentSymbol([])).toBe("No symbols found.")
  })

  it("formats flat symbols", () => {
    const results = [
      { name: "foo", kind: 12, range: { start: { line: 0 } } },
      { name: "bar", kind: 6, range: { start: { line: 10 } } },
    ]
    const output = formatDocumentSymbol(results)
    expect(output).toContain("[Function] foo:1")
    expect(output).toContain("[Method] bar:11")
  })

  it("formats nested symbols with indentation", () => {
    const results = [
      {
        name: "MyClass",
        kind: 5,
        range: { start: { line: 0 } },
        children: [{ name: "method", kind: 6, range: { start: { line: 5 } } }],
      },
    ]
    const output = formatDocumentSymbol(results)
    expect(output).toContain("[Class] MyClass:1")
    expect(output).toContain("  [Method] method:6")
  })

  it("shows detail when present", () => {
    const results = [{ name: "x", kind: 13, detail: "int", range: { start: { line: 0 } } }]
    const output = formatDocumentSymbol(results)
    expect(output).toContain("— int")
  })
})

// ── formatWorkspaceSymbol ────────────────────────────────────────────────────

describe("formatWorkspaceSymbol", () => {
  it("returns fallback for empty results", () => {
    expect(formatWorkspaceSymbol([], ROOT)).toBe("No symbols found.")
  })

  it("formats symbols with location", () => {
    const results = [
      { name: "handler", kind: 12, location: { uri: `file://${ROOT}/handler.c`, range: { start: { line: 41, character: 0 } } } },
    ]
    const output = formatWorkspaceSymbol(results, ROOT)
    expect(output).toContain("[Function] handler")
    expect(output).toContain("handler.c:42:1")
  })
})

// ── formatIncomingCalls ──────────────────────────────────────────────────────

describe("formatIncomingCalls", () => {
  it("returns fallback for empty results", () => {
    expect(formatIncomingCalls([], ROOT)).toBe("No incoming calls.")
  })

  it("formats callers with arrow", () => {
    const results = [
      { from: { name: "caller_fn", kind: 12, uri: `file://${ROOT}/caller.c`, selectionRange: { start: { line: 5, character: 0 } } } },
    ]
    const output = formatIncomingCalls(results, ROOT)
    expect(output).toContain("<- [Function] caller_fn")
    expect(output).toContain("caller.c:6:1")
  })

  it("handles missing from.name", () => {
    const results = [{ from: { kind: 12, uri: `file://${ROOT}/x.c`, range: { start: { line: 0, character: 0 } } } }]
    const output = formatIncomingCalls(results, ROOT)
    expect(output).toContain("(unknown)")
  })
})

// ── formatOutgoingCalls ──────────────────────────────────────────────────────

describe("formatOutgoingCalls", () => {
  it("returns fallback for empty results", () => {
    expect(formatOutgoingCalls([], ROOT)).toBe("No outgoing calls.")
  })

  it("formats callees with arrow", () => {
    const results = [
      { to: { name: "callee_fn", kind: 6, uri: `file://${ROOT}/callee.c`, selectionRange: { start: { line: 10, character: 4 } } } },
    ]
    const output = formatOutgoingCalls(results, ROOT)
    expect(output).toContain("-> [Method] callee_fn")
    expect(output).toContain("callee.c:11:5")
  })
})

// ── formatTypeHierarchy ──────────────────────────────────────────────────────

describe("formatTypeHierarchy", () => {
  it("returns fallback for supertypes when empty", () => {
    expect(formatTypeHierarchy([], ROOT, "↑")).toBe("No supertypes found.")
  })

  it("returns fallback for subtypes when empty", () => {
    expect(formatTypeHierarchy([], ROOT, "↓")).toBe("No subtypes found.")
  })

  it("formats supertypes", () => {
    const results = [
      { name: "Base", kind: 5, uri: `file://${ROOT}/base.h`, selectionRange: { start: { line: 0, character: 0 } } },
    ]
    const output = formatTypeHierarchy(results, ROOT, "↑")
    expect(output).toContain("↑ [Class] Base")
  })
})

// ── formatDiagnostics ────────────────────────────────────────────────────────

describe("formatDiagnostics", () => {
  it("returns fallback for empty map", () => {
    expect(formatDiagnostics(new Map(), ROOT)).toBe("No diagnostics.")
  })

  it("formats errors and warnings", () => {
    const map = new Map([
      [`${ROOT}/src/foo.c`, [
        { severity: 1, range: { start: { line: 10, character: 4 } }, message: "undeclared" },
        { severity: 2, range: { start: { line: 20, character: 0 } }, message: "unused var" },
      ]],
    ])
    const output = formatDiagnostics(map, ROOT)
    expect(output).toContain("src/foo.c:")
    expect(output).toContain("ERROR [11:5] undeclared")
    expect(output).toContain("WARN [21:1] unused var")
  })

  it("skips empty diagnostic arrays", () => {
    const map = new Map([[`${ROOT}/empty.c`, []]])
    expect(formatDiagnostics(map, ROOT)).toBe("No diagnostics.")
  })
})

// ── formatCodeAction ─────────────────────────────────────────────────────────

describe("formatCodeAction", () => {
  it("returns fallback for empty results", () => {
    expect(formatCodeAction([])).toBe("No code actions available.")
  })

  it("formats actions with kind", () => {
    const results = [{ title: "Fix typo", kind: "quickfix" }]
    const output = formatCodeAction(results)
    expect(output).toContain("* Fix typo [quickfix]")
  })

  it("shows disabled reason", () => {
    const results = [{ title: "Refactor", disabled: { reason: "not supported" } }]
    const output = formatCodeAction(results)
    expect(output).toContain("(disabled: not supported)")
  })
})

// ── formatDocumentHighlight ──────────────────────────────────────────────────

describe("formatDocumentHighlight", () => {
  it("returns fallback for empty results", () => {
    expect(formatDocumentHighlight([], `${ROOT}/foo.c`, ROOT)).toBe("No highlights found.")
  })

  it("formats highlights with kind and range", () => {
    const results = [
      { kind: 2, range: { start: { line: 5, character: 4 }, end: { line: 5, character: 10 } } },
    ]
    const output = formatDocumentHighlight(results, `${ROOT}/foo.c`, ROOT)
    expect(output).toContain("[read] foo.c:6:5 – 6:11")
  })

  it("defaults to text kind", () => {
    const results = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }]
    const output = formatDocumentHighlight(results, `${ROOT}/x.c`, ROOT)
    expect(output).toContain("[text]")
  })
})

// ── formatFoldingRange ───────────────────────────────────────────────────────

describe("formatFoldingRange", () => {
  it("returns fallback for empty results", () => {
    expect(formatFoldingRange([], `${ROOT}/foo.c`, ROOT)).toBe("No folding ranges found.")
  })

  it("formats ranges with kind", () => {
    const results = [{ startLine: 0, endLine: 10, kind: "region" }]
    const output = formatFoldingRange(results, `${ROOT}/foo.c`, ROOT)
    expect(output).toContain("foo.c:1–11 (region)")
  })

  it("formats ranges without kind", () => {
    const results = [{ startLine: 5, endLine: 8 }]
    const output = formatFoldingRange(results, `${ROOT}/x.c`, ROOT)
    expect(output).toContain("x.c:6–9")
  })
})

// ── formatSignatureHelp ──────────────────────────────────────────────────────

describe("formatSignatureHelp", () => {
  it("returns fallback for null", () => {
    expect(formatSignatureHelp(null)).toBe("No signature help available.")
  })

  it("returns fallback for empty signatures", () => {
    expect(formatSignatureHelp({ signatures: [] })).toBe("No signature help available.")
  })

  it("formats active signature with marker", () => {
    const result = {
      activeSignature: 0,
      signatures: [
        { label: "void foo(int x)", parameters: [{ label: "int x" }] },
        { label: "void foo(int x, int y)", parameters: [{ label: "int x" }, { label: "int y" }] },
      ],
    }
    const output = formatSignatureHelp(result)
    expect(output).toContain("▶ void foo(int x)")
    expect(output).toContain("  void foo(int x, int y)")
  })

  it("shows parameter documentation", () => {
    const result = {
      signatures: [{
        label: "void foo(int x)",
        parameters: [{ label: "int x", documentation: "the value" }],
      }],
    }
    const output = formatSignatureHelp(result)
    expect(output).toContain("the value")
  })
})

// ── formatRename ─────────────────────────────────────────────────────────────

describe("formatRename", () => {
  it("returns fallback for null", () => {
    expect(formatRename(null, ROOT)).toBe("Rename not possible at this position.")
  })

  it("formats documentChanges", () => {
    const edit = {
      documentChanges: [
        {
          textDocument: { uri: `file://${ROOT}/foo.c` },
          edits: [{ range: { start: { line: 5, character: 4 } }, newText: "new_name" }],
        },
      ],
    }
    const output = formatRename(edit, ROOT)
    expect(output).toContain("foo.c: 1 edit(s)")
    expect(output).toContain('line 6:5 → "new_name"')
  })

  it("formats flat changes map", () => {
    const edit = {
      changes: {
        [`file://${ROOT}/bar.c`]: [
          { range: { start: { line: 0, character: 0 } }, newText: "x" },
        ],
      },
    }
    const output = formatRename(edit, ROOT)
    expect(output).toContain("bar.c: 1 edit(s)")
  })

  it("shows no changes when neither format present", () => {
    const output = formatRename({}, ROOT)
    expect(output).toContain("(no changes)")
  })
})
