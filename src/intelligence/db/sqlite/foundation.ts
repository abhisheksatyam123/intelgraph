/**
 * foundation.ts — SQLite implementation of IDbFoundation, via Drizzle.
 *
 * Mirrors Neo4jDbFoundation but talks to better-sqlite3 through the
 * Drizzle ORM. Snapshot lifecycle is the entirety of this class; the
 * write path for nodes/edges lives in SqliteGraphStore.
 *
 * Database lifetime: the Drizzle db handle is passed in, not owned. A
 * single Database + drizzle() wrapper is built once in backend-factory
 * and shared by the foundation, the graph store, and the lookup. Tests
 * pass an in-memory handle.
 */

import type BetterSqlite3 from "better-sqlite3"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { and, desc, eq } from "drizzle-orm"
import type { IDbFoundation, DbTxContext } from "../../contracts/db-foundation.js"
import type { SnapshotMeta, SnapshotRef } from "../../contracts/common.js"
import { DDL_STATEMENTS, graphSnapshots } from "./schema.js"

function nowIso(): string {
  return new Date().toISOString()
}

export class SqliteDbFoundation implements IDbFoundation {
  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly raw: BetterSqlite3.Database,
  ) {}

  async initSchema(): Promise<void> {
    // Drizzle's db.run(sql`...`) goes through prepare() which only accepts
    // a single statement. We run the multi-statement DDL through the raw
    // better-sqlite3 handle via exec(), which handles batched statements
    // natively.
    for (const stmt of DDL_STATEMENTS) {
      this.raw.exec(stmt)
    }
  }

  async runMigrations(): Promise<void> {
    await this.initSchema()
  }

  async beginSnapshot(meta: SnapshotMeta): Promise<SnapshotRef> {
    const createdAt = nowIso()
    const fingerprint = `${meta.workspaceRoot}:${meta.compileDbHash}:${meta.parserVersion}`
    const inserted = this.db
      .insert(graphSnapshots)
      .values({
        workspaceRoot: meta.workspaceRoot,
        compileDbHash: meta.compileDbHash,
        parserVersion: meta.parserVersion,
        sourceRevision: meta.sourceRevision ?? null,
        status: "building",
        createdAt,
        fingerprint,
        metadata: (meta.metadata ?? null) as Record<string, unknown> | null,
      })
      .returning({ snapshotId: graphSnapshots.snapshotId })
      .all()
    const snapshotId = inserted[0]?.snapshotId
    if (snapshotId === undefined) {
      throw new Error("[sqlite-foundation] beginSnapshot: insert returned no snapshot_id")
    }
    return { snapshotId, createdAt, status: "building" }
  }

  async commitSnapshot(snapshotId: number): Promise<void> {
    const readyAt = nowIso()
    this.db
      .update(graphSnapshots)
      .set({ status: "ready", readyAt, failReason: null })
      .where(eq(graphSnapshots.snapshotId, snapshotId))
      .run()
  }

  async failSnapshot(snapshotId: number, reason: string): Promise<void> {
    const failedAt = nowIso()
    this.db
      .update(graphSnapshots)
      .set({ status: "failed", failReason: reason, failedAt })
      .where(eq(graphSnapshots.snapshotId, snapshotId))
      .run()
  }

  async getLatestReadySnapshot(workspaceRoot: string): Promise<SnapshotRef | null> {
    const rows = this.db
      .select({
        snapshotId: graphSnapshots.snapshotId,
        createdAt: graphSnapshots.createdAt,
      })
      .from(graphSnapshots)
      .where(
        and(
          eq(graphSnapshots.workspaceRoot, workspaceRoot),
          eq(graphSnapshots.status, "ready"),
        ),
      )
      .orderBy(desc(graphSnapshots.snapshotId))
      .limit(1)
      .all()
    const row = rows[0]
    if (!row) return null
    return {
      snapshotId: row.snapshotId,
      createdAt: row.createdAt,
      status: "ready",
    }
  }

  async withTransaction<T>(fn: (tx: DbTxContext) => Promise<T>): Promise<T> {
    // The legacy Neo4j implementation returned an empty query stub — no
    // consumer actually exercises withTransaction's query() method today.
    // We match that behavior. Real transactions on the write path use
    // db.transaction(() => { ... }) inside SqliteGraphStore.
    const tx: DbTxContext = {
      query: async () => [],
    }
    return fn(tx)
  }
}
