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
  format: "text" | "json" | "markdown" | "graph-json" | "html"
  /** Comma-separated edge_kind filter for --graph-json / --html. */
  edgeKinds?: Set<string>
  /** Comma-separated symbol kind filter for --graph-json / --html. */
  symbolKinds?: Set<string>
  /** --center: anchor symbol to scope the graph around. */
  centerOf?: string
  /** --center-hops: max hop budget for --center (default 2). */
  centerHops?: number
  /** --center-direction: in | out | both (default both). */
  centerDirection?: "in" | "out" | "both"
  /** --max-nodes: cap the result to the top-N nodes by degree. */
  maxNodes?: number
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
  for (const arg of args) {
    if (arg === "--json") format = "json"
    else if (arg === "--markdown" || arg === "--md") format = "markdown"
    else if (arg === "--graph-json" || arg === "--graph") format = "graph-json"
    else if (arg === "--html") format = "html"
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
      "  --html         self-contained HTML viewer (open in browser)",
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
  console.log(`2-cycles:            ${d.cycles.length}`)
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
  return lines.join("\n")
}

/**
 * Render a GraphJson as a single self-contained HTML document with
 * a d3-force layout. Pipe the output into a `.html` file and open
 * it in a browser — no build step, no dev server, no file:// CORS
 * issues. d3 is loaded from a pinned CDN URL.
 *
 * Interactivity:
 *   - drag nodes
 *   - zoom + pan
 *   - hover for symbol tooltip
 *   - click a node to highlight its 1-hop neighborhood
 *   - toggle edge kinds via the legend
 *   - search by canonical name
 */
