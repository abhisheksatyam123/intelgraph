import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createServer } from "http"
import { randomUUID } from "crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createMcpServer } from "../../src/core/server.js"
import { IndexTracker } from "../../src/tracking/index.js"
import { writeLlmDbEntry, computeFileHash } from "../../src/tools/reason-engine/db.js"
import { createUnifiedBackend } from "../../src/backend/unified-backend.js"

let tmpRoot = ""
let targetFile = ""
let client: Client
let httpServer: ReturnType<typeof createServer>

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "clangd-mcp-reason-e2e-"))
  targetFile = path.join(tmpRoot, "bpf_offload.c")
  writeFileSync(
    targetFile,
    [
      "void wlan_bpf_filter_offload_handler(void) {",
      "  return;",
      "}",
      "",
    ].join("\n"),
  )

  const targetSymbol = "wlan_bpf_filter_offload_handler"
  const targetLine = 1
  const connectionKey = `${tmpRoot}::${targetSymbol}::${targetFile}:${targetLine}`
  const fileHash = computeFileHash(targetFile)
  if (!fileHash) throw new Error("Failed to compute test file hash")

  writeLlmDbEntry(tmpRoot, {
    connectionKey,
    targetSymbol,
    reasonPaths: [
      {
        targetSymbol,
        registrarFn: "wlan_bpf_enable_data_path",
        registrationApi: "offldmgr_register_data_offload",
        gates: ["offload_data[i].vdev_bitmap & (1 << vdev_id)"],
        evidence: [{ role: "ground-truth", file: targetFile, line: 1 }],
        provenance: "llm_validated",
        confidence: { score: 0.98, reasons: ["seeded-e2e"] },
        invocationReason: {
          runtimeTrigger: "Incoming RX data packet from hardware matched BPF filter criteria",
          dispatchChain: [
            "offloadif_data_ind",
            "_offldmgr_protocol_data_handler",
            "_offldmgr_enhanced_data_handler",
            "wlan_bpf_filter_offload_handler",
          ],
          dispatchSite: {
            file: "/workspace/wlan_proc/wlan/protocol/src/cmn_infra/src/offload_mgr/offload_mgr_ext.c",
            line: 1107,
            snippet: "p_offldmgr_ctxt->offload_data[i].data_handler(...)",
          },
          registrationGate: {
            registrarFn: "wlan_bpf_enable_data_path",
            registrationApi: "offldmgr_register_data_offload",
            conditions: ["offload_data[i].vdev_bitmap & (1 << vdev_id)"],
          },
        },
        runtimeFlow: {
          targetApi: targetSymbol,
          runtimeTrigger: "Incoming RX data packet from hardware matched BPF filter criteria",
          dispatchChain: [
            "offloadif_data_ind",
            "_offldmgr_protocol_data_handler",
            "_offldmgr_enhanced_data_handler",
            "wlan_bpf_filter_offload_handler",
          ],
          dispatchSite: {
            file: "/workspace/wlan_proc/wlan/protocol/src/cmn_infra/src/offload_mgr/offload_mgr_ext.c",
            line: 1107,
            snippet: "p_offldmgr_ctxt->offload_data[i].data_handler(...)",
          },
          immediateInvoker: "_offldmgr_enhanced_data_handler",
        },
      },
    ],
    requiredFiles: [targetFile],
    hashManifest: { [targetFile]: fileHash },
    createdAt: new Date().toISOString(),
  })

  const mockLsp: any = {
    root: tmpRoot,
    openFile: async () => true,
    prepareCallHierarchy: async () => [
      {
        name: targetSymbol,
        uri: `file://${targetFile}`,
        selectionRange: { start: { line: 0, character: 5 } },
      },
    ],
    incomingCalls: async () => [],
    references: async () => [],
    hover: async () => null,
    definition: async () => [],
    declaration: async () => [],
    typeDefinition: async () => [],
    implementation: async () => [],
    documentHighlight: async () => [],
    documentSymbol: async () => [],
    workspaceSymbol: async () => [],
    foldingRange: async () => [],
    signatureHelp: async () => null,
    outgoingCalls: async () => [],
    supertypes: async () => [],
    subtypes: async () => [],
    rename: async () => null,
    prepareRename: async () => null,
    formatting: async () => [],
    rangeFormatting: async () => [],
    inlayHints: async () => [],
    codeAction: async () => [],
    getDiagnostics: () => [],
    clangdInfo: async () => null,
  }

  const tracker = new IndexTracker()
  tracker.markReady()
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end("Not found")
      return
    }
    const sessionId = (req.headers["mcp-session-id"] as string) ?? randomUUID()
    let transport = sessions.get(sessionId)
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id) => {
          sessions.set(id, transport!)
        },
      })
      const getClient = () => Promise.resolve(mockLsp)
      const server = await createMcpServer({ getClient, tracker, backend: createUnifiedBackend(getClient, tracker) })
      await server.connect(transport)
      sessions.set(sessionId, transport)
    }
    await transport.handleRequest(req, res)
  })

  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()))
  const port = (httpServer.address() as any).port
  client = new Client({ name: "reason-chain-e2e", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)))
})

afterAll(async () => {
  await client?.close()
  httpServer?.close()
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe("lsp_reason_chain end-to-end via MCP", () => {
  it("returns known indirect-caller runtime path", async () => {
    const result = await client.callTool({
      name: "lsp_reason_chain",
      arguments: {
        file: targetFile,
        line: 1,
        character: 1,
        targetSymbol: "wlan_bpf_filter_offload_handler",
        workspaceRoot: tmpRoot,
      },
    }) as any

    const text = result.content?.[0]?.type === "text" ? result.content[0].text : ""
    expect(text).toContain("Invocation reason chain: wlan_bpf_filter_offload_handler")

    // Indirect-caller runtime path (Layer B)
    expect(text).toContain("_offldmgr_enhanced_data_handler")
    expect(text).toContain("Dispatch site:")
    expect(text).toContain("offload_mgr_ext.c:1107")

    // Runtime trigger (Layer C)
    expect(text).toContain("Incoming RX data packet from hardware")

    // Structured invoker-first block
    expect(text).toContain("---runtime-flow-json---")
    expect(text).toContain("\"targetApi\": \"wlan_bpf_filter_offload_handler\"")
    expect(text).toContain("\"immediateInvoker\": \"_offldmgr_enhanced_data_handler\"")
    expect(text).toContain("---end-runtime-flow-json---")

    // Human-readable verification log from ACTUAL tool output
    console.log("✅ target: wlan_bpf_filter_offload_handler")
    console.log("✅ runtime dispatch chain:")

    const expectedFns = [
      "offloadif_data_ind",
      "_offldmgr_protocol_data_handler",
      "_offldmgr_enhanced_data_handler",
      "wlan_bpf_filter_offload_handler",
    ]
    for (const fn of expectedFns) {
      if (text.includes(fn)) {
        console.log(`   ✅ ${fn}`)
      } else {
        console.log(`   ❌ ${fn}`)
      }
      expect(text).toContain(fn)
    }

    console.log("✅ dispatch site: offload_mgr_ext.c:1107")
  })
})
