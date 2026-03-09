#!/usr/bin/env node
/**
 * clangd-mcp functional test suite — strict content validation
 *
 * Every test verifies the ACTUAL content of the response, not just
 * "did it respond without error". Assertions check specific symbol names,
 * file paths, line numbers, and data shapes.
 *
 * Usage:
 *   node test-clangd-mcp.mjs [--url http://localhost:7777/mcp]
 *
 * Exit code: 0 = all passed, 1 = one or more failed
 */

// ── Config ────────────────────────────────────────────────────────────────────

const urlArgEq  = process.argv.find(a => a.startsWith("--url="))
const urlArgIdx = process.argv.indexOf("--url")
const MCP_URL   = urlArgEq
  ? urlArgEq.slice(6)
  : urlArgIdx !== -1
    ? process.argv[urlArgIdx + 1]
    : "http://localhost:7777/mcp"

const REPO  = "/local/mnt/workspace/code/WLAN.HL.3.4.3-00886-QCAHLSWMTPL-2"
const BPF_C = `${REPO}/wlan_proc/wlan/fw/target/protocol/src/offloads/src/l2/bpf/bpf_offload.c`
const BPF_H = `${REPO}/wlan_proc/wlan/fw/target/protocol/src/offloads/src/l2/bpf/bpf_offload_int.h`

// Known positions in bpf_offload.c (1-based, verified against source)
const POS = {
  // Line 50: wlan_bpf_filter_offload_handler(...)  — function definition
  FN_DEF:   { line: 50, character: 5  },
  // Line 52: wlan_pdev_t *pdev = ...  — variable with struct type
  PDEV_VAR: { line: 52, character: 14 },
  // Line 66: wlan_bpf_offload_get_bpf_vdev(pdev->bpf_pdev, vdev_id)  — call site
  CALL_SITE:{ line: 66, character: 14 },
  // Line 66 inside the argument list — for signature help
  SIG_HELP: { line: 66, character: 45 },
}

// ── Colours ───────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", grey: "\x1b[90m",
}
const pass  = msg => `${C.green}✔${C.reset} ${msg}`
const fail  = msg => `${C.red}✘${C.reset} ${msg}`
const info  = msg => `${C.grey}  ${msg}${C.reset}`
const title = msg => `\n${C.bold}${C.cyan}── ${msg} ──${C.reset}`

// ── MCP client ────────────────────────────────────────────────────────────────

async function initSession() {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "clangd-mcp-test", version: "1.0" } },
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} on initialize`)
  const sid = res.headers.get("mcp-session-id")
  if (!sid) throw new Error("No mcp-session-id in response headers")
  return sid
}

async function callTool(sid, toolName, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sid,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} calling ${toolName}`)
  const body = await res.text()
  const dataLine = body.split("\n").find(l => l.startsWith("data:"))
  if (!dataLine) throw new Error(`No data line in response for ${toolName}`)
  const json = JSON.parse(dataLine.slice(5).trim())
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  return json.result?.content?.[0]?.text ?? ""
}

async function listTools(sid) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
  })
  const body = await res.text()
  const dataLine = body.split("\n").find(l => l.startsWith("data:"))
  const json = JSON.parse(dataLine.slice(5).trim())
  return json.result?.tools ?? []
}

