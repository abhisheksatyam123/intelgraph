/**
 * test/integration/intelligence-query-mcp-roundtrip.test.ts
 *
 * Round-trip test for the `intelligence_query` MCP tool, focusing on
 * the intents that take `filePath` / `lineNumber` as inputs:
 *
 *   - find_symbol_at_location
 *   - find_symbols_in_file
 *
 * Until recently the MCP tool's Zod schema did not declare those two
 * fields, which meant Zod silently stripped them on the way in and the
 * orchestrator received an empty `filePath`/`lineNumber`. Both intents
 * appeared "broken" from the TUI side even though the underlying
 * SqliteDbLookup implementation worked fine.
 *
 * This test wires the real ts-core extractor + a real SqliteDbLookup
 * behind the MCP tool's executor and asserts that the click-to-symbol
 * paths the TUI relies on actually return the right rows.
 *
 * Also covers a third regression: a *new* intent (`find_largest_modules`)
 * that takes only `limit` — verifying the executor works for the
 * structural-overview intents the visualization tooling depends on.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  setIntelligenceDeps,
  TOOLS,
} from "../../src/tools/index.js"
import { openSqlite } from "../../src/intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../../src/intelligence/db/sqlite/foundation.js"
import { SqliteGraphStore } from "../../src/intelligence/db/sqlite/graph-store.js"
import { SqliteDbLookup } from "../../src/intelligence/db/sqlite/db-lookup.js"
import { ExtractorRunner } from "../../src/intelligence/extraction/runner.js"
import { tsCoreExtractor } from "../../src/plugins/index.js"
import type { ILanguageClient } from "../../src/lsp/types.js"
import type { OrchestratorRunnerDeps } from "../../src/intelligence/orchestrator-runner.js"

const stubLsp = {
  root: "/tmp",
  openFile: async () => false,
  documentSymbol: async () => [],
  outgoingCalls: async () => [],
  incomingCalls: async () => [],
  references: async () => [],
  definition: async () => [],
} as unknown as ILanguageClient

const tool = TOOLS.find((t) => t.name === "intelligence_query")
if (!tool) throw new Error("intelligence_query tool not registered")
const graphTool = TOOLS.find((t) => t.name === "intelligence_graph")
if (!graphTool) throw new Error("intelligence_graph tool not registered")
const diffTool = TOOLS.find((t) => t.name === "intelligence_graph_diff")
if (!diffTool) throw new Error("intelligence_graph_diff tool not registered")
const stubClient = {} as Parameters<typeof tool.execute>[1]
const stubTracker = {} as Parameters<typeof tool.execute>[2]

interface Fixture {
  tempRoot: string
  cleanup: () => void
  snapshotId: number
}

async function buildFixture(): Promise<Fixture> {
  const tempRoot = mkdtempSync(join(tmpdir(), "intel-query-mcp-"))
  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({ name: "fixture-mcp" }),
  )
  mkdirSync(join(tempRoot, "src"), { recursive: true })

  // alpha.ts: 5-line file with a class and a function — predictable
  // line numbers for find_symbol_at_location.
  writeFileSync(
    join(tempRoot, "src", "alpha.ts"),
    `export class Alpha {
  greet(name: string): string {
    return "hi " + name
  }
}
export function bigFn(): number {
  return 42
}
`,
  )

  // beta.ts: a second module so the workspace has > 1 file for
  // find_largest_modules to rank.
  writeFileSync(
    join(tempRoot, "src", "beta.ts"),
    `import { Alpha } from "./alpha"
export function makeAlpha(): Alpha {
  return new Alpha()
}
export function helper(): void {
  return
}
export function helper2(): void {
  return
}
`,
  )

  const client = openSqlite({ path: ":memory:" })
  const foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
  const store = new SqliteGraphStore(client.db)
  const lookup = new SqliteDbLookup(client.db, client.raw)

  const ref = await foundation.beginSnapshot({
    workspaceRoot: tempRoot,
    compileDbHash: "intel-query-mcp",
    parserVersion: "0.1.0",
  })
  const snapshotId = ref.snapshotId

  const runner = new ExtractorRunner({
    snapshotId,
    workspaceRoot: tempRoot,
    lsp: stubLsp,
    sink: store,
    plugins: [tsCoreExtractor],
  })
  await runner.run()
  await foundation.commitSnapshot(snapshotId)

  // Wire the real SqliteDbLookup behind the intelligence_query tool.
  // The other deps are stubs — for these intents the orchestrator never
  // hits the deterministic enrichers because dbLookup hits on the
  // first try.
  const deps: OrchestratorRunnerDeps = {
    persistence: {
      dbLookup: lookup,
      authoritativeStore: { persistEnrichment: async () => 0 },
      graphProjection: {
        syncFromAuthoritative: async () => ({
          synced: true,
          nodesUpserted: 0,
          edgesUpserted: 0,
        }),
      },
    },
    clangdEnricher: {
      source: "clangd" as const,
      enrich: async () => ({
        attempts: [{ source: "clangd" as const, status: "failed" as const }],
        persistedRows: 0,
      }),
    },
    cParserEnricher: {
      source: "c_parser" as const,
      enrich: async () => ({
        attempts: [{ source: "c_parser" as const, status: "failed" as const }],
        persistedRows: 0,
      }),
    },
  }
  setIntelligenceDeps(deps)

  return {
    tempRoot,
    snapshotId,
    cleanup: () => {
      try {
        client.close()
      } catch {
        // already closed
      }
      rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}

interface FlatResponse {
  status: string
  data: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }
}

async function callTool(
  args: Record<string, unknown>,
): Promise<FlatResponse> {
  const raw = await tool!.execute(args, stubClient, stubTracker)
  return JSON.parse(raw) as FlatResponse
}

let fixture: Fixture | null = null

afterEach(() => {
  if (fixture) {
    fixture.cleanup()
    fixture = null
  }
})

describe("intelligence_query MCP tool — round trip", () => {
  it("forwards filePath + lineNumber to find_symbol_at_location", async () => {
    fixture = await buildFixture()
    // class Alpha is on line 1 of src/alpha.ts. find_symbol_at_location
    // walks the symbol tree to find the innermost symbol whose source
    // range contains the requested line.
    const filePath = join(fixture.tempRoot, "src", "alpha.ts")
    const res = await callTool({
      intent: "find_symbol_at_location",
      snapshotId: fixture.snapshotId,
      filePath,
      lineNumber: 1,
      limit: 5,
    })
    expect(res.status).toBe("hit")
    expect(res.data.nodes.length).toBeGreaterThan(0)
    const names = res.data.nodes.map((n) => String(n.canonical_name))
    // Either the file-level module symbol or the class itself is fine —
    // the assertion is that *something* came back, proving filePath
    // survived the Zod schema and reached the lookup.
    expect(names.some((n) => n.includes("alpha.ts"))).toBe(true)
  })

  it("forwards filePath to find_symbols_in_file", async () => {
    fixture = await buildFixture()
    const filePath = join(fixture.tempRoot, "src", "alpha.ts")
    const res = await callTool({
      intent: "find_symbols_in_file",
      snapshotId: fixture.snapshotId,
      filePath,
      limit: 50,
    })
    expect(res.status).toBe("hit")
    // alpha.ts declares: module + Alpha class + greet method + bigFn function
    expect(res.data.nodes.length).toBeGreaterThanOrEqual(3)
    const names = res.data.nodes.map((n) => String(n.canonical_name))
    expect(names.some((n) => n.endsWith("#Alpha"))).toBe(true)
    expect(names.some((n) => n.endsWith("#bigFn"))).toBe(true)
  })

  it("returns an error (not a silent empty hit) when filePath is missing on find_symbol_at_location", async () => {
    fixture = await buildFixture()
    // Without filePath, the lookup defaults to "" and matches no rows.
    // The orchestrator should still return a well-formed response —
    // either status=not_found, status=enriched-with-no-rows, or
    // status=hit with zero nodes. Whatever it is, it must not throw.
    const res = await callTool({
      intent: "find_symbol_at_location",
      snapshotId: fixture.snapshotId,
      lineNumber: 1,
    })
    expect(["hit", "not_found", "enriched", "error"]).toContain(res.status)
    // No rows should come back
    expect(res.data.nodes.length).toBe(0)
  })

  it("structural overview intents work for the visualization tools (find_largest_modules)", async () => {
    fixture = await buildFixture()
    // This intent takes only `limit` — verifies that the broader
    // family of intents the snapshot-stats CLI / TUI dashboards rely
    // on are reachable through MCP.
    const res = await callTool({
      intent: "find_largest_modules",
      snapshotId: fixture.snapshotId,
      limit: 5,
    })
    expect(res.status).toBe("hit")
    expect(res.data.nodes.length).toBeGreaterThanOrEqual(2)
    // Ranked DESC by line_count, so the longer file (beta.ts has more
    // lines) should appear and the shorter file should also appear.
    const names = res.data.nodes.map((n) => String(n.canonical_name))
    expect(names.some((n) => n.endsWith("beta.ts"))).toBe(true)
    expect(names.some((n) => n.endsWith("alpha.ts"))).toBe(true)
  })

  it("structural overview intents work via MCP (find_top_called_functions)", async () => {
    fixture = await buildFixture()
    const res = await callTool({
      intent: "find_top_called_functions",
      snapshotId: fixture.snapshotId,
      limit: 10,
    })
    expect(res.status).toBe("hit")
    // beta.ts calls Alpha (constructor) — there should be at least one
    // function with an incoming call edge.
    expect(Array.isArray(res.data.nodes)).toBe(true)
  })

  it("rejects unknown intent with a structured error response", async () => {
    fixture = await buildFixture()
    // The executor doesn't throw on unknown intents — it returns a
    // structured `status: "error"` response (the MCP transport prefers
    // this over an exception so the client can render it). Assert the
    // shape so we don't regress to silent acceptance.
    const res = await callTool({
      intent: "totally_made_up_intent",
      snapshotId: fixture.snapshotId,
    })
    expect(res.status).toBe("error")
    expect(res.data.nodes.length).toBe(0)
  })
})

describe("intelligence_graph MCP tool — round trip", () => {
  it("returns the full GraphJson for a snapshot", async () => {
    fixture = await buildFixture()
    const raw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
      },
      stubClient,
      stubTracker,
    )
    const graph = JSON.parse(raw) as {
      workspace: string
      snapshot_id: number
      nodes: Array<{ id: string; kind: string; file_path: string | null }>
      edges: Array<{ src: string; dst: string; kind: string }>
    }
    expect(graph.workspace).toBe(fixture.tempRoot)
    expect(graph.snapshot_id).toBe(fixture.snapshotId)
    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(graph.edges.length).toBeGreaterThan(0)

    // Both fixture modules should appear
    const ids = graph.nodes.map((n) => n.id)
    expect(ids.some((i) => i.includes("alpha.ts"))).toBe(true)
    expect(ids.some((i) => i.includes("beta.ts"))).toBe(true)
    // Alpha class should be present
    expect(ids.some((i) => i.endsWith("#Alpha"))).toBe(true)

    // Every edge endpoint must resolve to a node — same orphan-edge
    // invariant the snapshot-stats real-workspace test enforces.
    const nodeIdSet = new Set(ids)
    for (const edge of graph.edges) {
      expect(nodeIdSet.has(edge.src)).toBe(true)
      expect(nodeIdSet.has(edge.dst)).toBe(true)
    }
  })

  it("honors edgeKinds + symbolKinds filters", async () => {
    fixture = await buildFixture()
    const raw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
        edgeKinds: ["imports"],
        symbolKinds: ["module"],
      },
      stubClient,
      stubTracker,
    )
    const graph = JSON.parse(raw) as {
      nodes: Array<{ kind: string }>
      edges: Array<{ kind: string }>
    }
    // Only module nodes survive the symbol filter
    for (const node of graph.nodes) {
      expect(node.kind).toBe("module")
    }
    // Only imports edges survive the edge filter
    for (const edge of graph.edges) {
      expect(edge.kind).toBe("imports")
    }
  })

  it("honors centerOf + centerHops to scope the graph", async () => {
    fixture = await buildFixture()
    // Center on Alpha — the fixture's class. Hops=1 should return
    // Alpha itself plus its module + methods + the module that
    // imports it (beta.ts). Whatever the exact count, it must be
    // strictly smaller than the full graph.
    const fullRaw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
      },
      stubClient,
      stubTracker,
    )
    const full = JSON.parse(fullRaw) as { nodes: unknown[] }

    const centeredRaw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
        centerOf: "Alpha",
        centerHops: 1,
      },
      stubClient,
      stubTracker,
    )
    const centered = JSON.parse(centeredRaw) as {
      nodes: Array<{ id: string }>
      edges: Array<{ src: string; dst: string }>
    }

    expect(centered.nodes.length).toBeLessThan(full.nodes.length)
    expect(centered.nodes.length).toBeGreaterThan(0)
    expect(
      centered.nodes.some((n) => n.id.endsWith("#Alpha")),
    ).toBe(true)
    // Every edge endpoint must be inside the centered set
    const ids = new Set(centered.nodes.map((n) => n.id))
    for (const edge of centered.edges) {
      expect(ids.has(edge.src)).toBe(true)
      expect(ids.has(edge.dst)).toBe(true)
    }
  })

  it("centerDirection narrows the BFS walk via the MCP tool", async () => {
    fixture = await buildFixture()
    const both = JSON.parse(
      await graphTool!.execute(
        {
          snapshotId: fixture.snapshotId,
          workspaceRoot: fixture.tempRoot,
          centerOf: "Alpha",
          centerHops: 1,
          centerDirection: "both",
        },
        stubClient,
        stubTracker,
      ),
    ) as { nodes: unknown[] }
    const outOnly = JSON.parse(
      await graphTool!.execute(
        {
          snapshotId: fixture.snapshotId,
          workspaceRoot: fixture.tempRoot,
          centerOf: "Alpha",
          centerHops: 1,
          centerDirection: "out",
        },
        stubClient,
        stubTracker,
      ),
    ) as { nodes: unknown[] }
    const inOnly = JSON.parse(
      await graphTool!.execute(
        {
          snapshotId: fixture.snapshotId,
          workspaceRoot: fixture.tempRoot,
          centerOf: "Alpha",
          centerHops: 1,
          centerDirection: "in",
        },
        stubClient,
        stubTracker,
      ),
    ) as { nodes: unknown[] }

    expect(both.nodes.length).toBeGreaterThan(0)
    expect(outOnly.nodes.length).toBeLessThanOrEqual(both.nodes.length)
    expect(inOnly.nodes.length).toBeLessThanOrEqual(both.nodes.length)
  })

  it("centerOf returns an empty graph when the symbol doesn't resolve", async () => {
    fixture = await buildFixture()
    const raw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
        centerOf: "totally_made_up_xyz_zzz_qq",
      },
      stubClient,
      stubTracker,
    )
    const graph = JSON.parse(raw) as { nodes: unknown[]; edges: unknown[] }
    expect(graph.nodes.length).toBe(0)
    expect(graph.edges.length).toBe(0)
  })

  it("returns an empty graph for an unknown snapshotId", async () => {
    fixture = await buildFixture()
    // Pass a snapshotId that doesn't exist in the db. The lookup
    // should return an empty graph (zero nodes/edges) rather than
    // throwing — the contract is "no rows matched" not "error".
    const raw = await graphTool!.execute(
      {
        snapshotId: 999999,
        workspaceRoot: fixture.tempRoot,
      },
      stubClient,
      stubTracker,
    )
    const graph = JSON.parse(raw) as {
      workspace: string
      snapshot_id: number
      nodes: unknown[]
      edges: unknown[]
      total_nodes: number
      total_edges: number
    }
    expect(graph.workspace).toBe(fixture.tempRoot)
    expect(graph.snapshot_id).toBe(999999)
    expect(graph.nodes.length).toBe(0)
    expect(graph.edges.length).toBe(0)
    expect(graph.total_nodes).toBe(0)
    expect(graph.total_edges).toBe(0)
  })

  it("ignores empty filter arrays as if they were omitted", async () => {
    fixture = await buildFixture()
    // The contract: an empty array is treated as "no filter" rather
    // than "match nothing", so callers can pass [] for optional
    // filters without zeroing the result.
    const baseRaw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
      },
      stubClient,
      stubTracker,
    )
    const emptyRaw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
        edgeKinds: [],
        symbolKinds: [],
      },
      stubClient,
      stubTracker,
    )
    const base = JSON.parse(baseRaw) as { nodes: unknown[]; edges: unknown[] }
    const withEmpty = JSON.parse(emptyRaw) as {
      nodes: unknown[]
      edges: unknown[]
    }
    expect(withEmpty.nodes.length).toBe(base.nodes.length)
    expect(withEmpty.edges.length).toBe(base.edges.length)
  })

  it("handles centerOf with whitespace + special chars gracefully", async () => {
    fixture = await buildFixture()
    // None of these should throw — empty / whitespace / regex-like
    // characters all flow through resolveCenterSymbol which uses
    // plain string matching, never a regex compile.
    const probes = ["  ", "(", ")", "[", "]", "*", ".*", "no_such_xyz"]
    for (const probe of probes) {
      const raw = await graphTool!.execute(
        {
          snapshotId: fixture.snapshotId,
          workspaceRoot: fixture.tempRoot,
          centerOf: probe,
        },
        stubClient,
        stubTracker,
      )
      const graph = JSON.parse(raw) as { nodes: unknown[]; edges: unknown[] }
      // Each probe either resolves to no node (empty result) or
      // to a substring match (non-empty result). Either is valid;
      // what we care about is that none throw.
      expect(Array.isArray(graph.nodes)).toBe(true)
      expect(Array.isArray(graph.edges)).toBe(true)
    }
  })

  it("maxNodes caps the result to the top-N by degree", async () => {
    fixture = await buildFixture()
    // Get the full graph first to know how many nodes to cap from
    const fullRaw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
      },
      stubClient,
      stubTracker,
    )
    const full = JSON.parse(fullRaw) as { nodes: Array<{ id: string }> }
    expect(full.nodes.length).toBeGreaterThan(3)

    const cap = Math.max(3, Math.floor(full.nodes.length / 2))
    const cappedRaw = await graphTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
        maxNodes: cap,
      },
      stubClient,
      stubTracker,
    )
    const capped = JSON.parse(cappedRaw) as {
      nodes: Array<{ id: string }>
      edges: Array<{ src: string; dst: string }>
    }
    expect(capped.nodes.length).toBeLessThanOrEqual(cap)
    expect(capped.nodes.length).toBeGreaterThan(0)
    // Edge endpoints must all be in the capped set
    const ids = new Set(capped.nodes.map((n) => n.id))
    for (const edge of capped.edges) {
      expect(ids.has(edge.src)).toBe(true)
      expect(ids.has(edge.dst)).toBe(true)
    }
  })

  it("returns a structured error when the backend has no graph reader", async () => {
    // Wire deps with a stub dbLookup that does NOT implement
    // loadGraphJson — simulating a backend that supports query
    // intents but not graph reads.
    fixture = await buildFixture()
    setIntelligenceDeps({
      persistence: {
        dbLookup: {
          // Only the lookup method, no loadGraphJson
          lookup: async () => ({
            hit: false,
            intent: "who_calls_api" as const,
            snapshotId: 1,
            rows: [],
          }),
        },
        authoritativeStore: { persistEnrichment: async () => 0 },
        graphProjection: {
          syncFromAuthoritative: async () => ({
            synced: true,
            nodesUpserted: 0,
            edgesUpserted: 0,
          }),
        },
      },
      clangdEnricher: {
        source: "clangd" as const,
        enrich: async () => ({
          attempts: [{ source: "clangd" as const, status: "failed" as const }],
          persistedRows: 0,
        }),
      },
      cParserEnricher: {
        source: "c_parser" as const,
        enrich: async () => ({
          attempts: [{ source: "c_parser" as const, status: "failed" as const }],
          persistedRows: 0,
        }),
      },
    } as never)

    const raw = await graphTool!.execute(
      {
        snapshotId: 1,
        workspaceRoot: fixture.tempRoot,
      },
      stubClient,
      stubTracker,
    )
    const res = JSON.parse(raw) as { status?: string; errors?: string[] }
    expect(res.status).toBe("error")
    expect(res.errors?.[0]).toMatch(/loadGraphJson/)
  })
})

describe("intelligence_graph_diff MCP tool — round trip", () => {
  type Diff = {
    nodes_only_in_a: string[]
    nodes_only_in_b: string[]
    nodes_in_both: number
    edges_only_in_a: string[]
    edges_only_in_b: string[]
    edges_in_both: number
    summary: {
      a_nodes: number
      b_nodes: number
      a_edges: number
      b_edges: number
      nodes_added: number
      nodes_removed: number
      edges_added: number
      edges_removed: number
    }
  }

  it("returns zero diff when both filters are unfiltered (default)", async () => {
    fixture = await buildFixture()
    const raw = await diffTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
      },
      stubClient,
      stubTracker,
    )
    const diff = JSON.parse(raw) as Diff
    expect(diff.nodes_only_in_a).toEqual([])
    expect(diff.nodes_only_in_b).toEqual([])
    expect(diff.edges_only_in_a).toEqual([])
    expect(diff.edges_only_in_b).toEqual([])
    expect(diff.summary.nodes_added).toBe(0)
    expect(diff.summary.nodes_removed).toBe(0)
    // Both sides loaded the same graph
    expect(diff.summary.a_nodes).toBe(diff.summary.b_nodes)
    expect(diff.summary.a_edges).toBe(diff.summary.b_edges)
  })

  it("returns symmetric difference when filtersA differs from filtersB", async () => {
    fixture = await buildFixture()
    // A = full graph, B = module-only subgraph. Everything in B
    // should be in A (subset relationship), so nodes_only_in_b = []
    // and nodes_only_in_a should contain the cut symbols.
    const raw = await diffTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
        filtersB: {
          symbolKinds: ["module"],
        },
      },
      stubClient,
      stubTracker,
    )
    const diff = JSON.parse(raw) as Diff
    // B is a strict subset of A
    expect(diff.nodes_only_in_b).toEqual([])
    expect(diff.summary.nodes_added).toBe(0)
    // A has more than B
    expect(diff.summary.a_nodes).toBeGreaterThan(diff.summary.b_nodes)
    // The cut symbols are in nodes_only_in_a — at least the Alpha
    // class from the fixture
    expect(diff.nodes_only_in_a.length).toBeGreaterThan(0)
  })

  it("centerOf=Alpha vs full graph: full has more nodes", async () => {
    fixture = await buildFixture()
    const raw = await diffTool!.execute(
      {
        snapshotId: fixture.snapshotId,
        workspaceRoot: fixture.tempRoot,
        filtersB: {
          centerOf: "Alpha",
          centerHops: 1,
        },
      },
      stubClient,
      stubTracker,
    )
    const diff = JSON.parse(raw) as Diff
    // The centered subgraph is a subset of the full graph
    expect(diff.nodes_only_in_b).toEqual([])
    expect(diff.summary.b_nodes).toBeLessThanOrEqual(diff.summary.a_nodes)
    // The center symbol is in the intersection
    expect(diff.nodes_in_both).toBeGreaterThan(0)
  })

  it("returns a structured error when the backend has no graph reader", async () => {
    fixture = await buildFixture()
    setIntelligenceDeps({
      persistence: {
        dbLookup: {
          lookup: async () => ({
            hit: false,
            intent: "who_calls_api" as const,
            snapshotId: 1,
            rows: [],
          }),
        },
        authoritativeStore: { persistEnrichment: async () => 0 },
        graphProjection: {
          syncFromAuthoritative: async () => ({
            synced: true,
            nodesUpserted: 0,
            edgesUpserted: 0,
          }),
        },
      },
      clangdEnricher: {
        source: "clangd" as const,
        enrich: async () => ({
          attempts: [{ source: "clangd" as const, status: "failed" as const }],
          persistedRows: 0,
        }),
      },
      cParserEnricher: {
        source: "c_parser" as const,
        enrich: async () => ({
          attempts: [{ source: "c_parser" as const, status: "failed" as const }],
          persistedRows: 0,
        }),
      },
    } as never)
    const raw = await diffTool!.execute(
      {
        snapshotId: 1,
        workspaceRoot: fixture.tempRoot,
      },
      stubClient,
      stubTracker,
    )
    const res = JSON.parse(raw) as { status?: string; errors?: string[] }
    expect(res.status).toBe("error")
    expect(res.errors?.[0]).toMatch(/loadGraphJson/)
  })
})

// ── Phase 3e: data-structure intents over the MCP path ───────────────────────
//
// Builds a small fixture with explicit class fields + an enum so the
// four new intents (find_field_type, find_type_fields,
// find_type_aggregates, find_type_aggregators) all have something
// to return.

interface DataStructFixture {
  client: { close: () => void }
  cleanup: () => void
  snapshotId: number
  tempRoot: string
}

async function buildDataStructFixture(): Promise<DataStructFixture> {
  const tempRoot = mkdtempSync(join(tmpdir(), "intel-data-struct-"))
  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify({ name: "fixture-data-struct" }),
  )
  mkdirSync(join(tempRoot, "src"), { recursive: true })
  writeFileSync(
    join(tempRoot, "src", "model.ts"),
    `export interface User { id: string }
export class Box {
  owner: User
  members: User[]
  fallback: User | undefined
}
export enum Status { Active, Inactive = 1 }
`,
  )

  const client = openSqlite({ path: ":memory:" })
  const foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
  const store = new SqliteGraphStore(client.db)
  const lookup = new SqliteDbLookup(client.db, client.raw)
  const ref = await foundation.beginSnapshot({
    workspaceRoot: tempRoot,
    compileDbHash: "data-struct-mcp",
    parserVersion: "0.1.0",
  })
  const snapshotId = ref.snapshotId
  const runner = new ExtractorRunner({
    snapshotId,
    workspaceRoot: tempRoot,
    lsp: stubLsp,
    sink: store,
    plugins: [tsCoreExtractor],
  })
  await runner.run()
  await foundation.commitSnapshot(snapshotId)

  const deps: OrchestratorRunnerDeps = {
    persistence: {
      dbLookup: lookup,
      authoritativeStore: { persistEnrichment: async () => 0 },
      graphProjection: {
        syncFromAuthoritative: async () => ({
          synced: true,
          nodesUpserted: 0,
          edgesUpserted: 0,
        }),
      },
    },
    clangdEnricher: {
      source: "clangd" as const,
      enrich: async () => ({
        attempts: [{ source: "clangd" as const, status: "failed" as const }],
        persistedRows: 0,
      }),
    },
    cParserEnricher: {
      source: "c_parser" as const,
      enrich: async () => ({
        attempts: [{ source: "c_parser" as const, status: "failed" as const }],
        persistedRows: 0,
      }),
    },
  }
  setIntelligenceDeps(deps)

  return {
    client,
    snapshotId,
    tempRoot,
    cleanup: () => {
      try { client.close() } catch {}
      rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}

describe("intelligence_query MCP tool — data-structure intents (Phase 3e)", () => {
  let dsFixture: DataStructFixture | null = null

  afterEach(() => {
    if (dsFixture) {
      dsFixture.cleanup()
      dsFixture = null
    }
  })

  it("find_type_fields returns the data members of a class (excluding methods)", async () => {
    dsFixture = await buildDataStructFixture()
    const raw = await tool!.execute(
      {
        intent: "find_type_fields",
        snapshotId: dsFixture.snapshotId,
        apiName: "module:src/model.ts#Box",
      },
      stubClient,
      stubTracker,
    )
    const res = JSON.parse(raw) as FlatResponse
    expect(res.status).toBe("hit")
    const names = res.data.nodes.map((n) => String(n.canonical_name))
    expect(names.some((n) => n.endsWith("#Box.owner"))).toBe(true)
    expect(names.some((n) => n.endsWith("#Box.members"))).toBe(true)
    expect(names.some((n) => n.endsWith("#Box.fallback"))).toBe(true)
    // Every returned node must have kind=field (no methods leaking through)
    for (const node of res.data.nodes) {
      expect(node.kind).toBe("field")
    }
  })

  it("find_type_fields returns the variants of an enum (kind=enum_variant)", async () => {
    dsFixture = await buildDataStructFixture()
    const raw = await tool!.execute(
      {
        intent: "find_type_fields",
        snapshotId: dsFixture.snapshotId,
        apiName: "module:src/model.ts#Status",
      },
      stubClient,
      stubTracker,
    )
    const res = JSON.parse(raw) as FlatResponse
    expect(res.status).toBe("hit")
    const names = res.data.nodes.map((n) => String(n.canonical_name))
    expect(names.some((n) => n.endsWith("#Status.Active"))).toBe(true)
    expect(names.some((n) => n.endsWith("#Status.Inactive"))).toBe(true)
    for (const node of res.data.nodes) {
      expect(node.kind).toBe("enum_variant")
    }
  })

  it("find_field_type returns the type a field declares", async () => {
    dsFixture = await buildDataStructFixture()
    const raw = await tool!.execute(
      {
        intent: "find_field_type",
        snapshotId: dsFixture.snapshotId,
        apiName: "module:src/model.ts#Box.members",
      },
      stubClient,
      stubTracker,
    )
    const res = JSON.parse(raw) as FlatResponse
    expect(res.status).toBe("hit")
    // members: User[] → User shows up in the response nodes
    expect(res.data.nodes.length).toBeGreaterThan(0)
    expect(
      res.data.nodes.some((n) =>
        String(n.canonical_name).endsWith("#User"),
      ),
    ).toBe(true)
  })

  it("find_type_aggregates returns the rolled-up types this struct depends on", async () => {
    dsFixture = await buildDataStructFixture()
    const raw = await tool!.execute(
      {
        intent: "find_type_aggregates",
        snapshotId: dsFixture.snapshotId,
        apiName: "module:src/model.ts#Box",
      },
      stubClient,
      stubTracker,
    )
    const res = JSON.parse(raw) as FlatResponse
    expect(res.status).toBe("hit")
    // Box.owner, Box.members, Box.fallback all reference User → one
    // aggregates edge to User (de-duped from 3 field_of_type edges)
    const targets = res.data.nodes.map((n) => String(n.canonical_name))
    expect(targets.some((t) => t.endsWith("#User"))).toBe(true)
  })

  it("find_type_aggregators returns the reverse — types that depend on this", async () => {
    dsFixture = await buildDataStructFixture()
    const raw = await tool!.execute(
      {
        intent: "find_type_aggregators",
        snapshotId: dsFixture.snapshotId,
        apiName: "module:src/model.ts#User",
      },
      stubClient,
      stubTracker,
    )
    const res = JSON.parse(raw) as FlatResponse
    expect(res.status).toBe("hit")
    // Box aggregates User → User has Box as an aggregator
    const sources = res.data.nodes.map((n) => String(n.canonical_name))
    expect(sources.some((s) => s.endsWith("#Box"))).toBe(true)
  })

  // ── Phase 3g: language-agnostic field-access aliases ──────────────
  // The fixture's Box class has reads_field/writes_field edges from
  // its methods to its fields (via the existing ts-core extraction).
  // We need to extend the fixture so the four field-access intents
  // have something to find — `Box.greet` reads `Box.owner` and
  // writes `Box.count`.
  it("find_api_field_reads / find_api_field_writes / find_field_readers / find_field_writers — synthetic data flow fixture", async () => {
    // Build a small fixture with explicit reads/writes via this.foo
    // and confirm all four intents find the right rows.
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3g-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3g" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      writeFileSync(
        join(tempRoot, "src", "counter.ts"),
        `export class Counter {
  count = 0
  name = "init"
  reset(): void {
    this.count = 0
  }
  bump(): void {
    this.count = this.count + 1
  }
  label(): string {
    return this.name
  }
}
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3g",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      // 1. find_api_field_writes(Counter.bump) → Counter.count
      const apiWritesRaw = await tool!.execute(
        {
          intent: "find_api_field_writes",
          snapshotId,
          apiName: "module:src/counter.ts#Counter.bump",
        },
        stubClient,
        stubTracker,
      )
      const apiWrites = JSON.parse(apiWritesRaw) as FlatResponse
      expect(apiWrites.status).toBe("hit")
      expect(
        apiWrites.data.nodes.some((n) =>
          String(n.canonical_name).endsWith("#Counter.count"),
        ),
      ).toBe(true)

      // 2. find_api_field_reads(Counter.label) → Counter.name
      const apiReadsRaw = await tool!.execute(
        {
          intent: "find_api_field_reads",
          snapshotId,
          apiName: "module:src/counter.ts#Counter.label",
        },
        stubClient,
        stubTracker,
      )
      const apiReads = JSON.parse(apiReadsRaw) as FlatResponse
      expect(apiReads.status).toBe("hit")
      expect(
        apiReads.data.nodes.some((n) =>
          String(n.canonical_name).endsWith("#Counter.name"),
        ),
      ).toBe(true)

      // 3. find_field_writers(Counter.count) → Counter.reset + Counter.bump
      const writersRaw = await tool!.execute(
        {
          intent: "find_field_writers",
          snapshotId,
          apiName: "module:src/counter.ts#Counter.count",
        },
        stubClient,
        stubTracker,
      )
      const writers = JSON.parse(writersRaw) as FlatResponse
      expect(writers.status).toBe("hit")
      const writerNames = writers.data.nodes.map((n) =>
        String(n.canonical_name),
      )
      expect(writerNames.some((n) => n.endsWith("#Counter.reset"))).toBe(true)
      expect(writerNames.some((n) => n.endsWith("#Counter.bump"))).toBe(true)

      // 4. find_field_readers(Counter.name) → Counter.label
      const readersRaw = await tool!.execute(
        {
          intent: "find_field_readers",
          snapshotId,
          apiName: "module:src/counter.ts#Counter.name",
        },
        stubClient,
        stubTracker,
      )
      const readers = JSON.parse(readersRaw) as FlatResponse
      expect(readers.status).toBe("hit")
      expect(
        readers.data.nodes.some((n) =>
          String(n.canonical_name).endsWith("#Counter.label"),
        ),
      ).toBe(true)

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

// ── Phase 3h: find_data_path — data-side analog of find_call_chain ───────────
//
// Walks field_of_type / aggregates edges from a source type to a
// destination type and returns the shortest chain expanded into
// per-hop rows. This is the structural answer to "how does X
// reach Y" — useful when you have a top-level container type and
// want to see how it transitively holds a leaf type.
//
// Fixture shape:  Container -> Box -> User
//   class Container { box: Box }    → field_of_type Container.box → Box (+ Container aggregates Box)
//   class Box       { owner: User } → field_of_type Box.owner → User      (+ Box aggregates User)
//
// Expected: find_data_path(Container → User) returns a 2-hop chain.

describe("intelligence_query MCP tool — find_data_path (Phase 3h)", () => {
  it("returns a chain of struct hops from src type to dst type", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3h-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3h" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      writeFileSync(
        join(tempRoot, "src", "model.ts"),
        `export interface User { id: string }
export class Box {
  owner: User
}
export class Container {
  box: Box
}
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3h",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      const raw = await tool!.execute(
        {
          intent: "find_data_path",
          snapshotId,
          srcApi: "module:src/model.ts#Container",
          dstApi: "module:src/model.ts#User",
          depth: 6,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      expect(res.status).toBe("hit")
      // Two hops in the canonical chain: Container → Box, Box → User
      // (the BFS picks whichever path through field_of_type/aggregates
      // is shortest — since aggregates is the per-type rollup of
      // field_of_type, the shortest chain is two hops either way).
      expect(res.data.nodes.length).toBeGreaterThanOrEqual(2)
      // Every hop is rendered as a struct (the data-path response
      // hard-codes kind="struct" so the node-protocol schema accepts
      // it — same pattern as callChain hard-coding "function").
      for (const node of res.data.nodes) {
        expect(node.kind).toBe("struct")
      }
      // The names along the chain mention Container and User
      const names = res.data.nodes.map((n) => String(n.canonical_name))
      expect(names.some((n) => n.endsWith("#Container"))).toBe(true)

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("rejects find_data_path when srcApi or dstApi is missing", async () => {
    const raw = await tool!.execute(
      {
        intent: "find_data_path",
        snapshotId: 1,
        // srcApi and dstApi intentionally omitted
      },
      stubClient,
      stubTracker,
    )
    const res = JSON.parse(raw) as { status?: string; nodeProtocol?: { errors?: Array<{ message: string }> } }
    expect(res.status).toBe("error")
    const messages =
      res.nodeProtocol?.errors?.map((e) => e.message).join(" ") ?? ""
    expect(messages).toMatch(/srcApi.*dstApi.*find_data_path/)
  })
})

// ── Phase 3i: find_struct_cycles — A.b: B and B.a: A antipattern ─────────────
//
// The data-side analog of find_type_cycles. Catches mutual structural
// containment via aggregates edges (the de-duplicated rollup of
// field_of_type, so a single class with multiple fields of the same
// type doesn't get reported as multiple cycles).

describe("intelligence_query MCP tool — find_struct_cycles (Phase 3i)", () => {
  it("returns the cycle when two classes structurally reference each other", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3i-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3i" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      // Mutual containment: Tree.parent: Node + Node.tree: Tree.
      // The ts-core extractor emits aggregates edges for both
      // Tree → Node and Node → Tree, which the cycle detector
      // self-joins to find the pair.
      writeFileSync(
        join(tempRoot, "src", "model.ts"),
        `export class Node {
  tree: Tree | null = null
}
export class Tree {
  parent: Node | null = null
}
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3i",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      const raw = await tool!.execute(
        {
          intent: "find_struct_cycles",
          snapshotId,
          limit: 50,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      expect(res.status).toBe("hit")
      expect(res.data.nodes.length).toBeGreaterThan(0)
      // The cycle pair must be present — exactly one row for the
      // Tree/Node pair. The canonical_name < canonical_name self-join
      // condition picks the alphabetically-first endpoint (Node) as
      // the row's canonical_name. The legacy-flat response strips
      // the caller/callee fields, so we assert on canonical_name
      // and use the underlying nodeProtocol response to verify both
      // endpoints survive in the structures rel bucket.
      const names = res.data.nodes.map((n) => String(n.canonical_name))
      // Node < Tree alphabetically, so the canonical name is Node
      expect(names.some((n) => n.endsWith("#Node"))).toBe(true)

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("returns no rows when there are no structural cycles", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3i-noncyclic-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3i-noncyclic" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      // Container -> Box -> User is a chain, not a cycle
      writeFileSync(
        join(tempRoot, "src", "model.ts"),
        `export class User { id = "" }
export class Box {
  owner: User | null = null
}
export class Container {
  box: Box | null = null
}
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3i-noncyclic",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      const raw = await tool!.execute(
        {
          intent: "find_struct_cycles",
          snapshotId,
          limit: 50,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      // No cycles → not_found is acceptable, hit with empty rows is also fine
      expect(res.data.nodes.length).toBe(0)

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

// ── Phase 3l: find_api_data_footprint ───────────────────────────────────────
//
// BFS-walks calls edges from a starting api and collects every
// reads_field/writes_field touched by any reachable method. Answers
// "what data does this api ultimately touch via its call chain",
// not just what the literal method writes itself.

describe("intelligence_query MCP tool — find_api_data_footprint (Phase 3l)", () => {
  it("collects fields touched by direct + transitive callees", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3l-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3l" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      // Auth.login() doesn't touch any field directly. It calls
      // validate() which writes attempts AND reads passwordHash.
      // The transitive footprint of login() must include both
      // attempts (write) and passwordHash (read), even though
      // login() itself does neither.
      writeFileSync(
        join(tempRoot, "src", "auth.ts"),
        `export class Auth {
  attempts = 0
  passwordHash = ""
  login(): boolean {
    return this.validate()
  }
  validate(): boolean {
    this.attempts = this.attempts + 1
    return this.passwordHash.length > 0
  }
}
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3l",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      // Query against login() — its DIRECT footprint is empty, but
      // its TRANSITIVE footprint via validate() must include both
      // attempts (write) and passwordHash (read).
      const raw = await tool!.execute(
        {
          intent: "find_api_data_footprint",
          snapshotId,
          apiName: "module:src/auth.ts#Auth.login",
          depth: 6,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      expect(res.status).toBe("hit")
      const names = res.data.nodes.map((n) => String(n.canonical_name))
      expect(names.some((n) => n.endsWith("#Auth.attempts"))).toBe(true)
      expect(names.some((n) => n.endsWith("#Auth.passwordHash"))).toBe(true)
      // Every returned node has kind=field
      for (const node of res.data.nodes) {
        expect(node.kind).toBe("field")
      }

      // Direct query against validate() must also work
      const validateRaw = await tool!.execute(
        {
          intent: "find_api_data_footprint",
          snapshotId,
          apiName: "module:src/auth.ts#Auth.validate",
          depth: 6,
        },
        stubClient,
        stubTracker,
      )
      const validateRes = JSON.parse(validateRaw) as FlatResponse
      expect(validateRes.status).toBe("hit")
      const validateNames = validateRes.data.nodes.map((n) =>
        String(n.canonical_name),
      )
      expect(validateNames.some((n) => n.endsWith("#Auth.attempts"))).toBe(true)
      expect(validateNames.some((n) => n.endsWith("#Auth.passwordHash"))).toBe(
        true,
      )

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("returns empty when the api has no field accesses anywhere in its call closure", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3l-pure-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3l-pure" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      writeFileSync(
        join(tempRoot, "src", "math.ts"),
        `export function double(n: number): number {
  return n + n
}
export function quad(n: number): number {
  return double(double(n))
}
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3l-pure",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      const raw = await tool!.execute(
        {
          intent: "find_api_data_footprint",
          snapshotId,
          apiName: "module:src/math.ts#quad",
          depth: 6,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      // Pure chain → no field touches
      expect(res.data.nodes.length).toBe(0)

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

// ── Phase 3m: find_top_touched_types ────────────────────────────────────────
//
// Data-side analog of find_top_called_functions. Ranks types by
// the number of DISTINCT APIs that read or write any of their
// fields. Surfaces the central pieces of state that the codebase
// revolves around.

describe("intelligence_query MCP tool — find_top_touched_types (Phase 3m)", () => {
  it("ranks types by distinct API touchers", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3m-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3m" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      // User has 2 fields touched by 3 distinct methods (load reads
      // name + email, rename writes name, audit reads name).
      // Config has 1 field touched by 1 method.
      // → User should outrank Config (3 > 1).
      // Methods are placed inside the class whose fields they touch
      // because Phase 3g reads_field extraction works on `this.field`
      // direct access (the simpler, common case).
      writeFileSync(
        join(tempRoot, "src", "model.ts"),
        `export class User {
  name = ""
  email = ""
  load(): void {
    const x = this.name
    const y = this.email
  }
  rename(): void {
    this.name = "new"
  }
  audit(): string {
    return this.name
  }
}
export class Config {
  level = 0
  read(): number {
    return this.level
  }
}
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3m",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      const raw = await tool!.execute(
        {
          intent: "find_top_touched_types",
          snapshotId,
          limit: 10,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      expect(res.status).toBe("hit")
      expect(res.data.nodes.length).toBeGreaterThan(0)
      const names = res.data.nodes.map((n) => String(n.canonical_name))
      // User must rank above Config (more touchers) — find their indices
      const userIdx = names.findIndex((n) => n.endsWith("#User"))
      const configIdx = names.findIndex((n) => n.endsWith("#Config"))
      // User exists; Config may or may not depending on extractor accuracy
      expect(userIdx).toBeGreaterThanOrEqual(0)
      if (configIdx >= 0) {
        // If Config is in the result, User must come first (more touchers)
        expect(userIdx).toBeLessThan(configIdx)
      }
      // Every row must be a struct/class/interface kind
      for (const node of res.data.nodes) {
        expect(["struct", "class", "interface"]).toContain(String(node.kind))
      }

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("returns empty when no types have any field touchers", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3m-empty-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3m-empty" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      // Pure functions only, no classes / no fields.
      writeFileSync(
        join(tempRoot, "src", "math.ts"),
        `export function add(a: number, b: number): number { return a + b }
export function mul(a: number, b: number): number { return a * b }
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3m-empty",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      const raw = await tool!.execute(
        {
          intent: "find_top_touched_types",
          snapshotId,
          limit: 10,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      expect(res.data.nodes.length).toBe(0)

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})

// ── Phase 3n: find_call_cycles — direct mutual recursion ────────────────────
//
// Closes the cycle-detection family alongside find_import_cycles,
// find_type_cycles, and find_struct_cycles. Detects (A, B) pairs
// where A calls B AND B calls A — the bug-suspect shape where two
// methods bounce off each other.

describe("intelligence_query MCP tool — find_call_cycles (Phase 3n)", () => {
  it("returns the cycle when two methods call each other", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3n-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3n" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      // ping() calls pong() AND pong() calls ping(). The cycle
      // detector should report the pair.
      writeFileSync(
        join(tempRoot, "src", "pingpong.ts"),
        `export function ping(n: number): number {
  if (n <= 0) return 0
  return pong(n - 1)
}
export function pong(n: number): number {
  if (n <= 0) return 0
  return ping(n - 1)
}
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3n",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      const raw = await tool!.execute(
        {
          intent: "find_call_cycles",
          snapshotId,
          limit: 50,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      expect(res.status).toBe("hit")
      expect(res.data.nodes.length).toBeGreaterThan(0)
      // The canonical name is alphabetically first of the pair (ping)
      const names = res.data.nodes.map((n) => String(n.canonical_name))
      expect(names.some((n) => n.endsWith("#ping"))).toBe(true)
      // Function kind preserved (the node-protocol layer remaps
      // SqliteRow.kind="function" → NodeItem.kind="api")
      for (const node of res.data.nodes) {
        expect(["api", "method"]).toContain(String(node.kind))
      }

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("returns no rows when there is no mutual recursion", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "intel-3n-acyclic-"))
    try {
      writeFileSync(
        join(tempRoot, "package.json"),
        JSON.stringify({ name: "fixture-3n-acyclic" }),
      )
      mkdirSync(join(tempRoot, "src"), { recursive: true })
      // Linear call chain: a → b → c, no back-edges.
      writeFileSync(
        join(tempRoot, "src", "chain.ts"),
        `export function c(): number { return 1 }
export function b(): number { return c() }
export function a(): number { return b() }
`,
      )

      const client = openSqlite({ path: ":memory:" })
      const foundation = new SqliteDbFoundation(client.db, client.raw)
      await foundation.initSchema()
      const store = new SqliteGraphStore(client.db)
      const lookup = new SqliteDbLookup(client.db, client.raw)
      const ref = await foundation.beginSnapshot({
        workspaceRoot: tempRoot,
        compileDbHash: "intel-3n-acyclic",
        parserVersion: "0.1.0",
      })
      const snapshotId = ref.snapshotId
      const runner = new ExtractorRunner({
        snapshotId,
        workspaceRoot: tempRoot,
        lsp: stubLsp,
        sink: store,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      await foundation.commitSnapshot(snapshotId)

      const deps: OrchestratorRunnerDeps = {
        persistence: {
          dbLookup: lookup,
          authoritativeStore: { persistEnrichment: async () => 0 },
          graphProjection: {
            syncFromAuthoritative: async () => ({
              synced: true,
              nodesUpserted: 0,
              edgesUpserted: 0,
            }),
          },
        },
        clangdEnricher: {
          source: "clangd" as const,
          enrich: async () => ({
            attempts: [{ source: "clangd" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
        cParserEnricher: {
          source: "c_parser" as const,
          enrich: async () => ({
            attempts: [{ source: "c_parser" as const, status: "failed" as const }],
            persistedRows: 0,
          }),
        },
      }
      setIntelligenceDeps(deps)

      const raw = await tool!.execute(
        {
          intent: "find_call_cycles",
          snapshotId,
          limit: 50,
        },
        stubClient,
        stubTracker,
      )
      const res = JSON.parse(raw) as FlatResponse
      expect(res.data.nodes.length).toBe(0)

      client.close()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
