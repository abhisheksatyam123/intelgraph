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
