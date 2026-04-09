// run-fixtures.mjs — compare every fixture under test/fixtures/linux/api
// against a live intelgraph daemon and report PASS/FAIL per relation kind.
//
// Usage:
//   MCP_URL=http://127.0.0.1:7785/mcp \
//     node test/fixtures/linux/run-fixtures.mjs
//
// Optional:
//   FIXTURE_FILTER=read_mem        only run fixtures whose canonical_name matches
//   FIXTURE_DIR=/path/to/fixtures  override fixture directory
//   WORKSPACE=/path/to/linux       override the absolute kernel root

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { join, dirname, resolve, basename, relative } from "node:path"
import { fileURLToPath } from "node:url"

const HERE         = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR  = process.env.FIXTURE_DIR  || join(HERE, "api")
const RESULTS_DIR  = join(HERE, "results")
const WORKSPACE    = process.env.WORKSPACE    || "/home/abhi/qprojects/linux"
const MCP_URL      = process.env.MCP_URL      || "http://127.0.0.1:7785/mcp"
const FIXTURE_FILTER = process.env.FIXTURE_FILTER || ""

mkdirSync(RESULTS_DIR, { recursive: true })

// ── MCP HTTP client ─────────────────────────────────────────────────────────

async function rpc(method, params, sessionId) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  }
  if (sessionId) headers["mcp-session-id"] = sessionId
  const resp = await fetch(MCP_URL, { method: "POST", headers, body })
  const sid = resp.headers.get("mcp-session-id") || sessionId
  const text = await resp.text()
  let json = null
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"))
    if (dataLine) json = JSON.parse(dataLine.slice(5).trim())
  } else if (text.trim().startsWith("{")) {
    json = JSON.parse(text)
  } else {
    throw new Error(`Unexpected response from ${MCP_URL}: ${text.slice(0, 200)}`)
  }
  return { sid, json }
}

async function init() {
  const { sid } = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "linux-fixture-runner", version: "0.0.1" },
  })
  await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  })
  return sid
}

async function callTool(sid, name, args) {
  const { json } = await rpc("tools/call", { name, arguments: args }, sid)
  if (json?.error) return { error: json.error }
  return { text: (json?.result?.content ?? []).map((c) => c.text ?? "").join("\n") }
}

// ── Result text parsers ─────────────────────────────────────────────────────

// Parse `lsp_incoming_calls` plain-text response. Each entry looks like:
//   <- [Function] kstrtoint  at lib/kstrtox.c:259:5
// Note: trailing position can be either FILE:LINE or FILE:LINE:COLUMN — the
// regex below uses a non-greedy file capture so it doesn't swallow the line/col.
const POS_TAIL = /(\S+?):(\d+)(?::\d+)?(?:\s.*)?$/
function parseIncomingCalls(text) {
  if (!text) return []
  const out = []
  for (const line of text.split("\n")) {
    const m = line.match(/<-\s+\[(\w+)\]\s+(\S+)\s+at\s+(\S+?):(\d+)(?::\d+)?\s*$/)
    if (m) {
      out.push({ kind: m[1], name: m[2], file: m[3], line: parseInt(m[4], 10) })
    }
  }
  return out
}

// Parse `lsp_outgoing_calls` plain-text response. Same shape with -> instead of <-.
function parseOutgoingCalls(text) {
  if (!text) return []
  const out = []
  for (const line of text.split("\n")) {
    const m = line.match(/->\s+\[(\w+)\]\s+(\S+)\s+at\s+(\S+?):(\d+)(?::\d+)?\s*$/)
    if (m) {
      out.push({ kind: m[1], name: m[2], file: m[3], line: parseInt(m[4], 10) })
    }
  }
  return out
}

// Parse `lsp_indirect_callers`. Each entry looks like:
//   <- mem_fops  at drivers/char/mem.c:636 [maybe trailing classification]
function parseIndirectCallers(text) {
  if (!text) return []
  const out = []
  for (const line of text.split("\n")) {
    const m = line.match(/<-\s+(\S+)\s+at\s+(\S+?):(\d+)(?::\d+)?(?:\s.*)?$/)
    if (m) {
      out.push({ name: m[1], file: m[2], line: parseInt(m[3], 10) })
    }
  }
  return out
}

