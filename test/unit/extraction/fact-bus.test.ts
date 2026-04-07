/**
 * fact-bus.test.ts — exercises FactBus dedup, provenance, validation,
 * batching, and flush behavior.
 *
 * Uses an in-memory GraphWriteSink that captures every batch instead of
 * talking to Neo4j.
 */

import { describe, expect, it } from "vitest"
import {
  FactBus,
  type FactBusReport,
} from "../../../src/intelligence/extraction/fact-bus.js"
import {
  type EdgeFact,
  type Fact,
  type SymbolFact,
  FactValidationError,
} from "../../../src/intelligence/extraction/facts.js"
import type {
  GraphWriteBatch,
  GraphWriteSink,
} from "../../../src/intelligence/db/graph-rows.js"

// ---------------------------------------------------------------------------
// Test sink — captures every batch handed to write()
// ---------------------------------------------------------------------------

class CaptureSink implements GraphWriteSink {
  public readonly batches: GraphWriteBatch[] = []
  async write(batch: GraphWriteBatch): Promise<void> {
    // Deep clone so subsequent mutations to the bus's internal state don't
    // affect what we've captured.
    this.batches.push(JSON.parse(JSON.stringify(batch)))
  }
  /** Total nodes across all flushed batches. */
  totalNodes(): number {
    return this.batches.reduce((acc, b) => acc + b.nodes.length, 0)
  }
  /** Total edges across all flushed batches. */
  totalEdges(): number {
    return this.batches.reduce((acc, b) => acc + b.edges.length, 0)
  }
}

// ---------------------------------------------------------------------------
// Fact builders for tests
// ---------------------------------------------------------------------------

function symbolFact(opts: {
  name: string
  kind?: SymbolFact["payload"]["kind"]
  filePath?: string
  line?: number
  producedBy?: string[]
  confidence?: number
}): SymbolFact {
  return {
    kind: "symbol",
    payload: {
      name: opts.name,
      kind: opts.kind ?? "function",
      location: opts.filePath
        ? { filePath: opts.filePath, line: opts.line ?? 1 }
        : undefined,
    },
    producedBy: opts.producedBy ?? ["test-extractor"],
    confidence: opts.confidence ?? 1.0,
  }
}

function edgeFact(opts: {
  edgeKind?: EdgeFact["payload"]["edgeKind"]
  src: string
  dst: string
  producedBy?: string[]
  confidence?: number
  derivation?: EdgeFact["payload"]["derivation"]
}): EdgeFact {
  return {
    kind: "edge",
    payload: {
      edgeKind: opts.edgeKind ?? "calls",
      srcSymbolName: opts.src,
      dstSymbolName: opts.dst,
      confidence: opts.confidence ?? 1.0,
      derivation: opts.derivation ?? "clangd",
    },
    producedBy: opts.producedBy ?? ["test-extractor"],
    confidence: opts.confidence ?? 1.0,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FactBus — basic emit and flush", () => {
  it("accepts a single symbol fact and flushes it on close", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(symbolFact({ name: "foo" }))
    expect(sink.batches.length).toBe(0) // not flushed yet

    await bus.close()
    expect(sink.batches.length).toBe(1)
    expect(sink.totalNodes()).toBe(1)
    expect(sink.batches[0].nodes[0].canonical_name).toBe("foo")
  })

  it("accepts an edge fact and converts it to a graph edge row", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(edgeFact({ src: "caller", dst: "callee" }))
    await bus.close()

    expect(sink.totalEdges()).toBe(1)
    expect(sink.batches[0].edges[0].edge_kind).toBe("calls")
  })

  it("close() is idempotent", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(symbolFact({ name: "foo" }))
    await bus.close()
    await bus.close()

    expect(sink.batches.length).toBe(1)
  })

  it("emit() throws after close()", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })
    await bus.close()

    await expect(bus.emit(symbolFact({ name: "foo" }))).rejects.toThrow(
      /closed bus/,
    )
  })

  it("flush() on empty buffer is a no-op", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.flush()
    expect(sink.batches.length).toBe(0)
  })
})

describe("FactBus — deduplication", () => {
  it("dedupes symbol facts with the same canonical key", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(
      symbolFact({ name: "foo", filePath: "/a.c", line: 10, producedBy: ["a"] }),
    )
    await bus.emit(
      symbolFact({ name: "foo", filePath: "/a.c", line: 10, producedBy: ["b"] }),
    )
    await bus.close()

    expect(sink.totalNodes()).toBe(1)

    const report = bus.report()
    expect(report.totalEmits).toBe(2)
    expect(report.totalAccepted).toBe(1)
    expect(report.byKind.symbol).toBe(1)
  })

  it("does NOT dedupe symbols with the same name but different locations", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(symbolFact({ name: "foo", filePath: "/a.c", line: 10 }))
    await bus.emit(symbolFact({ name: "foo", filePath: "/b.c", line: 10 }))
    await bus.close()

    expect(sink.totalNodes()).toBe(2)
  })

  it("dedupes edge facts with the same (kind, src, dst, location)", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(edgeFact({ src: "a", dst: "b", producedBy: ["x"] }))
    await bus.emit(edgeFact({ src: "a", dst: "b", producedBy: ["y"] }))
    await bus.close()

    expect(sink.totalEdges()).toBe(1)
    expect(bus.report().totalAccepted).toBe(1)
  })

  it("does NOT dedupe edges with different edge kinds", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(edgeFact({ edgeKind: "calls", src: "a", dst: "b" }))
    await bus.emit(edgeFact({ edgeKind: "registers_callback", src: "a", dst: "b" }))
    await bus.close()

    expect(sink.totalEdges()).toBe(2)
  })
})

