/**
 * context.test.ts — exercises ExtractionContextImpl fact builders.
 *
 * The interesting behavior in the context implementation is that every
 * fact builder auto-tags producedBy with the extractor name. The services
 * are passed in by the runner; this test uses lightweight mocks since the
 * builders themselves don't touch the services.
 */

import { describe, expect, it } from "vitest"
import {
  ExtractionContextImpl,
  InMemoryKeyedCache,
  InMemoryPluginMetrics,
  type LspService,
  type RipgrepService,
  type TreeSitterService,
  type WorkspaceService,
} from "../../../src/intelligence/extraction/context.js"

// ---------------------------------------------------------------------------
// Service stubs (the builders never call them, so empty objects suffice)
// ---------------------------------------------------------------------------

const stubLsp = {} as unknown as LspService
const stubTreesitter = {} as unknown as TreeSitterService
const stubRipgrep = {} as unknown as RipgrepService
const stubWorkspace = {} as unknown as WorkspaceService

function makeCtx(extractorName = "test-extractor"): ExtractionContextImpl {
  return new ExtractionContextImpl({
    snapshotId: 42,
    workspaceRoot: "/tmp/ws",
    extractorName,
    lsp: stubLsp,
    treesitter: stubTreesitter,
    ripgrep: stubRipgrep,
    workspace: stubWorkspace,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExtractionContextImpl — identity", () => {
  it("exposes snapshotId, workspaceRoot, extractorName from constructor", () => {
    const ctx = new ExtractionContextImpl({
      snapshotId: 7,
      workspaceRoot: "/x",
      extractorName: "alpha",
      lsp: stubLsp,
      treesitter: stubTreesitter,
      ripgrep: stubRipgrep,
      workspace: stubWorkspace,
    })
    expect(ctx.snapshotId).toBe(7)
    expect(ctx.workspaceRoot).toBe("/x")
    expect(ctx.extractorName).toBe("alpha")
  })
})

describe("ExtractionContextImpl — fact builders", () => {
  it("ctx.symbol() builds a SymbolFact with auto-provenance", () => {
    const ctx = makeCtx("alpha")
    const fact = ctx.symbol({
      payload: { name: "foo", kind: "function" },
    })
    expect(fact.kind).toBe("symbol")
    expect(fact.payload.name).toBe("foo")
    expect(fact.producedBy).toEqual(["alpha"])
    expect(fact.confidence).toBe(1.0)
  })

  it("ctx.symbol() respects custom confidence", () => {
    const ctx = makeCtx()
    const fact = ctx.symbol({
      payload: { name: "foo", kind: "function" },
      confidence: 0.7,
    })
    expect(fact.confidence).toBe(0.7)
  })

  it("ctx.edge() builds an EdgeFact with auto-provenance", () => {
    const ctx = makeCtx("beta")
    const fact = ctx.edge({
      payload: {
        edgeKind: "calls",
        srcSymbolName: "a",
        dstSymbolName: "b",
        confidence: 0.9,
        derivation: "clangd",
      },
    })
    expect(fact.kind).toBe("edge")
    expect(fact.payload.edgeKind).toBe("calls")
    expect(fact.producedBy).toEqual(["beta"])
    // edge envelope confidence falls through from the payload when not
    // explicitly overridden — keeps clangd-derived edges' confidence
    // visible at both layers.
    expect(fact.confidence).toBe(0.9)
  })

  it("ctx.type() builds a TypeFact", () => {
    const ctx = makeCtx()
    const fact = ctx.type({
      payload: { kind: "struct", spelling: "wlan_vdev_t" },
    })
    expect(fact.kind).toBe("type")
    expect(fact.payload.spelling).toBe("wlan_vdev_t")
  })

  it("ctx.aggregateField() builds an AggregateFieldFact", () => {
    const ctx = makeCtx()
    const fact = ctx.aggregateField({
      payload: {
        aggregateSymbolName: "wlan_vdev_t",
        name: "state",
        ordinal: 0,
        typeSpelling: "uint32_t",
      },
    })
    expect(fact.kind).toBe("aggregate-field")
  })

  it("ctx.evidence() builds an EvidenceFact attached to another fact", () => {
    const ctx = makeCtx()
    const fact = ctx.evidence({
      payload: {
        sourceKind: "clangd_response",
        location: { filePath: "/x.c", line: 10 },
      },
      attachedTo: { factKind: "edge", canonicalKey: "edge|calls|a->b|" },
    })
    expect(fact.kind).toBe("evidence")
    expect(fact.attachedTo.canonicalKey).toBe("edge|calls|a->b|")
  })

  it("ctx.observation() builds an ObservationFact", () => {
    const ctx = makeCtx()
    const fact = ctx.observation({
      payload: {
        observationKind: "runtime_callsite_seen",
        subject: "wlan_handler",
        observedAt: "2026-04-07T00:00:00Z",
      },
    })
    expect(fact.kind).toBe("observation")
    expect(fact.payload.observationKind).toBe("runtime_callsite_seen")
  })

  it("ctx.location() builds a SourceLocation", () => {
    const ctx = makeCtx()
    const loc = ctx.location("/a.c", 10, 5)
    expect(loc).toEqual({ filePath: "/a.c", line: 10, column: 5 })
  })
})

describe("ExtractionContextImpl — auto-provenance is per-instance", () => {
  it("two ctx instances tag facts with different extractor names", () => {
    const ctxA = makeCtx("alpha")
    const ctxB = makeCtx("beta")
    const factA = ctxA.symbol({ payload: { name: "x", kind: "function" } })
    const factB = ctxB.symbol({ payload: { name: "x", kind: "function" } })
    expect(factA.producedBy).toEqual(["alpha"])
    expect(factB.producedBy).toEqual(["beta"])
  })
})

describe("InMemoryKeyedCache", () => {
  it("get returns undefined for unset keys", () => {
    const c = new InMemoryKeyedCache()
    expect(c.get("missing")).toBeUndefined()
  })

  it("set/get round-trips values", () => {
    const c = new InMemoryKeyedCache()
    c.set("k", { v: 1 })
    expect(c.get<{ v: number }>("k")).toEqual({ v: 1 })
  })

  it("getOrCompute caches the computed value", async () => {
    const c = new InMemoryKeyedCache()
    let calls = 0
    const compute = () => {
      calls++
      return Promise.resolve(123)
    }
    expect(await c.getOrCompute("k", compute)).toBe(123)
    expect(await c.getOrCompute("k", compute)).toBe(123)
    expect(calls).toBe(1)
  })
})

describe("InMemoryPluginMetrics", () => {
  it("count and timing accumulate, snapshot drains them", () => {
    const m = new InMemoryPluginMetrics()
    m.count("files-walked", 5)
    m.count("files-walked", 3)
    m.timing("lsp.documentSymbol", 100)
    m.timing("lsp.documentSymbol", 50)

    const snap = m.snapshot()
    expect(snap.counters["files-walked"]).toBe(8)
    expect(snap.timings["lsp.documentSymbol"]).toEqual({
      count: 2,
      totalMs: 150,
      avgMs: 75,
    })
  })
})
