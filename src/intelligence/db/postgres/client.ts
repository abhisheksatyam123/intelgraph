import pg from "pg"
import type { IDbFoundation } from "../../contracts/db-foundation.js"
import type { SnapshotMeta, SnapshotRef } from "../../contracts/common.js"
import type { DbTxContext } from "../../contracts/db-foundation.js"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const { Pool } = pg

const dir = dirname(fileURLToPath(import.meta.url))

export function createPool(url: string) {
  return new Pool({ connectionString: url, max: 10 })
}

export class PostgresDbFoundation implements IDbFoundation {
  constructor(private pool: pg.Pool) {}

  async initSchema(): Promise<void> {
    const sql = readFileSync(join(dir, "schema.sql"), "utf8")
    await this.pool.query(sql)
  }

  async runMigrations(): Promise<void> {
    // future: run versioned migration files
    await this.initSchema()
  }

  async beginSnapshot(meta: SnapshotMeta): Promise<SnapshotRef> {
    const res = await this.pool.query<{ id: string; created_at: string }>(
      `INSERT INTO snapshot (workspace_root, source_revision, compile_db_hash, parser_version, status, metadata)
       VALUES ($1, $2, $3, $4, 'building', $5)
       RETURNING id, created_at`,
      [meta.workspaceRoot, meta.sourceRevision ?? null, meta.compileDbHash, meta.parserVersion, meta.metadata ?? null],
    )
    const row = res.rows[0]!
    return { snapshotId: Number(row.id), createdAt: row.created_at, status: "building" }
  }

  async commitSnapshot(snapshotId: number): Promise<void> {
    await this.pool.query(
      `UPDATE snapshot SET status = 'ready' WHERE id = $1`,
      [snapshotId],
    )
  }

  async failSnapshot(snapshotId: number, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE snapshot SET status = 'failed', fail_reason = $2 WHERE id = $1`,
      [snapshotId, reason],
    )
  }

  async getLatestReadySnapshot(workspaceRoot: string): Promise<import("../../contracts/common.js").SnapshotRef | null> {
    const res = await this.pool.query<{ id: string; created_at: string; status: string }>(
      `SELECT id, created_at, status
       FROM snapshot
       WHERE workspace_root = $1 AND status = 'ready'
       ORDER BY id DESC
       LIMIT 1`,
      [workspaceRoot],
    )
    if (res.rows.length === 0) return null
    const row = res.rows[0]!
    return { snapshotId: Number(row.id), createdAt: row.created_at, status: "ready" }
  }

  async withTransaction<T>(fn: (tx: DbTxContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const ctx: DbTxContext = {
        query: (sql: string, params?: unknown[]) =>
          client.query(sql, params).then((r) => r.rows) as Promise<any[]>,
      }
      const result = await fn(ctx)
      await client.query("COMMIT")
      return result
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }
}
