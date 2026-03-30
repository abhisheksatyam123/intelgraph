import type { IngestReport, SnapshotMeta, SnapshotRef } from "./common.js"

export interface DbTxContext {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface IDbFoundation {
  initSchema(): Promise<void>
  runMigrations(): Promise<void>
  beginSnapshot(meta: SnapshotMeta): Promise<SnapshotRef>
  commitSnapshot(snapshotId: number): Promise<void>
  failSnapshot(snapshotId: number, reason: string): Promise<void>
  /** Returns the latest ready snapshot for the given workspace root, or null if none exists. */
  getLatestReadySnapshot(workspaceRoot: string): Promise<SnapshotRef | null>
  withTransaction<T>(fn: (tx: DbTxContext) => Promise<T>): Promise<T>
}

export interface ISnapshotIngestWriter {
  writeSnapshotBatch(snapshotId: number, batch: {
    symbols?: unknown[]
    types?: unknown[]
    fields?: unknown[]
    edges?: unknown[]
    runtimeCallers?: unknown[]
  }): Promise<IngestReport>
}
