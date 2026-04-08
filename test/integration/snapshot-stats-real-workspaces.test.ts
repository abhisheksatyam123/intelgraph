/**
 * test/integration/snapshot-stats-real-workspaces.test.ts
 *
 * End-to-end smoke tests for the visualization data path. Exercises
 * three layers against the real TypeScript workspaces:
 *
 *   1. `loadGraphJsonFromDb` (the pure SQL→GraphJson reader)
 *   2. `graphJsonToHtml` (the self-contained --html viewer)
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
 * data surface* — graph-export + graphJsonToHtml + intelligence_graph
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
import { loadGraphJsonFromDb } from "../../src/intelligence/db/sqlite/graph-export.js"
import { ExtractorRunner } from "../../src/intelligence/extraction/runner.js"
import { tsCoreExtractor } from "../../src/plugins/index.js"
import {
  graphJsonToHtml,
  VIEWER_PURE_JS,
} from "../../src/bin/snapshot-stats.js"
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
const stubClient = {} as Parameters<typeof graphTool.execute>[1]
const stubTracker = {} as Parameters<typeof graphTool.execute>[2]

// Eval the VIEWER_PURE_JS block once and capture its function
// references. Same accessor pattern as the unit tests, but reused
// here so we can run the BFS / shortestPath / resolveSymbol against
// real workspace adjacency below.
type ViewerFns = {
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
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const viewerFns = new Function(`
  ${VIEWER_PURE_JS}
  return { neighborhood, shortestPath, resolveSymbol };
`)() as ViewerFns

// Build the directed adjacency the inlined viewer builds at init,
// from a GraphJson. Used by the real-workspace pure-function tests.
function buildAdjacency(graph: {
  nodes: Array<{ id: string }>
  edges: Array<{ src: string; dst: string }>
}): {
  succ: Map<string, Set<string>>
  pred: Map<string, Set<string>>
  ids: Set<string>
} {
  const succ = new Map<string, Set<string>>()
  const pred = new Map<string, Set<string>>()
  const ids = new Set<string>()
  for (const n of graph.nodes) {
    succ.set(n.id, new Set())
    pred.set(n.id, new Set())
    ids.add(n.id)
  }
  for (const e of graph.edges) {
    succ.get(e.src)?.add(e.dst)
    pred.get(e.dst)?.add(e.src)
  }
  return { succ, pred, ids }
}

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

      it("graphJsonToHtml renders a self-contained, parseable viewer", () => {
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const html = graphJsonToHtml(graph)

        expect(html.startsWith("<!doctype html>")).toBe(true)
        expect(html).toContain("</html>")
        expect(html).toContain("d3@7.9.0")

        // Full feature set survives a real workspace's canonical names
        expect(html).toContain("ARROW_KINDS")
        expect(html).toContain("function neighborhood")
        expect(html).toContain("cycleNodes")
        expect(html).toContain("dirHueByNode")
        expect(html).toContain("function saveHashState")

        // Inlined script must parse — catches template-literal corruption
        const start = html.indexOf("<script>")
        const end = html.indexOf("</script>", start)
        expect(start).toBeGreaterThan(0)
        expect(end).toBeGreaterThan(start)
        const inlined = html.substring(start + "<script>".length, end)
        expect(() =>
          new Function("document", "window", "d3", inlined),
        ).not.toThrow()
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

      it("VIEWER_PURE_JS neighborhood BFS works on real workspace adjacency", () => {
        // Build the real adjacency the inlined viewer would see
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const adj = buildAdjacency(graph)

        // Resolve the workspace's hub symbol via the pure resolver
        const center = viewerFns.resolveSymbol(wcase.centerSymbol, adj.ids)
        expect(center).not.toBeNull()
        expect(adj.ids.has(center!)).toBe(true)

        // Run undirected BFS from the hub at depth 2 — must be
        // nontrivial (>1 node) and contain the center
        const undirected = viewerFns.neighborhood(
          center!,
          2,
          "both",
          adj.succ,
          adj.pred,
        )
        expect(undirected.size).toBeGreaterThan(1)
        expect(undirected.has(center!)).toBe(true)

        // The directional walks must be subsets of the undirected
        // walk — same invariant as the server-side centerDirection
        // tests, but verified inside the viewer's own pure JS.
        const outOnly = viewerFns.neighborhood(
          center!,
          2,
          "out",
          adj.succ,
          adj.pred,
        )
        const inOnly = viewerFns.neighborhood(
          center!,
          2,
          "in",
          adj.succ,
          adj.pred,
        )
        for (const id of outOnly) expect(undirected.has(id)).toBe(true)
        for (const id of inOnly) expect(undirected.has(id)).toBe(true)
      })

      it("VIEWER_PURE_JS shortestPath finds a real call chain", () => {
        // Find any directed src→dst pair from the real graph and
        // assert the BFS actually walks it. This is the property
        // the HTML viewer's "Find path" inputs rely on.
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const adj = buildAdjacency(graph)

        // Pick a source with at least one outgoing edge — almost
        // every function in either workspace qualifies.
        let src: string | null = null
        let dst: string | null = null
        for (const [id, outs] of adj.succ) {
          if (outs.size > 0) {
            src = id
            dst = [...outs][0]
            break
          }
        }
        expect(src).not.toBeNull()
        expect(dst).not.toBeNull()

        // 1-hop path: src → dst
        const trail = viewerFns.shortestPath(src!, dst!, adj.succ, adj.ids)
        expect(trail).not.toBeNull()
        expect(trail![0]).toBe(src)
        expect(trail![trail!.length - 1]).toBe(dst)
        expect(trail!.length).toBe(2)
      })

      it("VIEWER_PURE_JS resolveSymbol handles real canonical names", () => {
        // The forgiving resolver must work on real workspace symbols.
        const graph = loadGraphJsonFromDb(
          ingest.client.raw,
          ingest.snapshotId,
          wcase.path,
        )
        const adj = buildAdjacency(graph)

        // Suffix-after-# should resolve the bare local name
        const found = viewerFns.resolveSymbol(wcase.centerSymbol, adj.ids)
        expect(found).not.toBeNull()
        expect(found!.endsWith("#" + wcase.centerSymbol)).toBe(true)

        // Exact passthrough must work on the resolved id
        expect(viewerFns.resolveSymbol(found!, adj.ids)).toBe(found)

        // Substring fallback must find at least *something* that
        // contains a unique-ish substring from the workspace path
        const probe = wcase.expectedSubstring
        const sub = viewerFns.resolveSymbol(probe, adj.ids)
        expect(sub).not.toBeNull()
        expect(sub!.includes(probe)).toBe(true)
      })
    },
  )
}
