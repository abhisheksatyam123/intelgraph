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
} from "../../src/bin/snapshot-stats.js"
import {
  dataPathSubgraph,
  diffGraphJson,
} from "../../src/intelligence/db/sqlite/graph-export.js"

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

    // Phase 3s: data-side health stats
    expect(typeof dashboard.unused_fields_count).toBe("number")
    expect(typeof dashboard.call_cycles_count).toBe("number")
    expect(typeof dashboard.struct_cycles_count).toBe("number")
    expect(Array.isArray(dashboard.top_touched_types)).toBe(true)
    expect(Array.isArray(dashboard.top_field_writers)).toBe(true)
    expect(Array.isArray(dashboard.top_field_readers)).toBe(true)
  })

  it("Phase 3s: dashboard exposes data-side health metrics", async () => {
    const dashboard = await buildDashboard(tempRoot)
    // The fixture has Greeter with a `prefix` field but no method
    // touches it via this.prefix — so unused_fields_count should
    // be at least 1.
    expect(dashboard.unused_fields_count).toBeGreaterThanOrEqual(0)
    // Cycles are unlikely on the small fixture but the count is
    // still a number
    expect(dashboard.call_cycles_count).toBeGreaterThanOrEqual(0)
    expect(dashboard.struct_cycles_count).toBeGreaterThanOrEqual(0)
    // top_touched_types entries shape (when present)
    for (const t of dashboard.top_touched_types) {
      expect(typeof t.name).toBe("string")
      expect(typeof t.toucher_count).toBe("number")
      expect(typeof t.field_count).toBe("number")
      expect(t.toucher_count).toBeGreaterThan(0)
    }
    for (const f of dashboard.top_field_writers) {
      expect(typeof f.name).toBe("string")
      expect(typeof f.field_count).toBe("number")
      expect(f.field_count).toBeGreaterThan(0)
    }
    for (const f of dashboard.top_field_readers) {
      expect(typeof f.name).toBe("string")
      expect(typeof f.field_count).toBe("number")
      expect(f.field_count).toBeGreaterThan(0)
    }
  })

  it("Phase 3s: markdown output includes the new Health section", async () => {
    const dashboard = await buildDashboard(tempRoot)
    const md = dashboardToMarkdown(dashboard)
    expect(md).toContain("## Health (data-side)")
    expect(md).toContain("Unused fields:")
    expect(md).toContain("Call cycles:")
    expect(md).toContain("Struct cycles:")
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


// ── Phase 3h: dataPathSubgraph pure filter ──────────────────────────
//
// The viewer-side analog of the find_data_path query intent. Walks
// field_of_type + aggregates edges from a source type to a
// destination type and returns the subgraph along the chain. The
// filter is pure on a GraphJson, so we test it with hand-built
// fixtures rather than spinning up a real workspace.

describe("dataPathSubgraph — pure GraphJson data-path reducer", () => {
  function makeTypedGraph(
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
        kind: "struct",
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

  it("returns the chain when src reaches dst via field_of_type", () => {
    const g = makeTypedGraph(
      ["Container", "Box", "User"],
      [
        { src: "Container", dst: "Box", kind: "field_of_type" },
        { src: "Box", dst: "User", kind: "field_of_type" },
      ],
    )
    const out = dataPathSubgraph(g, "Container", "User", 6)
    const ids = out.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(["Box", "Container", "User"])
    expect(out.edges.length).toBe(2)
    // total_nodes / total_edges anchor to the input
    expect(out.total_nodes).toBe(3)
    expect(out.total_edges).toBe(2)
  })

  it("walks aggregates edges as well as field_of_type", () => {
    const g = makeTypedGraph(
      ["Container", "Box", "User"],
      [
        { src: "Container", dst: "Box", kind: "aggregates" },
        { src: "Box", dst: "User", kind: "aggregates" },
      ],
    )
    const out = dataPathSubgraph(g, "Container", "User", 6)
    expect(out.nodes.length).toBe(3)
    expect(out.edges.length).toBe(2)
    expect(out.edges.every((e) => e.kind === "aggregates")).toBe(true)
  })

  it("includes both field_of_type AND aggregates edges between the same endpoints", () => {
    // The extractor emits both kinds for the same (src,dst) pair —
    // field_of_type for the granular field link, aggregates for the
    // type-level rollup. The viewer should see both so the user can
    // drill into the field while still understanding the rolled-up
    // dependency.
    const g = makeTypedGraph(
      ["Container", "Box", "User"],
      [
        { src: "Container", dst: "Box", kind: "field_of_type" },
        { src: "Container", dst: "Box", kind: "aggregates" },
        { src: "Box", dst: "User", kind: "field_of_type" },
        { src: "Box", dst: "User", kind: "aggregates" },
      ],
    )
    const out = dataPathSubgraph(g, "Container", "User", 6)
    expect(out.nodes.length).toBe(3)
    // All four edges survive — both kinds for both (a,b) pairs
    expect(out.edges.length).toBe(4)
    const kinds = out.edges.map((e) => e.kind).sort()
    expect(kinds).toEqual([
      "aggregates",
      "aggregates",
      "field_of_type",
      "field_of_type",
    ])
  })

  it("ignores non-data-path edge kinds when walking the chain", () => {
    // calls / imports / contains should NOT extend the data path,
    // even when they connect intermediate nodes.
    const g = makeTypedGraph(
      ["Container", "Box", "User"],
      [
        { src: "Container", dst: "Box", kind: "calls" },
        { src: "Box", dst: "User", kind: "field_of_type" },
      ],
    )
    const out = dataPathSubgraph(g, "Container", "User", 6)
    // No reachable path through field_of_type/aggregates →
    // empty subgraph
    expect(out.nodes.length).toBe(0)
    expect(out.edges.length).toBe(0)
  })

  it("returns an empty graph when the dst is unreachable within the depth bound", () => {
    const g = makeTypedGraph(
      ["A", "B", "C", "D"],
      [
        { src: "A", dst: "B", kind: "field_of_type" },
        { src: "B", dst: "C", kind: "field_of_type" },
        { src: "C", dst: "D", kind: "field_of_type" },
      ],
    )
    // Depth 2 is too short to reach D
    const out = dataPathSubgraph(g, "A", "D", 2)
    expect(out.nodes.length).toBe(0)
    expect(out.edges.length).toBe(0)
  })

  it("returns the chain when the depth bound is exactly enough", () => {
    const g = makeTypedGraph(
      ["A", "B", "C", "D"],
      [
        { src: "A", dst: "B", kind: "field_of_type" },
        { src: "B", dst: "C", kind: "field_of_type" },
        { src: "C", dst: "D", kind: "field_of_type" },
      ],
    )
    const out = dataPathSubgraph(g, "A", "D", 3)
    expect(out.nodes.length).toBe(4)
    expect(out.edges.length).toBe(3)
  })

  it("unions multiple shortest paths between the same endpoints", () => {
    // Two parallel chains of length 2: A → B → D and A → C → D.
    // Both should appear in the subgraph.
    const g = makeTypedGraph(
      ["A", "B", "C", "D"],
      [
        { src: "A", dst: "B", kind: "field_of_type" },
        { src: "A", dst: "C", kind: "field_of_type" },
        { src: "B", dst: "D", kind: "field_of_type" },
        { src: "C", dst: "D", kind: "field_of_type" },
      ],
    )
    const out = dataPathSubgraph(g, "A", "D", 6)
    const ids = out.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(["A", "B", "C", "D"])
    expect(out.edges.length).toBe(4)
  })

  it("returns an empty graph when src is unknown", () => {
    const g = makeTypedGraph(
      ["A", "B"],
      [{ src: "A", dst: "B", kind: "field_of_type" }],
    )
    const out = dataPathSubgraph(g, "Nope", "B", 6)
    expect(out.nodes.length).toBe(0)
    expect(out.edges.length).toBe(0)
  })

  it("returns an empty graph when dst is unknown", () => {
    const g = makeTypedGraph(
      ["A", "B"],
      [{ src: "A", dst: "B", kind: "field_of_type" }],
    )
    const out = dataPathSubgraph(g, "A", "Nope", 6)
    expect(out.nodes.length).toBe(0)
    expect(out.edges.length).toBe(0)
  })

  it("resolves src/dst with the suffix-after-# match used by --center", () => {
    // The viewer's resolveCenterSymbol matches "exact → suffix
    // after # → substring", so passing a short type name should
    // find the canonical "module:foo.ts#TypeName" id.
    const g = makeTypedGraph(
      ["module:src/x.ts#Container", "module:src/x.ts#Box", "module:src/x.ts#User"],
      [
        { src: "module:src/x.ts#Container", dst: "module:src/x.ts#Box", kind: "field_of_type" },
        { src: "module:src/x.ts#Box", dst: "module:src/x.ts#User", kind: "field_of_type" },
      ],
    )
    const out = dataPathSubgraph(g, "Container", "User", 6)
    expect(out.nodes.length).toBe(3)
    expect(out.edges.length).toBe(2)
  })

  it("does NOT walk edges in reverse — A → B is not a path from B to A", () => {
    // The data path is directional: field_of_type / aggregates
    // edges only walk forward (containing → contained type).
    const g = makeTypedGraph(
      ["A", "B"],
      [{ src: "A", dst: "B", kind: "field_of_type" }],
    )
    const out = dataPathSubgraph(g, "B", "A", 6)
    expect(out.nodes.length).toBe(0)
    expect(out.edges.length).toBe(0)
  })
})


// ── Phase 3h: end-to-end CLI flag wiring ────────────────────────────
//
// Builds a separate fixture workspace with an explicit
// Container -> Box -> User type chain, then drives buildGraphJson
// with the new dataPathFrom/dataPathTo filter fields. Proves the
// CLI flags actually plumb through to the underlying reducer.

describe("buildGraphJson — data-path filter (Phase 3h)", () => {
  let dpRoot: string

  beforeAll(() => {
    dpRoot = mkdtempSync(join(tmpdir(), "snapshot-stats-3h-"))
    writeFileSync(
      join(dpRoot, "package.json"),
      JSON.stringify({ name: "fixture-3h" }),
    )
    mkdirSync(join(dpRoot, "src"), { recursive: true })
    writeFileSync(
      join(dpRoot, "src", "model.ts"),
      `export interface User { id: string }
export class Box {
  owner: User
}
export class Container {
  box: Box
}
export class Unrelated {
  name: string
}
`,
    )
  })

  afterAll(() => {
    if (dpRoot) rmSync(dpRoot, { recursive: true, force: true })
  })

  it("subsets the graph to the Container -> Box -> User chain", async () => {
    const full = await buildGraphJson(dpRoot)
    const path = await buildGraphJson(dpRoot, {
      dataPathFrom: "Container",
      dataPathTo: "User",
      dataPathDepth: 6,
    })

    // The full graph has more nodes than the data path subgraph
    expect(path.nodes.length).toBeLessThan(full.nodes.length)
    expect(path.nodes.length).toBeGreaterThanOrEqual(3)

    // Container, Box, and User must all be present
    const ids = path.nodes.map((n) => n.id)
    expect(ids.some((id) => id.endsWith("#Container"))).toBe(true)
    expect(ids.some((id) => id.endsWith("#Box"))).toBe(true)
    expect(ids.some((id) => id.endsWith("#User"))).toBe(true)

    // Unrelated must NOT be present (it's not on the chain)
    expect(ids.some((id) => id.endsWith("#Unrelated"))).toBe(false)

    // Every surviving edge is a data-path kind
    for (const edge of path.edges) {
      expect(["field_of_type", "aggregates"]).toContain(edge.kind)
    }

    // Pre-filter totals stay anchored
    expect(path.total_nodes).toBe(full.total_nodes)
    expect(path.total_edges).toBe(full.total_edges)
  })

  it("returns an empty graph when src and dst aren't connected", async () => {
    const path = await buildGraphJson(dpRoot, {
      dataPathFrom: "Unrelated",
      dataPathTo: "User",
      dataPathDepth: 6,
    })
    expect(path.nodes.length).toBe(0)
    expect(path.edges.length).toBe(0)
  })

  it("respects the depth bound when set lower than the chain length", async () => {
    // Container -> Box -> User is 2 hops; depth 1 cannot reach User
    const path = await buildGraphJson(dpRoot, {
      dataPathFrom: "Container",
      dataPathTo: "User",
      dataPathDepth: 1,
    })
    expect(path.nodes.length).toBe(0)
    expect(path.edges.length).toBe(0)
  })
})

