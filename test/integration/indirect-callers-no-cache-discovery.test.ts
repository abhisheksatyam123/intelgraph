import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { mkdtempSync, copyFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createServer } from "http"
import { randomUUID } from "crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createMcpServer } from "../../src/core/server.js"
import { IndexTracker } from "../../src/tracking/index.js"
import { createUnifiedBackend } from "../../src/backend/unified-backend.js"

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/indirect-callers")

let tmpRoot = ""
let handlersFile = ""
let registrationsFile = ""
let client: Client
let httpServer: ReturnType<typeof createServer>

function createMockLspClient() {
  const handlers = require("fs").readFileSync(handlersFile, "utf8").split(/\n/)
  const registrations = require("fs").readFileSync(registrationsFile, "utf8").split(/\n/)
  const targetLine = handlers.findIndex((l: string) => l.includes("void wlan_bpf_filter_offload_handler("))
  const regLine = registrations.findIndex((l: string) => l.includes("wlan_bpf_filter_offload_handler"))
  const regChar = regLine >= 0 ? registrations[regLine].indexOf("wlan_bpf_filter_offload_handler") : -1

  return {
    root: tmpRoot,
    openFile: vi.fn().mockResolvedValue(true),
    prepareCallHierarchy: vi.fn().mockImplementation(async (file: string, line: number) => {
      if (file === handlersFile && line === targetLine) {
        return [{
          name: "wlan_bpf_filter_offload_handler",
          uri: `file://${handlersFile}`,
          selectionRange: { start: { line: targetLine, character: 0 } },
        }]
      }
      if (file === registrationsFile) {
        return [{
          name: "setup_offloads",
          uri: `file://${registrationsFile}`,
          selectionRange: { start: { line: regLine, character: 0 } },
        }]
      }
      return []
    }),
    incomingCalls: vi.fn().mockResolvedValue([]),
    references: vi.fn().mockResolvedValue([
      { uri: `file://${handlersFile}`, range: { start: { line: targetLine, character: 0 } } },
      { uri: `file://${registrationsFile}`, range: { start: { line: regLine, character: regChar } } },
    ]),
    hover: vi.fn().mockResolvedValue(null),
    definition: vi.fn().mockResolvedValue([]),
    declaration: vi.fn().mockResolvedValue([]),
    typeDefinition: vi.fn().mockResolvedValue([]),
    implementation: vi.fn().mockResolvedValue([]),
    documentHighlight: vi.fn().mockResolvedValue([]),
    documentSymbol: vi.fn().mockResolvedValue([]),
    workspaceSymbol: vi.fn().mockResolvedValue([]),
    foldingRange: vi.fn().mockResolvedValue([]),
    signatureHelp: vi.fn().mockResolvedValue(null),
    outgoingCalls: vi.fn().mockResolvedValue([]),
    supertypes: vi.fn().mockResolvedValue([]),
    subtypes: vi.fn().mockResolvedValue([]),
    rename: vi.fn().mockResolvedValue(null),
    prepareRename: vi.fn().mockResolvedValue(null),
    formatting: vi.fn().mockResolvedValue([]),
    rangeFormatting: vi.fn().mockResolvedValue([]),
    inlayHints: vi.fn().mockResolvedValue([]),
    codeAction: vi.fn().mockResolvedValue([]),
    getDiagnostics: vi.fn().mockReturnValue([]),
    clangdInfo: vi.fn().mockResolvedValue(null),
  }
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "clangd-mcp-nocache-"))
  handlersFile = path.join(tmpRoot, "handlers.c")
  registrationsFile = path.join(tmpRoot, "registrations.c")
  copyFileSync(path.join(FIXTURE_DIR, "handlers.c"), handlersFile)
  copyFileSync(path.join(FIXTURE_DIR, "registrations.c"), registrationsFile)

  const mockLsp = createMockLspClient()
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
      const getClient = () => Promise.resolve(mockLsp as any)
      const server = await createMcpServer({ getClient, tracker, backend: createUnifiedBackend(getClient, tracker) })
      await server.connect(transport)
      sessions.set(sessionId, transport)
    }
    await transport.handleRequest(req, res)
  })

  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()))
  const port = (httpServer.address() as any).port
  client = new Client({ name: "indirect-discovery", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)))
})

afterAll(async () => {
  await client?.close()
  httpServer?.close()
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe("lsp_indirect_callers no-cache discovery via program", () => {
  it("discovers indirect callers on first call and caches on second call", async () => {
    const args = { file: handlersFile, line: 12, character: 1 }

    const first = await client.callTool({ name: "lsp_indirect_callers", arguments: args }) as any
    const firstText = first.content?.[0]?.type === "text" ? first.content[0].text : ""
    expect(firstText).toContain("Callers of wlan_bpf_filter_offload_handler")
    expect(firstText).toContain("offldmgr_register_data_offload")
    expect(firstText).not.toContain("[cache: hit")
    console.log("✅ first call discovered indirect caller through program")

    const second = await client.callTool({ name: "lsp_indirect_callers", arguments: args }) as any
    const secondText = second.content?.[0]?.type === "text" ? second.content[0].text : ""
    expect(secondText).toContain("offldmgr_register_data_offload")
    expect(secondText).toContain("[cache: hit")
    console.log("✅ second call served cached indirect-caller result")
  })
})
