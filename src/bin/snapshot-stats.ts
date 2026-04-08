/**
 * snapshot-stats — print a per-workspace ts-core snapshot dashboard.
 *
 * Usage:
 *   bun run src/bin/snapshot-stats.ts <workspace-path>
 *   bun run src/bin/snapshot-stats.ts <workspace-path> --json
 *
 * Walks the workspace using ts-core, then runs the most useful query
 * intents and prints a dashboard summarizing the snapshot:
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
import { ExtractorRunner } from "../intelligence/extraction/runner.js"
import { tsCoreExtractor } from "../plugins/index.js"
import type { ILanguageClient } from "../lsp/types.js"

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
  format: "text" | "json" | "markdown"
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  const positionals: string[] = []
  let format: CliOptions["format"] = "text"
  for (const arg of args) {
    if (arg === "--json") format = "json"
    else if (arg === "--markdown" || arg === "--md") format = "markdown"
    else if (arg === "--help" || arg === "-h") {
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
  return { workspace: positionals[0], format }
}

function printUsage(): void {
  console.error(
    "Usage: bun run src/bin/snapshot-stats.ts <workspace-path> [--json|--markdown]",
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
      plugins: [tsCoreExtractor],
    })
    const report = await runner.run()
    await foundation.commitSnapshot(snapshotId)

    const filesDiscovered =
      report.perPlugin.find((p) => p.name === "ts-core")?.metrics?.counters?.[
        "ts.files-discovered"
      ] ?? 0

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

async function main(): Promise<void> {
  const options = parseArgs()
  if (!existsSync(options.workspace)) {
    console.error(`Workspace not found: ${options.workspace}`)
    process.exit(1)
  }

  try {
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
