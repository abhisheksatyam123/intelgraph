/**
 * snapshot-stats — print a per-workspace snapshot dashboard.
 *
 * Usage:
 *   bun run src/bin/snapshot-stats.ts <workspace-path>
 *   bun run src/bin/snapshot-stats.ts <workspace-path> --json
 *
 * Walks the workspace using every BUILT_IN extractor whose appliesTo
 * matches (ts-core, rust-core, clangd-core, …), then runs the most
 * useful query intents and prints a dashboard summarizing the snapshot:
 *
 *   - edge kind histogram
 *   - call resolution kind histogram
 *   - top imported modules (busy hubs)
 *   - top called functions
 *   - module entry points
 *   - dead exports (count only)
 *   - import cycles
 *   - largest modules
 *   - tightly coupled module pairs
 *   - god classes
 *   - external imports
 *
 * Exit code 0 on success, 1 on ingest or query error.
 */

import { existsSync } from "node:fs"
import { openSqlite } from "../intelligence/db/sqlite/client.js"
import { SqliteDbFoundation } from "../intelligence/db/sqlite/foundation.js"
import { SqliteGraphStore } from "../intelligence/db/sqlite/graph-store.js"
import { SqliteDbLookup } from "../intelligence/db/sqlite/db-lookup.js"
import {
  loadGraphJsonFromDb,
  type GraphJson,
  type GraphJsonFilters,
} from "../intelligence/db/sqlite/graph-export.js"
import { ExtractorRunner } from "../intelligence/extraction/runner.js"
import { BUILT_IN_EXTRACTORS } from "../plugins/index.js"
import type { ILanguageClient } from "../lsp/types.js"

// Re-export for back-compat — existing tests import GraphJson and
// GraphJsonFilters from this module.
export type { GraphJson, GraphJsonFilters }

const stubLsp = {
  root: "/tmp",
  openFile: async () => false,
  documentSymbol: async () => [],
  outgoingCalls: async () => [],
  incomingCalls: async () => [],
  references: async () => [],
  definition: async () => [],
} as unknown as ILanguageClient

