/**
 * sqlite-graph-store.test.ts — exercises SqliteGraphStore write() and
 * hasSymbol() against an in-memory database.
 *
 * Writes a realistic GraphWriteBatch, reads the rows back through the
 * Drizzle query layer, asserts that column values and JSON fields
 * round-trip correctly, and tests idempotent upsert behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openSqlite, type SqliteClient } from "../../../src/intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../../../src/intelligence/db/sqlite/foundation.js"
import { SqliteGraphStore } from "../../../src/intelligence/db/sqlite/graph-store.js"
import {
  graphEdges,
  graphEvidence,
  graphNodes,
  graphObservations,
} from "../../../src/intelligence/db/sqlite/schema.js"
import { eq } from "drizzle-orm"
import type {
  GraphEdgeRow,
  GraphEvidenceRow,
  GraphNodeRow,
  GraphObservationRow,
  GraphWriteBatch,
} from "../../../src/intelligence/db/graph-rows.js"

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let client: SqliteClient
let foundation: SqliteDbFoundation
let store: SqliteGraphStore
let snapshotId: number

beforeEach(async () => {
  client = openSqlite({ path: ":memory:" })
  foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
  store = new SqliteGraphStore(client.db)
  const ref = await foundation.beginSnapshot({
    workspaceRoot: "/tmp/ws",
    compileDbHash: "abc",
    parserVersion: "1.0.0",
  })
  snapshotId = ref.snapshotId
})

afterEach(() => {
  client.close()
})

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNodeRow> = {}): GraphNodeRow {
  return {
    snapshot_id: snapshotId,
    node_id: "node-1",
    canonical_name: "foo",
    kind: "function",
    location: { filePath: "/src/a.c", line: 10, column: 5 },
    payload: { signature: "int foo(void)", linkage: "extern", metadata: {} },
    ...overrides,
  }
}

function makeEdge(overrides: Partial<GraphEdgeRow> = {}): GraphEdgeRow {
  return {
    snapshot_id: snapshotId,
    edge_id: "edge-1",
    edge_kind: "calls",
    src_node_id: "node-1",
    dst_node_id: "node-2",
    confidence: 1.0,
    derivation: "clangd",
    metadata: {
      access_path: undefined,
      source_location: { sourceFilePath: "/src/a.c", sourceLineNumber: 10 },
    },
    ...overrides,
  }
}

function makeEvidence(overrides: Partial<GraphEvidenceRow> = {}): GraphEvidenceRow {
  return {
    snapshot_id: snapshotId,
    evidence_id: "ev-1",
    edge_id: "edge-1",
    node_id: undefined,
    source_kind: "clangd_response",
    location: { filePath: "/src/a.c", line: 10 },
    payload: {},
    ...overrides,
  }
}

function makeObservation(
  overrides: Partial<GraphObservationRow> = {},
): GraphObservationRow {
  return {
    snapshot_id: snapshotId,
    observation_id: "obs-1",
    node_id: "node-2",
    kind: "runtime_invocation",
    observed_at: "2026-04-07T00:00:00Z",
    confidence: 0.9,
    payload: {
      target_api: "bar",
      immediate_invoker: "foo",
      runtime_trigger: "timer",
      dispatch_chain: ["foo", "dispatch_fn", "bar"],
      dispatch_site: { filePath: "/src/a.c", line: 20 },
    },
    ...overrides,
  }
}

function emptyBatch(): GraphWriteBatch {
  return { nodes: [], edges: [], evidence: [], observations: [] }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SqliteGraphStore.write() — nodes", () => {
  it("inserts a single node row and round-trips JSON payload + location", async () => {
    await store.write({
      ...emptyBatch(),
      nodes: [makeNode()],
    })

    const rows = client.db
      .select()
      .from(graphNodes)
      .where(eq(graphNodes.nodeId, "node-1"))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0].canonicalName).toBe("foo")
    expect(rows[0].kind).toBe("function")
    expect(rows[0].location).toEqual({ filePath: "/src/a.c", line: 10, column: 5 })
    expect(rows[0].payload).toMatchObject({
      signature: "int foo(void)",
      linkage: "extern",
    })
  })

  it("inserts many nodes in one batch", async () => {
    const nodes = Array.from({ length: 50 }, (_, i) =>
      makeNode({ node_id: `node-${i}`, canonical_name: `fn_${i}` }),
    )
    await store.write({ ...emptyBatch(), nodes })

    const count = client.db.select().from(graphNodes).all().length
    expect(count).toBe(50)
  })

  it("upsert: re-inserting the same node_id updates fields", async () => {
    await store.write({ ...emptyBatch(), nodes: [makeNode({ canonical_name: "foo_v1" })] })
    await store.write({ ...emptyBatch(), nodes: [makeNode({ canonical_name: "foo_v2" })] })

    const rows = client.db.select().from(graphNodes).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].canonicalName).toBe("foo_v2")
  })
})

describe("SqliteGraphStore.write() — edges", () => {
  it("inserts edges with JSON metadata round-trip", async () => {
    await store.write({ ...emptyBatch(), edges: [makeEdge()] })

    const rows = client.db.select().from(graphEdges).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].edgeKind).toBe("calls")
    expect(rows[0].srcNodeId).toBe("node-1")
    expect(rows[0].dstNodeId).toBe("node-2")
    expect(rows[0].confidence).toBe(1.0)
    expect(rows[0].derivation).toBe("clangd")
    expect(rows[0].metadata?.source_location).toEqual({
      sourceFilePath: "/src/a.c",
      sourceLineNumber: 10,
    })
  })

  it("upsert: re-inserting the same edge_id updates fields", async () => {
    await store.write({ ...emptyBatch(), edges: [makeEdge({ confidence: 0.5 })] })
    await store.write({ ...emptyBatch(), edges: [makeEdge({ confidence: 0.9 })] })

    const rows = client.db.select().from(graphEdges).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].confidence).toBe(0.9)
  })

  it("handles edges with null src or dst (registration / dispatch-only edges)", async () => {
    await store.write({
      ...emptyBatch(),
      edges: [
        makeEdge({ edge_id: "e-src-only", src_node_id: "x", dst_node_id: undefined }),
        makeEdge({ edge_id: "e-dst-only", src_node_id: undefined, dst_node_id: "y" }),
      ],
    })
    const rows = client.db
      .select()
      .from(graphEdges)
      .all()
      .sort((a, b) => a.edgeId.localeCompare(b.edgeId))
    expect(rows).toHaveLength(2)
    // After sort: e-dst-only (null src, "y" dst), then e-src-only ("x" src, null dst)
    expect(rows[0].edgeId).toBe("e-dst-only")
    expect(rows[0].srcNodeId).toBeNull()
    expect(rows[0].dstNodeId).toBe("y")
    expect(rows[1].edgeId).toBe("e-src-only")
    expect(rows[1].srcNodeId).toBe("x")
    expect(rows[1].dstNodeId).toBeNull()
  })
})

describe("SqliteGraphStore.write() — evidence and observations", () => {
  it("inserts evidence rows", async () => {
    await store.write({ ...emptyBatch(), evidence: [makeEvidence()] })
    const rows = client.db.select().from(graphEvidence).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceKind).toBe("clangd_response")
    expect(rows[0].edgeId).toBe("edge-1")
    expect(rows[0].location?.filePath).toBe("/src/a.c")
  })

  it("inserts observation rows with dispatch chain payload", async () => {
    await store.write({ ...emptyBatch(), observations: [makeObservation()] })
    const rows = client.db.select().from(graphObservations).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("runtime_invocation")
    expect(rows[0].payload?.target_api).toBe("bar")
    expect(rows[0].payload?.dispatch_chain).toEqual(["foo", "dispatch_fn", "bar"])
  })
})

describe("SqliteGraphStore.write() — atomic batch", () => {
  it("writes all four row kinds in a single call", async () => {
    await store.write({
      nodes: [makeNode(), makeNode({ node_id: "node-2", canonical_name: "bar" })],
      edges: [makeEdge()],
      evidence: [makeEvidence()],
      observations: [makeObservation()],
    })

    expect(client.db.select().from(graphNodes).all()).toHaveLength(2)
    expect(client.db.select().from(graphEdges).all()).toHaveLength(1)
    expect(client.db.select().from(graphEvidence).all()).toHaveLength(1)
    expect(client.db.select().from(graphObservations).all()).toHaveLength(1)
  })

  it("empty batch is a no-op", async () => {
    await store.write(emptyBatch())
    expect(client.db.select().from(graphNodes).all()).toHaveLength(0)
  })
})

describe("SqliteGraphStore — SymbolFinder.hasSymbol", () => {
  it("returns true for a function node that exists", async () => {
    await store.write({
      ...emptyBatch(),
      nodes: [makeNode({ canonical_name: "foo" })],
    })
    expect(await store.hasSymbol(snapshotId, "foo")).toBe(true)
  })

  it("returns false for a non-existent symbol", async () => {
    expect(await store.hasSymbol(snapshotId, "nonexistent")).toBe(false)
  })

  it("returns false for a symbol in a different snapshot", async () => {
    await store.write({
      ...emptyBatch(),
      nodes: [makeNode({ canonical_name: "foo" })],
    })
    expect(await store.hasSymbol(999, "foo")).toBe(false)
  })

  it("returns false when the node exists but is not a function", async () => {
    await store.write({
      ...emptyBatch(),
      nodes: [
        makeNode({ node_id: "node-struct", canonical_name: "MyStruct", kind: "struct" }),
      ],
    })
    expect(await store.hasSymbol(snapshotId, "MyStruct")).toBe(false)
  })
})
