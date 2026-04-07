/**
 * sqlite-foundation.test.ts — exercises SqliteDbFoundation + client.
 *
 * Each test spins up a fresh in-memory database via openSqlite(":memory:")
 * so there is no persistent state between tests and no external
 * dependency — the whole SQLite stack runs in-process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openSqlite, type SqliteClient } from "../../../src/intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../../../src/intelligence/db/sqlite/foundation.js"
import { graphSnapshots } from "../../../src/intelligence/db/sqlite/schema.js"
import { eq } from "drizzle-orm"

let client: SqliteClient
let foundation: SqliteDbFoundation

beforeEach(async () => {
  client = openSqlite({ path: ":memory:" })
  foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
})

afterEach(() => {
  client.close()
})

describe("SqliteDbFoundation — schema initialization", () => {
  it("initSchema creates all five tables idempotently", async () => {
    // Running twice must not throw (CREATE TABLE IF NOT EXISTS).
    await foundation.initSchema()
    await foundation.runMigrations()

    const tables = client.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toEqual([
      "graph_edges",
      "graph_evidence",
      "graph_nodes",
      "graph_observations",
      "graph_snapshots",
    ])
  })

  it("creates the expected indexes", async () => {
    const indexes = client.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='index' AND name LIKE 'idx_graph_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
    const idxNames = indexes.map((i) => i.name)
    expect(idxNames).toEqual([
      "idx_graph_edges_dst",
      "idx_graph_edges_kind",
      "idx_graph_edges_src",
      "idx_graph_evidence_edge",
      "idx_graph_evidence_node",
      "idx_graph_nodes_kind",
      "idx_graph_nodes_ws_name",
      "idx_graph_observations_kind",
      "idx_graph_snapshots_ws_status",
    ])
  })
})

describe("SqliteDbFoundation — snapshot lifecycle", () => {
  it("beginSnapshot inserts a building row and returns the id", async () => {
    const ref = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "abc123",
      parserVersion: "1.0.0",
    })
    expect(ref.status).toBe("building")
    expect(ref.snapshotId).toBe(1)
    expect(ref.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const rows = client.db
      .select()
      .from(graphSnapshots)
      .where(eq(graphSnapshots.snapshotId, ref.snapshotId))
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0].workspaceRoot).toBe("/tmp/ws")
    expect(rows[0].compileDbHash).toBe("abc123")
    expect(rows[0].parserVersion).toBe("1.0.0")
    expect(rows[0].status).toBe("building")
    expect(rows[0].readyAt).toBeNull()
    expect(rows[0].fingerprint).toBe("/tmp/ws:abc123:1.0.0")
  })

  it("beginSnapshot increments the snapshotId across inserts", async () => {
    const a = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "h1",
      parserVersion: "1.0.0",
    })
    const b = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "h2",
      parserVersion: "1.0.0",
    })
    const c = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/other",
      compileDbHash: "h3",
      parserVersion: "1.0.0",
    })
    expect(a.snapshotId).toBe(1)
    expect(b.snapshotId).toBe(2)
    expect(c.snapshotId).toBe(3)
  })

  it("commitSnapshot flips status to ready and stamps ready_at", async () => {
    const { snapshotId } = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "abc",
      parserVersion: "1.0.0",
    })
    await foundation.commitSnapshot(snapshotId)

    const row = client.db
      .select()
      .from(graphSnapshots)
      .where(eq(graphSnapshots.snapshotId, snapshotId))
      .all()[0]
    expect(row.status).toBe("ready")
    expect(row.readyAt).not.toBeNull()
    expect(row.failReason).toBeNull()
  })

  it("failSnapshot flips status to failed with a reason", async () => {
    const { snapshotId } = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "abc",
      parserVersion: "1.0.0",
    })
    await foundation.failSnapshot(snapshotId, "synthetic failure")

    const row = client.db
      .select()
      .from(graphSnapshots)
      .where(eq(graphSnapshots.snapshotId, snapshotId))
      .all()[0]
    expect(row.status).toBe("failed")
    expect(row.failReason).toBe("synthetic failure")
    expect(row.failedAt).not.toBeNull()
  })

  it("getLatestReadySnapshot returns null when nothing is ready", async () => {
    const latest = await foundation.getLatestReadySnapshot("/tmp/ws")
    expect(latest).toBeNull()
  })

  it("getLatestReadySnapshot ignores building and failed snapshots", async () => {
    const a = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "h1",
      parserVersion: "1.0.0",
    })
    await foundation.commitSnapshot(a.snapshotId)

    const b = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "h2",
      parserVersion: "1.0.0",
    })
    await foundation.failSnapshot(b.snapshotId, "oops")

    // c is left in "building" state on purpose
    await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "h3",
      parserVersion: "1.0.0",
    })

    const latest = await foundation.getLatestReadySnapshot("/tmp/ws")
    expect(latest?.snapshotId).toBe(a.snapshotId)
    expect(latest?.status).toBe("ready")
  })

  it("getLatestReadySnapshot returns the highest ready id when multiple exist", async () => {
    const a = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "h1",
      parserVersion: "1.0.0",
    })
    await foundation.commitSnapshot(a.snapshotId)

    const b = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "h2",
      parserVersion: "1.0.0",
    })
    await foundation.commitSnapshot(b.snapshotId)

    const latest = await foundation.getLatestReadySnapshot("/tmp/ws")
    expect(latest?.snapshotId).toBe(b.snapshotId)
  })

  it("getLatestReadySnapshot scopes by workspace_root", async () => {
    const a = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws-a",
      compileDbHash: "h1",
      parserVersion: "1.0.0",
    })
    await foundation.commitSnapshot(a.snapshotId)

    const b = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws-b",
      compileDbHash: "h2",
      parserVersion: "1.0.0",
    })
    await foundation.commitSnapshot(b.snapshotId)

    const latestA = await foundation.getLatestReadySnapshot("/tmp/ws-a")
    const latestB = await foundation.getLatestReadySnapshot("/tmp/ws-b")
    expect(latestA?.snapshotId).toBe(a.snapshotId)
    expect(latestB?.snapshotId).toBe(b.snapshotId)
  })

  it("stores arbitrary metadata as JSON and round-trips it", async () => {
    const { snapshotId } = await foundation.beginSnapshot({
      workspaceRoot: "/tmp/ws",
      compileDbHash: "abc",
      parserVersion: "1.0.0",
      metadata: { run: 42, source: "ci", nested: { key: "value" } },
    })
    const row = client.db
      .select()
      .from(graphSnapshots)
      .where(eq(graphSnapshots.snapshotId, snapshotId))
      .all()[0]
    expect(row.metadata).toEqual({ run: 42, source: "ci", nested: { key: "value" } })
  })
})

describe("SqliteDbFoundation — withTransaction stub", () => {
  it("invokes the callback with a query() that returns empty", async () => {
    const result = await foundation.withTransaction(async (tx) => {
      const rows = await tx.query("SELECT 1")
      return { ok: true, rowCount: rows.length }
    })
    expect(result).toEqual({ ok: true, rowCount: 0 })
  })
})
