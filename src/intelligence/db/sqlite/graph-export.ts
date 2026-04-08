/**
 * graph-export.ts — pure SQLite → node-link graph reader.
 *
 * This module contains the reusable bit of `buildGraphJson` from
 * src/bin/snapshot-stats.ts: given a raw better-sqlite3 db handle and
 * a snapshot id, build a `GraphJson` document by reading graph_nodes
 * and graph_edges directly. The CLI uses this after running an
 * ephemeral extraction; the `intelligence_graph` MCP tool uses it
 * against the live persisted snapshot, so any MCP client (TUI,
 * external script, etc.) can fetch the visualization data without
 * re-extracting.
 *
 * The function is intentionally synchronous and pure: no extraction,
 * no schema, no IO beyond the SELECT statements. Callers own the db
 * connection.
 */

import type BetterSqlite3 from "better-sqlite3"

/**
 * Node-link graph shape suitable for d3-force, cytoscape, sigma,
 * cosmograph, and most other web visualization libraries.
 *
 * Each node carries the symbol's kind, canonical name, and the
 * useful metadata flags from the extractor (exported, line range,
 * doc snippet, etc). Each edge carries its kind plus any resolution
 * metadata (resolutionKind, awaited, jsxTag, …) so the visualizer
 * can render different connection styles.
 */
export interface GraphJson {
  workspace: string
  snapshot_id: number
  nodes: Array<{
    id: string
    kind: string
    file_path: string | null
    line: number | null
    end_line: number | null
    line_count: number | null
    exported: boolean
    doc: string | null
    owning_class: string | null
  }>
  edges: Array<{
    src: string
    dst: string
    kind: string
    resolution_kind: string | null
    metadata: Record<string, unknown> | null
  }>
}

export interface GraphJsonFilters {
  /** If set, keep only edges whose edge_kind is in this set. */
  edgeKinds?: Set<string>
  /**
   * If set, keep only nodes whose kind is in this set, plus only edges
   * where BOTH src and dst survive the node filter.
   */
  symbolKinds?: Set<string>
}

type NodeRow = {
  canonical_name: string
  kind: string
  location: string | null
  payload: string | null
}

type EdgeRow = {
  src_node_id: string
  dst_node_id: string
  edge_kind: string
  metadata: string | null
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseLocation(
  raw: string | null,
): { filePath?: string; line?: number } {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Read graph_nodes + graph_edges for `snapshotId` and assemble the
 * node-link `GraphJson`. Pure: no IO outside the SELECTs, no side
 * effects on the db. Apply optional filters to subset the result.
 */
export function loadGraphJsonFromDb(
  raw: BetterSqlite3.Database,
  snapshotId: number,
  workspace: string,
  filters: GraphJsonFilters = {},
): GraphJson {
  const nodeRows = raw
    .prepare(
      `SELECT canonical_name, kind, location, payload
       FROM graph_nodes
       WHERE snapshot_id = ?
       ORDER BY canonical_name`,
    )
    .all(snapshotId) as NodeRow[]

  const edgeRows = raw
    .prepare(
      `SELECT src_node_id, dst_node_id, edge_kind, metadata
       FROM graph_edges
       WHERE snapshot_id = ?`,
    )
    .all(snapshotId) as EdgeRow[]

  // Build a node_id → canonical_name lookup so edges can use
  // canonical names (which are stable and human-readable) instead
  // of opaque graph_node IDs.
  const nodeIdLookup = new Map<string, string>()
  const nodeIdRows = raw
    .prepare(
      `SELECT node_id, canonical_name FROM graph_nodes WHERE snapshot_id = ?`,
    )
    .all(snapshotId) as Array<{ node_id: string; canonical_name: string }>
  for (const row of nodeIdRows) {
    nodeIdLookup.set(row.node_id, row.canonical_name)
  }

  const allNodes = nodeRows.map((row) => {
    const loc = parseLocation(row.location)
    const payload = parseMetadata(row.payload) as
      | { metadata?: Record<string, unknown> }
      | null
    const meta = payload?.metadata ?? {}
    return {
      id: row.canonical_name,
      kind: row.kind,
      file_path: loc.filePath ?? null,
      line: typeof loc.line === "number" ? loc.line : null,
      end_line:
        typeof (meta as { endLine?: unknown }).endLine === "number"
          ? Number((meta as { endLine?: number }).endLine)
          : null,
      line_count:
        typeof (meta as { lineCount?: unknown }).lineCount === "number"
          ? Number((meta as { lineCount?: number }).lineCount)
          : null,
      exported: (meta as { exported?: boolean }).exported === true,
      doc: (meta as { doc?: string }).doc ?? null,
      owning_class: (meta as { owningClass?: string }).owningClass ?? null,
    }
  })

  // Symbol-kind filter: drop nodes whose kind isn't in the set, and
  // build a survivor set so the edge filter below can drop edges
  // where either endpoint was filtered out.
  const nodes = filters.symbolKinds
    ? allNodes.filter((n) => filters.symbolKinds!.has(n.kind))
    : allNodes
  const survivingNodeIds = filters.symbolKinds
    ? new Set(nodes.map((n) => n.id))
    : null

  const edges = edgeRows
    .map((row) => {
      const src = nodeIdLookup.get(row.src_node_id)
      const dst = nodeIdLookup.get(row.dst_node_id)
      // Skip edges where src/dst doesn't resolve to a known node
      // (these are usually external/unresolved targets and don't
      // belong in a node-link graph). The visualizer can request
      // them separately via the query intents if needed.
      if (!src || !dst) return null
      // Edge-kind filter: drop edges whose kind isn't in the set
      if (filters.edgeKinds && !filters.edgeKinds.has(row.edge_kind)) {
        return null
      }
      // Symbol-kind filter cascade: drop edges that connect to a
      // node that was filtered out
      if (
        survivingNodeIds &&
        (!survivingNodeIds.has(src) || !survivingNodeIds.has(dst))
      ) {
        return null
      }
      const meta = parseMetadata(row.metadata)
      return {
        src,
        dst,
        kind: row.edge_kind,
        resolution_kind:
          (meta as { resolutionKind?: string } | null)?.resolutionKind ?? null,
        metadata: meta,
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  return {
    workspace,
    snapshot_id: snapshotId,
    nodes,
    edges,
  }
}
