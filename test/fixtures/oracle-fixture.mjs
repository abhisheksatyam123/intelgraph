// oracle-fixture.mjs — derive a fixture from source via file ops + MCP/LSP
// (C/C++) or direct graph_edges queries (TS/Rust).
//
// The "oracle" workflow:
//
//   1. Take a workspace + a symbol identifier.
//   2. Gather every relation a careful manual auditor would record:
//        • C/C++ path  — use the daemon's MCP tools (lsp_definition,
//          lsp_hover, lsp_references, lsp_incoming_calls,
//          lsp_outgoing_calls, lsp_indirect_callers). This path requires a
//          running daemon and MCP_URL.
//        • TS/Rust path — spawn a fresh ExtractorRunner over the workspace
//          into a temporary on-disk sqlite db, then query graph_nodes /
//          graph_edges directly for every edge kind (calls,
//          references_type, contains, implements, imports, extends,
//          field_of_type, aggregates). No daemon needed.
//   3. For struct-field-callback / non-LSP relations in C/C++, use direct
//      file reads + tree-sitter / regex to detect them.
//   4. Emit a fixture JSON that's the GROUND TRUTH for that symbol.
//
// Generated fixtures land in test/fixtures/<lang>/<project>/api/oracle/ so
// they're clearly distinguishable from hand-authored ones. The deep
// verifier (verify-fixtures.mjs) treats them identically.
//
// Why two paths? intelgraph's lsp_* MCP tools route through clangd, which
// only indexes C/C++. Running the C/C++ flow against a TS/Rust file
// returns 0 callers/callees because clangd has no data on it. For TS and
// Rust we bypass MCP entirely and talk to the same graph store the
// verifier uses.
//
// Usage (C/C++ via MCP):
//   MCP_URL=http://127.0.0.1:7785/mcp \
//     node test/fixtures/oracle-fixture.mjs \
//     --lang c \
//     --workspace /home/abhi/linux \
//     --file fs/read_write.c \
//     --line 456 --character 5 \
//     --out test/fixtures/c/linux/api/oracle/vfs_read.json
//
// Usage (TS/Rust via direct graph queries — no daemon needed):
//   npx tsx test/fixtures/oracle-fixture.mjs \
//     --lang ts \
//     --workspace /home/abhi/qprojects/intelgraph \
//     --symbol "module:src/config/config.ts#readConfig" \
//     --out test/fixtures/ts/intelgraph/api/oracle/readConfig.json

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, resolve, basename, extname } from "node:path"

// ── CLI parser (minimal — no dependencies) ─────────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) { out[key] = next; i++ } else { out[key] = "true" }
    }
  }
  return out
}
const args = parseArgs(process.argv.slice(2))

// Infer --lang from --file extension if unset
function inferLang() {
  if (args.lang) return args.lang
  if (args.file) {
    const ext = extname(args.file).toLowerCase()
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") return "ts"
    if (ext === ".rs") return "rust"
    if (ext === ".c" || ext === ".h" || ext === ".cc" || ext === ".cpp" || ext === ".hpp") return "c"
  }
  return "c"
}
const lang = inferLang()

// Common required args
if (!args.workspace || !args.out) {
  console.error("Missing --workspace or --out")
  console.error("Usage: oracle-fixture.mjs --lang <c|ts|rust> --workspace <dir> --out <file.json> [--file ... --line ... --character ...] [--symbol <canonical_name>]")
  process.exit(2)
}

const workspace = resolve(args.workspace)
const outPath   = resolve(args.out)

if (lang === "c") {
  // C/C++ path keeps its historical MCP-based flow and its own required
  // args (file / line / character plus MCP_URL).
  for (const required of ["file", "line", "character"]) {
    if (!args[required]) {
      console.error(`Missing --${required} (required for --lang c)`)
      process.exit(2)
    }
  }
  if (!process.env.MCP_URL) {
    console.error("Set MCP_URL to a running intelgraph daemon, e.g. http://127.0.0.1:7785/mcp")
    process.exit(2)
  }
  await runMcpOracleForC()
} else if (lang === "ts" || lang === "rust") {
  if (!args.symbol) {
    console.error(`Missing --symbol (canonical_name is required for --lang ${lang})`)
    console.error(`Example: --symbol "module:src/config/config.ts#readConfig"`)
    process.exit(2)
  }
  await runGraphOracleForTsRust(lang)
} else {
  console.error(`Unsupported --lang ${lang}; use one of: c, ts, rust`)
  process.exit(2)
}

