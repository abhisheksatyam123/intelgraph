/**
 * runner.test.ts — exercises ExtractorRunner orchestration.
 *
 * Tests use a CaptureSink for the FactBus and a stub ILanguageClient that
 * returns nothing (the test plugins don't call any LSP methods).
 */

import { describe, expect, it } from "vitest"
import { ExtractorRunner } from "../../../src/intelligence/extraction/runner.js"
import { defineExtractor } from "../../../src/intelligence/extraction/contract.js"
import type {
  ExtractionContext,
} from "../../../src/intelligence/extraction/context.js"
import type { Fact } from "../../../src/intelligence/extraction/facts.js"
import type {
  GraphWriteBatch,
  GraphWriteSink,
} from "../../../src/intelligence/db/graph-rows.js"
import type { ILanguageClient } from "../../../src/lsp/types.js"

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class CaptureSink implements GraphWriteSink {
  public readonly batches: GraphWriteBatch[] = []
  async write(batch: GraphWriteBatch): Promise<void> {
    this.batches.push(JSON.parse(JSON.stringify(batch)))
  }
  totalNodes(): number {
    return this.batches.reduce((acc, b) => acc + b.nodes.length, 0)
  }
  totalEdges(): number {
    return this.batches.reduce((acc, b) => acc + b.edges.length, 0)
  }
}

const stubLsp = {
  root: "/tmp/ws",
  // Method stubs the runner's services may call (we don't actually call
  // them in these tests, so they can throw if invoked).
  openFile: async () => false,
  documentSymbol: async () => [],
  references: async () => [],
  definition: async () => [],
} as unknown as ILanguageClient

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExtractorRunner — happy path", () => {
  it("runs a single plugin and writes its facts", async () => {
    const plugin = defineExtractor({
      metadata: {
        name: "test-symbols",
        version: "0.1.0",
        capabilities: ["symbols"],
      },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "foo", kind: "function" } })
        yield ctx.symbol({ payload: { name: "bar", kind: "function" } })
      },
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [plugin],
    })

    const report = await runner.run()

    expect(report.pluginsRun).toBe(1)
    expect(report.pluginsFailed).toBe(0)
    expect(report.pluginsSkipped).toBe(0)
    expect(report.perPlugin[0]?.factsYielded).toBe(2)
    expect(sink.totalNodes()).toBe(2)
    expect(sink.batches[0].nodes[0].canonical_name).toBe("foo")
  })

  it("runs multiple plugins in parallel", async () => {
    const symbolsPlugin = defineExtractor({
      metadata: { name: "symbols", version: "0.1.0", capabilities: ["symbols"] },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "foo", kind: "function" } })
      },
    })
    const edgesPlugin = defineExtractor({
      metadata: { name: "edges", version: "0.1.0", capabilities: ["direct-calls"] },
      async *extract(ctx) {
        yield ctx.edge({
          payload: {
            edgeKind: "calls",
            srcSymbolName: "foo",
            dstSymbolName: "bar",
            confidence: 1.0,
            derivation: "clangd",
          },
        })
      },
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [symbolsPlugin, edgesPlugin],
    })

    const report = await runner.run()
    expect(report.pluginsRun).toBe(2)
    expect(sink.totalNodes()).toBe(1)
    expect(sink.totalEdges()).toBe(1)
  })

  it("merges facts from multiple plugins via dedup", async () => {
    // Both plugins emit the same symbol — bus should dedup and merge
    // their producedBy lists.
    const a = defineExtractor({
      metadata: { name: "alpha", version: "0.1.0", capabilities: ["symbols"] },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "shared", kind: "function" } })
      },
    })
    const b = defineExtractor({
      metadata: { name: "beta", version: "0.1.0", capabilities: ["symbols"] },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "shared", kind: "function" } })
      },
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [a, b],
    })

    const report = await runner.run()
    expect(report.bus.totalEmits).toBe(2)
    expect(report.bus.totalAccepted).toBe(1)
    expect(sink.totalNodes()).toBe(1)

    const node = sink.batches[0].nodes[0]
    const provenance = (node.payload as Record<string, unknown>)._provenance as
      | { producedBy?: string[] }
      | undefined
    expect(provenance?.producedBy?.sort()).toEqual(["alpha", "beta"])
  })
})