interface CliOptions {
  workspace: string
  format: "text" | "json" | "markdown" | "graph-json"
  /** Comma-separated edge_kind filter for --graph-json. */
  edgeKinds?: Set<string>
  /** Comma-separated symbol kind filter for --graph-json. */
  symbolKinds?: Set<string>
  /** --center: anchor symbol to scope the graph around. */
  centerOf?: string
  /** --center-hops: max hop budget for --center (default 2). */
  centerHops?: number
  /** --center-direction: in | out | both (default both). */
  centerDirection?: "in" | "out" | "both"
  /** --max-nodes: cap the result to the top-N nodes by degree. */
  maxNodes?: number
  /** --data-path-from: source type for find_data_path subgraph filter. */
  dataPathFrom?: string
  /** --data-path-to: destination type for find_data_path subgraph filter. */
  dataPathTo?: string
  /** --data-path-depth: hop budget for the data-path BFS (default 6). */
  dataPathDepth?: number
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  const positionals: string[] = []
  let format: CliOptions["format"] = "text"
  let edgeKinds: Set<string> | undefined
  let symbolKinds: Set<string> | undefined
  let centerOf: string | undefined
  let centerHops: number | undefined
  let centerDirection: "in" | "out" | "both" | undefined
  let maxNodes: number | undefined
  let dataPathFrom: string | undefined
  let dataPathTo: string | undefined
  let dataPathDepth: number | undefined
  for (const arg of args) {
    if (arg === "--json") format = "json"
    else if (arg === "--markdown" || arg === "--md") format = "markdown"
    else if (arg === "--graph-json" || arg === "--graph") format = "graph-json"
    else if (arg === "--html") {
      // The --html mode moved to tui-relation-window/html-viewer/.
      // Print a friendly redirect instead of silently doing nothing.
      console.error(
        "snapshot-stats: --html has been moved to tui-relation-window/html-viewer/.\n" +
          "Use:\n" +
          "  intelgraph snapshot-stats <workspace> --graph-json |\\\n" +
          "    bun run /home/abhi/qprojects/tui-relation-window/html-viewer/render.ts > out.html\n" +
          "or import { graphJsonToHtml } from that module directly.",
      )
      process.exit(2)
    }
    else if (arg.startsWith("--filter-edge-kind=")) {
      const value = arg.replace("--filter-edge-kind=", "")
      edgeKinds = new Set(value.split(",").map((s) => s.trim()).filter(Boolean))
    } else if (arg.startsWith("--filter-symbol-kind=")) {
      const value = arg.replace("--filter-symbol-kind=", "")
      symbolKinds = new Set(value.split(",").map((s) => s.trim()).filter(Boolean))
    } else if (arg.startsWith("--center=")) {
      centerOf = arg.replace("--center=", "")
    } else if (arg.startsWith("--center-hops=")) {
      const n = Number(arg.replace("--center-hops=", ""))
      if (Number.isFinite(n) && n >= 1) centerHops = Math.floor(n)
    } else if (arg.startsWith("--center-direction=")) {
      const v = arg.replace("--center-direction=", "")
      if (v === "in" || v === "out" || v === "both") centerDirection = v
    } else if (arg.startsWith("--max-nodes=")) {
      const n = Number(arg.replace("--max-nodes=", ""))
      if (Number.isFinite(n) && n >= 1) maxNodes = Math.floor(n)
    } else if (arg.startsWith("--data-path-from=")) {
      dataPathFrom = arg.replace("--data-path-from=", "")
    } else if (arg.startsWith("--data-path-to=")) {
      dataPathTo = arg.replace("--data-path-to=", "")
    } else if (arg.startsWith("--data-path-depth=")) {
      const n = Number(arg.replace("--data-path-depth=", ""))
      if (Number.isFinite(n) && n >= 1) dataPathDepth = Math.floor(n)
    } else if (arg === "--help" || arg === "-h") {
      printUsage()
      process.exit(0)
    } else if (!arg.startsWith("--")) {
      positionals.push(arg)
    }
  }
  if (positionals.length === 0) {
    printUsage()
    process.exit(1)
  }
  return {
    workspace: positionals[0],
    format,
    edgeKinds,
    symbolKinds,
    centerOf,
    centerHops,
    centerDirection,
    maxNodes,
    dataPathFrom,
    dataPathTo,
    dataPathDepth,
  }
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run src/bin/snapshot-stats.ts <workspace-path> [options]",
      "",
      "Output formats:",
      "  --text         human-readable dashboard (default)",
      "  --json         summary stats as JSON",
      "  --markdown     PR-pasteable markdown report",
      "  --graph-json   full node-link graph for d3/cytoscape/sigma",
      "                 (--html viewer moved to tui-relation-window/",
      "                  html-viewer; pipe --graph-json into it)",
      "",
      "Graph-json filters (combine to subset the graph):",
      "  --filter-edge-kind=K,K     keep only these edge kinds",
      "                             (calls, imports, contains, extends,",
      "                              implements, references_type)",
      "  --filter-symbol-kind=K,K   keep only nodes of these kinds AND",
      "                             edges where both endpoints survive",
      "                             (module, function, class, interface,",
      "                              method, namespace, typedef, enum,",
      "                              global_var)",
      "  --center=<symbol>          scope to N-hop neighborhood of a symbol",
      "                             (matched exact / suffix-after-# /",
      "                              substring; e.g. --center=Greeter.greet)",
      "  --center-hops=<n>          hop budget for --center (default 2)",
      "  --center-direction=<dir>   direction of the BFS walk:",
      "                             both = everything related to X (default)",
      "                             out  = what X reaches (forward)",
      "                             in   = what reaches X (backward)",
      "  --max-nodes=<n>            cap result to top-N nodes by degree",
      "                             (applied last; useful for big workspaces",
      "                              where the unfiltered graph would be too",
      "                              dense for the force layout)",
      "  --data-path-from=<type>    BFS source for the find_data_path subgraph",
      "                             reducer (Phase 3h). Walks field_of_type +",
      "                             aggregates edges from this type to",
      "                             --data-path-to. Both flags must be set",
      "                             together. Resolved with the same forgiving",
      "                             match as --center.",
      "  --data-path-to=<type>      BFS destination for find_data_path.",
      "  --data-path-depth=<n>      Hop budget for the data-path BFS",
      "                             (default 6, max 20).",
    ].join("\n"),
  )
}

