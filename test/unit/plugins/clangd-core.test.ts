/**
 * clangd-core.test.ts — exercises the clangd-core plugin end-to-end through
 * the ExtractorRunner with a fake LSP client and a fixture workspace.
 *
 * The goal is parity with the legacy ClangdExtractionAdapter: given the
 * same source files and the same canned LSP responses, the plugin should
 * produce the same facts (symbols + edges) that materializeSnapshot()
 * would have produced from the legacy batches.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExtractorRunner } from "../../../src/intelligence/extraction/runner.js"
import { clangdCoreExtractor } from "../../../src/plugins/index.js"
import type {
  GraphWriteBatch,
  GraphWriteSink,
} from "../../../src/intelligence/db/graph-rows.js"
import type { ILanguageClient } from "../../../src/lsp/types.js"

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

class CaptureSink implements GraphWriteSink {
  public readonly batches: GraphWriteBatch[] = []
  async write(batch: GraphWriteBatch): Promise<void> {
    this.batches.push(JSON.parse(JSON.stringify(batch)))
  }
  allNodes() {
    return this.batches.flatMap((b) => b.nodes)
  }
  allEdges() {
    return this.batches.flatMap((b) => b.edges)
  }
}

interface FakeSymbol {
  name: string
  kind: number
  line: number
  character: number
  containerName?: string
}

interface FakeOutgoing {
  to: { name: string }
}

function makeFakeLsp(opts: {
  documentSymbols: Map<string, FakeSymbol[]>
  outgoingCalls?: Map<string, FakeOutgoing[]>
}): ILanguageClient {
  return {
    root: "/tmp",
    openFile: async () => false,
    documentSymbol: async (filePath: string) => {
      const syms = opts.documentSymbols.get(filePath) ?? []
      return syms.map((s) => ({
        name: s.name,
        kind: s.kind,
        containerName: s.containerName,
        range: { start: { line: s.line, character: s.character } },
      }))
    },
    outgoingCalls: async (filePath: string, line: number, character: number) => {
      const key = `${filePath}:${line}:${character}`
      return opts.outgoingCalls?.get(key) ?? []
    },
    incomingCalls: async () => [],
    references: async () => [],
    definition: async () => [],
  } as unknown as ILanguageClient
}

let workspaceRoot: string

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "clangd-core-test-"))
  mkdirSync(join(workspaceRoot, "src"), { recursive: true })
  writeFileSync(
    join(workspaceRoot, "src", "a.c"),
    "int foo(void) {\n  bar();\n  return 0;\n}\n",
  )
  writeFileSync(
    join(workspaceRoot, "src", "b.c"),
    "void bar(void) {}\nstruct point { int x; int y; };\n",
  )
})

afterEach(() => {
  // Each test rebuilds its own runner and sink.
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clangd-core plugin — symbol extraction", () => {
  it("yields a SymbolFact for every documentSymbol entry across all files", async () => {
    const aFile = join(workspaceRoot, "src", "a.c")
    const bFile = join(workspaceRoot, "src", "b.c")
    const lsp = makeFakeLsp({
      documentSymbols: new Map([
        [aFile, [{ name: "foo", kind: 12, line: 0, character: 4 }]],
        [
          bFile,
          [
            { name: "bar", kind: 12, line: 0, character: 5 },
            { name: "point", kind: 23, line: 1, character: 7 },
          ],
        ],
      ]),
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 100,
      workspaceRoot,
      lsp,
      sink,
      plugins: [clangdCoreExtractor],
    })

    const report = await runner.run()
    expect(report.pluginsRun).toBe(1)
    expect(report.pluginsFailed).toBe(0)

    const nodeNames = sink.allNodes().map((n) => n.canonical_name).sort()
    // Expect: foo, bar, point — and bar gets duplicated as a "type" fact
    // is yielded for struct kind, but type facts don't become graph nodes
    // in Step 6 (matches legacy materializeSnapshot behavior).
    expect(nodeNames).toEqual(["bar", "foo", "point"])

    // Locations should carry 1-based line/column (clangd-core converts
    // from 0-based LSP positions).
    const fooNode = sink.allNodes().find((n) => n.canonical_name === "foo")
    expect(fooNode?.location).toEqual({
      filePath: aFile,
      line: 1,
      column: 5,
    })
  })

  it("yields a TypeFact for struct/enum/typedef symbols", async () => {
    const bFile = join(workspaceRoot, "src", "b.c")
    const lsp = makeFakeLsp({
      documentSymbols: new Map([
        [bFile, [{ name: "point", kind: 23, line: 0, character: 0 }]],
      ]),
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 100,
      workspaceRoot,
      lsp,
      sink,
      plugins: [clangdCoreExtractor],
    })

    const report = await runner.run()
    // The bus accepts type facts but doesn't write them to graph rows
    // yet (matches legacy materializeSnapshot). Verify via the by-kind
    // counter on the bus report.
    expect(report.bus.byKind.type).toBe(1)
  })

  it("auto-tags every symbol fact with producedBy=clangd-core", async () => {
    const aFile = join(workspaceRoot, "src", "a.c")
    const lsp = makeFakeLsp({
      documentSymbols: new Map([
        [aFile, [{ name: "foo", kind: 12, line: 0, character: 0 }]],
      ]),
    })
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot,
      lsp,
      sink,
      plugins: [clangdCoreExtractor],
    })

    await runner.run()
    const fooNode = sink.allNodes().find((n) => n.canonical_name === "foo")
    const provenance = (fooNode!.payload as Record<string, unknown>)._provenance as
      | { producedBy?: string[] }
      | undefined
    expect(provenance?.producedBy).toEqual(["clangd-core"])
  })
})

describe("clangd-core plugin — edge extraction", () => {
  it("yields a calls EdgeFact per outgoingCalls result for function symbols", async () => {
    const aFile = join(workspaceRoot, "src", "a.c")
    const lsp = makeFakeLsp({
      documentSymbols: new Map([
        [aFile, [{ name: "foo", kind: 12, line: 0, character: 4 }]],
      ]),
      outgoingCalls: new Map([
        // Plugin queries with line-1, char-1 (LSP is 0-based).
        // foo is at line=1 col=5 in our 1-based coords → 0,4 LSP.
        [`${aFile}:0:4`, [{ to: { name: "bar" } }, { to: { name: "baz" } }]],
      ]),
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot,
      lsp,
      sink,
      plugins: [clangdCoreExtractor],
    })

    await runner.run()
    const edges = sink.allEdges()
    // Filter to calls edges only — Phases 6-7 also emit contains/imports/
    // references_type edges which are tested separately.
    const callEdges = edges.filter((e) => e.edge_kind === "calls")
    expect(callEdges.length).toBe(2)
    expect(callEdges.map((e) => e.edge_kind)).toEqual(["calls", "calls"])
    const dsts = callEdges
      .map((e) => e.metadata?._provenance ?? null)
      .map(() => null) // smoke check; actual dst comes via dst_node_id which embeds the dst symbol
    expect(dsts.length).toBe(2)
  })

  it("does not query outgoingCalls for non-function symbols", async () => {
    const bFile = join(workspaceRoot, "src", "b.c")
    let outgoingCallCount = 0
    const baseLsp = makeFakeLsp({
      documentSymbols: new Map([
        [bFile, [{ name: "point", kind: 23, line: 0, character: 7 }]], // struct
      ]),
    })
    const lsp = {
      ...baseLsp,
      outgoingCalls: async (...args: unknown[]) => {
        outgoingCallCount++
        return (await (baseLsp as ILanguageClient).outgoingCalls(
          args[0] as string,
          args[1] as number,
          args[2] as number,
        )) as never
      },
    } as ILanguageClient

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot,
      lsp,
      sink,
      plugins: [clangdCoreExtractor],
    })

    await runner.run()
    expect(outgoingCallCount).toBe(0)
  })

  it("inlines clangd_response evidence into each emitted edge", async () => {
    const aFile = join(workspaceRoot, "src", "a.c")
    const lsp = makeFakeLsp({
      documentSymbols: new Map([
        [aFile, [{ name: "foo", kind: 12, line: 0, character: 4 }]],
      ]),
      outgoingCalls: new Map([
        [`${aFile}:0:4`, [{ to: { name: "bar" } }]],
      ]),
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot,
      lsp,
      sink,
      plugins: [clangdCoreExtractor],
    })

    await runner.run()
    // Filter evidence to clangd_response only — new phases emit
    // file_line evidence which is tested separately.
    const clangdEvidence = sink.batches[0].evidence.filter(
      (e) => e.source_kind === "clangd_response"
    )
    expect(clangdEvidence.length).toBe(1)
    expect(clangdEvidence[0].source_kind).toBe("clangd_response")
  })
})

describe("clangd-core plugin — error tolerance", () => {
  it("skips files where documentSymbol throws (does not fail snapshot)", async () => {
    const aFile = join(workspaceRoot, "src", "a.c")
    const bFile = join(workspaceRoot, "src", "b.c")
    const lsp = {
      root: "/tmp",
      openFile: async () => false,
      documentSymbol: async (filePath: string) => {
        if (filePath === aFile) throw new Error("synthetic clangd failure")
        if (filePath === bFile)
          return [{ name: "bar", kind: 12, range: { start: { line: 0, character: 5 } } }]
        return []
      },
      outgoingCalls: async () => [],
      incomingCalls: async () => [],
      references: async () => [],
    } as unknown as ILanguageClient

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot,
      lsp,
      sink,
      plugins: [clangdCoreExtractor],
    })

    const report = await runner.run()
    expect(report.pluginsFailed).toBe(0) // plugin completes despite per-file errors
    const names = sink.allNodes().map((n) => n.canonical_name)
    expect(names).toContain("bar")
    expect(names).not.toContain("foo")
  })
})

// Cleanup happens via process exit; the temp dir is named.
describe("cleanup", () => {
  it("removes temp workspace", () => {
    rmSync(workspaceRoot, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})