describe("ExtractorRunner — error isolation", () => {
  it("a plugin throwing does not abort the snapshot", async () => {
    const goodPlugin = defineExtractor({
      metadata: { name: "good", version: "0.1.0", capabilities: ["symbols"] },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "ok", kind: "function" } })
      },
    })
    const badPlugin = defineExtractor({
      metadata: { name: "bad", version: "0.1.0", capabilities: ["symbols"] },
      async *extract(_ctx: ExtractionContext): AsyncIterable<Fact> {
        throw new Error("synthetic plugin failure")
      },
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [goodPlugin, badPlugin],
    })

    const report = await runner.run()
    expect(report.pluginsRun).toBe(1)
    expect(report.pluginsFailed).toBe(1)
    expect(sink.totalNodes()).toBe(1) // good plugin's fact still flushed

    const failed = report.perPlugin.find((p) => p.name === "bad")
    expect(failed?.errorMessage).toMatch(/synthetic plugin failure/)
  })

  it("partial yields before throw are still flushed", async () => {
    const partial = defineExtractor({
      metadata: { name: "partial", version: "0.1.0", capabilities: ["symbols"] },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "first", kind: "function" } })
        yield ctx.symbol({ payload: { name: "second", kind: "function" } })
        throw new Error("after-yield failure")
      },
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [partial],
    })

    const report = await runner.run()
    expect(report.pluginsFailed).toBe(1)
    expect(report.perPlugin[0]?.factsYielded).toBe(2)
    expect(sink.totalNodes()).toBe(2)
  })
})

describe("ExtractorRunner — appliesTo filtering", () => {
  it("skips plugins whose appliesTo returns false", async () => {
    const skipped = defineExtractor({
      metadata: {
        name: "skipped",
        version: "0.1.0",
        capabilities: ["symbols"],
        appliesTo: () => false,
      },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "should-not-appear", kind: "function" } })
      },
    })
    const ran = defineExtractor({
      metadata: {
        name: "ran",
        version: "0.1.0",
        capabilities: ["symbols"],
        appliesTo: () => true,
      },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "yes", kind: "function" } })
      },
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [skipped, ran],
    })

    const report = await runner.run()
    expect(report.pluginsRun).toBe(1)
    expect(report.pluginsSkipped).toBe(1)
    expect(sink.totalNodes()).toBe(1)
    expect(sink.batches[0].nodes[0].canonical_name).toBe("yes")
  })

  it("treats appliesTo throwing as skipped with a warning", async () => {
    const broken = defineExtractor({
      metadata: {
        name: "broken-applies",
        version: "0.1.0",
        capabilities: ["symbols"],
        appliesTo: () => {
          throw new Error("oops")
        },
      },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "x", kind: "function" } })
      },
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [broken],
    })

    const report = await runner.run()
    expect(report.pluginsSkipped).toBe(1)
    expect(report.warnings.some((w) => /broken-applies/.test(w))).toBe(true)
  })
})

describe("ExtractorRunner — empty input", () => {
  it("running zero plugins yields an empty but well-formed report", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [],
    })

    const report = await runner.run()
    expect(report.pluginsRun).toBe(0)
    expect(report.pluginsFailed).toBe(0)
    expect(report.pluginsSkipped).toBe(0)
    expect(report.perPlugin).toEqual([])
    expect(sink.batches.length).toBe(0)
    expect(report.bus.totalAccepted).toBe(0)
  })
})

describe("ExtractorRunner — duplicate plugin names emit a warning", () => {
  it("warns when two plugins share the same metadata.name", async () => {
    const a = defineExtractor({
      metadata: { name: "dupe", version: "0.1.0", capabilities: ["symbols"] },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "x", kind: "function" } })
      },
    })
    const b = defineExtractor({
      metadata: { name: "dupe", version: "0.2.0", capabilities: ["symbols"] },
      async *extract(ctx) {
        yield ctx.symbol({ payload: { name: "y", kind: "function" } })
      },
    })

    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: "/tmp/ws",
      lsp: stubLsp,
      sink,
      plugins: [a, b],
    })

    const report = await runner.run()
    expect(report.warnings.some((w) => /duplicate plugin name/.test(w))).toBe(true)
    // Both still run.
    expect(report.pluginsRun).toBe(2)
  })
})
