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
    },
  )
}
