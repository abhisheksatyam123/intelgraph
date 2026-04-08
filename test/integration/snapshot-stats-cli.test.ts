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