// ═══════════════════════════════════════════════════════════════════════════
// Path 1 — C/C++ via MCP tools (historical flow, unchanged behavior)
// ═══════════════════════════════════════════════════════════════════════════

async function runMcpOracleForC() {
  const MCP_URL = process.env.MCP_URL
  const filePath  = resolve(workspace, args.file)
  const line      = parseInt(args.line, 10)
  const character = parseInt(args.character, 10)

  console.log(`[oracle/c] path=MCP  ${args.file}:${line}:${character}  -> ${args.out}`)

  async function rpc(method, params, sessionId) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    }
    if (sessionId) headers["mcp-session-id"] = sessionId
    const resp = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) })
    const sid = resp.headers.get("mcp-session-id") || sessionId
    const text = await resp.text()
    let json = null
    if (text.startsWith("event:") || text.startsWith("data:")) {
      const dl = text.split("\n").find((l) => l.startsWith("data:"))
      if (dl) json = JSON.parse(dl.slice(5).trim())
    } else if (text.trim().startsWith("{")) json = JSON.parse(text)
    return { sid, json }
  }
  async function init() {
    const { sid } = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "oracle", version: "0" } })
    await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    })
    return sid
  }
  async function callTool(sid, name, args) {
    const { json } = await rpc("tools/call", { name, arguments: args }, sid)
    if (json?.error) return { error: json.error }
    return { text: (json?.result?.content ?? []).map((c) => c.text ?? "").join("\n") }
  }

  async function deriveFixture(sid) {
    const baseArgs = { file: filePath, line, character }

    // 1. Definition / hover — confirm the symbol resolves and capture its source location
    const hover     = await callTool(sid, "lsp_hover",      baseArgs)
    const def       = await callTool(sid, "lsp_definition", baseArgs)

    // 2. Caller and callee graphs (direct, via clangd's call hierarchy)
    const incoming  = await callTool(sid, "lsp_incoming_calls", baseArgs)
    const outgoing  = await callTool(sid, "lsp_outgoing_calls", baseArgs)

    // 3. Cross-reference graph
    const refs      = await callTool(sid, "lsp_references", baseArgs)

    // 4. Indirect / runtime callers (the WLAN/Linux callback path detection)
    const indirect  = await callTool(sid, "lsp_indirect_callers", baseArgs)

    // 5. Source-line snippet from the file (so the fixture has a literal anchor)
    let sourceSnippet = ""
    try {
      const fileText = readFileSync(filePath, "utf8")
      const lines = fileText.split("\n")
      const startLine = Math.max(0, line - 1)
      sourceSnippet = lines.slice(startLine, startLine + 1).join("\n").trim().slice(0, 200)
    } catch {}

    // 6. Parse the plain-text MCP responses into structured relation rows.
    const callerRegex = /<-\s+\[(\w+)\]\s+(\S+)\s+at\s+(\S+?):(\d+)(?::\d+)?\s*$/
    const calleeRegex = /->\s+\[(\w+)\]\s+(\S+)\s+at\s+(\S+?):(\d+)(?::\d+)?\s*$/

    const incomingCallers = []
    for (const line of (incoming.text ?? "").split("\n")) {
      const m = line.match(callerRegex)
      if (m) incomingCallers.push({ caller: m[2], file: m[3], line: parseInt(m[4], 10) })
    }
    const outgoingCallees = []
    for (const line of (outgoing.text ?? "").split("\n")) {
      const m = line.match(calleeRegex)
      if (m) outgoingCallees.push({ callee: m[2], file: m[3], line: parseInt(m[4], 10) })
    }

    // 7. Indirect-caller registrations come back tagged like:
    //      <- mem_fops at drivers/char/mem.c:636 [mem_fops:read]
    const registrationRegex = /<-\s+(\S+)\s+at\s+(\S+?):(\d+)(?::\d+)?(?:\s+\[([^\]]+)\])?/
    const registrationsIn = []
    for (const line of (indirect.text ?? "").split("\n")) {
      const m = line.match(registrationRegex)
      if (m && m[4]) {
        const [registrar, field] = m[4].split(":")
        registrationsIn.push({ registrar, field, file: m[2], line: parseInt(m[3], 10) })
      }
    }

    // 8. Pick a hover-derived hint at the symbol kind
    const hoverFirstLine = (hover.text ?? "").split("\n")[0] ?? ""
    let inferredKind = "function"
    if (/^class /.test(hoverFirstLine)) inferredKind = "class"
    else if (/^interface /.test(hoverFirstLine)) inferredKind = "interface"
    else if (/^method /.test(hoverFirstLine)) inferredKind = "method"
    else if (/^struct /.test(hoverFirstLine)) inferredKind = "struct"
    else if (/^enum /.test(hoverFirstLine)) inferredKind = "enum"
    else if (/^typedef /.test(hoverFirstLine)) inferredKind = "typedef"

    return {
      kind: inferredKind,
      canonical_name: `(oracle-derived from ${args.file}:${line})`,
      category: "oracle_generated",
      source: { file: args.file, line, character },
      description: `Auto-derived by test/fixtures/oracle-fixture.mjs at ${new Date().toISOString()}. Source line: ${sourceSnippet}`,
      relations: {
        calls_in_direct:  incomingCallers,
        calls_out:        outgoingCallees,
        registrations_in: registrationsIn,
      },
      contract: {
        required_node_kinds: [inferredKind],
        notes: "Generated by oracle workflow. Run verify-fixtures.mjs to compare against the deterministic extractor.",
      },
      oracle_evidence: {
        oracle_path: "mcp",
        hover_first_line: hoverFirstLine,
        definition_text: def.text?.slice(0, 200),
        incoming_count:  incomingCallers.length,
        outgoing_count:  outgoingCallees.length,
        indirect_count:  registrationsIn.length,
        raw_indirect_first_line: (indirect.text ?? "").split("\n").find((l) => l.includes("<-")) ?? null,
      },
    }
  }

  const sid = await init()
  const fixture = await deriveFixture(sid)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(fixture, null, 2))
  console.log(`[oracle/c] wrote ${outPath}`)
  console.log(`  hover:    ${fixture.oracle_evidence.hover_first_line}`)
  console.log(`  callers:  ${fixture.oracle_evidence.incoming_count}`)
  console.log(`  callees:  ${fixture.oracle_evidence.outgoing_count}`)
  console.log(`  indirect: ${fixture.oracle_evidence.indirect_count}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Path 2 — TS/Rust via direct graph_edges queries
// ═══════════════════════════════════════════════════════════════════════════

async function runGraphOracleForTsRust(lang) {
  const symbolName = args.symbol
  const dbBase = basename(symbolName).replace(/[^a-zA-Z0-9_-]/g, "_")
  const dbPath = `/tmp/intelgraph-oracle-${lang}-${dbBase}.db`

  console.log(`[oracle/${lang}] path=graph_edges  symbol=${symbolName}`)
  console.log(`[oracle/${lang}] workspace=${workspace}`)
  console.log(`[oracle/${lang}] db=${dbPath}`)

  // Dynamic imports so the C path never has to load the extractor stack.
  const { openSqlite } = await import("../../src/intelligence/db/sqlite/client.ts")
  const { SqliteDbFoundation } = await import("../../src/intelligence/db/sqlite/foundation.ts")
  const { SqliteGraphStore } = await import("../../src/intelligence/db/sqlite/graph-store.ts")
  const { ExtractorRunner } = await import("../../src/intelligence/extraction/runner.ts")
  const { BUILT_IN_EXTRACTORS } = await import("../../src/plugins/index.ts")

  rmSync(dbPath, { force: true })

  // TS/Rust extractors don't need a real LSP client — a stub is enough.
  const stubLsp = {
    root: workspace,
    openFile: async () => false,
    documentSymbol: async () => [],
    outgoingCalls: async () => [],
    incomingCalls: async () => [],
    references: async () => [],
    definition: async () => [],
  }

  const client = openSqlite({ path: dbPath })
  const foundation = new SqliteDbFoundation(client.db, client.raw)
  await foundation.initSchema()
  const store = new SqliteGraphStore(client.db)

  const ref = await foundation.beginSnapshot({
    workspaceRoot: workspace,
    compileDbHash: `oracle-${lang}-${dbBase}`,
    parserVersion: "0.1.0",
  })
  const snapshotId = ref.snapshotId

  console.log(`[oracle/${lang}] running BUILT_IN_EXTRACTORS (snapshot=${snapshotId})...`)
  const t0 = Date.now()
  const runner = new ExtractorRunner({
    snapshotId,
    workspaceRoot: workspace,
    lsp: stubLsp,
    sink: store,
    plugins: BUILT_IN_EXTRACTORS,
  })
  await runner.run()
  await foundation.commitSnapshot(snapshotId)
  console.log(`[oracle/${lang}] extraction done in ${Date.now() - t0}ms`)

  const totalNodes = client.raw.prepare(
    "SELECT COUNT(*) AS n FROM graph_nodes WHERE snapshot_id = ?",
  ).get(snapshotId).n
  const totalEdges = client.raw.prepare(
    "SELECT COUNT(*) AS n FROM graph_edges WHERE snapshot_id = ?",
  ).get(snapshotId).n
  console.log(`[oracle/${lang}] graph_nodes=${totalNodes}  graph_edges=${totalEdges}`)

  // ── Locate the target node ────────────────────────────────────────────────
  const stmtNodeByCanonical = client.raw.prepare(
    "SELECT canonical_name, kind, location FROM graph_nodes WHERE snapshot_id = ? AND canonical_name = ?",
  )
  const node = stmtNodeByCanonical.get(snapshotId, symbolName)
  if (!node) {
    console.error(`[oracle/${lang}] ERROR: no node with canonical_name = ${symbolName}`)
    const like = client.raw.prepare(
      "SELECT canonical_name FROM graph_nodes WHERE snapshot_id = ? AND canonical_name LIKE ? LIMIT 10",
    ).all(snapshotId, `%${basename(symbolName)}%`)
    if (like.length > 0) {
      console.error(`[oracle/${lang}] similar names:`)
      for (const row of like) console.error(`    ${row.canonical_name}`)
    }
    process.exit(3)
  }

  const NODE_ID_PREFIX = `graph_node:${snapshotId}:symbol:`
  const targetNodeId = `${NODE_ID_PREFIX}${symbolName}`

  function stripPrefix(nodeId) {
    if (typeof nodeId !== "string") return nodeId
    return nodeId.startsWith(NODE_ID_PREFIX) ? nodeId.slice(NODE_ID_PREFIX.length) : nodeId
  }

  const stmtIncoming = client.raw.prepare(
    `SELECT src_node_id, edge_kind FROM graph_edges
     WHERE snapshot_id = ? AND edge_kind = ? AND dst_node_id = ?`,
  )
  const stmtOutgoing = client.raw.prepare(
    `SELECT dst_node_id, edge_kind FROM graph_edges
     WHERE snapshot_id = ? AND edge_kind = ? AND src_node_id = ?`,
  )

  function rowsIn(kind) {
    return stmtIncoming.all(snapshotId, kind, targetNodeId).map((r) => ({
      from: stripPrefix(r.src_node_id),
      edge_kind: r.edge_kind,
    }))
  }
  function rowsOut(kind) {
    return stmtOutgoing.all(snapshotId, kind, targetNodeId).map((r) => ({
      to: stripPrefix(r.dst_node_id),
      edge_kind: r.edge_kind,
    }))
  }

  // Every edge kind the TS/Rust extractors emit that's relevant to a
  // symbol-level oracle fixture.
  const EDGE_KINDS = [
    "calls",
    "references_type",
    "contains",
    "implements",
    "imports",
    "extends",
    "field_of_type",
    "aggregates",
  ]

  const inByKind = {}
  const outByKind = {}
  for (const kind of EDGE_KINDS) {
    inByKind[kind] = rowsIn(kind)
    outByKind[kind] = rowsOut(kind)
  }

  // Shape relations to mirror the fixture format the verifier understands.
  const relations = {
    // Incoming calls (direct callers): stored as caller canonical names
    calls_in_direct: inByKind.calls.map((r) => ({ caller: r.from })),
    // Incoming type references: who types this symbol as a field/param/etc.
    references_type_in: inByKind.references_type.map((r) => ({ referrer: r.from })),
    // Outgoing calls (callees)
    calls_out: outByKind.calls.map((r) => ({ callee: r.to })),
    // Outgoing type references
    references_type: outByKind.references_type.map((r) => ({ type: r.to })),
    // Interfaces / traits this symbol implements
    implements: outByKind.implements.map((r) => ({ type: r.to })),
    // Superclass / supertrait
    extends: outByKind.extends.map((r) => ({ type: r.to })),
    // Imports (module-level outgoing)
    imports_out: outByKind.imports.map((r) => ({ to: r.to })),
    // Containment: what this symbol contains (methods/fields/variants/...)
    contains: outByKind.contains.map((r) => ({ child: r.to })),
    // Who contains this symbol (parent module/class/trait)
    contained_by: inByKind.contains.map((r) => ({ parent: r.from })),
    // Field typing edges
    field_of_type_out: outByKind.field_of_type.map((r) => ({ type: r.to })),
    field_of_type_in: inByKind.field_of_type.map((r) => ({ field: r.from })),
    // Aggregation edges (struct contains struct-by-value, etc.)
    aggregates_out: outByKind.aggregates.map((r) => ({ to: r.to })),
    aggregates_in: inByKind.aggregates.map((r) => ({ from: r.from })),
  }

  // Optional: grab a source snippet if we can locate the file.
  let sourceSnippet = ""
  try {
    const loc = node.location ? JSON.parse(node.location) : null
    if (loc && loc.file && typeof loc.startLine === "number") {
      const abs = resolve(workspace, loc.file)
      const fileText = readFileSync(abs, "utf8")
      const lines = fileText.split("\n")
      const i = Math.max(0, (loc.startLine ?? 1) - 1)
      sourceSnippet = lines.slice(i, i + 1).join("\n").trim().slice(0, 200)
    }
  } catch {}

  const fixture = {
    kind: node.kind,
    canonical_name: symbolName,
    category: "oracle_generated",
    source: (() => {
      try { return node.location ? JSON.parse(node.location) : null } catch { return null }
    })(),
    description: `Auto-derived by test/fixtures/oracle-fixture.mjs (lang=${lang}, direct graph_edges query) at ${new Date().toISOString()}. Source line: ${sourceSnippet}`,
    relations,
    contract: {
      required_node_kinds: [node.kind],
      notes: "Generated by oracle workflow via direct graph_edges queries. Run verify-fixtures.mjs to compare against the deterministic extractor.",
    },
    oracle_evidence: {
      oracle_path: `graph_edges/${lang}`,
      snapshot_id: snapshotId,
      total_nodes_in_snapshot: totalNodes,
      total_edges_in_snapshot: totalEdges,
      db_path: dbPath,
      calls_in_count:           relations.calls_in_direct.length,
      calls_out_count:          relations.calls_out.length,
      references_type_in_count: relations.references_type_in.length,
      references_type_out_count: relations.references_type.length,
      implements_count:         relations.implements.length,
      extends_count:            relations.extends.length,
      imports_out_count:        relations.imports_out.length,
      contains_count:           relations.contains.length,
      contained_by_count:       relations.contained_by.length,
      field_of_type_in_count:   relations.field_of_type_in.length,
      field_of_type_out_count:  relations.field_of_type_out.length,
      aggregates_in_count:      relations.aggregates_in.length,
      aggregates_out_count:     relations.aggregates_out.length,
    },
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(fixture, null, 2))
  console.log(`[oracle/${lang}] wrote ${outPath}`)
  console.log(`  kind:            ${fixture.kind}`)
  console.log(`  calls in:        ${fixture.oracle_evidence.calls_in_count}`)
  console.log(`  calls out:       ${fixture.oracle_evidence.calls_out_count}`)
  console.log(`  references_type in/out: ${fixture.oracle_evidence.references_type_in_count}/${fixture.oracle_evidence.references_type_out_count}`)
  console.log(`  implements:      ${fixture.oracle_evidence.implements_count}`)
  console.log(`  extends:         ${fixture.oracle_evidence.extends_count}`)
  console.log(`  imports out:     ${fixture.oracle_evidence.imports_out_count}`)
  console.log(`  contains:        ${fixture.oracle_evidence.contains_count}`)
  console.log(`  contained_by:    ${fixture.oracle_evidence.contained_by_count}`)
  console.log(`  field_of_type in/out: ${fixture.oracle_evidence.field_of_type_in_count}/${fixture.oracle_evidence.field_of_type_out_count}`)
  console.log(`  aggregates in/out: ${fixture.oracle_evidence.aggregates_in_count}/${fixture.oracle_evidence.aggregates_out_count}`)
}
