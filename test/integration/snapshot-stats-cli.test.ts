/**
 * test/integration/snapshot-stats-cli.test.ts
 *
 * Integration test for the snapshot-stats CLI tool added in D69.
 * Calls the underlying buildDashboard() against a small temp
 * fixture workspace and asserts the dashboard shape end-to-end.
 *
 * This catches the kind of regression where the CLI breaks because
 * a query intent it depends on changes its row shape — the per-intent
 * tests would still pass but the CLI would silently produce wrong
 * output.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDashboard,
  buildGraphJson,
  dashboardToMarkdown,
  graphJsonToHtml,
  VIEWER_PURE_JS,
} from "../../src/bin/snapshot-stats.js"
import { diffGraphJson } from "../../src/intelligence/db/sqlite/graph-export.js"

let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "snapshot-stats-test-"))
  writeFileSync(join(tempRoot, "package.json"), JSON.stringify({ name: "fixture" }))
  mkdirSync(join(tempRoot, "src"), { recursive: true })

  // A handful of files exercising different shapes:
  // - module-a defines a class with methods
  // - module-b imports module-a and uses Greeter
  // - util provides a function
  // - barrel re-exports both
  // - one orphan module with no imports either way

  writeFileSync(
    join(tempRoot, "src", "module-a.ts"),
    `
import { format } from "./util"

export class Greeter {
  constructor(public prefix: string) {}
  greet(name: string): string {
    return format(this.prefix + " " + name)
  }
}

export function entry(name: string): string {
  return new Greeter("hi").greet(name)
}
`,
  )

  writeFileSync(
    join(tempRoot, "src", "module-b.ts"),
    `
import { Greeter } from "./module-a"
export function makeFormal(): Greeter {
  return new Greeter("formal")
}
`,
  )

  writeFileSync(
    join(tempRoot, "src", "util.ts"),
    `
export function format(s: string): string {
  return s.trim()
}
`,
  )

  writeFileSync(
    join(tempRoot, "src", "index.ts"),
    `
export { Greeter, entry } from "./module-a"
export * from "./module-b"
`,
  )

  // Orphan module — no imports either way
  writeFileSync(
    join(tempRoot, "src", "orphan.ts"),
    `// completely isolated
const x = 1
export default x
`,
  )
})

afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})

describe("snapshot-stats CLI — buildDashboard", () => {
  it("returns a dashboard with all expected top-level fields", async () => {
    const dashboard = await buildDashboard(tempRoot)

    // Identity
    expect(dashboard.workspace).toBe(tempRoot)
    expect(dashboard.files_discovered).toBeGreaterThan(0)
    expect(dashboard.total_nodes).toBeGreaterThan(0)
    expect(dashboard.total_edges).toBeGreaterThan(0)

    // Histograms
    expect(Array.isArray(dashboard.edge_kinds)).toBe(true)
    expect(dashboard.edge_kinds.length).toBeGreaterThan(0)
    expect(Array.isArray(dashboard.resolution_kinds)).toBe(true)

    // Top-N intent results
    expect(Array.isArray(dashboard.top_imported_modules)).toBe(true)
    expect(Array.isArray(dashboard.top_called_functions)).toBe(true)
    expect(Array.isArray(dashboard.largest_modules)).toBe(true)
    expect(Array.isArray(dashboard.tightly_coupled)).toBe(true)
    expect(Array.isArray(dashboard.cycles)).toBe(true)
    expect(Array.isArray(dashboard.external_imports)).toBe(true)

    // Counts
    expect(typeof dashboard.dead_exports_count).toBe("number")
    expect(typeof dashboard.undocumented_exports_count).toBe("number")
    expect(typeof dashboard.entry_points_count).toBe("number")
    expect(typeof dashboard.orphan_modules_count).toBe("number")
  })

  it("counts at least one edge of each ts-core edge kind", async () => {
    const dashboard = await buildDashboard(tempRoot)
    const kinds = new Set(dashboard.edge_kinds.map((e) => e.edge_kind))
    // Fixture exercises imports + contains + calls minimum
    expect(kinds.has("imports")).toBe(true)
    expect(kinds.has("contains")).toBe(true)
    expect(kinds.has("calls")).toBe(true)
  })

  it("finds the orphan module", async () => {
    const dashboard = await buildDashboard(tempRoot)
    // src/orphan.ts has no incoming OR outgoing imports — it should
    // appear in the orphan count
    expect(dashboard.orphan_modules_count).toBeGreaterThan(0)
  })

  it("finds module-a as a top imported module (since both index.ts and module-b import it)", async () => {
    const dashboard = await buildDashboard(tempRoot)
    const moduleA = dashboard.top_imported_modules.find((m) =>
      m.name.endsWith("module-a.ts"),
    )
    expect(moduleA).toBeDefined()
    expect(moduleA!.incoming_count).toBeGreaterThanOrEqual(2)
  })

  it("buildGraphJson returns a node-link graph for web visualizers", async () => {
    const graph = await buildGraphJson(tempRoot)

    expect(graph.workspace).toBe(tempRoot)
    expect(typeof graph.snapshot_id).toBe("number")
    expect(Array.isArray(graph.nodes)).toBe(true)
    expect(Array.isArray(graph.edges)).toBe(true)

    // Should have at least the 5 fixture modules + their declarations
    expect(graph.nodes.length).toBeGreaterThan(5)
    expect(graph.edges.length).toBeGreaterThan(0)

    // Module-a should be present and exported
    const moduleA = graph.nodes.find((n) => n.id.endsWith("module-a.ts"))
    expect(moduleA).toBeDefined()
    expect(moduleA!.kind).toBe("module")

    // Greeter class should appear with exported=true
    const greeter = graph.nodes.find((n) => n.id.endsWith("module-a.ts#Greeter"))
    expect(greeter).toBeDefined()
    expect(greeter!.exported).toBe(true)
    expect(greeter!.kind).toBe("class")

    // Every edge's src and dst should resolve to a node in the graph
    const nodeIds = new Set(graph.nodes.map((n) => n.id))
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.src)).toBe(true)
      expect(nodeIds.has(edge.dst)).toBe(true)
      expect(typeof edge.kind).toBe("string")
    }
  })

  it("buildGraphJson edge-kind filter keeps only the requested kinds", async () => {
    const graph = await buildGraphJson(tempRoot, {
      edgeKinds: new Set(["imports"]),
    })
    expect(graph.edges.length).toBeGreaterThan(0)
    for (const edge of graph.edges) {
      expect(edge.kind).toBe("imports")
    }
  })

  it("buildGraphJson symbol-kind filter cascades to edges", async () => {
    const graph = await buildGraphJson(tempRoot, {
      symbolKinds: new Set(["module"]),
    })
    // Only module nodes should remain
    expect(graph.nodes.length).toBeGreaterThan(0)
    for (const node of graph.nodes) {
      expect(node.kind).toBe("module")
    }
    // Every edge's endpoints should be in the surviving node set
    const nodeIds = new Set(graph.nodes.map((n) => n.id))
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.src)).toBe(true)
      expect(nodeIds.has(edge.dst)).toBe(true)
    }
  })

  it("buildGraphJson combines edge-kind + symbol-kind filters", async () => {
    // module → module imports edges only — the canonical "package
    // dependency" view.
    const graph = await buildGraphJson(tempRoot, {
      edgeKinds: new Set(["imports"]),
      symbolKinds: new Set(["module"]),
    })
    for (const node of graph.nodes) {
      expect(node.kind).toBe("module")
    }
    for (const edge of graph.edges) {
      expect(edge.kind).toBe("imports")
    }
  })

  it("buildGraphJson centerOf filter scopes the graph to a symbol's neighborhood", async () => {
    // Greeter exists in the fixture (module-a.ts). Centering on it
    // should return Greeter + its 1-hop neighbors (the module that
    // contains it, the methods it has, the module that imports it).
    // The full graph has many more nodes than the centered subgraph.
    const full = await buildGraphJson(tempRoot)
    const centered = await buildGraphJson(tempRoot, {
      centerOf: "Greeter",
      centerHops: 1,
    })

    // Strictly smaller than the full graph
    expect(centered.nodes.length).toBeLessThan(full.nodes.length)
    expect(centered.nodes.length).toBeGreaterThan(0)

    // Greeter itself must be in the result
    expect(
      centered.nodes.some((n) => n.id.endsWith("#Greeter")),
    ).toBe(true)

    // Every edge endpoint must resolve to a node in the centered set
    const ids = new Set(centered.nodes.map((n) => n.id))
    for (const edge of centered.edges) {
      expect(ids.has(edge.src)).toBe(true)
      expect(ids.has(edge.dst)).toBe(true)
    }
  })

  it("buildGraphJson centerOf returns an empty graph when the symbol doesn't resolve", async () => {
    const graph = await buildGraphJson(tempRoot, {
      centerOf: "totally_made_up_symbol_xyz_zzz",
      centerHops: 2,
    })
    expect(graph.nodes.length).toBe(0)
    expect(graph.edges.length).toBe(0)
  })

  it("buildGraphJson centerDirection narrows the BFS walk", async () => {
    // Center on Greeter at depth 1 in each direction. The
    // forward-only ('out') and backward-only ('in') subgraphs must
    // each be ≤ the undirected ('both') subgraph, since 'both' is
    // the union of the two directional walks.
    const both = await buildGraphJson(tempRoot, {
      centerOf: "Greeter",
      centerHops: 1,
      centerDirection: "both",
    })
    const outOnly = await buildGraphJson(tempRoot, {
      centerOf: "Greeter",
      centerHops: 1,
      centerDirection: "out",
    })
    const inOnly = await buildGraphJson(tempRoot, {
      centerOf: "Greeter",
      centerHops: 1,
      centerDirection: "in",
    })

    expect(both.nodes.length).toBeGreaterThan(0)
    expect(outOnly.nodes.length).toBeGreaterThan(0)
    expect(inOnly.nodes.length).toBeGreaterThan(0)

    // Both directions must include the center symbol itself
    for (const g of [both, outOnly, inOnly]) {
      expect(g.nodes.some((n) => n.id.endsWith("#Greeter"))).toBe(true)
    }

    // 'both' is the superset of either directional walk
    expect(outOnly.nodes.length).toBeLessThanOrEqual(both.nodes.length)
    expect(inOnly.nodes.length).toBeLessThanOrEqual(both.nodes.length)

    // Edge integrity in each variant
    for (const g of [both, outOnly, inOnly]) {
      const ids = new Set(g.nodes.map((n) => n.id))
      for (const edge of g.edges) {
        expect(ids.has(edge.src)).toBe(true)
        expect(ids.has(edge.dst)).toBe(true)
      }
    }
  })

  it("buildGraphJson defaults centerDirection to 'both' when omitted", async () => {
    const explicitBoth = await buildGraphJson(tempRoot, {
      centerOf: "Greeter",
      centerHops: 2,
      centerDirection: "both",
    })
    const omitted = await buildGraphJson(tempRoot, {
      centerOf: "Greeter",
      centerHops: 2,
    })
    expect(omitted.nodes.length).toBe(explicitBoth.nodes.length)
    expect(omitted.edges.length).toBe(explicitBoth.edges.length)
  })

  it("buildGraphJson maxNodes caps the graph to the top-N nodes by degree", async () => {
    const full = await buildGraphJson(tempRoot)
    // Cap to fewer nodes than the full graph has
    const cap = Math.max(3, Math.floor(full.nodes.length / 2))
    const capped = await buildGraphJson(tempRoot, { maxNodes: cap })

    expect(capped.nodes.length).toBeLessThanOrEqual(cap)
    expect(capped.nodes.length).toBeGreaterThan(0)

    // Every surviving edge endpoint must still be in the capped set
    const ids = new Set(capped.nodes.map((n) => n.id))
    for (const edge of capped.edges) {
      expect(ids.has(edge.src)).toBe(true)
      expect(ids.has(edge.dst)).toBe(true)
    }

    // Edge count cannot exceed the full graph's edge count
    expect(capped.edges.length).toBeLessThanOrEqual(full.edges.length)
  })

  it("buildGraphJson maxNodes leaves small graphs unchanged", async () => {
    const full = await buildGraphJson(tempRoot)
    // Cap larger than the graph — no truncation
    const capped = await buildGraphJson(tempRoot, {
      maxNodes: full.nodes.length + 1000,
    })
    expect(capped.nodes.length).toBe(full.nodes.length)
    expect(capped.edges.length).toBe(full.edges.length)
  })

  it("buildGraphJson carries pre-filter totals through every filter", async () => {
    const full = await buildGraphJson(tempRoot)
    // Totals are the raw graph_nodes / graph_edges row counts; the
    // visible nodes/edges arrays have already had orphan edges (dst
    // doesn't resolve to a node) dropped, so totals >= visible counts
    // is the only invariant that holds in the unfiltered case.
    expect(full.total_nodes).toBeGreaterThanOrEqual(full.nodes.length)
    expect(full.total_edges).toBeGreaterThanOrEqual(full.edges.length)
    // Both must be positive (non-empty fixture)
    expect(full.total_nodes).toBeGreaterThan(0)
    expect(full.total_edges).toBeGreaterThan(0)

    // edge-kind + symbol-kind filter shrinks nodes/edges but the
    // totals stay anchored to the snapshot.
    const filtered = await buildGraphJson(tempRoot, {
      edgeKinds: new Set(["imports"]),
      symbolKinds: new Set(["module"]),
    })
    expect(filtered.total_nodes).toBe(full.total_nodes)
    expect(filtered.total_edges).toBe(full.total_edges)
    expect(filtered.nodes.length).toBeLessThanOrEqual(full.total_nodes)

    // centerOf scopes the result but totals stay anchored
    const centered = await buildGraphJson(tempRoot, { centerOf: "Greeter" })
    expect(centered.total_nodes).toBe(full.total_nodes)
    expect(centered.total_edges).toBe(full.total_edges)

    // maxNodes truncates but totals stay anchored
    const capped = await buildGraphJson(tempRoot, { maxNodes: 3 })
    expect(capped.total_nodes).toBe(full.total_nodes)
    expect(capped.total_edges).toBe(full.total_edges)
    expect(capped.nodes.length).toBeLessThanOrEqual(3)
  })

  it("graphJsonToHtml returns a self-contained HTML viewer", async () => {
    const graph = await buildGraphJson(tempRoot)
    const html = graphJsonToHtml(graph)

    // Standard document shape
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("</html>")
    expect(html).toContain("<svg")
    expect(html).toContain("d3.forceSimulation")

    // d3 is loaded from the CDN with a pinned version
    expect(html).toContain("d3@7.9.0")

    // Workspace name in the title and sidebar
    expect(html).toContain(tempRoot)

    // Graph data is inlined as a JS literal — verify by checking that
    // a known canonical name from the fixture appears in the body
    expect(html).toContain("module-a.ts")

    // Legends are wired to the data
    expect(html).toContain("kind-legend")
    expect(html).toContain("edge-legend")

    // Defends against script-tag injection from rogue canonical names —
    // any literal `</` inside the JSON literal should be escaped to `<\/`.
    // Find the data block and assert no raw `</script` survives within it.
    const dataMatch = html.match(/const data = (\{[\s\S]*?\});\nconst KIND_COLORS/)
    expect(dataMatch).not.toBeNull()
    expect(dataMatch![1]).not.toContain("</script")

    // Directional arrow markers — every edge kind in EDGE_COLORS gets
    // a marker, plus a default and a hit highlight. The markers are
    // created by d3 at runtime, so we assert against the JS source
    // that creates them rather than the (un-rendered) static HTML.
    expect(html).toContain("ARROW_KINDS")
    expect(html).toContain('"__default"')
    expect(html).toContain('"__hit"')
    expect(html).toContain('"arrow-"')
    expect(html).toContain("marker-end")

    // Multi-hop neighborhood: hop slider + the BFS expansion function.
    expect(html).toContain('id="hop-slider"')
    expect(html).toContain("function neighborhood")

    // In/out degree shown in the selection panel.
    expect(html).toContain("in-degree")
    expect(html).toContain("out-degree")

    // Directed adjacency: successors / predecessors maps.
    expect(html).toContain("const successors")
    expect(html).toContain("const predecessors")

    // Cycle highlighting: detection runs at init, toggle wires it,
    // and the .cycle CSS classes are present.
    expect(html).toContain("cycleNodes")
    expect(html).toContain("cycleEdgeKeys")
    expect(html).toContain('id="cycle-toggle"')
    expect(html).toContain('id="cycle-count"')
    expect(html).toContain(".link.cycle")
    expect(html).toContain(".node.cycle")

    // Directory tinting: the hue function and toggle are wired, and
    // the per-node hue map is built at init.
    expect(html).toContain("dirHueByNode")
    expect(html).toContain("function hashHue")
    expect(html).toContain('id="tint-toggle"')
    expect(html).toContain('id="tint-count"')

    // URL hash state: save + load + history.replaceState wiring.
    expect(html).toContain("function saveHashState")
    expect(html).toContain("function loadHashState")
    expect(html).toContain("history.replaceState")
    expect(html).toContain("URLSearchParams")

    // Top hubs panels: client-side ranking + the two containers.
    expect(html).toContain("function buildHubPanel")
    expect(html).toContain('id="top-imported"')
    expect(html).toContain('id="top-called"')

    // Quick view presets + the live stats badge in the corner.
    expect(html).toContain('id="preset-modules"')
    expect(html).toContain('id="preset-reset"')
    expect(html).toContain("function applyModuleDepView")
    expect(html).toContain("function applyResetView")
    expect(html).toContain('id="badge"')
    expect(html).toContain("function updateBadge")

    // Path-finding: BFS function + UI inputs + status row + .path-on
    // CSS classes are all wired.
    expect(html).toContain("function shortestPath")
    expect(html).toContain("function findAndShowPath")
    expect(html).toContain("function resolveSymbol")
    expect(html).toContain('id="path-from"')
    expect(html).toContain('id="path-to"')
    expect(html).toContain('id="path-find"')
    expect(html).toContain('id="path-status"')
    expect(html).toContain(".link.path-on")
    expect(html).toContain(".node.path-on")

    // Live center filter (HTML viewer's inline counterpart to the
    // CLI / MCP centerOf flag).
    expect(html).toContain("let centerSet")
    expect(html).toContain('id="center-on-focused"')
    expect(html).toContain('id="clear-center"')
    // The filter must be applied inside render(): when centerSet is
    // set, render() drops nodes outside it.
    expect(html).toContain("centerSet && !centerSet.has")
    // URL hash flag for the live center mode
    expect(html).toContain('"cm"')

    // Walk direction radio buttons (in/out/both) — the inline
    // counterpart to the new server-side centerDirection parameter.
    expect(html).toContain("let walkDirection")
    expect(html).toContain('name="dir"')
    expect(html).toContain('value="both"')
    expect(html).toContain('value="out"')
    expect(html).toContain('value="in"')
    // The neighborhood BFS is now parametric (takes adjacency in)
    // and lives in the VIEWER_PURE_JS block; the closure-bound
    // wrapper is nbhd().
    expect(html).toContain("function neighborhood(rootId, hops, direction, succ, pred)")
    expect(html).toContain("function nbhd(rootId, hops, direction)")

    // Pre-filter totals carried through GraphJson + the badge
    // formatter that shows "X of Y nodes" when truncated.
    expect(html).toContain("TOTAL_NODES")
    expect(html).toContain("TOTAL_EDGES")
    expect(html).toContain("function fmtBadgePart")
    expect(html).toContain("data.total_nodes")
    expect(html).toContain("data.total_edges")

    // Inlined script must parse as valid JS. Catches the class of bug
    // where a stray backtick inside a comment closes the outer
    // template literal and corrupts the rest of the document.
    const start = html.indexOf("<script>")
    const end = html.indexOf("</script>", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const inlined = html.substring(start + "<script>".length, end)
    expect(() => new Function("document", "window", "d3", inlined)).not.toThrow()
  })

  it("graphJsonToHtml propagates --filter-edge-kind subsets", async () => {
    // Imports-only subset → the inlined data should NOT contain a
    // "calls" edge_kind anywhere in the data block.
    const graph = await buildGraphJson(tempRoot, {
      edgeKinds: new Set(["imports"]),
    })
    const html = graphJsonToHtml(graph)
    const dataMatch = html.match(/const data = (\{[\s\S]*?\});/)
    expect(dataMatch).not.toBeNull()
    const dataBlock = dataMatch![1]
    // The graph object's edges array carries kind:"imports" only.
    // We can't perfectly tokenize JSON in regex, but checking that
    // no `"kind":"calls"` substring appears is a reliable smoke
    // signal because that's how JSON.stringify renders it.
    expect(dataBlock).not.toContain('"kind":"calls"')
    expect(dataBlock).toContain('"kind":"imports"')
  })

  it("dashboardToMarkdown renders a valid markdown report", async () => {
    const dashboard = await buildDashboard(tempRoot)
    const md = dashboardToMarkdown(dashboard)
    // Top-level heading
    expect(md).toContain("# Snapshot stats")
    expect(md).toContain(tempRoot)
    // Section headings
    expect(md).toContain("## Overview")
    expect(md).toContain("## Edge kinds")
    // Table syntax
    expect(md).toContain("| edge_kind | count |")
    expect(md).toContain("|---|---:|")
    // module-a should appear in the top imported modules section
    expect(md).toContain("module-a.ts")
    // No raw object/undefined leakage
    expect(md).not.toContain("undefined")
    expect(md).not.toContain("[object Object]")
  })
})

describe("VIEWER_PURE_JS — pure-function unit tests", () => {
  // Eval the inlined viewer-runtime block once and capture its
  // function references via a tiny accessor block. This gives real
  // unit test coverage of the BFS / shortestPath / resolveSymbol
  // logic that the HTML viewer relies on, without spinning up a
  // JSDOM environment.
  const fns = (() => {
    const accessor = `
      ${VIEWER_PURE_JS}
      return {
        dirOf,
        hashHue,
        neighborhood,
        shortestPath,
        resolveSymbol,
      };
    `
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(accessor)() as {
      dirOf: (filePath: string) => string
      hashHue: (s: string) => number
      neighborhood: (
        rootId: string,
        hops: number,
        direction: "in" | "out" | "both",
        succ: Map<string, Set<string>>,
        pred: Map<string, Set<string>>,
      ) => Set<string>
      shortestPath: (
        srcId: string,
        dstId: string,
        succ: Map<string, Set<string>>,
        nodeIds: Set<string>,
      ) => string[] | null
      resolveSymbol: (
        query: string,
        nodeIds: Set<string> | string[],
      ) => string | null
    }
  })()

  describe("dirOf", () => {
    it("returns parent directory for a path", () => {
      expect(fns.dirOf("src/util/format.ts")).toBe("src/util")
    })
    it("returns empty string for path with no slash", () => {
      expect(fns.dirOf("foo.ts")).toBe("")
    })
    it("returns empty string for empty input", () => {
      expect(fns.dirOf("")).toBe("")
    })
  })

  describe("hashHue", () => {
    it("returns a number 0..359", () => {
      const h = fns.hashHue("src/util")
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    })
    it("is stable across calls", () => {
      expect(fns.hashHue("src/util")).toBe(fns.hashHue("src/util"))
    })
    it("returns different hues for different inputs (no trivial collision)", () => {
      // Not a strict guarantee for any two strings, but two different
      // dir names from a real workspace should virtually never collide.
      expect(fns.hashHue("src/util")).not.toBe(fns.hashHue("src/cli"))
    })
  })

  describe("neighborhood", () => {
    // Build a tiny graph:
    //   A → B → C
    //   A → D
    //   E → A
    const succ = new Map<string, Set<string>>([
      ["A", new Set(["B", "D"])],
      ["B", new Set(["C"])],
      ["C", new Set()],
      ["D", new Set()],
      ["E", new Set(["A"])],
    ])
    const pred = new Map<string, Set<string>>([
      ["A", new Set(["E"])],
      ["B", new Set(["A"])],
      ["C", new Set(["B"])],
      ["D", new Set(["A"])],
      ["E", new Set()],
    ])

    it("undirected BFS at hops=1 includes both directions", () => {
      const got = fns.neighborhood("A", 1, "both", succ, pred)
      expect([...got].sort()).toEqual(["A", "B", "D", "E"])
    })
    it("forward-only BFS at hops=1 only walks successors", () => {
      const got = fns.neighborhood("A", 1, "out", succ, pred)
      expect([...got].sort()).toEqual(["A", "B", "D"])
    })
    it("backward-only BFS at hops=1 only walks predecessors", () => {
      const got = fns.neighborhood("A", 1, "in", succ, pred)
      expect([...got].sort()).toEqual(["A", "E"])
    })
    it("forward BFS at hops=2 reaches grandchildren", () => {
      const got = fns.neighborhood("A", 2, "out", succ, pred)
      expect([...got].sort()).toEqual(["A", "B", "C", "D"])
    })
    it("BFS terminates when frontier empties before max hops", () => {
      // From C there's nothing forward; should still return {C}
      const got = fns.neighborhood("C", 5, "out", succ, pred)
      expect([...got]).toEqual(["C"])
    })
  })

  describe("shortestPath", () => {
    const ids = new Set(["A", "B", "C", "D"])
    const succ = new Map<string, Set<string>>([
      ["A", new Set(["B", "C"])],
      ["B", new Set(["D"])],
      ["C", new Set(["D"])],
      ["D", new Set()],
    ])

    it("finds the direct path A→B", () => {
      expect(fns.shortestPath("A", "B", succ, ids)).toEqual(["A", "B"])
    })
    it("finds a 2-hop path A→D (via B or C, BFS picks one)", () => {
      const path = fns.shortestPath("A", "D", succ, ids)
      expect(path).not.toBeNull()
      expect(path!.length).toBe(3)
      expect(path![0]).toBe("A")
      expect(path![2]).toBe("D")
      expect(["B", "C"]).toContain(path![1])
    })
    it("returns [src] for src===dst", () => {
      expect(fns.shortestPath("A", "A", succ, ids)).toEqual(["A"])
    })
    it("returns null when no path exists (D→A)", () => {
      expect(fns.shortestPath("D", "A", succ, ids)).toBeNull()
    })
    it("returns null when src is unknown", () => {
      expect(fns.shortestPath("Z", "A", succ, ids)).toBeNull()
    })
    it("returns null when dst is unknown", () => {
      expect(fns.shortestPath("A", "Z", succ, ids)).toBeNull()
    })
  })

  describe("resolveSymbol", () => {
    const ids = new Set([
      "module:src/foo.ts",
      "module:src/foo.ts#Greeter",
      "module:src/foo.ts#Greeter.greet",
      "module:src/util.ts#format",
    ])
    it("returns the exact match when present", () => {
      expect(fns.resolveSymbol("module:src/foo.ts#Greeter", ids)).toBe(
        "module:src/foo.ts#Greeter",
      )
    })
    it("returns the suffix-after-# match when no exact match", () => {
      // "Greeter" → matches "module:src/foo.ts#Greeter" via suffix
      expect(fns.resolveSymbol("Greeter", ids)).toBe("module:src/foo.ts#Greeter")
    })
    it("returns the substring match as a last resort", () => {
      // "format" matches the format function via substring (no exact
      // canonical name, no #format suffix on a plain canonical_name)
      const got = fns.resolveSymbol("format", ids)
      expect(got).toBe("module:src/util.ts#format")
    })
    it("returns null when nothing matches", () => {
      expect(fns.resolveSymbol("totally_made_up_xyz", ids)).toBeNull()
    })
    it("returns null for empty query", () => {
      expect(fns.resolveSymbol("", ids)).toBeNull()
    })
    it("works with an iterable that's not already a Set", () => {
      const arr = [...ids]
      expect(fns.resolveSymbol("Greeter", arr)).toBe("module:src/foo.ts#Greeter")
    })
  })
})

describe("diffGraphJson — pure GraphJson set diff", () => {
  // Build two tiny graphs by hand. The diff should report the
  // exact set difference at the node and edge level.
  function makeGraph(
    nodeIds: string[],
    edges: Array<{ src: string; dst: string; kind: string }>,
  ): import("../../src/intelligence/db/sqlite/graph-export.js").GraphJson {
    return {
      workspace: "/tmp/x",
      snapshot_id: 1,
      total_nodes: nodeIds.length,
      total_edges: edges.length,
      nodes: nodeIds.map((id) => ({
        id,
        kind: "function",
        file_path: null,
        line: null,
        end_line: null,
        line_count: null,
        exported: false,
        doc: null,
        owning_class: null,
      })),
      edges: edges.map((e) => ({
        src: e.src,
        dst: e.dst,
        kind: e.kind,
        resolution_kind: null,
        metadata: null,
      })),
    }
  }

  it("identifies a graph as identical to itself", () => {
    const g = makeGraph(
      ["A", "B", "C"],
      [
        { src: "A", dst: "B", kind: "calls" },
        { src: "B", dst: "C", kind: "calls" },
      ],
    )
    const diff = diffGraphJson(g, g)
    expect(diff.nodes_only_in_a).toEqual([])
    expect(diff.nodes_only_in_b).toEqual([])
    expect(diff.nodes_in_both).toBe(3)
    expect(diff.edges_only_in_a).toEqual([])
    expect(diff.edges_only_in_b).toEqual([])
    expect(diff.edges_in_both).toBe(2)
    expect(diff.summary.nodes_added).toBe(0)
    expect(diff.summary.nodes_removed).toBe(0)
    expect(diff.summary.edges_added).toBe(0)
    expect(diff.summary.edges_removed).toBe(0)
  })

  it("reports added and removed nodes", () => {
    const a = makeGraph(["A", "B", "C"], [])
    const b = makeGraph(["B", "C", "D"], [])
    const diff = diffGraphJson(a, b)
    expect(diff.nodes_only_in_a).toEqual(["A"])
    expect(diff.nodes_only_in_b).toEqual(["D"])
    expect(diff.nodes_in_both).toBe(2)
    expect(diff.summary.nodes_added).toBe(1)
    expect(diff.summary.nodes_removed).toBe(1)
  })

  it("reports added and removed edges by (src,dst,kind) tuple", () => {
    const a = makeGraph(
      ["A", "B"],
      [{ src: "A", dst: "B", kind: "calls" }],
    )
    const b = makeGraph(
      ["A", "B"],
      [
        { src: "A", dst: "B", kind: "calls" },
        { src: "A", dst: "B", kind: "imports" }, // same nodes, different kind
      ],
    )
    const diff = diffGraphJson(a, b)
    expect(diff.nodes_in_both).toBe(2)
    expect(diff.nodes_only_in_a).toEqual([])
    expect(diff.nodes_only_in_b).toEqual([])
    // The "calls" edge is in both, the "imports" edge is only in b
    expect(diff.edges_in_both).toBe(1)
    expect(diff.edges_only_in_a).toEqual([])
    expect(diff.edges_only_in_b).toEqual(["A|B|imports"])
    expect(diff.summary.edges_added).toBe(1)
    expect(diff.summary.edges_removed).toBe(0)
  })

  it("ignores metadata-only changes", () => {
    // Same edge, different metadata. The diff treats them as
    // identical because the (src,dst,kind) tuple matches.
    const a = makeGraph(["A", "B"], [{ src: "A", dst: "B", kind: "calls" }])
    const b = makeGraph(["A", "B"], [{ src: "A", dst: "B", kind: "calls" }])
    a.edges[0].metadata = { resolutionKind: "direct" }
    b.edges[0].metadata = { resolutionKind: "indirect" }
    const diff = diffGraphJson(a, b)
    expect(diff.edges_in_both).toBe(1)
    expect(diff.edges_only_in_a).toEqual([])
    expect(diff.edges_only_in_b).toEqual([])
  })

  it("caps the sample arrays at 100 entries even when the diff is huge", () => {
    // Build two large disjoint graphs and check that the sample
    // arrays don't blow up the response.
    const aIds: string[] = []
    const bIds: string[] = []
    for (let i = 0; i < 500; i++) aIds.push("A_" + i)
    for (let i = 0; i < 500; i++) bIds.push("B_" + i)
    const a = makeGraph(aIds, [])
    const b = makeGraph(bIds, [])
    const diff = diffGraphJson(a, b)
    expect(diff.nodes_only_in_a.length).toBe(100)
    expect(diff.nodes_only_in_b.length).toBe(100)
    // But the counts in the summary are exact
    expect(diff.summary.nodes_removed).toBe(500)
    expect(diff.summary.nodes_added).toBe(500)
    expect(diff.nodes_in_both).toBe(0)
  })

  it("captures the summary counts from both inputs verbatim", () => {
    const a = makeGraph(
      ["A", "B"],
      [{ src: "A", dst: "B", kind: "calls" }],
    )
    const b = makeGraph(
      ["A", "B", "C"],
      [
        { src: "A", dst: "B", kind: "calls" },
        { src: "B", dst: "C", kind: "calls" },
      ],
    )
    const diff = diffGraphJson(a, b)
    expect(diff.summary.a_nodes).toBe(2)
    expect(diff.summary.b_nodes).toBe(3)
    expect(diff.summary.a_edges).toBe(1)
    expect(diff.summary.b_edges).toBe(2)
  })
})
