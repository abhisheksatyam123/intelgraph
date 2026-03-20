#!/usr/bin/env node
// Quick test: connect to clangd-mcp and call lsp_document_symbol
// which also triggers openFile internally

import { readFileSync } from "fs"

const SESSION_URL = "http://localhost:7777/mcp"
const TEST_FILE = "/local/mnt/workspace/code/WLAN.HL.3.4.3-00886-QCAHLSWMTPL-2/wlan_proc/wlan/fw/target/protocol/src/offloads/src/l2/bpf/bpf_offload_main.c"

async function main() {
  // 1. Initialize session
  const initRes = await fetch(SESSION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
  })
  const sid = initRes.headers.get("mcp-session-id")
  console.log("Session:", sid)

  // 2. Call lsp_document_symbol (triggers didOpen)
  const res = await fetch(SESSION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lsp_document_symbol", arguments: { file: TEST_FILE } } })
  })
  const text = await res.text()
  console.log("Response:", text.slice(0, 500))
}

main().catch(console.error)