export interface Dashboard {
  workspace: string
  files_discovered: number
  total_nodes: number
  total_edges: number
  edge_kinds: Array<{ edge_kind: string; n: number }>
  resolution_kinds: Array<{ kind: string; n: number }>
  top_imported_modules: Array<{ name: string; incoming_count: number }>
  top_called_functions: Array<{ name: string; incoming_count: number }>
  largest_modules: Array<{ name: string; line_count: number }>
  tightly_coupled: Array<{
    src: string
    dst: string
    coupling_count: number
  }>
  cycles: Array<{ src: string; dst: string }>
  dead_exports_count: number
  undocumented_exports_count: number
  entry_points_count: number
  orphan_modules_count: number
  external_imports: Array<{ name: string; usage_count: number }>
  // Phase 3s: data-side health stats. These mirror the viewer
  // sidebar's Health badge so the CLI dashboard surfaces the same
  // signals (cycles + dead state) the interactive viewer shows.
  unused_fields_count: number
  call_cycles_count: number
  struct_cycles_count: number
  top_touched_types: Array<{ name: string; toucher_count: number; field_count: number }>
  top_field_writers: Array<{ name: string; field_count: number }>
  top_field_readers: Array<{ name: string; field_count: number }>
  // Phase 3t: field-level hot-spot ranking
  top_hot_fields: Array<{
    name: string
    toucher_count: number
    read_count: number
    write_count: number
  }>
  // Phase 3u: god classes by state size (contained field count)
  top_field_classes: Array<{ name: string; field_count: number }>
  // Phase 3v: data clumps — field pairs touched by the same methods
  field_clumps: Array<{ field_a: string; field_b: string; co_occurrence: number }>
  // Phase 3w: methods called by exactly one other method
  unique_callers_count: number
  // Phase 3x: directly self-recursive methods
  recursive_methods_count: number
}

