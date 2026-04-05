import type { Driver } from "neo4j-driver"
import type { IDbFoundation, DbTxContext } from "../../contracts/db-foundation.js"
import type { SnapshotMeta, SnapshotRef } from "../../contracts/common.js"

function now(): string {
  return new Date().toISOString()
}

export class Neo4jDbFoundation implements IDbFoundation {
  constructor(private driver: Driver) {}

  async initSchema(): Promise<void> {
    const s = this.driver.session()
    try {
      await s.run("CREATE CONSTRAINT graph_snapshot_id IF NOT EXISTS FOR (n:GraphSnapshot) REQUIRE n.snapshot_id IS UNIQUE")
    } finally {
      await s.close()
    }
  }

  async runMigrations(): Promise<void> {
    await this.initSchema()
  }

  async beginSnapshot(meta: SnapshotMeta): Promise<SnapshotRef> {
    const s = this.driver.session()
    try {
      const idRow = await s.run("MATCH (n:GraphSnapshot) RETURN coalesce(max(n.snapshot_id), 0) + 1 AS id")
      const id = Number(idRow.records[0]?.get("id") ?? 1)
      const createdAt = now()
      const fingerprint = `${meta.workspaceRoot}:${meta.compileDbHash}:${meta.parserVersion}`
      await s.run(
        "CREATE (n:GraphSnapshot { snapshot_id: $id, workspace_root: $root, compile_db_hash: $hash, parser_version: $parser, source_revision: $rev, status: 'building', created_at: $createdAt, metadata: $meta, fingerprint: $fingerprint })",
        {
          id,
          root: meta.workspaceRoot,
          hash: meta.compileDbHash,
          parser: meta.parserVersion,
          rev: meta.sourceRevision ?? null,
          createdAt,
          meta: meta.metadata ?? null,
          fingerprint,
        },
      )
      return { snapshotId: id, createdAt, status: "building" }
    } finally {
      await s.close()
    }
  }

  async commitSnapshot(snapshotId: number): Promise<void> {
    const s = this.driver.session()
    try {
      await s.run(
        "MATCH (n:GraphSnapshot {snapshot_id: $id}) SET n.status = 'ready', n.ready_at = $readyAt, n.fail_reason = null",
        { id: snapshotId, readyAt: now() },
      )
    } finally {
      await s.close()
    }
  }

  async failSnapshot(snapshotId: number, reason: string): Promise<void> {
    const s = this.driver.session()
    try {
      await s.run(
        "MATCH (n:GraphSnapshot {snapshot_id: $id}) SET n.status = 'failed', n.fail_reason = $reason, n.failed_at = $failedAt",
        { id: snapshotId, reason, failedAt: now() },
      )
    } finally {
      await s.close()
    }
  }

  async getLatestReadySnapshot(workspaceRoot: string): Promise<SnapshotRef | null> {
    const s = this.driver.session()
    try {
      const res = await s.run(
        "MATCH (n:GraphSnapshot {workspace_root: $root, status: 'ready'}) RETURN n.snapshot_id AS id, n.created_at AS createdAt ORDER BY id DESC LIMIT 1",
        { root: workspaceRoot },
      )
      if (res.records.length === 0) return null
      const row = res.records[0]!
      return {
        snapshotId: Number(row.get("id")),
        createdAt: String(row.get("createdAt") ?? ""),
        status: "ready",
      }
    } finally {
      await s.close()
    }
  }

  async withTransaction<T>(fn: (tx: DbTxContext) => Promise<T>): Promise<T> {
    const tx: DbTxContext = {
      query: async () => [],
    }
    return fn(tx)
  }
}
