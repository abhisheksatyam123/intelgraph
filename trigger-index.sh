#!/bin/bash
set -e

SID=$(curl -si -X POST http://localhost:7777/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"trigger","version":"1"}}}' \
  2>/dev/null | grep -i mcp-session-id | tr -d '\r' | awk '{print $2}')

echo "Session: $SID"

# Use a real file that exists in the repo
curl -s -X POST http://localhost:7777/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"lsp_document_symbol","arguments":{"file":"/local/mnt/workspace/code/WLAN.HL.3.4.3-00886-QCAHLSWMTPL-2/wlan_proc/wlan/fw/target/protocol/src/offloads/src/l2/bpf/bpf_offload.c"}}}'
