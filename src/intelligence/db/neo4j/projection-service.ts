import neo4j, { type Driver } from "neo4j-driver"
import pg from "pg"
import type { GraphProjectionRepository } from "../../contracts/orchestrator.js"

const { Pool } = pg

export class Neo4jGraphProjectionService implements GraphProjectionRepository {
  constructor(
    private driver: Driver,
    private pgPool: pg.Pool,
  ) {}

  async syncFromAuthoritative(snapshotId: number): Promise<{ synced: boolean; nodesUpserted: number; edgesUpserted: number }> {
    // Read canonical symbols and edges from Postgres
    const [symRes, edgeRes] = await Promise.all([
      this.pgPool.query<{ id: string; name: string; kind: string }>(
        `SELECT id, name, kind FROM symbol WHERE snapshot_id = $1`,
        [snapshotId],
      ),
      this.pgPool.query<{ id: string; src_symbol_name: string; dst_symbol_name: string; edge_kind: string; confidence: number; derivation: string }>(
        `SELECT id, src_symbol_name, dst_symbol_name, edge_kind, confidence, derivation
         FROM semantic_edge WHERE snapshot_id = $1`,
        [snapshotId],
      ),
    ])

    const session = this.driver.session()
    let nodesUpserted = 0
    let edgesUpserted = 0

    try {
      // Upsert symbol nodes
      for (const row of symRes.rows) {
        await session.run(
          `MERGE (n:Symbol {node_id: $node_id})
           SET n.snapshot_id = $snapshot_id, n.name = $name, n.kind = $kind`,
          { node_id: `${snapshotId}:${row.name}`, snapshot_id: snapshotId, name: row.name, kind: row.kind },
        )
        nodesUpserted++
      }

      // Upsert semantic edges as relationships
      for (const row of edgeRes.rows) {
        if (!row.src_symbol_name || !row.dst_symbol_name) continue
        await session.run(
          `MATCH (src:Symbol {node_id: $src_id})
           MATCH (dst:Symbol {node_id: $dst_id})
           MERGE (src)-[r:SEMANTIC_EDGE {edge_id: $edge_id}]->(dst)
           SET r.snapshot_id = $snapshot_id,
               r.kind = $kind,
               r.confidence = $confidence,
               r.derivation = $derivation`,
          {
            src_id: `${snapshotId}:${row.src_symbol_name}`,
            dst_id: `${snapshotId}:${row.dst_symbol_name}`,
            edge_id: `${snapshotId}:${row.id}`,
            snapshot_id: snapshotId,
            kind: row.edge_kind,
            confidence: row.confidence,
            derivation: row.derivation,
          },
        )
        edgesUpserted++
      }
    } finally {
      await session.close()
    }

    return { synced: true, nodesUpserted, edgesUpserted }
  }
}
