import type { Driver } from "neo4j-driver"
import type { GraphProjectionRepository } from "../../contracts/orchestrator.js"

export class Neo4jGraphProjectionService implements GraphProjectionRepository {
  constructor(
    private driver: Driver,
    _legacy?: unknown,
  ) {}

  async syncFromAuthoritative(snapshotId: number): Promise<{ synced: boolean; nodesUpserted: number; edgesUpserted: number }> {
    void snapshotId
    if (!this.driver) {
      return { synced: false, nodesUpserted: 0, edgesUpserted: 0 }
    }
    return { synced: false, nodesUpserted: 0, edgesUpserted: 0 }
  }
}