// Detect "[Index: building N%" hint and extract progress.
function parseIndexHint(text) {
  if (!text) return null
  const m = text.match(/\[Index: building (\d+)%/)
  return m ? parseInt(m[1], 10) : null
}

// ── Per-relation checkers ───────────────────────────────────────────────────

function strip(p) {
  // Drop the workspace prefix if present so fixture-relative paths match
  // backend-returned paths.
  return p.startsWith(WORKSPACE + "/") ? p.slice(WORKSPACE.length + 1) : p
}

function findGroundTruthMatch(actual, expected) {
  // expected is { caller/callee, file, line } from the fixture
  // actual is parsed from the backend (kind, name, file, line)
  const wantName = expected.caller || expected.callee
  const wantFile = expected.file
  // Match by name + file. Line numbers can drift slightly, so don't require exact equality.
  return actual.find((a) => {
    if (a.name !== wantName) return false
    return strip(a.file) === wantFile
  })
}

async function checkCallsInDirect(sid, fixture) {
  const want = fixture.relations.calls_in_direct ?? []
  const minN = fixture.contract.minimum_counts?.calls_in_direct ?? 0
  if (want.length === 0 && minN === 0) {
    return { kind: "calls_in_direct", status: "n/a", want: 0, got: 0, missing: [] }
  }
  const r = await callTool(sid, "lsp_incoming_calls", {
    file: join(WORKSPACE, fixture.source.file),
    line: fixture.source.line,
    character: fixture.source.character,
  })
  if (r.error) {
    return { kind: "calls_in_direct", status: "error", error: r.error }
  }
  const got = parseIncomingCalls(r.text)
  const indexProgress = parseIndexHint(r.text)

  // Two-axis check:
  //   existence  — did the backend return at least the minimum number of callers?
  //   exactness  — are the fixture's specific named callers all present?
  // The backend "robustness" is mostly about EXISTENCE (does it find the
  // relationship). EXACTNESS is informational and only fails the test if the
  // fixture explicitly opts in via contract.strict_caller_names = true.
  const missing = []
  for (const w of want) {
    if (!findGroundTruthMatch(got, w)) {
      missing.push({ name: w.caller, file: w.file, line: w.line })
    }
  }
  const passByCount   = got.length >= minN
  const passByContent = missing.length === 0
  const strict        = fixture.contract.strict_caller_names === true

  // Status:
  //   pass               — meets count AND (loose mode OR exact match)
  //   warn-content-drift — meets count but specific fixture names don't all match
  //                        (this is usually a cold-index or fixture-noise issue,
  //                        not a backend bug)
  //   fail               — doesn't meet the minimum count, OR strict mode + missing
  let status
  if (!passByCount) status = "fail"
  else if (passByContent) status = "pass"
  else if (strict) status = "fail"
  else status = "warn-content-drift"

  return {
    kind: "calls_in_direct",
    status,
    want: want.length,
    minN,
    got: got.length,
    missing,
    indexProgress,
  }
}

async function checkCallsOut(sid, fixture) {
  const want = fixture.relations.calls_out ?? []
  const minN = fixture.contract.minimum_counts?.calls_out ?? 0
  if (want.length === 0 && minN === 0) {
    return { kind: "calls_out", status: "n/a", want: 0, got: 0, missing: [] }
  }
  const r = await callTool(sid, "lsp_outgoing_calls", {
    file: join(WORKSPACE, fixture.source.file),
    line: fixture.source.line,
    character: fixture.source.character,
  })
  if (r.error) {
    return { kind: "calls_out", status: "error", error: r.error }
  }
  const got = parseOutgoingCalls(r.text)
  // Outgoing calls match by callee name only — file is typically the callee's
  // *definition* file which the fixture may not have.
  const wantNames = new Set(want.map((w) => w.callee))
  const gotNames  = new Set(got.map((g) => g.name))
  const missing = []
  for (const n of wantNames) if (!gotNames.has(n)) missing.push({ callee: n })
  const passByCount = got.length >= minN
  const passByContent = missing.length === 0
  const strict = fixture.contract.strict_callee_names === true
  let status
  if (!passByCount) status = "fail"
  else if (passByContent) status = "pass"
  else if (strict) status = "fail"
  else status = "warn-content-drift"
  return {
    kind: "calls_out",
    status,
    want: want.length,
    minN,
    got: got.length,
    missing,
  }
}

async function checkCallsInRuntime(sid, fixture) {
  const want = fixture.relations.calls_in_runtime ?? []
  const minN = fixture.contract.minimum_counts?.calls_in_runtime ?? 0
  if (want.length === 0 && minN === 0) {
    return { kind: "calls_in_runtime", status: "n/a", want: 0, got: 0, missing: [] }
  }
  const r = await callTool(sid, "lsp_indirect_callers", {
    file: join(WORKSPACE, fixture.source.file),
    line: fixture.source.line,
    character: fixture.source.character,
  })
  if (r.error) {
    return { kind: "calls_in_runtime", status: "error", error: r.error }
  }
  const got = parseIndirectCallers(r.text)
  // Match by caller name. Indirect callers are fuzzy — accept any non-empty result
  // that contains a caller whose name appears in any expected dispatch_chain entry.
  const expectedNames = new Set()
  for (const w of want) {
    expectedNames.add(w.caller)
    if (Array.isArray(w.dispatch_chain)) {
      for (const c of w.dispatch_chain) expectedNames.add(c)
    }
  }
  const matches = got.filter((g) => expectedNames.has(g.name))
  const missing = (matches.length === 0)
    ? want.map((w) => ({ caller: w.caller, dispatch_chain: w.dispatch_chain }))
    : []
  return {
    kind: "calls_in_runtime",
    status: (got.length >= minN && missing.length === 0) ? "pass" : "fail",
    want: want.length,
    minN,
    got: got.length,
    matches: matches.length,
    missing,
    raw_first_line: (r.text || "").split("\n")[0]?.slice(0, 120),
  }
}

async function checkRegistrationsIn(sid, fixture) {
  // The backend has no dedicated MCP tool for "find registrar" queries — the
  // registration info is bundled into the lsp_indirect_callers output (it
  // appears after the [tag] suffix on each caller line). For now, just
  // re-use the indirect-callers parse and check whether any registrar name
  // appears in the raw text.
  const want = fixture.relations.registrations_in ?? []
  const minN = fixture.contract.minimum_counts?.registrations_in ?? 0
  if (want.length === 0 && minN === 0) {
    return { kind: "registrations_in", status: "n/a", want: 0, got: 0, missing: [] }
  }
  const r = await callTool(sid, "lsp_indirect_callers", {
    file: join(WORKSPACE, fixture.source.file),
    line: fixture.source.line,
    character: fixture.source.character,
  })
  if (r.error) {
    return { kind: "registrations_in", status: "error", error: r.error }
  }
  const text = r.text || ""
  const found = []
  const missing = []
  for (const w of want) {
    if (text.includes(w.registrar)) {
      found.push(w.registrar)
    } else {
      missing.push({ registrar: w.registrar, registration_kind: w.registration_kind })
    }
  }
  return {
    kind: "registrations_in",
    status: (found.length >= minN && missing.length === 0) ? "pass" : "fail",
    want: want.length,
    minN,
    got: found.length,
    found,
    missing,
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function runOne(sid, fixture) {
  const checks = []
  for (const kind of fixture.contract.required_relation_kinds) {
    let res
    if      (kind === "calls_in_direct")  res = await checkCallsInDirect(sid, fixture)
    else if (kind === "calls_out")        res = await checkCallsOut(sid, fixture)
    else if (kind === "calls_in_runtime") res = await checkCallsInRuntime(sid, fixture)
    else if (kind === "registrations_in") res = await checkRegistrationsIn(sid, fixture)
    else res = { kind, status: "skipped", reason: "no checker for this relation kind yet" }
    checks.push(res)
  }
  // Overall status:
  //   pass               — every required relation passed (or n/a)
  //   pass-with-warnings — every relation met its minimum count, but some
  //                        specific named items in the fixture didn't exactly
  //                        match (likely cold index or fixture noise)
  //   fail               — at least one relation failed by count or in strict mode
  let overall = "pass"
  for (const c of checks) {
    if (c.status === "pass" || c.status === "n/a") continue
    if (c.status === "warn-content-drift") {
      if (overall === "pass") overall = "pass-with-warnings"
      continue
    }
    overall = "fail"
  }
  return { canonical_name: fixture.canonical_name, category: fixture.category, overall, checks }
}

async function main() {
  console.log(`workspace: ${WORKSPACE}`)
  console.log(`fixtures:  ${FIXTURE_DIR}`)
  console.log(`mcp:       ${MCP_URL}`)
  console.log()

  const sid = await init()
  console.log(`session: ${sid}\n`)

  // Pre-flight: ask for index status so the user knows what to expect
  const status = await callTool(sid, "lsp_index_status", {})
  console.log("index_status:")
  for (const ln of (status.text || "").split("\n")) console.log("  " + ln)
  console.log()

  // Walk FIXTURE_DIR recursively so fixtures can be organized into category
  // subfolders (e.g. api/vfs_callback/read_mem.json) — one JSON per API,
  // grouped by symbol category at the directory level.
  const allFixtureFiles = walkJsonFiles(FIXTURE_DIR)
  const matches = FIXTURE_FILTER
    ? allFixtureFiles.filter((f) => f.includes(FIXTURE_FILTER))
    : allFixtureFiles

  // Sort by category-folder then filename so the report groups symbols
  // from the same category together.
  matches.sort()

  const results = []
  let lastCategoryDir = ""
  for (const absPath of matches) {
    const fixture = JSON.parse(readFileSync(absPath, "utf8"))
    const relPath = relative(FIXTURE_DIR, absPath)
    const categoryDir = dirname(relPath)
    if (categoryDir !== lastCategoryDir && categoryDir !== ".") {
      console.log(`\n── ${categoryDir} ──`)
      lastCategoryDir = categoryDir
    }
    process.stdout.write(`▶ ${fixture.canonical_name.padEnd(36)} [${(fixture.category ?? categoryDir).padEnd(28)}] `)
    const t0 = Date.now()
    let res
    try {
      res = await runOne(sid, fixture)
    } catch (err) {
      res = { canonical_name: fixture.canonical_name, category: fixture.category, overall: "error", error: String(err) }
    }
    const ms = Date.now() - t0
    const tag = res.overall === "pass" ? "PASS"
              : res.overall === "pass-with-warnings" ? "WARN"
              : res.overall === "error" ? "ERR "
              : "FAIL"
    console.log(`${tag} (${ms}ms)`)
    if (res.checks) {
      for (const c of res.checks) {
        const st = c.status.toUpperCase().padEnd(18)
        const detail = (c.status === "pass" || c.status === "n/a")
          ? `want=${c.want} min=${c.minN ?? 0} got=${c.got}`
          : `want=${c.want} min=${c.minN ?? 0} got=${c.got} missing=${(c.missing ?? []).length}`
        console.log(`     ${st} ${c.kind.padEnd(18)} ${detail}${c.indexProgress != null ? ` (index ${c.indexProgress}%)` : ""}`)
      }
    } else if (res.error) {
      console.log(`     ${res.error}`)
    }
    results.push(res)
  }

  // Summary
  const pass = results.filter((r) => r.overall === "pass").length
  const warn = results.filter((r) => r.overall === "pass-with-warnings").length
  const fail = results.filter((r) => r.overall === "fail").length
  const err  = results.filter((r) => r.overall === "error").length
  console.log()
  console.log(`════ Summary: ${pass} pass · ${warn} warn · ${fail} fail · ${err} error  (of ${results.length} fixtures)`)

  const outFile = join(RESULTS_DIR, `pass-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(outFile, JSON.stringify({
    workspace: WORKSPACE,
    timestamp: new Date().toISOString(),
    summary: { pass, fail, err, total: results.length },
    results,
  }, null, 2))
  console.log(`Detailed results: ${outFile}`)
}

/**
 * Recursively walk a directory tree and return every *.json file's absolute path.
 * Skips files starting with `_` (reserved for templates / partials).
 */
function walkJsonFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkJsonFiles(p))
    } else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("_")) {
      out.push(p)
    }
  }
  return out
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
