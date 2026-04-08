/**
 * test/integration/snapshot-stats-real-workspaces.test.ts
 *
 * End-to-end smoke tests for the visualization data path. Runs
 * `buildGraphJson` (the same function the --html viewer calls) and
 * `graphJsonToHtml` against the real TypeScript workspaces and asserts
 * the rendered HTML is well-formed and the inlined script is valid JS.
 *
 * Targets:
 *   - /home/abhi/qprojects/opencode (Bun monorepo, packages/opencode/src)
 *   - /home/abhi/qprojects/instructkr-claude-code (TS/React project)
 *
 * Both tests skip cleanly when the workspace path doesn't exist on the
 * host. Skips intentionally let CI environments without those checkouts
 * still pass.
 *
 * The existing ts-core-real-workspaces.test.ts covers the *query intent*
 * surface against these workspaces. This file covers the *visualization
 * data surface* — buildGraphJson + graphJsonToHtml — so the HTML viewer
 * can't silently break on a real codebase without the test catching it.
 *
 * Each workspace runs exactly two buildGraphJson invocations: one full
 * graph (used to verify floors, structure, and HTML rendering) and one
 * subset graph (used to verify the filter flags). Keeping the count of
 * extractions per workspace small matters because each invocation walks
 * 600–2000 .ts files and takes 30–60s; a 4-extraction-per-workspace
 * shape was both slow (~5 min total) and prone to flakes.
 */

import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import {
  buildGraphJson,
  graphJsonToHtml,
} from "../../src/bin/snapshot-stats.js"

const OPENCODE_ROOT = "/home/abhi/qprojects/opencode/packages/opencode"
const INSTRUCTKR_ROOT = "/home/abhi/qprojects/instructkr-claude-code"

interface WorkspaceCase {
  name: string
  path: string
  /** Floor on node count — the workspace must produce at least this many. */
  minNodes: number
  /** Floor on edge count. */
  minEdges: number
  /** A canonical-name substring expected to exist in the graph. */
  expectedSubstring: string
}

const CASES: WorkspaceCase[] = [
  {
    name: "opencode/packages/opencode",
    path: OPENCODE_ROOT,
    minNodes: 500,
    minEdges: 500,
    expectedSubstring: "opencode",
  },
  {
    name: "instructkr-claude-code",
    path: INSTRUCTKR_ROOT,
    minNodes: 200,
    minEdges: 200,
    expectedSubstring: "src/",
  },
]

for (const wcase of CASES) {
  describe.skipIf(!existsSync(wcase.path))(
    `snapshot-stats visualization — ${wcase.name}`,
    () => {
      it(
        "full graph: floors, structural integrity, HTML round-trip",
        async () => {
          const graph = await buildGraphJson(wcase.path)

          // ── Identity ───────────────────────────────────────────
          expect(graph.workspace).toBe(wcase.path)
          expect(typeof graph.snapshot_id).toBe("number")
          expect(graph.snapshot_id).toBeGreaterThan(0)

          // ── Floors ─────────────────────────────────────────────
          expect(graph.nodes.length).toBeGreaterThan(wcase.minNodes)
          expect(graph.edges.length).toBeGreaterThan(wcase.minEdges)

          // ── Structural integrity ───────────────────────────────
          // Every edge endpoint must resolve to a node in the graph.
          // Same property the in-memory fixture test checks; we
          // re-assert it here against a real codebase because that's
          // where the orphan-edge bug class actually shows up.
          const nodeIds = new Set(graph.nodes.map((n) => n.id))
          for (const edge of graph.edges) {
            expect(nodeIds.has(edge.src)).toBe(true)
            expect(nodeIds.has(edge.dst)).toBe(true)
          }

          // At least one node should match the expected substring,
          // proving the workspace's actual files made it into the
          // graph (rather than the graph being built against a
          // mistakenly-empty directory).
          expect(
            graph.nodes.some((n) => n.id.includes(wcase.expectedSubstring)),
          ).toBe(true)

          // ── HTML round-trip ────────────────────────────────────
          const html = graphJsonToHtml(graph)
          expect(html.startsWith("<!doctype html>")).toBe(true)
          expect(html).toContain("</html>")
          expect(html).toContain("d3@7.9.0")

          // The full feature set must be present even on a real
          // workspace — guards against any of the inlined feature
          // wiring breaking due to weird canonical names that contain
          // characters that break string concatenation.
          expect(html).toContain("ARROW_KINDS")
          expect(html).toContain("function neighborhood")
          expect(html).toContain("cycleNodes")
          expect(html).toContain("dirHueByNode")
          expect(html).toContain("function saveHashState")

          // Inlined script must parse — catches the class of bug
          // where a rogue canonical name (e.g. one containing
          // "</script>" or unbalanced template-literal syntax) breaks
          // the document.
          const start = html.indexOf("<script>")
          const end = html.indexOf("</script>", start)
          expect(start).toBeGreaterThan(0)
          expect(end).toBeGreaterThan(start)
          const inlined = html.substring(start + "<script>".length, end)
          expect(() =>
            new Function("document", "window", "d3", inlined),
          ).not.toThrow()
        },
        180_000,
      )

      it(
        "filter flags subset the graph correctly (edge-kind + symbol-kind)",
        async () => {
          // Imports-only edges → all surviving edges have kind=imports.
          // Combined with symbol-kind=module, this is the canonical
          // "module dependency view" the visualization tool offers.
          const graph = await buildGraphJson(wcase.path, {
            edgeKinds: new Set(["imports"]),
            symbolKinds: new Set(["module"]),
          })

          // Both filters must produce a non-trivial subset for any
          // real TS workspace.
          expect(graph.nodes.length).toBeGreaterThan(0)
          expect(graph.edges.length).toBeGreaterThan(0)

          // Symbol-kind invariant
          for (const node of graph.nodes) {
            expect(node.kind).toBe("module")
          }

          // Edge-kind invariant
          for (const edge of graph.edges) {
            expect(edge.kind).toBe("imports")
          }

          // Cascade invariant: every surviving edge connects two
          // surviving nodes.
          const nodeIds = new Set(graph.nodes.map((n) => n.id))
          for (const edge of graph.edges) {
            expect(nodeIds.has(edge.src)).toBe(true)
            expect(nodeIds.has(edge.dst)).toBe(true)
          }
        },
        180_000,
      )
    },
  )
}
