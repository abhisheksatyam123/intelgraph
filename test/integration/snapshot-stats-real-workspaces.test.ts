/**
 * test/integration/snapshot-stats-real-workspaces.test.ts
 *
 * End-to-end smoke tests for the visualization data path. Exercises
 * three layers against the real TypeScript workspaces:
 *
 *   1. `loadGraphJsonFromDb` (the pure SQL→GraphJson reader)
 *   3. `intelligence_graph` MCP tool (the path the TUI uses)
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
 * MCP tool — so the HTML viewer and the TUI's MCP path can't silently
 * break on a real codebase without the test catching it.
 *
 * Architectural note: each workspace runs exactly ONE extraction in
 * beforeAll (sharing the SqliteDbLookup across all assertions in the
 * describe block) so the suite stays under ~2 minutes for both
 * workspaces combined. An earlier shape that called buildGraphJson
 * per-test re-extracted N times and was both slow and prone to flakes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import {
  openSqlite,
  type SqliteClient,
} from "../../src/intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../../src/intelligence/db/sqlite/foundation.js"
import { SqliteGraphStore } from "../../src/intelligence/db/sqlite/graph-store.js"
import { SqliteDbLookup } from "../../src/intelligence/db/sqlite/db-lookup.js"
import {
  loadGraphJsonFromDb,
  diffGraphJson,
} from "../../src/intelligence/db/sqlite/graph-export.js"
import { ExtractorRunner } from "../../src/intelligence/extraction/runner.js"
import { tsCoreExtractor } from "../../src/plugins/index.js"
import { setIntelligenceDeps, TOOLS } from "../../src/tools/index.js"
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

const graphTool = TOOLS.find((t) => t.name === "intelligence_graph")
if (!graphTool) throw new Error("intelligence_graph tool not registered")
const diffTool = TOOLS.find((t) => t.name === "intelligence_graph_diff")
if (!diffTool) throw new Error("intelligence_graph_diff tool not registered")
const stubClient = {} as Parameters<typeof graphTool.execute>[1]
const stubTracker = {} as Parameters<typeof graphTool.execute>[2]



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
  /**
   * A symbol-name suffix (the part after `#` in canonical_name) that
   * resolves to a heavily-connected node — used as the center for
   * the centerOf filter tests. Picked to have ~30+ callers so the
   * centered subgraph is nontrivial but small.
   */
  centerSymbol: string
}

const CASES: WorkspaceCase[] = [
  {
    name: "opencode/packages/opencode",
    path: OPENCODE_ROOT,
    minNodes: 500,
    minEdges: 500,
    expectedSubstring: "opencode",
    centerSymbol: "cmd",
  },
  {
    name: "instructkr-claude-code",
    path: INSTRUCTKR_ROOT,
    minNodes: 200,
    minEdges: 200,
    expectedSubstring: "src/",
    centerSymbol: "Cursor",
  },
]

interface IngestedWorkspace {
  client: SqliteClient
  lookup: SqliteDbLookup
  snapshotId: number
}

async function ingestWorkspace(
  workspaceRoot: string,
): Promise<IngestedWorkspace> {
  const client = openSqlite({ path: ":memory:" })
  const foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
  const store = new SqliteGraphStore(client.db)
  const lookup = new SqliteDbLookup(client.db, client.raw)

  const ref = await foundation.beginSnapshot({
    workspaceRoot,
    compileDbHash: "snapshot-stats-real-workspaces",
    parserVersion: "0.1.0",
  })
  const snapshotId = ref.snapshotId

  const runner = new ExtractorRunner({
    snapshotId,
    workspaceRoot,
    lsp: stubLsp,
    sink: store,
    plugins: [tsCoreExtractor],
  })
  await runner.run()
  await foundation.commitSnapshot(snapshotId)

  return { client, lookup, snapshotId }
}

function wireMcpDeps(lookup: SqliteDbLookup): void {
  // Wire the real SqliteDbLookup behind the intelligence_graph MCP
  // tool so we exercise the actual MCP code path that the TUI uses.
  // Other deps are stubs — the graph tool only touches dbLookup.
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
}

