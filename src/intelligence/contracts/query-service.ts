import type { CallerGraph, CalleeGraph, Provenance } from "./common.js"

export interface QueryOptions {
  snapshotId?: number
  depth?: number
  includeIndirect?: boolean
}

export interface IQueryService {
  getCallers(apiName: string, opts?: QueryOptions): Promise<CallerGraph>
  getCallees(apiName: string, opts?: QueryOptions): Promise<CalleeGraph>
  getEdgeProvenance(edgeId: string, snapshotId?: number): Promise<Provenance>
}
