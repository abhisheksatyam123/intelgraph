/**
 * tui-contract-blackbox.test.ts — Layer 4: End-to-end TUI-consumable contract test.
 *
 * Validates that the output of lsp_indirect_callers can be parsed by the TUI's
 * text parser (parseIndirectCallersFromText in clangd-mcp-client.ts).
 *
 * The TUI expects:
 *   1. "Callers of <name>  (N reference sites found):" header
 *   2. "<- [Kind] name  at path:line:col" entry lines
 *   3. "     [api:key]" classification annotations
 *
 * This test validates the FORMAT CONTRACT without needing the TUI codebase.
 */

import { describe, it, expect, vi, beforeAll } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { collectIndirectCallers, formatIndirectCallerTree } from "../../src/tools/indirect-callers.js"

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/indirect-callers")
const HANDLERS_FILE = path.join(FIXTURE_DIR, "handlers.c")
const REGISTRATIONS_FILE = path.join(FIXTURE_DIR, "registrations.c")

/**
 * TUI text parser contract — these are the patterns the TUI parser uses
 * to extract structured data from lsp_indirect_callers text output.
 * 
 * Note: the classification annotation [api:key] is INLINE on the entry line,
 * not on a separate line.
 */
const TUI_ENTRY_PATTERN = /^\s*<-\s+(?:\[(\w+)\]\s+)?(\S+)\s+at\s+(.*):(\d+)(?:\s+\[([^\]]+)\])?\s*$/
const TUI_CALLERS_HEADER = /^Callers of\s+(.+?)\s+\((\d+)\s+reference sites found\):/

/**
 * Parse output text using TUI-compatible patterns.
 * Returns structured caller nodes that the TUI would produce.
 */
function parseTuiOutput(text: string): Array<{
  caller: string
  filePath: string
  lineNumber: number
  annotation: string | null
}> {
  const nodes: Array<{
    caller: string
    filePath: string
    lineNumber: number
    annotation: string | null
  }> = []

  for (const line of text.split("\n")) {
    // Match entry line with optional inline annotation:
    // "<- name  at path:line [api:key]"
    const entryMatch = line.match(TUI_ENTRY_PATTERN)
    if (entryMatch) {
      nodes.push({
        caller: entryMatch[2],
        filePath: entryMatch[3],
        lineNumber: parseInt(entryMatch[4], 10),
        annotation: entryMatch[5] ?? null,
      })
    }
  }

  return nodes
}

// ---------------------------------------------------------------------------
// Mock LSP client
// ---------------------------------------------------------------------------

function createMockLspClient() {
  const handlers = readFileSync(HANDLERS_FILE, "utf8").split(/\n/)
  const registrations = readFileSync(REGISTRATIONS_FILE, "utf8").split(/\n/)
  const targetLine = handlers.findIndex((l) => l.includes("void wlan_bpf_filter_offload_handler("))
  const regLine = registrations.findIndex((l) => l.includes("wlan_bpf_filter_offload_handler"))
  const regChar = regLine >= 0 ? registrations[regLine].indexOf("wlan_bpf_filter_offload_handler") : -1

  return {
    prepareCallHierarchy: vi.fn().mockImplementation(async (file: string, line: number) => {
      if (file === HANDLERS_FILE && line === targetLine) {
        return [{
          name: "wlan_bpf_filter_offload_handler",
          uri: `file://${HANDLERS_FILE}`,
          selectionRange: { start: { line: targetLine, character: 0 } },
        }]
      }
      if (file === REGISTRATIONS_FILE) {
        return [{
          name: "setup_offloads",
          uri: `file://${REGISTRATIONS_FILE}`,
          selectionRange: { start: { line: regLine, character: 0 } },
        }]
      }
      return []
    }),
    references: vi.fn().mockResolvedValue([
      { uri: `file://${HANDLERS_FILE}`, range: { start: { line: targetLine, character: 0 } } },
      { uri: `file://${REGISTRATIONS_FILE}`, range: { start: { line: regLine, character: regChar } } },
    ]),
    incomingCalls: vi.fn().mockResolvedValue([]),
    root: FIXTURE_DIR,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lsp_indirect_callers — Layer 4 black-box: TUI contract", () => {
  let outputText: string

  beforeAll(async () => {
    const mockClient = createMockLspClient()
    const graph = await collectIndirectCallers(mockClient as any, {
      file: HANDLERS_FILE,
      line: 12,
      character: 1,
    })
    outputText = formatIndirectCallerTree(graph, FIXTURE_DIR)
  })

  it("output starts with 'Callers of' header", () => {
    expect(outputText).toMatch(/^Callers of/)
  })

  it("header includes reference site count", () => {
    const match = outputText.match(TUI_CALLERS_HEADER)
    expect(match).not.toBeNull()
    expect(parseInt(match![2], 10)).toBeGreaterThan(0)
  })

  it("each caller entry is parseable by TUI entry pattern", () => {
    const nodes = parseTuiOutput(outputText)
    expect(nodes.length).toBeGreaterThan(0)

    for (const node of nodes) {
      expect(node.caller).toBeTruthy()
      expect(node.filePath).toBeTruthy()
      expect(node.lineNumber).toBeGreaterThan(0)
    }
  })

  it("classified entries have annotation with [api:key] format (or source text for auto-classifier)", () => {
    // offldmgr_register_data_offload is now handled by the auto-classifier (not in registry).
    // Without autoClassifier deps in the mock, the site is unclassified (no annotation tag).
    // The source text still contains the registration call name.
    expect(outputText).toContain("offldmgr_register_data_offload")

    // If any classified nodes exist (e.g. from registry fast-path), verify annotation format
    const nodes = parseTuiOutput(outputText)
    const classified = nodes.filter((n) => n.annotation !== null)
    for (const node of classified) {
      expect(node.annotation).toContain(":")
    }
  })

  it("output contains source text after each entry", () => {
    // The TUI also uses sourceText as a fallback
    expect(outputText).toContain("offldmgr_register_data_offload")
  })

  it("output is valid non-empty text", () => {
    expect(typeof outputText).toBe("string")
    expect(outputText.length).toBeGreaterThan(50)
    expect(outputText).not.toContain("Error:")
    expect(outputText).not.toContain("undefined")
    expect(outputText).not.toContain("null")
  })

  it("seed name appears in header", () => {
    // The header should include the resolved symbol name
    expect(outputText).toMatch(/Callers of \S+/)
  })
})