export async function buildDashboard(workspace: string): Promise<Dashboard> {
  const client = openSqlite({ path: ":memory:" })
  try {
    const foundation = new SqliteDbFoundation(client.db, client.raw)
    await foundation.initSchema()
    const store = new SqliteGraphStore(client.db)
    const lookup = new SqliteDbLookup(client.db, client.raw)

    const ref = await foundation.beginSnapshot({
      workspaceRoot: workspace,
      compileDbHash: "snapshot-stats",
      parserVersion: "0.1.0",
    })
    const snapshotId = ref.snapshotId

    const runner = new ExtractorRunner({
      snapshotId,
      workspaceRoot: workspace,
      lsp: stubLsp,
      sink: store,
      plugins: BUILT_IN_EXTRACTORS,
    })
    const report = await runner.run()
    await foundation.commitSnapshot(snapshotId)

    // Sum files-discovered across every plugin that ran. Each plugin
    // emits its own counter (ts.files-discovered, rust.files-discovered,
    // files-discovered for clangd-core), so we accept any counter whose
    // name ends in "files-discovered".
    let filesDiscovered = 0
    for (const plugin of report.perPlugin) {
      const counters = plugin.metrics?.counters ?? {}
      for (const [key, value] of Object.entries(counters)) {
        if (key.endsWith("files-discovered") && typeof value === "number") {
          filesDiscovered += value
        }
      }
    }

    // Total counts
    const totalNodes = (
      client.raw
        .prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ?")
        .get(snapshotId) as { n: number }
    ).n
    const totalEdges = (
      client.raw
        .prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ?")
        .get(snapshotId) as { n: number }
    ).n

    // Edge kind histogram
    const edgeKinds = client.raw
      .prepare(
        `SELECT edge_kind, COUNT(*) AS n FROM graph_edges
         WHERE snapshot_id = ? GROUP BY edge_kind ORDER BY n DESC`,
      )
      .all(snapshotId) as Array<{ edge_kind: string; n: number }>

    // Resolution kind histogram (calls only)
    const resolutionKinds = client.raw
      .prepare(
        `SELECT json_extract(metadata, '$.resolutionKind') AS kind, COUNT(*) AS n
         FROM graph_edges
         WHERE snapshot_id = ? AND edge_kind = 'calls'
           AND json_extract(metadata, '$.resolutionKind') IS NOT NULL
         GROUP BY kind ORDER BY n DESC`,
      )
      .all(snapshotId) as Array<{ kind: string; n: number }>

    // Top intent results
    const topImported = await lookup.lookup({
      intent: "find_top_imported_modules",
      snapshotId,
      limit: 10,
    })
    const topCalled = await lookup.lookup({
      intent: "find_top_called_functions",
      snapshotId,
      limit: 10,
    })
    const largestMods = await lookup.lookup({
      intent: "find_largest_modules",
      snapshotId,
      limit: 10,
    })
    const tightlyCoupled = await lookup.lookup({
      intent: "find_tightly_coupled_modules",
      snapshotId,
      limit: 10,
    })
    const cycles = await lookup.lookup({
      intent: "find_import_cycles",
      snapshotId,
      limit: 20,
    })
    const deadExports = await lookup.lookup({
      intent: "find_dead_exports",
      snapshotId,
      limit: 1000,
    })
    const undocumented = await lookup.lookup({
      intent: "find_undocumented_exports",
      snapshotId,
      limit: 1000,
    })
    const entryPoints = await lookup.lookup({
      intent: "find_module_entry_points",
      snapshotId,
      limit: 1000,
    })
    const orphans = await lookup.lookup({
      intent: "find_orphan_modules",
      snapshotId,
      limit: 1000,
    })
    const external = await lookup.lookup({
      intent: "find_external_imports",
      snapshotId,
      limit: 15,
    })

    // Phase 3s: data-side health stats. Mirror the viewer sidebar's
    // Health badge so the CLI dashboard surfaces the same signals.
    const unusedFields = await lookup.lookup({
      intent: "find_unused_fields",
      snapshotId,
      limit: 1000,
    })
    const callCycles = await lookup.lookup({
      intent: "find_call_cycles",
      snapshotId,
      limit: 1000,
    })
    const structCycles = await lookup.lookup({
      intent: "find_struct_cycles",
      snapshotId,
      limit: 1000,
    })
    const topTouched = await lookup.lookup({
      intent: "find_top_touched_types",
      snapshotId,
      limit: 10,
    })
    const topWriters = await lookup.lookup({
      intent: "find_top_field_writers",
      snapshotId,
      limit: 10,
    })
    const topReaders = await lookup.lookup({
      intent: "find_top_field_readers",
      snapshotId,
      limit: 10,
    })
    const topHotFields = await lookup.lookup({
      intent: "find_top_hot_fields",
      snapshotId,
      limit: 10,
    })
    const topFieldClasses = await lookup.lookup({
      intent: "find_classes_by_field_count",
      snapshotId,
      limit: 10,
    })
    const fieldClumps = await lookup.lookup({
      intent: "find_field_co_access",
      snapshotId,
      limit: 10,
    })
    const uniqueCallers = await lookup.lookup({
      intent: "find_unique_callers",
      snapshotId,
      limit: 1000,
    })
    const recursiveMethods = await lookup.lookup({
      intent: "find_recursive_methods",
      snapshotId,
      limit: 1000,
    })

    return {
      workspace,
      files_discovered: filesDiscovered,
      total_nodes: totalNodes,
      total_edges: totalEdges,
      edge_kinds: edgeKinds,
      resolution_kinds: resolutionKinds,
      top_imported_modules: topImported.rows.map((r) => ({
        name: String(r.canonical_name),
        incoming_count: Number((r as { incoming_count?: number }).incoming_count),
      })),
      top_called_functions: topCalled.rows.map((r) => ({
        name: String(r.canonical_name),
        incoming_count: Number((r as { incoming_count?: number }).incoming_count),
      })),
      largest_modules: largestMods.rows.map((r) => ({
        name: String(r.canonical_name),
        line_count: Number((r as { line_count?: number }).line_count),
      })),
      tightly_coupled: tightlyCoupled.rows.map((r) => ({
        src: String(r.caller),
        dst: String(r.callee),
        coupling_count: Number((r as { coupling_count?: number }).coupling_count),
      })),
      cycles: cycles.rows.map((r) => ({
        src: String(r.caller),
        dst: String(r.callee),
      })),
      dead_exports_count: deadExports.rows.length,
      undocumented_exports_count: undocumented.rows.length,
      entry_points_count: entryPoints.rows.length,
      orphan_modules_count: orphans.rows.length,
      external_imports: external.rows.map((r) => ({
        name: String(r.canonical_name),
        usage_count: Number((r as { incoming_count?: number }).incoming_count),
      })),
      unused_fields_count: unusedFields.rows.length,
      call_cycles_count: callCycles.rows.length,
      struct_cycles_count: structCycles.rows.length,
      top_touched_types: topTouched.rows.map((r) => ({
        name: String(r.canonical_name),
        toucher_count: Number((r as { toucher_count?: number }).toucher_count),
        field_count: Number((r as { field_count?: number }).field_count),
      })),
      top_field_writers: topWriters.rows.map((r) => ({
        name: String(r.canonical_name),
        field_count: Number((r as { field_count?: number }).field_count),
      })),
      top_field_readers: topReaders.rows.map((r) => ({
        name: String(r.canonical_name),
        field_count: Number((r as { field_count?: number }).field_count),
      })),
      top_hot_fields: topHotFields.rows.map((r) => ({
        name: String(r.canonical_name),
        toucher_count: Number((r as { toucher_count?: number }).toucher_count),
        read_count: Number((r as { read_count?: number }).read_count),
        write_count: Number((r as { write_count?: number }).write_count),
      })),
      top_field_classes: topFieldClasses.rows.map((r) => ({
        name: String(r.canonical_name),
        field_count: Number((r as { field_count?: number }).field_count),
      })),
      field_clumps: fieldClumps.rows.map((r) => ({
        field_a: String((r as { caller?: string }).caller ?? r.canonical_name),
        field_b: String((r as { callee?: string }).callee ?? ""),
        co_occurrence: Number((r as { co_occurrence?: number }).co_occurrence),
      })),
      unique_callers_count: uniqueCallers.rows.length,
      recursive_methods_count: recursiveMethods.rows.length,
    }
  } finally {
    client.close()
  }
}