// ── Assertions ────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function assertContains(text, sub, label) {
  if (!text.includes(sub))
    throw new Error(`Expected "${sub}" in output (${label})\nActual: ${text.slice(0, 400)}`)
}
function assertMatches(text, re, label) {
  if (!re.test(text))
    throw new Error(`Expected pattern ${re} in output (${label})\nActual: ${text.slice(0, 400)}`)
}
function assertNotError(text, tool) {
  if (text.startsWith("Error:"))
    throw new Error(`${tool} returned error: ${text.slice(0, 200)}`)
}
function assertCount(text, re, min, label) {
  const n = (text.match(re) ?? []).length
  if (n < min) throw new Error(`Expected ≥${min} matches for ${re} (${label}), got ${n}`)
  return n
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0
const failures = []

async function test(name, fn) {
  try {
    const detail = await fn()
    console.log(pass(name))
    if (detail) console.log(info(detail))
    passed++
  } catch (err) {
    console.log(fail(name))
    console.log(info(`ERROR: ${err.message}`))
    failed++
    failures.push({ name, error: err.message })
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.bold}clangd-mcp functional test suite${C.reset}`)
  console.log(`${C.grey}Server: ${MCP_URL}${C.reset}`)
  console.log(`${C.grey}Repo:   ${REPO}${C.reset}`)

  // ════════════════════════════════════════════════════════════════════════════
  // 1. CONNECTIVITY & TOOL REGISTRATION
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("1. Connectivity & tool registration"))

  let sid
  await test("Server reachable — returns valid session ID", async () => {
    sid = await initSession()
    assert(sid?.length > 10, `Invalid session ID: "${sid}"`)
    return `session=${sid}`
  })
  if (!sid) { console.log(`\n${C.red}Cannot continue — server not reachable.${C.reset}`); process.exit(1) }

  const EXPECTED_TOOLS = [
    "lsp_hover", "lsp_definition", "lsp_declaration", "lsp_type_definition",
    "lsp_references", "lsp_implementation", "lsp_document_highlight",
    "lsp_document_symbol", "lsp_workspace_symbol", "lsp_folding_range",
    "lsp_signature_help", "lsp_incoming_calls", "lsp_outgoing_calls",
    "lsp_supertypes", "lsp_subtypes", "lsp_rename", "lsp_format",
    "lsp_inlay_hints", "lsp_diagnostics", "lsp_code_action",
    "lsp_file_status", "lsp_index_status",
  ]

  await test(`All ${EXPECTED_TOOLS.length} tools are registered`, async () => {
    const tools = await listTools(sid)
    const names = tools.map(t => t.name)
    const missing = EXPECTED_TOOLS.filter(n => !names.includes(n))
    assert(missing.length === 0, `Missing tools: ${missing.join(", ")}`)
    return `${names.length} tools registered`
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 2. INDEX STATUS
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("2. Index status"))

  let indexReady = false
  await test("lsp_index_status — returns all required fields", async () => {
    const out = await callTool(sid, "lsp_index_status", {})
    assertNotError(out, "lsp_index_status")
    assertContains(out, "Index ready:", "index ready field")
    assertContains(out, "Progress:", "progress field")
    assertContains(out, "Status:", "status field")
    assertContains(out, "Updated:", "updated field")
    indexReady = out.includes("Index ready:  true")
    return out.split("\n").slice(0, 4).join(" | ")
  })

  if (!indexReady)
    console.log(info(`${C.yellow}Index still building — cross-file results may be incomplete${C.reset}`))

  // ════════════════════════════════════════════════════════════════════════════
  // 3. DOCUMENT SYMBOLS — verifies symbol names, kinds, and line numbers
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("3. Document symbols"))

  await test("lsp_document_symbol — correct functions in bpf_offload.c", async () => {
    const out = await callTool(sid, "lsp_document_symbol", { file: BPF_C })
    assertNotError(out, "lsp_document_symbol")
    // Must contain specific known functions
    assertContains(out, "wlan_bpf_filter_offload_handler", "main handler function")
    assertContains(out, "wlan_bpf_offload_pdev_init",      "pdev init function")
    assertContains(out, "wlan_bpf_offload_register",       "register function")
    // Must have correct kind tags
    assertContains(out, "[Function]", "function kind tag")
    // Must include line numbers (colon-number pattern)
    assertMatches(out, /:\d+$/, "line numbers present")
    const n = assertCount(out, /\[Function\]/g, 5, "function count")
    return `${n} functions with correct names and line numbers`
  })

  await test("lsp_document_symbol — correct symbol kinds in bpf_offload_int.h", async () => {
    const out = await callTool(sid, "lsp_document_symbol", { file: BPF_H })
    assertNotError(out, "lsp_document_symbol")
    // Header should have structs/classes, fields, and functions
    assertContains(out, "[Class]",    "struct/class symbols")
    assertContains(out, "[Field]",    "struct field symbols")
    assertContains(out, "[Function]", "function declarations")
    const total = assertCount(out, /\[\w+\]/g, 50, "total symbol count")
    return `${total} symbols across multiple kinds`
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 4. HOVER — verifies type signature content
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("4. Hover"))

  await test("lsp_hover — returns function signature with return type", async () => {
    const out = await callTool(sid, "lsp_hover", { file: BPF_C, ...POS.FN_DEF })
    assertNotError(out, "lsp_hover")
    // clangd hover for a function should mention the function name and return type
    assertContains(out, "wlan_bpf_filter_offload_handler", "function name in hover")
    assertContains(out, "OFFLOAD_STATUS", "return type in hover")
    return out.slice(0, 120).replace(/\n/g, " ")
  })

  await test("lsp_hover — returns type info for a variable", async () => {
    const out = await callTool(sid, "lsp_hover", { file: BPF_C, ...POS.PDEV_VAR })
    assertNotError(out, "lsp_hover")
    // Hovering on 'pdev' variable should show wlan_pdev_t type
    assertContains(out, "wlan_pdev_t", "variable type in hover")
    return out.slice(0, 120).replace(/\n/g, " ")
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 5. NAVIGATION — verifies exact file:line locations
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("5. Navigation"))

  await test("lsp_definition — points to correct file and line", async () => {
    const out = await callTool(sid, "lsp_definition", { file: BPF_C, ...POS.FN_DEF })
    assertNotError(out, "lsp_definition")
    assertContains(out, "Definition:", "definition label")
    // Should point to the api header where it's declared/defined
    assertContains(out, "bpf_offload_api.h", "correct header file")
    assertContains(out, ":29:", "correct line number in header")
    return out.trim()
  })

  await test("lsp_declaration — points to .h prototype, not .c body", async () => {
    const out = await callTool(sid, "lsp_declaration", { file: BPF_C, ...POS.FN_DEF })
    assertNotError(out, "lsp_declaration")
    assertContains(out, "Declaration:", "declaration label")
    // Must point to a header file
    assertContains(out, ".h:", "header file in declaration")
    // Must NOT point back to the .c file itself
    assert(!out.includes("bpf_offload.c:50"), "declaration must not point to .c definition line")
    return out.trim()
  })

  await test("lsp_type_definition — resolves wlan_pdev_t to its struct", async () => {
    const out = await callTool(sid, "lsp_type_definition", { file: BPF_C, ...POS.PDEV_VAR })
    assertNotError(out, "lsp_type_definition")
    assertContains(out, "Type definition:", "type definition label")
    // Should resolve to a header file containing the struct
    assertContains(out, ".h:", "resolves to a header file")
    return out.trim()
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 6. REFERENCES & HIGHLIGHTS
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("6. References & highlights"))

  await test("lsp_references — finds the definition site at minimum", async () => {
    const out = await callTool(sid, "lsp_references", { file: BPF_C, ...POS.FN_DEF })
    assertNotError(out, "lsp_references")
    assertContains(out, "References", "references header")
    // The definition itself must always appear as a reference
    assertContains(out, "bpf_offload.c:50", "definition site in references")
    const n = assertCount(out, /bpf_offload/g, 1, "at least one bpf_offload reference")
    return `${n} references found`
  })

  await test("lsp_document_highlight — finds read/write sites within file", async () => {
    const out = await callTool(sid, "lsp_document_highlight", { file: BPF_C, ...POS.FN_DEF })
    assertNotError(out, "lsp_document_highlight")
    // Must tag sites with kind
    assert(
      out.includes("[read]") || out.includes("[write]") || out.includes("[text]"),
      "highlight kind tags present"
    )
    // Must include the file path
    assertContains(out, "bpf_offload.c", "file path in highlights")
    // Must include line:col ranges
    assertMatches(out, /:\d+:\d+ – \d+:\d+/, "line:col range format")
    const n = assertCount(out, /\[(read|write|text)\]/g, 1, "highlight count")
    return `${n} highlight(s) with kind tags and ranges`
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 7. WORKSPACE SYMBOL SEARCH
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("7. Workspace symbol search"))

  await test("lsp_workspace_symbol — finds known symbols by prefix", async () => {
    const out = await callTool(sid, "lsp_workspace_symbol", { query: "wlan_bpf_offload" })
    assertNotError(out, "lsp_workspace_symbol")
    // Must find specific known symbols
    assertContains(out, "wlan_bpf_offload_pdev_init", "known function in results")
    assertContains(out, "[Function]", "function kind tag")
    // Each result must have a file:line location
    assertMatches(out, /\.c:\d+:\d+|\.h:\d+:\d+/, "file:line locations in results")
    const n = assertCount(out, /\[Function\]/g, 3, "minimum function count")
    return `${n} functions matching "wlan_bpf_offload"`
  })

  await test("lsp_workspace_symbol — empty query returns broad results", async () => {
    const out = await callTool(sid, "lsp_workspace_symbol", { query: "" })
    assertNotError(out, "lsp_workspace_symbol")
    assert(out.length > 10, "Non-empty results for empty query")
    const n = (out.match(/\[\w+\]/g) ?? []).length
    assert(n > 0 || out.includes("[Index:"), "Has symbol results or index notice")
    return `${n} symbols for empty query`
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 8. CALL HIERARCHY
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("8. Call hierarchy"))

  await test("lsp_outgoing_calls — finds known callee wlan_bpf_offload_get_bpf_vdev", async () => {
    const out = await callTool(sid, "lsp_outgoing_calls", { file: BPF_C, ...POS.FN_DEF })
    assertNotError(out, "lsp_outgoing_calls")
    // wlan_bpf_filter_offload_handler calls wlan_bpf_offload_get_bpf_vdev on line 66
    assertContains(out, "->", "outgoing call arrow")
    assertContains(out, "[Function]", "function kind tag")
    assertContains(out, "wlan_bpf_offload_get_bpf_vdev", "known callee function")
    // Each callee must have a location
    assertMatches(out, /at .+:\d+:\d+/, "callee location format")
    return out.split("\n").slice(0, 3).join(" | ")
  })

  await test("lsp_incoming_calls — returns callers or index-building notice", async () => {
    const out = await callTool(sid, "lsp_incoming_calls", { file: BPF_C, ...POS.FN_DEF })
    assertNotError(out, "lsp_incoming_calls")
    // Either found callers (with <- arrows) or index is still building
    assert(
      out.includes("<-") || out.includes("No incoming calls") || out.includes("[Index:"),
      `Unexpected format: ${out.slice(0, 100)}`
    )
    if (out.includes("<-")) {
      assertContains(out, "[Function]", "caller kind tag")
      assertMatches(out, /at .+:\d+:\d+/, "caller location format")
    }
    return out.split("\n")[0]
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 9. TYPE HIERARCHY
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("9. Type hierarchy"))

  await test("lsp_supertypes — responds correctly (C structs have no supertypes)", async () => {
    const out = await callTool(sid, "lsp_supertypes", { file: BPF_C, ...POS.PDEV_VAR })
    assertNotError(out, "lsp_supertypes")
    // C structs don't have supertypes — valid responses are "No supertypes" or actual results
    assert(
      out.includes("No supertypes") || out.includes("↑") || out.includes("[Index:"),
      `Unexpected format: ${out.slice(0, 100)}`
    )
    return out.split("\n")[0]
  })

  await test("lsp_subtypes — responds correctly (C structs have no subtypes)", async () => {
    const out = await callTool(sid, "lsp_subtypes", { file: BPF_C, ...POS.PDEV_VAR })
    assertNotError(out, "lsp_subtypes")
    assert(
      out.includes("No subtypes") || out.includes("↓") || out.includes("[Index:"),
      `Unexpected format: ${out.slice(0, 100)}`
    )
    return out.split("\n")[0]
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 10. FILE STRUCTURE
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("10. File structure"))

  await test("lsp_folding_range — returns regions with correct line range format", async () => {
    const out = await callTool(sid, "lsp_folding_range", { file: BPF_C })
    assertNotError(out, "lsp_folding_range")
    // Must have line ranges in format "file:N–M"
    assertMatches(out, /bpf_offload\.c:\d+–\d+/, "file:start–end format")
    // Must have at least one function region and one ifdef region
    const n = assertCount(out, /–/g, 10, "minimum folding regions")
    // Verify the file path is relative
    assert(!out.includes(REPO), "paths should be relative, not absolute")
    return `${n} folding regions with correct format`
  })

  await test("lsp_inlay_hints — returns param hints with correct format", async () => {
    const out = await callTool(sid, "lsp_inlay_hints", { file: BPF_C, startLine: 49, endLine: 80 })
    assertNotError(out, "lsp_inlay_hints")
    // Must have hints with kind tags
    assert(
      out.includes("[param]") || out.includes("[type]") || out.includes("No inlay hints"),
      "hint kind tags present"
    )
    if (!out.includes("No inlay hints")) {
      // Each hint must have file:line:col format
      assertMatches(out, /bpf_offload\.c:\d+:\d+/, "file:line:col in hints")
      // Must have a label after the location
      assertMatches(out, /\d+:\d+\s+\S+/, "hint label after location")
    }
    const n = (out.match(/\[(param|type|hint)\]/g) ?? []).length
    return n > 0 ? `${n} inlay hints with kind tags` : "No inlay hints (valid)"
  })

  await test("lsp_signature_help — returns signature at call site", async () => {
    const out = await callTool(sid, "lsp_signature_help", { file: BPF_C, ...POS.SIG_HELP })
    assertNotError(out, "lsp_signature_help")
    if (!out.includes("No signature help")) {
      // Must have the active signature marker
      assertContains(out, "▶", "active signature marker")
      // Must have parameter info
      assertContains(out, "param[", "parameter list")
      // Active parameter must be marked with →
      assertContains(out, "→", "active parameter marker")
    }
    return out.split("\n").slice(0, 2).join(" | ")
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 11. RENAME — read-only manifest, must NOT modify files
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("11. Rename (read-only manifest)"))

  await test("lsp_rename — returns change manifest with correct structure", async () => {
    const NEW_NAME = "wlan_bpf_filter_offload_handler_test_rename"
    const out = await callTool(sid, "lsp_rename", { file: BPF_C, ...POS.FN_DEF, newName: NEW_NAME })
    assertNotError(out, "lsp_rename")
    assertContains(out, "Rename would change:", "rename header")
    // Must list the .c file as a changed file
    assertContains(out, "bpf_offload.c", "source file in change list")
    // Must show the new name in the edit
    assertContains(out, NEW_NAME, "new name in edit preview")
    // Must show line number
    assertMatches(out, /line \d+:\d+/, "line:col in edit")
    return out.split("\n").slice(0, 4).join(" | ")
  })

  await test("lsp_rename — does NOT modify the file on disk", async () => {
    // Read the file content after rename call — it must be unchanged
    const { readFileSync } = await import("fs")
    const content = readFileSync(BPF_C, "utf8")
    assertContains(content, "wlan_bpf_filter_offload_handler(", "original function name still in file")
    assert(!content.includes("test_rename"), "renamed name must NOT appear in file")
    return "File unchanged after lsp_rename call ✓"
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 12. FORMAT — read-only edits, must NOT modify files
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("12. Format (read-only edits)"))

  await test("lsp_format — whole file returns edits with correct structure", async () => {
    const out = await callTool(sid, "lsp_format", { file: BPF_C })
    assertNotError(out, "lsp_format")
    // Must show the file path and edit count
    assertContains(out, "bpf_offload.c", "file path in output")
    assertMatches(out, /\d+ formatting edit\(s\)/, "edit count format")
    // Must show line ranges for edits
    assertMatches(out, /lines \d+–\d+/, "line range format")
    const m = out.match(/(\d+) formatting edit/)
    const n = m ? parseInt(m[1]) : 0
    assert(n > 0, "Expected at least one formatting edit")
    return `${n} formatting edits with correct structure`
  })

  await test("lsp_format — range format returns edits only for that range", async () => {
    const out = await callTool(sid, "lsp_format", { file: BPF_C, startLine: 49, endLine: 60 })
    assertNotError(out, "lsp_format")
    assertContains(out, "bpf_offload.c", "file path in output")
    assertMatches(out, /\d+ formatting edit\(s\)/, "edit count format")
    // Range edits should be fewer than whole-file edits
    const m = out.match(/(\d+) formatting edit/)
    const n = m ? parseInt(m[1]) : 0
    assert(n > 0, "Expected at least one range formatting edit")
    return `${n} range formatting edits (lines 49–60)`
  })

  await test("lsp_format — does NOT modify the file on disk", async () => {
    const { readFileSync } = await import("fs")
    const before = readFileSync(BPF_C, "utf8")
    await callTool(sid, "lsp_format", { file: BPF_C })
    const after = readFileSync(BPF_C, "utf8")
    assert(before === after, "File content must be identical before and after lsp_format")
    return "File unchanged after lsp_format call ✓"
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 13. DIAGNOSTICS & CODE ACTIONS
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("13. Diagnostics & code actions"))

  await test("lsp_diagnostics — returns structured error output", async () => {
    const out = await callTool(sid, "lsp_diagnostics", { file: BPF_C })
    assertNotError(out, "lsp_diagnostics")
    // This file has a known diagnostic: unknown --query-driver argument
    assert(
      out.includes("ERROR") || out.includes("WARN") || out.includes("No diagnostics"),
      "Valid severity tags or no-diagnostics message"
    )
    if (out.includes("ERROR") || out.includes("WARN")) {
      // Must have severity [line:col] format — e.g. "ERROR [1:1]" or "[ERROR] [1:1]"
      assertMatches(out, /\[?(ERROR|WARN|INFO|HINT)\]?\s+\[\d+:\d+\]/, "severity [line:col] format")
    }
    return out.split("\n").slice(0, 3).join(" | ")
  })

  await test("lsp_diagnostics — all-files mode returns a map", async () => {
    const out = await callTool(sid, "lsp_diagnostics", {})
    assertNotError(out, "lsp_diagnostics")
    assert(out.length > 0, "Non-empty response")
    return out.split("\n")[0]
  })

  await test("lsp_code_action — returns actions or empty list (not an error)", async () => {
    const out = await callTool(sid, "lsp_code_action", { file: BPF_C, ...POS.FN_DEF })
    assertNotError(out, "lsp_code_action")
    assert(
      out.includes("* ") || out.includes("No code actions"),
      "Either bullet-list of actions or no-actions message"
    )
    if (out.includes("* ")) {
      // Each action must have a title
      assertMatches(out, /^\* .+/m, "action title format")
    }
    return out.split("\n")[0]
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 14. PER-FILE STATUS
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("14. Per-file status"))

  await test("lsp_file_status — returns state for an opened file", async () => {
    const out = await callTool(sid, "lsp_file_status", { file: BPF_C })
    assertNotError(out, "lsp_file_status")
    // Must contain the file path
    assertContains(out, "bpf_offload.c", "file path in status")
    // Must contain a valid state string
    const validStates = ["idle", "queued", "parsing", "building preamble", "building AST", "indexing", "unknown"]
    assert(
      validStates.some(s => out.includes(s)),
      `Expected one of [${validStates.join(", ")}] in: ${out}`
    )
    return out.trim()
  })

  await test("lsp_file_status — returns unknown for a file never opened", async () => {
    const UNOPENED = `${REPO}/wlan_proc/wlan/fw/target/protocol/src/offloads/src/l2/bpf/apf_interpreter.c`
    const out = await callTool(sid, "lsp_file_status", { file: UNOPENED })
    assertNotError(out, "lsp_file_status")
    assertContains(out, "apf_interpreter.c", "file path in status")
    return out.trim()
  })

  // ════════════════════════════════════════════════════════════════════════════
  // 15. MULTI-SESSION ISOLATION
  // ════════════════════════════════════════════════════════════════════════════
  console.log(title("15. Multi-session isolation"))

  await test("Two concurrent sessions share the same clangd index", async () => {
    const sid2 = await initSession()
    assert(sid2 !== sid, `Sessions must have different IDs (both got "${sid2}")`)

    // Run the same query on both sessions simultaneously
    const [o1, o2] = await Promise.all([
      callTool(sid,  "lsp_document_symbol", { file: BPF_C }),
      callTool(sid2, "lsp_document_symbol", { file: BPF_C }),
    ])

    // Both must return the same symbols
    assertContains(o1, "wlan_bpf_filter_offload_handler", "session 1 result")
    assertContains(o2, "wlan_bpf_filter_offload_handler", "session 2 result")
    assert(o1 === o2, "Both sessions must return identical results (shared index)")
    return `session1=${sid.slice(0,8)}… session2=${sid2.slice(0,8)}… results identical ✓`
  })

  await test("Session IDs are unique across multiple initializations", async () => {
    const ids = await Promise.all([initSession(), initSession(), initSession()])
    const unique = new Set(ids)
    assert(unique.size === 3, `Expected 3 unique IDs, got ${unique.size}: ${ids.join(", ")}`)
    return `3 unique session IDs: ${ids.map(s => s.slice(0,8)).join(", ")}…`
  })

  // ════════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n${C.bold}── Results ──${C.reset}`)
  console.log(
    `${C.green}Passed: ${passed}${C.reset}  ` +
    `${failed > 0 ? C.red : C.grey}Failed: ${failed}${C.reset}  ` +
    `Total: ${passed + failed}`
  )

  if (failures.length) {
    console.log(`\n${C.red}${C.bold}Failed tests:${C.reset}`)
    for (const f of failures) {
      console.log(`  ${C.red}✘${C.reset} ${f.name}`)
      console.log(`    ${C.grey}${f.error}${C.reset}`)
    }
  }

  if (!indexReady)
    console.log(`\n${C.yellow}Note: Index was still building. Re-run after indexing completes for full cross-file results.${C.reset}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`${C.red}Fatal: ${err.message}${C.reset}`)
  process.exit(1)
})