describe("FactBus — provenance and confidence merging", () => {
  it("merges producedBy on dedup", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(symbolFact({ name: "foo", producedBy: ["alpha"] }))
    await bus.emit(symbolFact({ name: "foo", producedBy: ["beta"] }))
    await bus.emit(symbolFact({ name: "foo", producedBy: ["alpha"] }))
    await bus.close()

    const node = sink.batches[0].nodes[0]
    const provenance = (node.payload as Record<string, unknown>)._provenance as
      | { producedBy?: string[] }
      | undefined
    expect(provenance).toBeDefined()
    expect(provenance!.producedBy).toEqual(expect.arrayContaining(["alpha", "beta"]))
    expect(provenance!.producedBy!.length).toBe(2) // deduped — alpha not double
  })

  it("keeps the higher confidence on merge", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(symbolFact({ name: "foo", producedBy: ["a"], confidence: 0.4 }))
    await bus.emit(symbolFact({ name: "foo", producedBy: ["b"], confidence: 0.9 }))
    await bus.emit(symbolFact({ name: "foo", producedBy: ["c"], confidence: 0.6 }))
    await bus.close()

    const node = sink.batches[0].nodes[0]
    const provenance = (node.payload as Record<string, unknown>)._provenance as {
      busConfidence: number
    }
    expect(provenance.busConfidence).toBeCloseTo(0.9, 5)
  })

  it("counts per-extractor", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(symbolFact({ name: "a", producedBy: ["alpha"] }))
    await bus.emit(symbolFact({ name: "b", producedBy: ["beta"] }))
    await bus.emit(symbolFact({ name: "c", producedBy: ["alpha"] }))
    await bus.close()

    const report = bus.report()
    expect(report.byExtractor.alpha).toBe(2)
    expect(report.byExtractor.beta).toBe(1)
  })
})

describe("FactBus — validation", () => {
  it("rejects facts missing required producedBy", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    const bad: SymbolFact = {
      kind: "symbol",
      payload: { name: "foo", kind: "function" },
      producedBy: [],
      confidence: 1,
    }

    await expect(bus.emit(bad)).rejects.toThrow(FactValidationError)
  })

  it("rejects facts with confidence out of range", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await expect(
      bus.emit(symbolFact({ name: "foo", confidence: 1.5 })),
    ).rejects.toThrow(/confidence/)

    await expect(
      bus.emit(symbolFact({ name: "foo", confidence: -0.1 })),
    ).rejects.toThrow(/confidence/)
  })

  it("rejects symbol facts missing the name", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    const bad: SymbolFact = {
      kind: "symbol",
      payload: { name: "", kind: "function" },
      producedBy: ["x"],
      confidence: 1,
    }

    await expect(bus.emit(bad)).rejects.toThrow(/name/)
  })

  it("rejects edge facts missing both src and dst", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    const bad: EdgeFact = {
      kind: "edge",
      payload: {
        edgeKind: "calls",
        confidence: 1,
        derivation: "clangd",
      },
      producedBy: ["x"],
      confidence: 1,
    }

    await expect(bus.emit(bad)).rejects.toThrow(/srcSymbolName or dstSymbolName/)
  })
})

describe("FactBus — batching", () => {
  it("auto-flushes when buffer reaches threshold", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink, flushThreshold: 3 })

    await bus.emit(symbolFact({ name: "a" }))
    await bus.emit(symbolFact({ name: "b" }))
    expect(sink.batches.length).toBe(0)

    await bus.emit(symbolFact({ name: "c" })) // hits threshold
    expect(sink.batches.length).toBe(1)
    expect(sink.totalNodes()).toBe(3)

    await bus.emit(symbolFact({ name: "d" }))
    expect(sink.batches.length).toBe(1) // still buffered

    await bus.close()
    expect(sink.batches.length).toBe(2) // close flushes the remainder
    expect(sink.totalNodes()).toBe(4)
  })

  it("dedup keeps the buffer below threshold", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink, flushThreshold: 3 })

    // Three emits with the same canonical key — only one accepted.
    await bus.emit(symbolFact({ name: "foo", producedBy: ["a"] }))
    await bus.emit(symbolFact({ name: "foo", producedBy: ["b"] }))
    await bus.emit(symbolFact({ name: "foo", producedBy: ["c"] }))
    expect(sink.batches.length).toBe(0) // not auto-flushed; only 1 accepted

    await bus.close()
    expect(sink.totalNodes()).toBe(1)
  })
})

describe("FactBus — report", () => {
  it("reports counts after a successful run", async () => {
    const sink = new CaptureSink()
    const bus = new FactBus({ snapshotId: 1, sink })

    await bus.emit(symbolFact({ name: "a", producedBy: ["plugin-a"] }))
    await bus.emit(symbolFact({ name: "b", producedBy: ["plugin-a"] }))
    await bus.emit(edgeFact({ src: "a", dst: "b", producedBy: ["plugin-a"] }))
    await bus.emit(edgeFact({ src: "a", dst: "b", producedBy: ["plugin-b"] })) // dedup
    await bus.close()

    const report: FactBusReport = bus.report()
    expect(report.totalEmits).toBe(4)
    expect(report.totalAccepted).toBe(3)
    expect(report.byKind.symbol).toBe(2)
    expect(report.byKind.edge).toBe(1)
    expect(report.byExtractor["plugin-a"]).toBe(3)
    // plugin-b's emit was deduped — it's NOT in the accepted-by-extractor
    // count, but its name will appear in the merged provenance on the
    // resulting fact.
    expect(report.byExtractor["plugin-b"]).toBeUndefined()
    expect(report.flushCount).toBe(1)
    expect(report.closed).toBe(true)
  })
})