/**
 * Build the full node-link graph from a workspace snapshot. Used by
 * the --graph-json output mode and exported for direct programmatic
 * consumption (e.g. an HTTP wrapper or static-site generator).
 *
 * Optional filters subset the graph: edge-kind filtering keeps only
 * the specified edge kinds; symbol-kind filtering keeps only matching
 * nodes plus the edges where both endpoints survive.
 *
 * The SQL + filter logic lives in graph-export.ts so the new
 * `intelligence_graph` MCP tool can reuse it against an existing
 * snapshot without re-extracting.
 */
export async function buildGraphJson(
  workspace: string,
  filters: GraphJsonFilters = {},
): Promise<GraphJson> {
  const client = openSqlite({ path: ":memory:" })
  try {
    const foundation = new SqliteDbFoundation(client.db, client.raw)
    await foundation.initSchema()
    const store = new SqliteGraphStore(client.db)

    const ref = await foundation.beginSnapshot({
      workspaceRoot: workspace,
      compileDbHash: "snapshot-stats-graph",
      parserVersion: "0.1.0",
    })
    const snapshotId = ref.snapshotId

    const runner = new ExtractorRunner({
      snapshotId,
      workspaceRoot: workspace,
      lsp: stubLsp,
      sink: store,
      plugins: BUILT_IN_EXTRACTORS,
    })
    await runner.run()
    await foundation.commitSnapshot(snapshotId)

    return loadGraphJsonFromDb(client.raw, snapshotId, workspace, filters)
  } finally {
    client.close()
  }
}