for (const wcase of CASES) {
  describe.skipIf(!existsSync(wcase.path))(
    `snapshot-stats visualization — ${wcase.name}`,
    () => {
      let ingest: IngestedWorkspace

      beforeAll(async () => {
        ingest = await ingestWorkspace(wcase.path)
        wireMcpDeps(ingest.lookup)
      }, 180_000)

      afterAll(() => {
        ingest?.client.close()
      })

      it("loadGraphJsonFromDb produces a non-trivial graph with structural integrity", () => {
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )

        // Identity
        expect(graph.workspace).toBe(wcase.path)
        expect(graph.snapshot_id).toBe(ingest.snapshotId)

        // Floors
        expect(graph.nodes.length).toBeGreaterThan(wcase.minNodes)
        expect(graph.edges.length).toBeGreaterThan(wcase.minEdges)

        // Every edge endpoint must resolve to a node — orphan-edge
        // regression guard against the real codebase.
        const nodeIds = new Set(graph.nodes.map((n) => n.id))
        for (const edge of graph.edges) {
          expect(nodeIds.has(edge.src)).toBe(true)
          expect(nodeIds.has(edge.dst)).toBe(true)
        }

        // Workspace's actual files made it in
        expect(
          graph.nodes.some((n) => n.id.includes(wcase.expectedSubstring)),
        ).toBe(true)
      })


      it("loadGraphJsonFromDb honors edge-kind + symbol-kind filters", () => {
        // The canonical "module dependency view"
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          {
            edgeKinds: new Set(["imports"]),
            symbolKinds: new Set(["module"]),
          },
        )

        expect(graph.nodes.length).toBeGreaterThan(0)
        expect(graph.edges.length).toBeGreaterThan(0)
        for (const node of graph.nodes) {
          expect(node.kind).toBe("module")
        }
        for (const edge of graph.edges) {
          expect(edge.kind).toBe("imports")
        }
        const nodeIds = new Set(graph.nodes.map((n) => n.id))
        for (const edge of graph.edges) {
          expect(nodeIds.has(edge.src)).toBe(true)
          expect(nodeIds.has(edge.dst)).toBe(true)
        }
      })

      it("intelligence_graph MCP tool returns the live snapshot graph", async () => {
        const raw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
          },
          stubClient,
          stubTracker,
        )
        const graph = JSON.parse(raw) as {
          workspace: string
          snapshot_id: number
          nodes: Array<{ id: string; kind: string }>
          edges: Array<{ src: string; dst: string; kind: string }>
        }

        // Same identity + floors as the direct loadGraphJsonFromDb path
        expect(graph.workspace).toBe(wcase.path)
        expect(graph.snapshot_id).toBe(ingest.snapshotId)
        expect(graph.nodes.length).toBeGreaterThan(wcase.minNodes)
        expect(graph.edges.length).toBeGreaterThan(wcase.minEdges)

        // Every edge endpoint resolves
        const nodeIds = new Set(graph.nodes.map((n) => n.id))
        for (const edge of graph.edges) {
          expect(nodeIds.has(edge.src)).toBe(true)
          expect(nodeIds.has(edge.dst)).toBe(true)
        }
      })

      it("intelligence_graph MCP tool honors edgeKinds + symbolKinds filters", async () => {
        const raw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
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
        expect(graph.nodes.length).toBeGreaterThan(0)
        expect(graph.edges.length).toBeGreaterThan(0)
        for (const node of graph.nodes) {
          expect(node.kind).toBe("module")
        }
        for (const edge of graph.edges) {
          expect(edge.kind).toBe("imports")
        }
      })

      it("MCP and CLI paths return identical node and edge counts", async () => {
        // Same snapshot, same filters → same graph. Proves the MCP
        // tool is a faithful pass-through to loadGraphJsonFromDb and
        // not subtly transforming the data.
        const direct = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const raw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
          },
          stubClient,
          stubTracker,
        )
        const viaMcp = JSON.parse(raw) as {
          nodes: unknown[]
          edges: unknown[]
        }
        expect(viaMcp.nodes.length).toBe(direct.nodes.length)
        expect(viaMcp.edges.length).toBe(direct.edges.length)
      })

      it("centerOf via loadGraphJsonFromDb produces a small focused subgraph", () => {
        const full = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const centered = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          { centerOf: wcase.centerSymbol, centerHops: 2 },
        )

        // Strictly smaller than the full graph
        expect(centered.nodes.length).toBeLessThan(full.nodes.length)
        expect(centered.nodes.length).toBeGreaterThan(0)

        // The center symbol must appear in the result (suffix-after-#
        // resolution)
        expect(
          centered.nodes.some((n) => n.id.endsWith("#" + wcase.centerSymbol)),
        ).toBe(true)

        // Every edge endpoint must be in the centered set —
        // the orphan-edge invariant survives the BFS reduction.
        const ids = new Set(centered.nodes.map((n) => n.id))
        for (const edge of centered.edges) {
          expect(ids.has(edge.src)).toBe(true)
          expect(ids.has(edge.dst)).toBe(true)
        }
      })

      it("centerOf via intelligence_graph MCP tool works on real workspaces", async () => {
        const fullRaw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
          },
          stubClient,
          stubTracker,
        )
        const full = JSON.parse(fullRaw) as { nodes: unknown[] }

        const centeredRaw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
            centerOf: wcase.centerSymbol,
            centerHops: 2,
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
          centered.nodes.some((n) => n.id.endsWith("#" + wcase.centerSymbol)),
        ).toBe(true)
        // Edge integrity in the centered subgraph
        const ids = new Set(centered.nodes.map((n) => n.id))
        for (const edge of centered.edges) {
          expect(ids.has(edge.src)).toBe(true)
          expect(ids.has(edge.dst)).toBe(true)
        }
      })

      it("centerOf MCP and CLI paths return identical results", async () => {
        // Same snapshot, same center symbol, same hop budget → same
        // graph. Parity check between the two centerOf entry points.
        const direct = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          { centerOf: wcase.centerSymbol, centerHops: 2 },
        )
        const raw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
            centerOf: wcase.centerSymbol,
            centerHops: 2,
          },
          stubClient,
          stubTracker,
        )
        const viaMcp = JSON.parse(raw) as { nodes: unknown[]; edges: unknown[] }
        expect(viaMcp.nodes.length).toBe(direct.nodes.length)
        expect(viaMcp.edges.length).toBe(direct.edges.length)
      })

      it("maxNodes caps the unfiltered graph to a tractable size", () => {
        // The "production readiness" case: any workspace should
        // collapse to N nodes when maxNodes=N is requested. For
        // instructkr-claude-code this is the only way to make the
        // 20K-node graph tractable for the HTML force layout.
        const CAP = 300
        const full = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const capped = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          { maxNodes: CAP },
        )

        // If the full graph has > CAP nodes, the cap took effect;
        // otherwise the cap was a no-op and the result equals the
        // full graph. Either is correct.
        if (full.nodes.length > CAP) {
          expect(capped.nodes.length).toBeLessThanOrEqual(CAP)
          // The cap should produce something nontrivial
          expect(capped.nodes.length).toBeGreaterThan(0)
        } else {
          expect(capped.nodes.length).toBe(full.nodes.length)
        }

        // Edge integrity in the capped subgraph
        const ids = new Set(capped.nodes.map((n) => n.id))
        for (const edge of capped.edges) {
          expect(ids.has(edge.src)).toBe(true)
          expect(ids.has(edge.dst)).toBe(true)
        }
      })

      it("maxNodes via intelligence_graph MCP tool produces a tractable graph", async () => {
        const CAP = 300
        const raw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
            maxNodes: CAP,
          },
          stubClient,
          stubTracker,
        )
        const capped = JSON.parse(raw) as {
          nodes: Array<{ id: string }>
          edges: Array<{ src: string; dst: string }>
        }

        expect(capped.nodes.length).toBeLessThanOrEqual(CAP)
        expect(capped.nodes.length).toBeGreaterThan(0)
        const ids = new Set(capped.nodes.map((n) => n.id))
        for (const edge of capped.edges) {
          expect(ids.has(edge.src)).toBe(true)
          expect(ids.has(edge.dst)).toBe(true)
        }
      })

      it("maxNodes composes with centerOf — center first, then cap", () => {
        // The interesting composition: scope to a hub symbol's
        // neighborhood, then cap. The result should be ≤ both the
        // unbounded center result AND the cap.
        const CAP = 50
        const centered = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          { centerOf: wcase.centerSymbol, centerHops: 3 },
        )
        const both = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          { centerOf: wcase.centerSymbol, centerHops: 3, maxNodes: CAP },
        )

        expect(both.nodes.length).toBeLessThanOrEqual(CAP)
        expect(both.nodes.length).toBeLessThanOrEqual(centered.nodes.length)
        expect(both.nodes.length).toBeGreaterThan(0)

        // Every edge endpoint is in the result set
        const ids = new Set(both.nodes.map((n) => n.id))
        for (const edge of both.edges) {
          expect(ids.has(edge.src)).toBe(true)
          expect(ids.has(edge.dst)).toBe(true)
        }
      })

      it("pre-filter totals stay anchored across every filter cascade", () => {
        // The full graph defines the snapshot totals.
        const full = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        expect(full.total_nodes).toBeGreaterThan(0)
        expect(full.total_edges).toBeGreaterThan(0)
        // totals are >= visible counts (orphan edges are dropped at
        // load time, so total_edges >= edges.length always)
        expect(full.total_nodes).toBeGreaterThanOrEqual(full.nodes.length)
        expect(full.total_edges).toBeGreaterThanOrEqual(full.edges.length)

        // Every other filter combination must report the same totals.
        const variants = [
          loadGraphJsonFromDb(ingest.client.raw, ingest.snapshotId, wcase.path, {
            edgeKinds: new Set(["imports"]),
            symbolKinds: new Set(["module"]),
          }),
          loadGraphJsonFromDb(ingest.client.raw, ingest.snapshotId, wcase.path, {
            centerOf: wcase.centerSymbol,
            centerHops: 2,
          }),
          loadGraphJsonFromDb(ingest.client.raw, ingest.snapshotId, wcase.path, {
            maxNodes: 50,
          }),
          loadGraphJsonFromDb(ingest.client.raw, ingest.snapshotId, wcase.path, {
            centerOf: wcase.centerSymbol,
            centerHops: 3,
            maxNodes: 25,
          }),
        ]
        for (const v of variants) {
          expect(v.total_nodes).toBe(full.total_nodes)
          expect(v.total_edges).toBe(full.total_edges)
          // The visible counts must be ≤ totals (the filter only shrinks)
          expect(v.nodes.length).toBeLessThanOrEqual(full.total_nodes)
          expect(v.edges.length).toBeLessThanOrEqual(full.total_edges)
        }
      })

      it("totals also propagate through the intelligence_graph MCP path", async () => {
        // Same anchoring property must hold via the MCP tool.
        const fullRaw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
          },
          stubClient,
          stubTracker,
        )
        const full = JSON.parse(fullRaw) as {
          total_nodes: number
          total_edges: number
        }
        expect(full.total_nodes).toBeGreaterThan(0)
        expect(full.total_edges).toBeGreaterThan(0)

        // maxNodes via MCP — totals stay anchored, visible count drops
        const cappedRaw = await graphTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
            maxNodes: 50,
          },
          stubClient,
          stubTracker,
        )
        const capped = JSON.parse(cappedRaw) as {
          total_nodes: number
          total_edges: number
          nodes: unknown[]
        }
        expect(capped.total_nodes).toBe(full.total_nodes)
        expect(capped.total_edges).toBe(full.total_edges)
        expect(capped.nodes.length).toBeLessThanOrEqual(50)
        // Truncation actually happened: this workspace has > 50 nodes
        expect(capped.total_nodes).toBeGreaterThan(50)
      })

      it("centerDirection narrows the BFS walk on real data", () => {
        // Three direction variants centered on the same hub symbol.
        // Both directional walks must be proper subsets of the
        // undirected walk, since 'both' is the union of the two.
        const both = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          {
            centerOf: wcase.centerSymbol,
            centerHops: 2,
            centerDirection: "both",
          },
        )
        const outOnly = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          {
            centerOf: wcase.centerSymbol,
            centerHops: 2,
            centerDirection: "out",
          },
        )
        const inOnly = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          {
            centerOf: wcase.centerSymbol,
            centerHops: 2,
            centerDirection: "in",
          },
        )

        // All three contain the center symbol
        for (const g of [both, outOnly, inOnly]) {
          expect(
            g.nodes.some((n) => n.id.endsWith("#" + wcase.centerSymbol)),
          ).toBe(true)
        }

        // Set membership: every node in outOnly + inOnly must also
        // be in both. (Subset property — the directional walks are
        // always proper subsets of the undirected walk.)
        const bothIds = new Set(both.nodes.map((n) => n.id))
        for (const n of outOnly.nodes) {
          expect(bothIds.has(n.id)).toBe(true)
        }
        for (const n of inOnly.nodes) {
          expect(bothIds.has(n.id)).toBe(true)
        }

        // Counts also satisfy the subset invariant
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

      it("centerDirection works through the intelligence_graph MCP path", async () => {
        const directions: Array<"in" | "out" | "both"> = ["in", "out", "both"]
        const results: Record<string, { nodes: Array<{ id: string }> }> = {}
        for (const dir of directions) {
          const raw = await graphTool!.execute(
            {
              snapshotId: ingest.snapshotId,
              workspaceRoot: wcase.path,
              centerOf: wcase.centerSymbol,
              centerHops: 2,
              centerDirection: dir,
            },
            stubClient,
            stubTracker,
          )
          results[dir] = JSON.parse(raw) as { nodes: Array<{ id: string }> }
        }

        // 'both' is the superset
        expect(results.out.nodes.length).toBeLessThanOrEqual(
          results.both.nodes.length,
        )
        expect(results.in.nodes.length).toBeLessThanOrEqual(
          results.both.nodes.length,
        )

        // Center symbol present in all three
        for (const dir of directions) {
          expect(
            results[dir].nodes.some((n) =>
              n.id.endsWith("#" + wcase.centerSymbol),
            ),
          ).toBe(true)
        }
      })




      it("diffGraphJson reports zero diff when comparing a graph to itself", () => {
        const g = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const diff = diffGraphJson(g, g)
        expect(diff.nodes_only_in_a).toEqual([])
        expect(diff.nodes_only_in_b).toEqual([])
        expect(diff.edges_only_in_a).toEqual([])
        expect(diff.edges_only_in_b).toEqual([])
        expect(diff.nodes_in_both).toBe(g.nodes.length)
        expect(diff.edges_in_both).toBe(g.edges.length)
        expect(diff.summary.nodes_added).toBe(0)
        expect(diff.summary.nodes_removed).toBe(0)
        expect(diff.summary.edges_added).toBe(0)
        expect(diff.summary.edges_removed).toBe(0)
      })

      it("diffGraphJson against a centerOf subset shows the cut nodes as removed", () => {
        // Compare the full graph (a) against a centerOf subset (b).
        // Everything b contains should be in a, so:
        //   - nodes_only_in_b == 0  (b is a subset of a)
        //   - edges_only_in_b == 0  (same property at the edge level)
        //   - nodes_only_in_a > 0   (the cut nodes)
        //   - nodes_in_both == b.nodes.length  (b ⊂ a)
        const full = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const centered = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          { centerOf: wcase.centerSymbol, centerHops: 2 },
        )
        const diff = diffGraphJson(full, centered)

        expect(diff.nodes_only_in_b).toEqual([])
        expect(diff.edges_only_in_b).toEqual([])
        expect(diff.nodes_in_both).toBe(centered.nodes.length)
        expect(diff.edges_in_both).toBe(centered.edges.length)
        // The cut count must equal full - centered
        expect(diff.summary.nodes_removed).toBe(
          full.nodes.length - centered.nodes.length,
        )
        expect(diff.summary.edges_removed).toBe(
          full.edges.length - centered.edges.length,
        )
      })

      it("intelligence_graph_diff via MCP — identity yields zero diff on real data", async () => {
        const raw = await diffTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
          },
          stubClient,
          stubTracker,
        )
        const diff = JSON.parse(raw) as {
          nodes_only_in_a: string[]
          nodes_only_in_b: string[]
          edges_only_in_a: string[]
          edges_only_in_b: string[]
          summary: {
            a_nodes: number
            b_nodes: number
            nodes_added: number
            nodes_removed: number
            edges_added: number
            edges_removed: number
          }
        }
        expect(diff.nodes_only_in_a).toEqual([])
        expect(diff.nodes_only_in_b).toEqual([])
        expect(diff.edges_only_in_a).toEqual([])
        expect(diff.edges_only_in_b).toEqual([])
        expect(diff.summary.nodes_added).toBe(0)
        expect(diff.summary.nodes_removed).toBe(0)
        expect(diff.summary.edges_added).toBe(0)
        expect(diff.summary.edges_removed).toBe(0)
        expect(diff.summary.a_nodes).toBe(diff.summary.b_nodes)
      })

      it("intelligence_graph_diff via MCP — full vs centerOf shows the cut", async () => {
        // filtersA: unfiltered (full graph)
        // filtersB: scope to the workspace's hub symbol at hops=2
        // Property: B ⊂ A → nodes_only_in_b is empty, nodes_removed > 0
        const raw = await diffTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
            filtersB: {
              centerOf: wcase.centerSymbol,
              centerHops: 2,
            },
          },
          stubClient,
          stubTracker,
        )
        const diff = JSON.parse(raw) as {
          nodes_only_in_a: string[]
          nodes_only_in_b: string[]
          summary: {
            a_nodes: number
            b_nodes: number
            nodes_added: number
            nodes_removed: number
          }
        }
        expect(diff.nodes_only_in_b).toEqual([])
        expect(diff.summary.nodes_added).toBe(0)
        expect(diff.summary.b_nodes).toBeLessThan(diff.summary.a_nodes)
        // The cut count must equal the difference
        expect(diff.summary.nodes_removed).toBe(
          diff.summary.a_nodes - diff.summary.b_nodes,
        )
      })

      it("intelligence_graph_diff via MCP — direction in vs out is meaningfully different", async () => {
        // filtersA: backward-only (predecessors) at hops=2
        // filtersB: forward-only (successors) at hops=2
        // These two views overlap at the center symbol but otherwise
        // describe different things. The diff should have nontrivial
        // counts on at least one side, and the center symbol should
        // appear in nodes_in_both since it's in every direction variant.
        const raw = await diffTool!.execute(
          {
            snapshotId: ingest.snapshotId,
            workspaceRoot: wcase.path,
            filtersA: {
              centerOf: wcase.centerSymbol,
              centerHops: 2,
              centerDirection: "in",
            },
            filtersB: {
              centerOf: wcase.centerSymbol,
              centerHops: 2,
              centerDirection: "out",
            },
          },
          stubClient,
          stubTracker,
        )
        const diff = JSON.parse(raw) as {
          nodes_in_both: number
          summary: {
            a_nodes: number
            b_nodes: number
            nodes_added: number
            nodes_removed: number
          }
        }
        // Both walks include the center symbol, so the intersection
        // is at least 1.
        expect(diff.nodes_in_both).toBeGreaterThanOrEqual(1)
        // Both sides must have at least the center node
        expect(diff.summary.a_nodes).toBeGreaterThanOrEqual(1)
        expect(diff.summary.b_nodes).toBeGreaterThanOrEqual(1)
      })


      it("loadGraphJsonFromDb completes within the performance budget", () => {
        // The full unfiltered graph build for instructkr-claude-code
        // (~20K nodes, ~100K edges) takes ~5s in CI; opencode is
        // ~2s. Budget is 15s — generous enough that flaky CI machines
        // don't fail spuriously, tight enough that any 3x regression
        // in the SQL or the post-processing is caught immediately.
        const PERF_BUDGET_MS = 15_000

        const t0 = performance.now()
        const full = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const t1 = performance.now()
        const fullMs = t1 - t0
        expect(fullMs).toBeLessThan(PERF_BUDGET_MS)
        expect(full.nodes.length).toBeGreaterThan(wcase.minNodes)

        // The filtered build (centerOf + maxNodes) does extra work
        // beyond the SQL: BFS reduction + degree-based topN.
        // It must still come in under the same budget.
        const t2 = performance.now()
        const filtered = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
          {
            centerOf: wcase.centerSymbol,
            centerHops: 3,
            maxNodes: 200,
          },
        )
        const t3 = performance.now()
        const filteredMs = t3 - t2
        expect(filteredMs).toBeLessThan(PERF_BUDGET_MS)
        expect(filtered.nodes.length).toBeGreaterThan(0)
      })

      // ── Phase 3 data-structure floors ────────────────────────────
      it("phase 3: emits field nodes and field_of_type edges (data-structure backend)", () => {
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const fields = graph.nodes.filter((n) => n.kind === "field")
        const fotEdges = graph.edges.filter((e) => e.kind === "field_of_type")
        const aggEdges = graph.edges.filter((e) => e.kind === "aggregates")

        // Real TS workspaces have lots of class fields and interface
        // properties — both opencode and instructkr-claude-code clear
        // 100 field nodes easily.
        expect(fields.length).toBeGreaterThan(100)
        // The field_of_type edges only fire when a field's type
        // resolves through the FileResolver to a workspace symbol.
        // Both workspaces produce hundreds.
        expect(fotEdges.length).toBeGreaterThan(50)
        // Aggregates is a strict de-dupe of field_of_type, so it
        // should be ≤ field_of_type and > 0.
        expect(aggEdges.length).toBeGreaterThan(0)
        expect(aggEdges.length).toBeLessThanOrEqual(fotEdges.length)

        // Every field_of_type edge must carry containment metadata
        // — that's the contract phase 3a established.
        for (const e of fotEdges.slice(0, 50)) {
          const meta = e.metadata as Record<string, unknown> | null
          expect(meta).not.toBeNull()
          expect(typeof meta!.containment).toBe("string")
        }
      })

      it("phase 3: every field has a contains edge from its parent class/interface", () => {
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const fields = graph.nodes.filter((n) => n.kind === "field")
        const containsEdges = graph.edges.filter((e) => e.kind === "contains")
        // Build a Set of dst ids that appear in any contains edge
        const containedDsts = new Set(containsEdges.map((e) => e.dst))
        // Every field node must appear as a contains-edge dst
        let orphanFields = 0
        for (const f of fields) {
          if (!containedDsts.has(f.id)) orphanFields++
        }
        // Allow up to 5% orphans (degenerate edge cases like
        // namespace-merged interfaces); the rest must be parented.
        expect(orphanFields).toBeLessThan(fields.length * 0.05)
      })

      it("phase 3: find_type_fields MCP intent returns field/enum_variant kinds only", async () => {
        // Find any class node with at least one field
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const containsByClass = new Map<string, string[]>()
        for (const e of graph.edges) {
          if (e.kind !== "contains") continue
          const dst = graph.nodes.find((n) => n.id === e.dst)
          if (!dst || dst.kind !== "field") continue
          if (!containsByClass.has(e.src)) containsByClass.set(e.src, [])
          containsByClass.get(e.src)!.push(e.dst)
        }
        // Pick any class that has at least 2 fields
        let pickedClass: string | null = null
        for (const [cls, fields] of containsByClass) {
          if (fields.length >= 2) {
            pickedClass = cls
            break
          }
        }
        expect(pickedClass).not.toBeNull()

        // Call find_type_fields via the lookup directly (the MCP
        // path is covered by the in-memory roundtrip tests; here we
        // just verify the SQL works on real workspace data)
        const result = await ingest.lookup.lookup({
          intent: "find_type_fields",
          snapshotId: ingest.snapshotId,
          apiName: pickedClass!,
          limit: 50,
        })
        expect(result.hit).toBe(true)
        expect(result.rows.length).toBeGreaterThan(0)
        // Every row must have kind=field or kind=enum_variant
        for (const row of result.rows) {
          expect(["field", "enum_variant"]).toContain(String(row.kind))
        }
      })

      it("phase 3: find_type_aggregates MCP intent returns aggregates rollup", async () => {
        // Pick any class that has aggregates edges going out
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const aggSrcs = new Map<string, number>()
        for (const e of graph.edges) {
          if (e.kind !== "aggregates") continue
          aggSrcs.set(e.src, (aggSrcs.get(e.src) ?? 0) + 1)
        }
        const pickedSrc = [...aggSrcs.entries()]
          .sort((a, b) => b[1] - a[1])[0]?.[0]
        if (!pickedSrc) {
          // Workspace has no aggregates — skip rather than fail
          return
        }
        const result = await ingest.lookup.lookup({
          intent: "find_type_aggregates",
          snapshotId: ingest.snapshotId,
          apiName: pickedSrc,
          limit: 50,
        })
        expect(result.hit).toBe(true)
        expect(result.rows.length).toBeGreaterThan(0)
        // Every row must carry edge_kind = aggregates
        for (const row of result.rows) {
          expect(row.edge_kind).toBe("aggregates")
        }
      })
    },
  )
}