export function graphJsonToHtml(graph: GraphJson): string {
  // Inline the graph data as a JSON literal. JSON is a strict
  // subset of JS, so this is a safe `<script>` body — but we still
  // escape `</` to defend against script-tag injection from rogue
  // canonical names.
  const dataLiteral = JSON.stringify(graph).replace(/<\//g, "<\\/")
  const title = `intelgraph — ${escapeHtml(graph.workspace)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root {
    --bg: #0f1117;
    --panel: #181b24;
    --border: #2a2f3d;
    --text: #d8def0;
    --muted: #8a93a6;
    --accent: #6ab1ff;
    --link: #3a4456;
    --link-active: #ffd86b;
  }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    overflow: hidden;
  }
  #app { display: flex; height: 100vh; }
  #sidebar {
    width: 280px;
    border-right: 1px solid var(--border);
    background: var(--panel);
    padding: 12px;
    overflow-y: auto;
    flex-shrink: 0;
  }
  #sidebar h1 {
    font-size: 14px;
    margin: 0 0 4px 0;
    font-weight: 600;
    color: var(--accent);
  }
  #sidebar .workspace { font-size: 11px; color: var(--muted); word-break: break-all; margin-bottom: 12px; }
  #sidebar h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 14px 0 6px 0;
    font-weight: 600;
  }
  #sidebar .stat { display: flex; justify-content: space-between; padding: 2px 0; font-variant-numeric: tabular-nums; }
  #sidebar .stat .label { color: var(--muted); }
  #sidebar input[type="search"] {
    width: 100%; box-sizing: border-box;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-size: 12px;
    margin-bottom: 8px;
  }
  #sidebar .legend-item, #sidebar .edge-toggle {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 0; cursor: pointer;
    user-select: none;
  }
  #sidebar .swatch {
    width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0;
  }
  #sidebar .swatch.line {
    height: 3px;
  }
  #sidebar .legend-item .count, #sidebar .edge-toggle .count {
    margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums;
  }
  #sidebar .disabled { opacity: 0.35; }
  #info {
    margin-top: 12px;
    padding: 8px; border: 1px solid var(--border); border-radius: 4px;
    font-size: 11px; min-height: 60px;
    background: var(--bg);
    word-break: break-all;
  }
  #info .empty { color: var(--muted); font-style: italic; }
  #info .row { margin: 2px 0; }
  #info .key { color: var(--muted); }
  #canvas-wrap { flex: 1; position: relative; }
  svg { width: 100%; height: 100%; display: block; }
  .node { stroke: #000; stroke-width: 0.5; cursor: pointer; }
  .node.dim { opacity: 0.12; }
  .node.hit { stroke: #fff; stroke-width: 1.5; }
  .node.focused { stroke: var(--link-active); stroke-width: 2; }
  .link { stroke-opacity: 0.45; fill: none; }
  .link.dim { stroke-opacity: 0.04; }
  .link.hit { stroke: var(--link-active); stroke-opacity: 0.85; }
  .arrowhead { fill-opacity: 0.5; }
  .arrowhead.hit { fill: var(--link-active); fill-opacity: 0.85; }
  .link.cycle { stroke: #ff5b6b; stroke-opacity: 0.85; stroke-width: 1.6; }
  .node.cycle { stroke: #ff5b6b; stroke-width: 1.5; }
  .link.path-on { stroke: #c792ea; stroke-opacity: 0.95; stroke-width: 2.4; }
  .node.path-on { stroke: #c792ea; stroke-width: 2.5; }
  #path-status {
    margin-top: 6px; font-size: 11px; color: var(--muted);
    min-height: 14px;
  }
  #path-status.ok { color: #9bd17f; }
  #path-status.fail { color: #ff5b6b; }
  #sidebar input[type="range"] {
    width: 100%; box-sizing: border-box;
    accent-color: var(--accent);
  }
  #sidebar .slider-row {
    display: flex; justify-content: space-between;
    font-size: 11px; color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  #sidebar .dir-row {
    display: flex; gap: 12px;
    font-size: 11px; color: var(--muted);
    margin: 6px 0 8px 0;
  }
  #sidebar .dir-row label {
    cursor: pointer; user-select: none;
    display: flex; gap: 4px; align-items: center;
  }
  #sidebar .dir-row input[type="radio"] {
    accent-color: var(--accent);
  }
  #sidebar button.preset {
    width: 100%; box-sizing: border-box;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-size: 12px; cursor: pointer;
    text-align: left;
    margin-bottom: 4px;
  }
  #sidebar button.preset:hover {
    border-color: var(--accent); color: var(--accent);
  }
  #sidebar .hub-row {
    display: flex; gap: 6px; align-items: baseline;
    font-size: 11px; padding: 2px 0;
    cursor: pointer; user-select: none;
  }
  #sidebar .hub-row:hover { color: var(--accent); }
  #sidebar .hub-row .deg {
    color: var(--muted); font-variant-numeric: tabular-nums;
    width: 28px; text-align: right; flex-shrink: 0;
  }
  #sidebar .hub-row .name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0;
  }
  .label {
    font-size: 9px;
    fill: var(--text);
    pointer-events: none;
    text-shadow: 0 0 2px var(--bg), 0 0 2px var(--bg);
  }
  #toolbar {
    position: absolute; top: 8px; right: 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 11px;
    color: var(--muted);
  }
  #toolbar kbd {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 2px; padding: 1px 4px; font-family: inherit;
  }
  #badge {
    position: absolute; bottom: 8px; right: 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <h1>intelgraph</h1>
    <div class="workspace">${escapeHtml(graph.workspace)}</div>

    <h2>Stats</h2>
    <div class="stat"><span class="label">nodes</span><span id="stat-nodes">0</span></div>
    <div class="stat"><span class="label">edges</span><span id="stat-edges">0</span></div>
    <div class="stat"><span class="label">visible</span><span id="stat-visible">0</span></div>

    <h2>Search</h2>
    <input id="search" type="search" placeholder="canonical name…" />

    <h2>Focus depth</h2>
    <input id="hop-slider" type="range" min="1" max="4" value="1" step="1" />
    <div class="slider-row">
      <span>1 hop</span>
      <span id="hop-value">1</span>
      <span>4 hops</span>
    </div>
    <div class="dir-row">
      <label><input type="radio" name="dir" value="both" checked> both</label>
      <label><input type="radio" name="dir" value="out"> out</label>
      <label><input type="radio" name="dir" value="in"> in</label>
    </div>
    <button class="preset" id="center-on-focused">Center on focused (live)</button>
    <button class="preset" id="clear-center">Show full graph</button>

    <h2>Cycles</h2>
    <div class="legend-item" id="cycle-toggle">
      <div class="swatch" style="background:#ff5b6b"></div>
      <div>highlight 2-cycles</div>
      <div class="count" id="cycle-count">0</div>
    </div>

    <h2>Tint by directory</h2>
    <div class="legend-item" id="tint-toggle">
      <div class="swatch" style="background:linear-gradient(90deg,#6ab1ff,#9bd17f,#ffb86b,#c792ea)"></div>
      <div>color stroke by parent dir</div>
      <div class="count" id="tint-count">0</div>
    </div>

    <h2>Quick views</h2>
    <button class="preset" id="preset-modules">Module dependency view</button>
    <button class="preset" id="preset-reset">Reset all filters</button>

    <h2>Find path</h2>
    <input id="path-from" type="search" placeholder="from (canonical name)" />
    <input id="path-to" type="search" placeholder="to (canonical name)" />
    <button class="preset" id="path-find">Find shortest path</button>
    <div id="path-status"></div>

    <h2>Top imported modules</h2>
    <div id="top-imported"></div>

    <h2>Top called functions</h2>
    <div id="top-called"></div>

    <h2>Symbol kinds</h2>
    <div id="kind-legend"></div>

    <h2>Edge kinds</h2>
    <div id="edge-legend"></div>

    <h2>Selection</h2>
    <div id="info"><span class="empty">click a node</span></div>
  </aside>
  <div id="canvas-wrap">
    <svg id="canvas"></svg>
    <div id="toolbar">scroll = zoom · drag = pan · click = focus · <kbd>esc</kbd> = clear</div>
    <div id="badge"><span id="badge-text">0 nodes / 0 edges</span></div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script>
const data = ${dataLiteral};
const KIND_COLORS = {
  module:     "#6ab1ff",
  function:   "#9bd17f",
  method:     "#7fc6c0",
  class:      "#ffb86b",
  struct:     "#ff8a65",
  interface:  "#c792ea",
  enum:       "#e5c07b",
  typedef:    "#82aaff",
  namespace:  "#f78c6c",
  global_var: "#a3a8b8",
};
const EDGE_COLORS = {
  imports:         "#6ab1ff",
  contains:        "#5a6378",
  calls:           "#9bd17f",
  references_type: "#c792ea",
  implements:      "#e5c07b",
  extends:         "#ff8a65",
};
function colorFor(kind, table, fallback) {
  return table[kind] || fallback;
}

const svg = d3.select("#canvas");
const wrap = document.getElementById("canvas-wrap");
const width  = () => wrap.clientWidth;
const height = () => wrap.clientHeight;

// Per-edge-kind arrowhead markers, so directed edges can show
// direction without us hand-rolling triangle paths. d3 auto-orients
// markerUnits=strokeWidth so the arrow scales with the link.
const defs = svg.append("defs");
const ARROW_KINDS = Object.keys(EDGE_COLORS).concat(["__default", "__hit"]);
for (const k of ARROW_KINDS) {
  const fill =
    k === "__hit" ? "#ffd86b" :
    k === "__default" ? "#5a6378" :
    EDGE_COLORS[k];
  defs.append("marker")
    .attr("id", "arrow-" + k)
    .attr("class", "arrowhead")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 12)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .attr("markerUnits", "strokeWidth")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", fill);
}

const root = svg.append("g");
const linkLayer  = root.append("g").attr("class", "links");
const nodeLayer  = root.append("g").attr("class", "nodes");
const labelLayer = root.append("g").attr("class", "labels");

const zoom = d3.zoom().scaleExtent([0.1, 8]).on("zoom", (ev) => {
  root.attr("transform", ev.transform);
  // hide labels when zoomed out
  labelLayer.style("display", ev.transform.k > 1.6 ? "block" : "none");
});
svg.call(zoom);

// Index nodes by id and build d3 link objects
const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
const links = data.edges
  .filter((e) => nodeById.has(e.src) && nodeById.has(e.dst))
  .map((e) => ({ source: e.src, target: e.dst, kind: e.kind }));

// Build directed in/out adjacency for multi-hop expansion + degree
// counts. successors[id] = Set of nodes this id points TO via any
// edge; predecessors[id] = Set of nodes that point AT this id.
const successors = new Map();
const predecessors = new Map();
for (const n of data.nodes) {
  successors.set(n.id, new Set());
  predecessors.set(n.id, new Set());
}
for (const l of links) {
  successors.get(l.source).add(l.target);
  predecessors.get(l.target).add(l.source);
}
// Walk direction for neighborhood expansion. Mirrors the server-side
// centerDirection contract:
//   "both" → undirected (successors ∪ predecessors), "everything related"
//   "out"  → forward only (successors), "what X reaches"
//   "in"   → backward only (predecessors), "what reaches X"
let walkDirection = "both";

function neighborhood(rootId, hops, direction) {
  // K-hop BFS in the requested direction. Defaults to the current
  // walkDirection state when no explicit direction is passed.
  const dir = direction || walkDirection;
  const walkOut = dir === "out" || dir === "both";
  const walkIn = dir === "in" || dir === "both";
  const seen = new Set([rootId]);
  let frontier = [rootId];
  for (let i = 0; i < hops; i++) {
    const next = [];
    for (const id of frontier) {
      if (walkOut) {
        const out = successors.get(id);
        if (out) for (const t of out) if (!seen.has(t)) { seen.add(t); next.push(t); }
      }
      if (walkIn) {
        const inn = predecessors.get(id);
        if (inn) for (const t of inn) if (!seen.has(t)) { seen.add(t); next.push(t); }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return seen;
}

document.getElementById("stat-nodes").textContent = data.nodes.length;
document.getElementById("stat-edges").textContent = links.length;

// Detect 2-cycles by edge_kind: any pair (a,b) where a→b AND b→a via
// the same kind. Reported as a Set of "kind|a|b" strings (a < b
// lexicographically, so each cycle appears once). We detect across
// every edge_kind so the user sees imports cycles, calls cycles, and
// references_type cycles uniformly. Used to color the offending nodes
// and edges in red.
const cycleNodes = new Set();
const cycleEdgeKeys = new Set();
{
  const keyOf = (kind, s, t) => kind + "|" + s + "|" + t;
  const have = new Set();
  for (const l of links) have.add(keyOf(l.kind, l.source, l.target));
  for (const l of links) {
    if (have.has(keyOf(l.kind, l.target, l.source))) {
      // Mark both directions as cycle edges
      cycleEdgeKeys.add(keyOf(l.kind, l.source, l.target));
      cycleEdgeKeys.add(keyOf(l.kind, l.target, l.source));
      cycleNodes.add(l.source);
      cycleNodes.add(l.target);
    }
  }
}
document.getElementById("cycle-count").textContent = cycleNodes.size;

// Active filters
const activeKinds = new Set(data.nodes.map((n) => n.kind));
const activeEdgeKinds = new Set(links.map((l) => l.kind));
let cyclesOn = false;
let tintOn = false;

// Directory tint: hash each node's parent directory to a stable hue
// in the HSL wheel. Used as the stroke color when "tint by directory"
// is on, so the kind color (fill) and subsystem cue (stroke) are
// readable simultaneously. Computed once at init.
function dirOf(filePath) {
  if (!filePath) return "";
  const slash = filePath.lastIndexOf("/");
  return slash >= 0 ? filePath.substring(0, slash) : "";
}
function hashHue(s) {
  // Simple FNV-1a-style hash → 0..359 hue
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h % 360;
}
const dirHueByNode = new Map();
const distinctDirs = new Set();
for (const n of data.nodes) {
  const d = dirOf(n.file_path);
  if (d) {
    distinctDirs.add(d);
    dirHueByNode.set(n.id, "hsl(" + hashHue(d) + ",55%,55%)");
  }
}
document.getElementById("tint-count").textContent = distinctDirs.size;

const sim = d3.forceSimulation(data.nodes)
  .force("link", d3.forceLink(links).id((d) => d.id).distance(40).strength(0.5))
  .force("charge", d3.forceManyBody().strength(-90))
  .force("center", d3.forceCenter(width() / 2, height() / 2))
  .force("collide", d3.forceCollide().radius(7));

let linkSel = linkLayer.selectAll("line");
let nodeSel = nodeLayer.selectAll("circle");
let labelSel = labelLayer.selectAll("text");

function shortName(id) {
  const hash = id.indexOf("#");
  if (hash >= 0) return id.substring(hash + 1);
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.substring(slash + 1) : id;
}

function radiusFor(d) {
  if (d.kind === "module") return 6;
  if (d.kind === "class" || d.kind === "struct" || d.kind === "interface") return 5;
  return 3.5;
}

// Live center filter: when set, render() drops nodes outside this
// set in addition to the kind filter. Populated by the "Center on
// focused" button from the focused node's k-hop neighborhood,
// where k is the current hop slider value. Cleared by "Show full
// graph" or by entering a fresh search query.
let centerSet = null;

function render() {
  const visibleNodes = data.nodes.filter((n) => {
    if (!activeKinds.has(n.kind)) return false;
    if (centerSet && !centerSet.has(n.id)) return false;
    return true;
  });
  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const visibleLinks = links.filter(
    (l) =>
      activeEdgeKinds.has(l.kind) &&
      visibleNodeIds.has(typeof l.source === "object" ? l.source.id : l.source) &&
      visibleNodeIds.has(typeof l.target === "object" ? l.target.id : l.target),
  );

  document.getElementById("stat-visible").textContent =
    visibleNodes.length + " / " + visibleLinks.length;
  if (typeof updateBadge === "function") {
    updateBadge(visibleNodes.length, visibleLinks.length);
  }

  linkSel = linkLayer
    .selectAll("line")
    .data(visibleLinks, (d) => (typeof d.source === "object" ? d.source.id : d.source) + "→" + (typeof d.target === "object" ? d.target.id : d.target) + ":" + d.kind)
    .join("line")
    .attr("class", (d) => {
      const s = typeof d.source === "object" ? d.source.id : d.source;
      const t = typeof d.target === "object" ? d.target.id : d.target;
      const isCycle = cyclesOn && cycleEdgeKeys.has(d.kind + "|" + s + "|" + t);
      const isPath = pathEdgeKeys.has(d.kind + "|" + s + "|" + t);
      let cls = "link";
      if (isCycle) cls += " cycle";
      if (isPath) cls += " path-on";
      return cls;
    })
    .attr("stroke", (d) => colorFor(d.kind, EDGE_COLORS, "#5a6378"))
    .attr("stroke-width", (d) => (d.kind === "calls" ? 1.2 : 0.8))
    .attr("marker-end", (d) =>
      EDGE_COLORS[d.kind] ? "url(#arrow-" + d.kind + ")" : "url(#arrow-__default)");

  nodeSel = nodeLayer
    .selectAll("circle")
    .data(visibleNodes, (d) => d.id)
    .join("circle")
    .attr("class", (d) => {
      let cls = "node";
      if (cyclesOn && cycleNodes.has(d.id)) cls += " cycle";
      if (pathNodes.has(d.id)) cls += " path-on";
      return cls;
    })
    .attr("r", radiusFor)
    .attr("fill", (d) => colorFor(d.kind, KIND_COLORS, "#a3a8b8"))
    .attr("stroke", (d) => {
      // .cycle class wins (set in CSS), then directory tint, then default.
      if (cyclesOn && cycleNodes.has(d.id)) return null;
      if (tintOn) return dirHueByNode.get(d.id) || "#000";
      return null;
    })
    .attr("stroke-width", (d) => (tintOn && dirHueByNode.has(d.id) ? 1.5 : 0.5))
    .on("click", onClick)
    .on("mouseover", onHover)
    .call(
      d3.drag()
        .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end",   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }),
    );

  labelSel = labelLayer
    .selectAll("text")
    .data(visibleNodes, (d) => d.id)
    .join("text")
    .attr("class", "label")
    .attr("dx", 7)
    .attr("dy", 3)
    .text((d) => shortName(d.id));

  sim.nodes(visibleNodes);
  sim.force("link").links(visibleLinks);
  sim.alpha(0.6).restart();
}

sim.on("tick", () => {
  linkSel
    .attr("x1", (d) => d.source.x)
    .attr("y1", (d) => d.source.y)
    .attr("x2", (d) => d.target.x)
    .attr("y2", (d) => d.target.y);
  nodeSel.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
  labelSel.attr("x", (d) => d.x).attr("y", (d) => d.y);
});

let focused = null;
let hopDepth = 1;
function onClick(ev, d) {
  ev.stopPropagation();
  focused = focused === d.id ? null : d.id;
  applyFocus();
  showInfo(d);
  saveHashState();
}
function onHover(ev, d) {
  if (!focused) showInfo(d);
}
svg.on("click", () => { focused = null; applyFocus(); clearInfo(); saveHashState(); });
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") { focused = null; applyFocus(); clearInfo(); saveHashState(); }
});

// ── URL hash state ──────────────────────────────────────────────────────────
// The viewer persists discrete UI state (focused node, hop depth, the
// cycle/tint toggles, and the active kind/edge filters) into the URL
// hash so users can bookmark or share specific views. The continuous
// zoom transform is excluded — it changes too often to be useful in
// the URL bar and would noisily push history entries.
function saveHashState() {
  const params = new URLSearchParams();
  if (focused) params.set("f", focused);
  if (hopDepth !== 1) params.set("h", String(hopDepth));
  if (walkDirection !== "both") params.set("d", walkDirection);
  if (cyclesOn) params.set("c", "1");
  if (tintOn) params.set("t", "1");
  if (centerSet) params.set("cm", "1");
  // Only encode kind filters when they don't match the full set
  const allKinds = new Set(data.nodes.map((n) => n.kind));
  if (activeKinds.size !== allKinds.size) {
    params.set("k", [...activeKinds].sort().join(","));
  }
  const allEdgeKinds = new Set(links.map((l) => l.kind));
  if (activeEdgeKinds.size !== allEdgeKinds.size) {
    params.set("e", [...activeEdgeKinds].sort().join(","));
  }
  const next = params.toString();
  // history.replaceState avoids spamming the back button with every click
  if (next !== (window.location.hash || "").slice(1)) {
    history.replaceState(null, "", next ? "#" + next : window.location.pathname);
  }
}
function loadHashState() {
  const raw = (window.location.hash || "").slice(1);
  if (!raw) return;
  const params = new URLSearchParams(raw);
  const f = params.get("f");
  if (f && nodeById.has(f)) focused = f;
  const h = Number(params.get("h"));
  if (h >= 1 && h <= 4) {
    hopDepth = h;
    document.getElementById("hop-slider").value = String(h);
    document.getElementById("hop-value").textContent = String(h);
  }
  const d = params.get("d");
  if (d === "in" || d === "out" || d === "both") {
    walkDirection = d;
    for (const radio of document.querySelectorAll('input[name="dir"]')) {
      radio.checked = radio.value === d;
    }
  }
  if (params.get("c") === "1") {
    cyclesOn = true;
    document.getElementById("cycle-toggle").classList.remove("disabled");
  }
  if (params.get("t") === "1") {
    tintOn = true;
    document.getElementById("tint-toggle").classList.remove("disabled");
  }
  // Live center filter: if cm=1 is in the hash AND f resolved to a
  // valid node, recompute the centerSet from the focused node's
  // neighborhood at the current hop depth. We can't store the full
  // ID set in the URL — it would explode for big graphs — so we
  // store just the flag and recompute.
  if (params.get("cm") === "1" && focused) {
    centerSet = neighborhood(focused, hopDepth);
  }
  const k = params.get("k");
  if (k) {
    activeKinds.clear();
    for (const part of k.split(",")) if (part) activeKinds.add(part);
  }
  const e = params.get("e");
  if (e) {
    activeEdgeKinds.clear();
    for (const part of e.split(",")) if (part) activeEdgeKinds.add(part);
  }
}

// Hop-depth slider — re-applies focus on change so the highlighted
// neighborhood expands/contracts live.
const hopSlider = document.getElementById("hop-slider");
const hopValue = document.getElementById("hop-value");
hopSlider.addEventListener("input", (ev) => {
  hopDepth = Number(ev.target.value);
  hopValue.textContent = String(hopDepth);
  if (focused) applyFocus();
  // If the live center filter is active, recompute it for the
  // new depth so the visible set tracks the slider live.
  if (centerSet && focused) {
    centerSet = neighborhood(focused, hopDepth);
    render();
  }
  saveHashState();
});

// Direction radio — switches the BFS walk to forward / backward / both.
// Re-applies focus so the highlighted set updates immediately, and
// rebuilds the live center filter if it's active.
for (const radio of document.querySelectorAll('input[name="dir"]')) {
  radio.addEventListener("change", (ev) => {
    walkDirection = ev.target.value;
    if (focused) applyFocus();
    if (centerSet && focused) {
      centerSet = neighborhood(focused, hopDepth);
      render();
    }
    saveHashState();
  });
}

// Cycle-highlight toggle — re-renders so node + link classes pick up
// the cycle marking. The cycle sets are precomputed once at init,
// the toggle just controls whether the .cycle class is applied.
const cycleToggle = document.getElementById("cycle-toggle");
cycleToggle.addEventListener("click", () => {
  cyclesOn = !cyclesOn;
  cycleToggle.classList.toggle("disabled", !cyclesOn);
  render();
  saveHashState();
});
// Start in the disabled visual state so users see the count first
cycleToggle.classList.add("disabled");

// Directory-tint toggle — same shape as the cycle toggle.
const tintToggle = document.getElementById("tint-toggle");
tintToggle.addEventListener("click", () => {
  tintOn = !tintOn;
  tintToggle.classList.toggle("disabled", !tintOn);
  render();
  saveHashState();
});
tintToggle.classList.add("disabled");

function applyFocus() {
  if (!focused) {
    nodeSel.classed("dim", false).classed("hit", false).classed("focused", false);
    linkSel.classed("dim", false).classed("hit", false);
    return;
  }
  const nbrs = neighborhood(focused, hopDepth);
  nodeSel
    .classed("dim", (d) => !nbrs.has(d.id))
    .classed("hit", (d) => nbrs.has(d.id) && d.id !== focused)
    .classed("focused", (d) => d.id === focused);
  linkSel
    .classed("dim", (l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return !(nbrs.has(s) && nbrs.has(t));
    })
    .classed("hit", (l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return nbrs.has(s) && nbrs.has(t) && (s === focused || t === focused);
    });
}

function showInfo(d) {
  const info = document.getElementById("info");
  const inDeg = (predecessors.get(d.id) || new Set()).size;
  const outDeg = (successors.get(d.id) || new Set()).size;
  const rows = [
    ["id",         d.id],
    ["kind",       d.kind],
    ["file",       d.file_path || "—"],
    ["line",       d.line ?? "—"],
    ["lines",      d.line_count ?? "—"],
    ["in-degree",  inDeg],
    ["out-degree", outDeg],
    ["exported",   d.exported ? "yes" : "no"],
    ["owning",     d.owning_class || "—"],
  ];
  info.innerHTML = rows
    .map((r) => '<div class="row"><span class="key">' + r[0] + '</span> ' + escapeHtml(String(r[1])) + '</div>')
    .join("");
}
function clearInfo() {
  document.getElementById("info").innerHTML = '<span class="empty">click a node</span>';
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Build legends
function buildKindLegend() {
  const counts = {};
  for (const n of data.nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const container = document.getElementById("kind-legend");
  container.innerHTML = "";
  for (const [kind, n] of sorted) {
    const div = document.createElement("div");
    div.className = "legend-item";
    div.innerHTML =
      '<div class="swatch" style="background:' + colorFor(kind, KIND_COLORS, "#a3a8b8") + '"></div>' +
      '<div>' + escapeHtml(kind) + '</div>' +
      '<div class="count">' + n + '</div>';
    if (!activeKinds.has(kind)) div.classList.add("disabled");
    div.onclick = () => {
      if (activeKinds.has(kind)) activeKinds.delete(kind);
      else activeKinds.add(kind);
      div.classList.toggle("disabled", !activeKinds.has(kind));
      render();
      saveHashState();
    };
    container.appendChild(div);
  }
}
function buildEdgeLegend() {
  const counts = {};
  for (const l of links) counts[l.kind] = (counts[l.kind] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const container = document.getElementById("edge-legend");
  container.innerHTML = "";
  for (const [kind, n] of sorted) {
    const div = document.createElement("div");
    div.className = "edge-toggle";
    div.innerHTML =
      '<div class="swatch line" style="background:' + colorFor(kind, EDGE_COLORS, "#5a6378") + '"></div>' +
      '<div>' + escapeHtml(kind) + '</div>' +
      '<div class="count">' + n + '</div>';
    if (!activeEdgeKinds.has(kind)) div.classList.add("disabled");
    div.onclick = () => {
      if (activeEdgeKinds.has(kind)) activeEdgeKinds.delete(kind);
      else activeEdgeKinds.add(kind);
      div.classList.toggle("disabled", !activeEdgeKinds.has(kind));
      render();
      saveHashState();
    };
    container.appendChild(div);
  }
}
// ── Top-hubs panels ─────────────────────────────────────────────────────────
// Surface the most-imported modules and most-called functions in the
// sidebar so users have one-click entry points into the busiest parts
// of the graph. The data is already inlined as the links array, so we
// compute the rankings client-side at init.
function buildHubPanel(containerId, edgeKind, validNodeKinds) {
  const incoming = new Map();
  for (const l of links) {
    if (l.kind !== edgeKind) continue;
    incoming.set(l.target, (incoming.get(l.target) || 0) + 1);
  }
  const ranked = [];
  for (const [id, count] of incoming) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (validNodeKinds && !validNodeKinds.has(node.kind)) continue;
    ranked.push({ id, count, node });
  }
  ranked.sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, 8);
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (top.length === 0) {
    container.innerHTML = '<div class="hub-row" style="cursor:default"><div class="name" style="color:var(--muted);font-style:italic">none</div></div>';
    return;
  }
  for (const hub of top) {
    const row = document.createElement("div");
    row.className = "hub-row";
    row.title = hub.id;
    row.innerHTML =
      '<div class="deg">' + hub.count + '</div>' +
      '<div class="name">' + escapeHtml(shortName(hub.id)) + '</div>';
    row.onclick = () => {
      focused = hub.id;
      applyFocus();
      showInfo(hub.node);
      saveHashState();
    };
    container.appendChild(row);
  }
}

// ── Quick-view presets ──────────────────────────────────────────────────────
// One-click filter combinations for the most useful subgraphs.
function applyModuleDepView() {
  // Module-only nodes, imports-only edges. The canonical "package
  // dependency" view that the snapshot-stats CLI exposes via
  // --filter-edge-kind=imports --filter-symbol-kind=module.
  activeKinds.clear();
  activeKinds.add("module");
  activeEdgeKinds.clear();
  activeEdgeKinds.add("imports");
  buildKindLegend();
  buildEdgeLegend();
  render();
  saveHashState();
}
function applyResetView() {
  activeKinds.clear();
  for (const n of data.nodes) activeKinds.add(n.kind);
  activeEdgeKinds.clear();
  for (const l of links) activeEdgeKinds.add(l.kind);
  focused = null;
  buildKindLegend();
  buildEdgeLegend();
  applyFocus();
  clearInfo();
  render();
  saveHashState();
}
document.getElementById("preset-modules").addEventListener("click", applyModuleDepView);
document.getElementById("preset-reset").addEventListener("click", applyResetView);

// Path-finding wiring: button click + Enter-key in either input.
document.getElementById("path-find").addEventListener("click", findAndShowPath);
for (const id of ["path-from", "path-to"]) {
  document.getElementById(id).addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") findAndShowPath();
  });
}
// Also clear the path when Reset is clicked.
document.getElementById("preset-reset").addEventListener("click", clearPath);

// Live center filter: take the focused node's k-hop neighborhood
// and use it as a hard visibility filter. This is the inline
// counterpart to the CLI / MCP centerOf flag — same effect, but
// reversible at any time and computed against the inlined data.
document.getElementById("center-on-focused").addEventListener("click", () => {
  if (!focused) {
    document.getElementById("info").innerHTML =
      '<span class="empty">click a node first, then center</span>';
    return;
  }
  centerSet = neighborhood(focused, hopDepth);
  render();
  saveHashState();
});
document.getElementById("clear-center").addEventListener("click", () => {
  centerSet = null;
  render();
  saveHashState();
});
// Also clear the center filter when "Reset all filters" is clicked.
document.getElementById("preset-reset").addEventListener("click", () => {
  centerSet = null;
});

// ── Live stats badge ────────────────────────────────────────────────────────
// Updates after every render() so users see exactly how their filter
// choices change the visible counts.
//
// When the result was filtered server-side (centerOf, maxNodes, etc.),
// the GraphJson carries the pre-filter totals so we can show
// "<visible> of <total>" instead of just the visible count. This
// makes truncation visible to the user — if they ran
// --max-nodes=300 against a 20K-node workspace, the badge will say
// "300 of 20466 nodes" so they know how much was hidden.
const TOTAL_NODES = data.total_nodes ?? data.nodes.length;
const TOTAL_EDGES = data.total_edges ?? links.length;
function fmtBadgePart(visible, total, label) {
  if (total > visible) return visible + " of " + total + " " + label;
  return visible + " " + label;
}
function updateBadge(visibleNodeCount, visibleEdgeCount) {
  document.getElementById("badge-text").textContent =
    fmtBadgePart(visibleNodeCount, TOTAL_NODES, "nodes") +
    " / " +
    fmtBadgePart(visibleEdgeCount, TOTAL_EDGES, "edges");
}

// ── Path finding ────────────────────────────────────────────────────────────
// Shortest src→dst path over the directed successors map. BFS, returns
// the ordered node-id sequence or null if no path exists. Pure client-
// side computation on the inlined adjacency — no MCP round-trip.
//
// Path state is stored as a Set of node ids and a Set of edge keys
// (kind|s|t) so the render() pass can paint .path-on classes without
// disturbing the existing focused/cycle/dim state.
const pathNodes = new Set();
const pathEdgeKeys = new Set();
function shortestPath(srcId, dstId) {
  if (!nodeById.has(srcId) || !nodeById.has(dstId)) return null;
  if (srcId === dstId) return [srcId];
  const prev = new Map();
  prev.set(srcId, null);
  const queue = [srcId];
  while (queue.length > 0) {
    const cur = queue.shift();
    const out = successors.get(cur);
    if (!out) continue;
    for (const next of out) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === dstId) {
        // Reconstruct
        const trail = [next];
        let walk = cur;
        while (walk !== null && walk !== undefined) {
          trail.push(walk);
          walk = prev.get(walk) ?? null;
        }
        return trail.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}
function resolveSymbol(query) {
  // Match strategies, in order: exact, suffix (#name), substring.
  if (!query) return null;
  if (nodeById.has(query)) return query;
  for (const id of nodeById.keys()) {
    if (id.endsWith("#" + query)) return id;
  }
  for (const id of nodeById.keys()) {
    if (id.includes(query)) return id;
  }
  return null;
}
function clearPath() {
  pathNodes.clear();
  pathEdgeKeys.clear();
  document.getElementById("path-status").textContent = "";
  document.getElementById("path-status").className = "";
  render();
}
function findAndShowPath() {
  const fromQ = document.getElementById("path-from").value.trim();
  const toQ = document.getElementById("path-to").value.trim();
  const status = document.getElementById("path-status");
  if (!fromQ || !toQ) {
    status.textContent = "enter both endpoints";
    status.className = "fail";
    return;
  }
  const src = resolveSymbol(fromQ);
  const dst = resolveSymbol(toQ);
  if (!src || !dst) {
    status.textContent =
      (!src ? "no match for from" : "no match for to") + " — try a longer query";
    status.className = "fail";
    pathNodes.clear();
    pathEdgeKeys.clear();
    render();
    return;
  }
  const trail = shortestPath(src, dst);
  if (!trail) {
    status.textContent = "no path found (src → dst)";
    status.className = "fail";
    pathNodes.clear();
    pathEdgeKeys.clear();
    render();
    return;
  }
  pathNodes.clear();
  pathEdgeKeys.clear();
  for (const id of trail) pathNodes.add(id);
  for (let i = 0; i < trail.length - 1; i++) {
    const a = trail[i];
    const b = trail[i + 1];
    // Add for any edge_kind — render() walks all visible links and
    // matches by (kind|src|dst). We don't know which kind connects
    // a→b at this point, so encode all kinds present in this edge.
    const kinds = new Set();
    for (const l of links) {
      const ls = typeof l.source === "object" ? l.source.id : l.source;
      const lt = typeof l.target === "object" ? l.target.id : l.target;
      if (ls === a && lt === b) kinds.add(l.kind);
    }
    for (const k of kinds) pathEdgeKeys.add(k + "|" + a + "|" + b);
  }
  status.textContent =
    "path: " + trail.length + " nodes, " + (trail.length - 1) + " hops";
  status.className = "ok";
  render();
}

// Restore any persisted state from the URL hash before building the
// legends and the first render — so the legends pick up the right
// disabled state and the canvas immediately shows the saved view.
loadHashState();

buildKindLegend();
buildEdgeLegend();
buildHubPanel("top-imported", "imports", new Set(["module"]));
buildHubPanel("top-called", "calls", new Set(["function", "method"]));

// Search
document.getElementById("search").addEventListener("input", (ev) => {
  const q = ev.target.value.trim().toLowerCase();
  if (!q) { focused = null; applyFocus(); saveHashState(); return; }
  const hit = data.nodes.find((n) => n.id.toLowerCase().includes(q));
  if (hit) { focused = hit.id; applyFocus(); showInfo(hit); saveHashState(); }
});

window.addEventListener("resize", () => {
  sim.force("center", d3.forceCenter(width() / 2, height() / 2));
  sim.alpha(0.3).restart();
});

render();
if (focused) {
  applyFocus();
  const node = nodeById.get(focused);
  if (node) showInfo(node);
}
</script>
</body>
</html>
`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

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
      })
      console.log(JSON.stringify(graph, null, 2))
      return
    }

    if (options.format === "html") {
      // Self-contained HTML viewer — pipe to a .html file and
      // open it in a browser. Uses the same buildGraphJson +
      // filter flags as --graph-json.
      const graph = await buildGraphJson(options.workspace, {
        edgeKinds: options.edgeKinds,
        symbolKinds: options.symbolKinds,
        centerOf: options.centerOf,
        centerHops: options.centerHops,
        centerDirection: options.centerDirection,
        maxNodes: options.maxNodes,
      })
      console.log(graphJsonToHtml(graph))
      return
    }

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