function printDashboard(d: Dashboard): void {
  const line = "─".repeat(60)
  console.log(line)
  console.log(`Workspace: ${d.workspace}`)
  console.log(line)
  console.log(`Files discovered: ${d.files_discovered}`)
  console.log(`Total symbols:    ${d.total_nodes}`)
  console.log(`Total edges:      ${d.total_edges}`)
  console.log()
  console.log("Edge kinds:")
  for (const ek of d.edge_kinds) {
    console.log(`  ${ek.edge_kind.padEnd(20)} ${ek.n}`)
  }
  console.log()
  console.log("Call resolution kinds:")
  for (const rk of d.resolution_kinds) {
    console.log(`  ${(rk.kind ?? "(none)").padEnd(25)} ${rk.n}`)
  }
  console.log()
  console.log(`Entry points:        ${d.entry_points_count} modules`)
  console.log(`Orphan modules:      ${d.orphan_modules_count}`)
  console.log(`Dead exports:        ${d.dead_exports_count}`)
  console.log(`Undocumented exports: ${d.undocumented_exports_count}`)
  console.log(`Import 2-cycles:     ${d.cycles.length}`)
  console.log()
  // Phase 3s: data-side health stats
  console.log("Health (Phase 3 data-side):")
  console.log(`  Unused fields:       ${d.unused_fields_count}`)
  console.log(`  Call cycles:         ${d.call_cycles_count}`)
  console.log(`  Struct cycles:       ${d.struct_cycles_count}`)
  // Phase 3w/3x: refactor signals
  console.log(`  Inline candidates:   ${d.unique_callers_count}`)
  console.log(`  Self-recursive:      ${d.recursive_methods_count}`)
  console.log()
  if (d.top_imported_modules.length > 0) {
    console.log("Top imported modules:")
    for (const m of d.top_imported_modules) {
      console.log(`  ${m.incoming_count.toString().padStart(4)} ← ${m.name}`)
    }
    console.log()
  }
  if (d.top_called_functions.length > 0) {
    console.log("Top called functions:")
    for (const f of d.top_called_functions) {
      console.log(`  ${f.incoming_count.toString().padStart(4)} ← ${f.name}`)
    }
    console.log()
  }
  if (d.largest_modules.length > 0) {
    console.log("Largest modules:")
    for (const m of d.largest_modules) {
      console.log(`  ${m.line_count.toString().padStart(5)}L  ${m.name}`)
    }
    console.log()
  }
  if (d.tightly_coupled.length > 0) {
    console.log("Tightly coupled module pairs:")
    for (const c of d.tightly_coupled) {
      console.log(`  ${c.coupling_count.toString().padStart(4)}× ${c.src} ↔ ${c.dst}`)
    }
    console.log()
  }
  if (d.cycles.length > 0) {
    console.log("Import cycles (2-cycles):")
    for (const c of d.cycles) {
      console.log(`  ${c.src} ↔ ${c.dst}`)
    }
    console.log()
  }
  if (d.external_imports.length > 0) {
    console.log("Top external dependencies:")
    for (const e of d.external_imports) {
      console.log(`  ${e.usage_count.toString().padStart(4)}× ${e.name}`)
    }
    console.log()
  }
  if (d.top_touched_types.length > 0) {
    console.log("Top touched types (data hot spots):")
    for (const t of d.top_touched_types) {
      console.log(
        `  ${t.toucher_count.toString().padStart(4)} APIs · ` +
          `${t.field_count.toString().padStart(3)} fields  ${t.name}`,
      )
    }
    console.log()
  }
  if (d.top_field_writers.length > 0) {
    console.log("Top mutators (most distinct fields written):")
    for (const f of d.top_field_writers) {
      console.log(`  ${f.field_count.toString().padStart(4)}× ${f.name}`)
    }
    console.log()
  }
  if (d.top_field_readers.length > 0) {
    console.log("Top readers (most distinct fields read):")
    for (const f of d.top_field_readers) {
      console.log(`  ${f.field_count.toString().padStart(4)}× ${f.name}`)
    }
    console.log()
  }
  if (d.top_hot_fields.length > 0) {
    console.log("Top hot fields (most contended state):")
    for (const f of d.top_hot_fields) {
      console.log(
        `  ${f.toucher_count.toString().padStart(4)} APIs · ` +
          `R:${f.read_count.toString().padStart(3)} W:${f.write_count.toString().padStart(3)}  ${f.name}`,
      )
    }
    console.log()
  }
  if (d.top_field_classes.length > 0) {
    console.log("Top god classes by state size:")
    for (const c of d.top_field_classes) {
      console.log(`  ${c.field_count.toString().padStart(4)} fields  ${c.name}`)
    }
    console.log()
  }
  if (d.field_clumps.length > 0) {
    console.log("Data clumps (field pairs touched together):")
    for (const cp of d.field_clumps) {
      console.log(
        `  ${cp.co_occurrence.toString().padStart(3)}× ${cp.field_a} ↔ ${cp.field_b}`,
      )
    }
    console.log()
  }
  console.log(line)
}

/**
 * Render a Dashboard as a markdown report — same content as the
 * text format but with proper headings and tables, suitable for
 * sharing in PR descriptions, docs, or chat.
 */
