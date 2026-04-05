import type { Driver } from "neo4j-driver"
import type { GraphWriteBatch, GraphWriteSink } from "./node-contracts.js"
import type { SymbolFinder } from "../ingestion/indirect-caller-ingestion-service.js"

export class Neo4jGraphStore implements GraphWriteSink, SymbolFinder {
  constructor(private driver: Driver) {}

  async hasSymbol(snapshotId: number, name: string): Promise<boolean> {
    const s = this.driver.session()
    try {
      const res = await s.run(
        "MATCH (n:GraphNode {snapshot_id: $snapshotId, canonical_name: $name, kind: 'function'}) RETURN n.node_id AS id LIMIT 1",
        { snapshotId, name },
      )
      return res.records.length > 0
    } finally {
      await s.close()
    }
  }

  async write(batch: GraphWriteBatch): Promise<void> {
    const s = this.driver.session()
    try {
      for (const row of batch.nodes) {
        await s.run(
          "MERGE (n:GraphNode {node_id: $node_id}) SET n.snapshot_id = $snapshot_id, n.canonical_name = $canonical_name, n.kind = $kind, n.location = $location, n.payload = $payload",
          row,
        )
      }

      for (const row of batch.edges) {
        await s.run(
          "MERGE (e:GraphEdge {edge_id: $edge_id}) SET e.snapshot_id = $snapshot_id, e.edge_kind = $edge_kind, e.src_node_id = $src_node_id, e.dst_node_id = $dst_node_id, e.confidence = $confidence, e.derivation = $derivation, e.metadata = $metadata",
          row,
        )
      }

      for (const row of batch.evidence) {
        await s.run(
          "MERGE (v:GraphEvidence {evidence_id: $evidence_id}) SET v.snapshot_id = $snapshot_id, v.edge_id = $edge_id, v.node_id = $node_id, v.source_kind = $source_kind, v.location = $location, v.payload = $payload",
          row,
        )
      }

      for (const row of batch.observations) {
        await s.run(
          "MERGE (o:GraphObservation {observation_id: $observation_id}) SET o.snapshot_id = $snapshot_id, o.node_id = $node_id, o.kind = $kind, o.observed_at = $observed_at, o.confidence = $confidence, o.payload = $payload",
          row,
        )
      }
    } finally {
      await s.close()
    }
  }
}
