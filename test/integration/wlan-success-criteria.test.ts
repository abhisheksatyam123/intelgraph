/**
 * WLAN success criteria — smoke test.
 *
 * For each target in wlan-targets.ts, a fake LSP client returns the
 * source-verified indirect callers. collectIndirectCallers() must surface
 * all expectedIndirectCallers in its output graph.
 *
 * This is a lightweight smoke test. The full 4-layer harness (including
 * cache/LLM comparison) lives in wlan-indirect-caller-harness.test.ts.
 */
import { describe, it, expect } from "vitest"
import { existsSync } from "fs"
import { getWlanTargets, getWlanWorkspaceRoot, type WlanTarget } from "./wlan-targets.js"
import { collectIndirectCallers } from "../../src/tools/indirect-callers.js"

const root = getWlanWorkspaceRoot()

/**
 * Build a fake LSP client that returns the ground-truth indirect callers for
 * a given target. Mirrors the helper in wlan-indirect-caller-harness.test.ts.
 */
function buildGroundTruthClient(target: WlanTarget): any {
  return {
    root,
    prepareCallHierarchy: async () => [
      {
        name: target.id,
        kind: 12,
        uri: `file://${target.file}`,
        selectionRange: {
          start: { line: target.line - 1, character: target.character - 1 },
          end: { line: target.line - 1, character: target.character + 30 },
        },
      },
    ],
    incomingCalls: async () =>
      target.expectedIndirectCallers.map((callerName, idx) => ({
        from: {
          name: callerName,
          kind: 12,
          uri: `file://${target.file}`,
          selectionRange: {
            start: { line: idx * 10, character: 0 },
            end: { line: idx * 10, character: callerName.length },
          },
        },
        fromRanges: [],
      })),
    incomingCallsAt: async () => [],
    references: async () => [],
  }
}

describe("WLAN success criteria targets", () => {
  it("workspace root exists", () => {
    expect(existsSync(root)).toBe(true)
  })

  for (const t of getWlanTargets()) {
    it(`target ${t.id} resolves expected indirect callers`, async () => {
      expect(existsSync(t.file)).toBe(true)

      const graph = await collectIndirectCallers(buildGroundTruthClient(t), {
        file: t.file,
        line: t.line,
        character: t.character,
        maxNodes: 50,
      })

      const got = new Set((graph?.nodes ?? []).map((n: any) => n.name))
      for (const expected of t.expectedIndirectCallers) {
        expect(
          got.has(expected),
          `Expected "${expected}" not found for target "${t.id}". Got: ${[...got].join(", ")}`,
        ).toBe(true)
      }
    })
  }
})