export function dashboardToMarkdown(d: Dashboard): string {
  const lines: string[] = []
  lines.push(`# Snapshot stats — ${d.workspace}`)
  lines.push("")
  lines.push("## Overview")
  lines.push("")
  lines.push(`- Files discovered: **${d.files_discovered}**`)
  lines.push(`- Total symbols: **${d.total_nodes}**`)
  lines.push(`- Total edges: **${d.total_edges}**`)
  lines.push(`- Entry points: ${d.entry_points_count} modules`)
  lines.push(`- Orphan modules: ${d.orphan_modules_count}`)
  lines.push(`- Dead exports: ${d.dead_exports_count}`)
  lines.push(`- Undocumented exports: ${d.undocumented_exports_count}`)
  lines.push(`- Import 2-cycles: ${d.cycles.length}`)
  lines.push("")
  // Phase 3s: data-side health stats summary
  lines.push("## Health (data-side)")
  lines.push("")
  lines.push(`- Unused fields: **${d.unused_fields_count}**`)
  lines.push(`- Call cycles: **${d.call_cycles_count}**`)
  lines.push(`- Struct cycles: **${d.struct_cycles_count}**`)
  lines.push(`- Inline candidates: **${d.unique_callers_count}**`)
  lines.push(`- Self-recursive methods: **${d.recursive_methods_count}**`)
  lines.push("")
  if (d.edge_kinds.length > 0) {
    lines.push("## Edge kinds")
    lines.push("")
    lines.push("| edge_kind | count |")
    lines.push("|---|---:|")
    for (const ek of d.edge_kinds) {
      lines.push(`| ${ek.edge_kind} | ${ek.n} |`)
    }
    lines.push("")
  }
  if (d.resolution_kinds.length > 0) {
    lines.push("## Call resolution kinds")
    lines.push("")
    lines.push("| kind | count |")
    lines.push("|---|---:|")
    for (const rk of d.resolution_kinds) {
      lines.push(`| ${rk.kind ?? "(none)"} | ${rk.n} |`)
    }
    lines.push("")
  }
  if (d.top_imported_modules.length > 0) {
    lines.push("## Top imported modules")
    lines.push("")
    lines.push("| incoming | module |")
    lines.push("|---:|---|")
    for (const m of d.top_imported_modules) {
      lines.push(`| ${m.incoming_count} | \`${m.name}\` |`)
    }
    lines.push("")
  }
  if (d.top_called_functions.length > 0) {
    lines.push("## Top called functions")
    lines.push("")
    lines.push("| incoming | function |")
    lines.push("|---:|---|")
    for (const f of d.top_called_functions) {
      lines.push(`| ${f.incoming_count} | \`${f.name}\` |`)
    }
    lines.push("")
  }
  if (d.largest_modules.length > 0) {
    lines.push("## Largest modules")
    lines.push("")
    lines.push("| lines | module |")
    lines.push("|---:|---|")
    for (const m of d.largest_modules) {
      lines.push(`| ${m.line_count} | \`${m.name}\` |`)
    }
    lines.push("")
  }
  if (d.tightly_coupled.length > 0) {
    lines.push("## Tightly coupled module pairs")
    lines.push("")
    lines.push("| edges | src ↔ dst |")
    lines.push("|---:|---|")
    for (const c of d.tightly_coupled) {
      lines.push(`| ${c.coupling_count} | \`${c.src}\` ↔ \`${c.dst}\` |`)
    }
    lines.push("")
  }
  if (d.cycles.length > 0) {
    lines.push("## Import cycles (2-cycles)")
    lines.push("")
    for (const c of d.cycles) {
      lines.push(`- \`${c.src}\` ↔ \`${c.dst}\``)
    }
    lines.push("")
  }
  if (d.external_imports.length > 0) {
    lines.push("## Top external dependencies")
    lines.push("")
    lines.push("| uses | package |")
    lines.push("|---:|---|")
    for (const e of d.external_imports) {
      lines.push(`| ${e.usage_count} | \`${e.name}\` |`)
    }
    lines.push("")
  }
  if (d.top_touched_types.length > 0) {
    lines.push("## Top touched types")
    lines.push("")
    lines.push("| APIs | fields | type |")
    lines.push("|---:|---:|---|")
    for (const t of d.top_touched_types) {
      lines.push(`| ${t.toucher_count} | ${t.field_count} | \`${t.name}\` |`)
    }
    lines.push("")
  }
  if (d.top_field_writers.length > 0) {
    lines.push("## Top mutators")
    lines.push("")
    lines.push("| fields | method |")
    lines.push("|---:|---|")
    for (const f of d.top_field_writers) {
      lines.push(`| ${f.field_count} | \`${f.name}\` |`)
    }
    lines.push("")
  }
  if (d.top_field_readers.length > 0) {
    lines.push("## Top readers")
    lines.push("")
    lines.push("| fields | method |")
    lines.push("|---:|---|")
    for (const f of d.top_field_readers) {
      lines.push(`| ${f.field_count} | \`${f.name}\` |`)
    }
    lines.push("")
  }
  if (d.top_hot_fields.length > 0) {
    lines.push("## Top hot fields")
    lines.push("")
    lines.push("| APIs | reads | writes | field |")
    lines.push("|---:|---:|---:|---|")
    for (const f of d.top_hot_fields) {
      lines.push(
        `| ${f.toucher_count} | ${f.read_count} | ${f.write_count} | \`${f.name}\` |`,
      )
    }
    lines.push("")
  }
  if (d.top_field_classes.length > 0) {
    lines.push("## Top god classes by state")
    lines.push("")
    lines.push("| fields | class |")
    lines.push("|---:|---|")
    for (const c of d.top_field_classes) {
      lines.push(`| ${c.field_count} | \`${c.name}\` |`)
    }
    lines.push("")
  }
  if (d.field_clumps.length > 0) {
    lines.push("## Data clumps")
    lines.push("")
    lines.push("| co | field a ↔ field b |")
    lines.push("|---:|---|")
    for (const cp of d.field_clumps) {
      lines.push(`| ${cp.co_occurrence} | \`${cp.field_a}\` ↔ \`${cp.field_b}\` |`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

// ── HTML viewer moved out ───────────────────────────────────────────────────
//
// graphJsonToHtml() and VIEWER_PURE_JS used to live here. They were
// frontend code (the inlined d3-force HTML viewer) and have moved to
//
//   /home/abhi/qprojects/tui-relation-window/html-viewer/graph-to-html.ts
//
// for separation of concerns: this repo (intelgraph) is the backend
// (extraction, schema, query intents, MCP tools); tui-relation-window
// is the frontend / UI home. The two sides are coupled only through
// the GraphJson type exported from
//   src/intelligence/db/sqlite/graph-export.ts
//
// The CLI's --html flag has been removed. Use:
//
//   intelgraph snapshot-stats <ws> --graph-json |\
//     bun run /home/abhi/qprojects/tui-relation-window/html-viewer/render.ts > out.html
//
// or call graphJsonToHtml() directly from the html-viewer module.
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs()
  if (!existsSync(options.workspace)) {
    console.error(`Workspace not found: ${options.workspace}`)
    process.exit(1)
  }

  try {
    if (options.format === "graph-json") {
      // Skip the dashboard build for graph-json — go straight to
      // the full node/edge dump. Filter flags subset the graph
      // before serialization so the JSON is smaller.
      const graph = await buildGraphJson(options.workspace, {
        edgeKinds: options.edgeKinds,
        symbolKinds: options.symbolKinds,
        centerOf: options.centerOf,
        centerHops: options.centerHops,
        centerDirection: options.centerDirection,
        maxNodes: options.maxNodes,
        dataPathFrom: options.dataPathFrom,
        dataPathTo: options.dataPathTo,
        dataPathDepth: options.dataPathDepth,
      })
      console.log(JSON.stringify(graph, null, 2))
      return
    }

    // Note: --html mode moved to tui-relation-window/html-viewer/.
    // The argv parser above prints a redirect and exits when --html
    // is passed, so we never reach this point with format === "html".

    const dashboard = await buildDashboard(options.workspace)
    if (options.format === "json") {
      console.log(JSON.stringify(dashboard, null, 2))
    } else if (options.format === "markdown") {
      console.log(dashboardToMarkdown(dashboard))
    } else {
      printDashboard(dashboard)
    }
  } catch (err) {
    console.error("Failed:", err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

// Only run main() when this file is the entry point. Imports from
// tests should NOT trigger ingestion.
const isEntryPoint =
  typeof import.meta !== "undefined" &&
  // @ts-ignore — import.meta.main is bun/node-specific
  (import.meta.main === true ||
    (typeof process !== "undefined" &&
      process.argv[1] &&
      import.meta.url &&
      import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")))

if (isEntryPoint) {
  main()
}
