// oracle-fixture.mjs — derive a fixture from source via file ops + MCP/LSP.
//
// The "oracle" workflow:
//
//   1. Take a workspace + symbol identifier (file:line:character).
//   2. Use the daemon's MCP tools (lsp_definition, lsp_hover,
//      lsp_references, lsp_workspace_symbol, lsp_incoming_calls,
//      lsp_outgoing_calls, lsp_indirect_callers) to gather every relation
//      a careful manual auditor would record.
//   3. For struct-field-callback patterns and other non-LSP relations,
//      use direct file reads + tree-sitter / regex to detect them.
//   4. Emit a fixture JSON that's the GROUND TRUTH for that symbol.
//
// The oracle is mechanically what an LLM would do if you asked it "look
// at this symbol and tell me every relation it has." We codify the
// process so it's reproducible across symbols and so the SAME relations
// any subsequent run would find can be compared against the deterministic
// backend extractor.
//
// Generated fixtures land in test/fixtures/<lang>/<project>/api/oracle/
// so they're clearly distinguishable from hand-authored ones. The deep
// verifier (verify-fixtures.mjs) treats them identically.
//
// CURRENT STATUS: this script is a SCAFFOLD demonstrating the workflow
// for one symbol at a time. It wires up the MCP client and shows the
// shape of the calls. Filling in every relation kind for every language
// is the next iteration's work — the architecture is ready, the
// mechanical loop just needs to be filled in per symbol category.
//
// Usage:
//   MCP_URL=http://127.0.0.1:7785/mcp \
//     node test/fixtures/oracle-fixture.mjs \
//     --workspace /home/abhi/qprojects/intelgraph \
//     --file src/config/config.ts \
//     --line 207 --character 17 \
//     --out test/fixtures/ts/intelgraph/api/oracle/readConfig.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const MCP_URL = process.env.MCP_URL
if (!MCP_URL) {
  console.error("Set MCP_URL to a running intelgraph daemon, e.g. http://127.0.0.1:7785/mcp")
  process.exit(2)
}

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
for (const required of ["workspace", "file", "line", "character", "out"]) {
  if (!args[required]) {
    console.error(`Missing --${required}`)
    process.exit(2)
  }
}

const workspace = resolve(args.workspace)
const filePath  = resolve(workspace, args.file)
const line      = parseInt(args.line, 10)
const character = parseInt(args.character, 10)
const outPath   = resolve(args.out)

// ── MCP HTTP client ────────────────────────────────────────────────────────

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

// ── Oracle: gather relations ───────────────────────────────────────────────

async function deriveFixture(sid) {
  const baseArgs = { file: filePath, line, character }

  // 1. Definition / hover — confirm the symbol resolves and capture its source location
  const hover     = await callTool(sid, "lsp_hover",      baseArgs)
  const def       = await callTool(sid, "lsp_definition", baseArgs)

  // 2. Caller and callee graphs (direct, via clangd's call hierarchy or TS workspace_symbol)
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
  //    Each parser is a small text-shape regex matching the format the
  //    backend prints today. (Same regex shapes the deep verifier uses.)
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
  //    Pull out the registrar via the trailing [name:field] tag.
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
      hover_first_line: hoverFirstLine,
      definition_text: def.text?.slice(0, 200),
      incoming_count:  incomingCallers.length,
      outgoing_count:  outgoingCallees.length,
      indirect_count:  registrationsIn.length,
      raw_indirect_first_line: (indirect.text ?? "").split("\n").find((l) => l.includes("<-")) ?? null,
    },
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

console.log(`oracle: ${args.file}:${line}:${character} → ${args.out}`)
const sid = await init()
const fixture = await deriveFixture(sid)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(fixture, null, 2))
console.log(`wrote ${outPath}`)
console.log(`  hover:    ${fixture.oracle_evidence.hover_first_line}`)
console.log(`  callers:  ${fixture.oracle_evidence.incoming_count}`)
console.log(`  callees:  ${fixture.oracle_evidence.outgoing_count}`)
console.log(`  indirect: ${fixture.oracle_evidence.indirect_count}`)
