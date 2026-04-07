/**
 * graph-store.ts — SQLite implementation of GraphWriteSink (and SymbolFinder).
 *
 * Mirrors Neo4jGraphStore but writes through Drizzle into the five
 * SQLite tables defined in schema.ts. The whole write() call runs in
 * one synchronous better-sqlite3 transaction for atomicity — either
 * every node/edge/evidence/observation in the batch is visible to
 * subsequent reads, or nothing is (on error).
 *
 * Conflict handling: INSERT ... ON CONFLICT(snapshot_id, id) DO UPDATE
 * matches the Neo4j MERGE semantics the legacy code used. Re-running
 * an ingest against the same snapshot is safe and idempotent.
 *
 * JSON columns: Drizzle's text(mode: 'json') auto-serializes on insert
 * and auto-parses on select, so plugins and the FactBus can pass
 * SourceLocation objects and metadata records directly — no manual
 * JSON.stringify at the boundary.
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { and, eq, sql } from "drizzle-orm"
import type {
  GraphEdgeRow,
  GraphEvidenceRow,
  GraphNodeRow,
  GraphObservationRow,
  GraphWriteBatch,
  GraphWriteSink,
} from "../neo4j/node-contracts.js"
import type { SymbolFinder } from "../ingestion/indirect-caller-ingestion-service.js"
import type { SourceLocation } from "../../contracts/common.js"
import * as schema from "./schema.js"
import {
  type EdgeMetadata,
  type EvidencePayload,
  type NodePayload,
  type ObservationPayload,
  graphEdges,
  graphEvidence,
  graphNodes,
  graphObservations,
} from "./schema.js"

type SqliteDb = BetterSQLite3Database<typeof schema>

export class SqliteGraphStore implements GraphWriteSink, SymbolFinder {
  constructor(private readonly db: SqliteDb) {}

  async hasSymbol(snapshotId: number, name: string): Promise<boolean> {
    const rows = this.db
      .select({ nodeId: graphNodes.nodeId })
      .from(graphNodes)
      .where(
        and(
          eq(graphNodes.snapshotId, snapshotId),
          eq(graphNodes.canonicalName, name),
          eq(graphNodes.kind, "function"),
        ),
      )
      .limit(1)
      .all()
    return rows.length > 0
  }

  async write(batch: GraphWriteBatch): Promise<void> {
    // better-sqlite3 transactions are synchronous; wrapping the whole
    // batch in one txn gives us atomicity without async overhead.
    this.db.transaction((tx) => {
      this.writeNodes(tx, batch.nodes)
      this.writeEdges(tx, batch.edges)
      this.writeEvidence(tx, batch.evidence)
      this.writeObservations(tx, batch.observations)
    })
  }

  // -------------------------------------------------------------------------
  // Per-table writers
  // -------------------------------------------------------------------------

  private writeNodes(
    tx: SqliteDb,
    rows: GraphNodeRow[],
  ): void {
    if (rows.length === 0) return
    tx.insert(graphNodes)
      .values(
        rows.map((r) => ({
          snapshotId: r.snapshot_id,
          nodeId: r.node_id,
          canonicalName: r.canonical_name,
          kind: r.kind,
          location: (r.location ?? null) as SourceLocation | null,
          payload: (r.payload ?? null) as NodePayload | null,
        })),
      )
      .onConflictDoUpdate({
        target: [graphNodes.snapshotId, graphNodes.nodeId],
        set: {
          canonicalName: sql`excluded.canonical_name`,
          kind: sql`excluded.kind`,
          location: sql`excluded.location`,
          payload: sql`excluded.payload`,
        },
      })
      .run()
  }

  private writeEdges(
    tx: SqliteDb,
    rows: GraphEdgeRow[],
  ): void {
    if (rows.length === 0) return
    tx.insert(graphEdges)
      .values(
        rows.map((r) => ({
          snapshotId: r.snapshot_id,
          edgeId: r.edge_id,
          edgeKind: r.edge_kind,
          srcNodeId: r.src_node_id ?? null,
          dstNodeId: r.dst_node_id ?? null,
          confidence: r.confidence,
          derivation: r.derivation,
          metadata: (r.metadata ?? null) as EdgeMetadata | null,
        })),
      )
      .onConflictDoUpdate({
        target: [graphEdges.snapshotId, graphEdges.edgeId],
        set: {
          edgeKind: sql`excluded.edge_kind`,
          srcNodeId: sql`excluded.src_node_id`,
          dstNodeId: sql`excluded.dst_node_id`,
          confidence: sql`excluded.confidence`,
          derivation: sql`excluded.derivation`,
          metadata: sql`excluded.metadata`,
        },
      })
      .run()
  }

  private writeEvidence(
    tx: SqliteDb,
    rows: GraphEvidenceRow[],
  ): void {
    if (rows.length === 0) return
    tx.insert(graphEvidence)
      .values(
        rows.map((r) => ({
          snapshotId: r.snapshot_id,
          evidenceId: r.evidence_id,
          edgeId: r.edge_id ?? null,
          nodeId: r.node_id ?? null,
          sourceKind: r.source_kind,
          location: (r.location ?? null) as SourceLocation | null,
          payload: (r.payload ?? null) as EvidencePayload | null,
        })),
      )
      .onConflictDoUpdate({
        target: [graphEvidence.snapshotId, graphEvidence.evidenceId],
        set: {
          edgeId: sql`excluded.edge_id`,
          nodeId: sql`excluded.node_id`,
          sourceKind: sql`excluded.source_kind`,
          location: sql`excluded.location`,
          payload: sql`excluded.payload`,
        },
      })
      .run()
  }

  private writeObservations(
    tx: SqliteDb,
    rows: GraphObservationRow[],
  ): void {
    if (rows.length === 0) return
    tx.insert(graphObservations)
      .values(
        rows.map((r) => ({
          snapshotId: r.snapshot_id,
          observationId: r.observation_id,
          nodeId: r.node_id ?? null,
          kind: r.kind,
          observedAt: r.observed_at,
          confidence: r.confidence,
          payload: (r.payload ?? null) as ObservationPayload | null,
        })),
      )
      .onConflictDoUpdate({
        target: [graphObservations.snapshotId, graphObservations.observationId],
        set: {
          nodeId: sql`excluded.node_id`,
          kind: sql`excluded.kind`,
          observedAt: sql`excluded.observed_at`,
          confidence: sql`excluded.confidence`,
          payload: sql`excluded.payload`,
        },
      })
      .run()
  }
}
