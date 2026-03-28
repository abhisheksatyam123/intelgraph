import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { mkdtempSync, copyFileSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { createServer } from "http"
import { randomUUID } from "crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { createMcpServer } from "../../src/core/server.js"
import { IndexTracker } from "../../src/tracking/index.js"

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/indirect-callers")

type PatternCase = {
  callback: string
  expectedApi: string
  expectedKey: string
  /** If true, this API was removed from the registry and is now handled by the auto-classifier.
   *  The annotation tag won't appear in the output, but the source text should still contain the API name. */
  autoClassified?: boolean
}

const CASES: PatternCase[] = [
  { callback: "wlan_bpf_filter_offload_handler", expectedApi: "offldmgr_register_data_offload", expectedKey: "OFFLOAD_BPF", autoClassified: true },
  { callback: "wlan_lpi_scan_cb", expectedApi: "offldmgr_register_nondata_offload", expectedKey: "OFFLOAD_LPI_SCAN", autoClassified: true },
  { callback: "wls_fw_scan_result_handler", expectedApi: "wmi_unified_register_event_handler", expectedKey: "WMI_LPI_RESULT_EVENTID" },
  { callback: "wsi_high_prio_irq_route", expectedApi: "cmnos_irq_register_dynamic", expectedKey: "A_INUM_WSI" },
  { callback: "wal_tqm_hipri_status_intr_sig_hdlr", expectedApi: "wlan_thread_register_signal_wrapper", expectedKey: "WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR", autoClassified: true },
  { callback: "wal_tqm_sync_notify_hdlr", expectedApi: "wlan_thread_msg_handler_register_dval_dptr1_dptr2", expectedKey: "WLAN_THREAD_COMM_FUNC_TQM_NOTIFY", autoClassified: true },
  { callback: "_d0wow_wmi_cmd_handler", expectedApi: "WMI_RegisterDispatchTable", expectedKey: "WMI_D0_WOW_ENABLE_DISABLE_CMDID", autoClassified: true },
  { callback: "vdev_start_resp_handler", expectedApi: "wlan_vdev_register_notif_handler", expectedKey: "WLAN_VDEV_SM_EV_START_RESP", autoClassified: true },
  { callback: "htt_rx_ce_handler", expectedApi: "ce_callback_register", expectedKey: "CE_ID_0", autoClassified: true },
  { callback: "wow_wakeup_handler", expectedApi: "wlan_wow_register_notif_handler", expectedKey: "WOW_WAKEUP_EVENT", autoClassified: true },
  { callback: "wsi_low_prio_irq_route", expectedApi: "cmnos_irq_register", expectedKey: "A_INUM_WSI_LOW" },
  { callback: "wal_tqm_low_prio_sig_hdlr", expectedApi: "wlan_thread_register_signal", expectedKey: "WLAN_THREAD_SIG_TQM_LOPRI_STATUS_HW_INTR", autoClassified: true },
  { callback: "wal_tqm_varlen_notify_hdlr", expectedApi: "wlan_thread_msg_handler_register_var_len_buf", expectedKey: "WLAN_THREAD_COMM_FUNC_TQM_NOTIFY_VARLEN", autoClassified: true },
  { callback: "wal_phy_sleep_wake_event_hdlr", expectedApi: "wal_phy_dev_register_event_handler", expectedKey: "WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE", autoClassified: true },
  { callback: "coex_wlan_state_handler", expectedApi: "coex_asm_register", expectedKey: "COEX_ASM_CLIENT_WLAN", autoClassified: true },
  { callback: "tbd_wlan_cfg_callback", expectedApi: "tbd_register_tbd_callback", expectedKey: "TBD_CFG_WLAN", autoClassified: true },
  { callback: "coex_wlan_notify_handler", expectedApi: "coex_asm_register_notify", expectedKey: "COEX_ASM_NOTIFY_WLAN", autoClassified: true },
  { callback: "wlan_roam_handoff_state_handler", expectedApi: "wlan_roam_register_handoff_notify", expectedKey: "ROAM_HANDOFF_PRE_AUTH", autoClassified: true },
  { callback: "wlan_nan_event_state_handler", expectedApi: "wlan_nan_register_event_notify", expectedKey: "NAN_EVENT_LINK_STATE", autoClassified: true },
  { callback: "wlan_traffic_mon_notify_handler", expectedApi: "wlan_traffic_register_notify_handler", expectedKey: "TRAFFIC_NOTIFY_TXRX", autoClassified: true },
]

let tmpRoot = ""
let handlersFile = ""
let registrationsFile = ""
let client: Client
let httpServer: ReturnType<typeof createServer>

const handlerLineByCallback = new Map<string, number>()
const callbackByHandlerLine = new Map<number, string>()
const regPosByCallback = new Map<string, { line: number; char: number }>()

function indexFixturePositions() {
  const handlers = readFileSync(handlersFile, "utf8").split(/\n/)
  const registrations = readFileSync(registrationsFile, "utf8").split(/\n/)

  for (const c of CASES) {
    const hLine = handlers.findIndex((l) => l.includes(`void ${c.callback}(`))
    const rLine = registrations.findIndex((l) => l.includes(c.callback))
    const rChar = rLine >= 0 ? registrations[rLine].indexOf(c.callback) : -1

    if (hLine >= 0) {
      handlerLineByCallback.set(c.callback, hLine)
      callbackByHandlerLine.set(hLine, c.callback)
    }
    if (rLine >= 0 && rChar >= 0) {
      regPosByCallback.set(c.callback, { line: rLine, char: rChar })
    }
  }
}

function createMockLspClient() {
  return {
    root: tmpRoot,
    openFile: vi.fn().mockResolvedValue(true),
    prepareCallHierarchy: vi.fn().mockImplementation(async (file: string, line: number) => {
      if (file === handlersFile) {
        const cb = callbackByHandlerLine.get(line)
        if (!cb) return []
        return [{ name: cb, uri: `file://${handlersFile}`, selectionRange: { start: { line, character: 0 } } }]
      }

      if (file === registrationsFile) {
        return [{ name: "registrar_fn", uri: `file://${registrationsFile}`, selectionRange: { start: { line, character: 0 } } }]
      }

      return []
    }),
    incomingCalls: vi.fn().mockResolvedValue([]),
    references: vi.fn().mockImplementation(async (_file: string, line: number) => {
      const cb = callbackByHandlerLine.get(line)
      if (!cb) return []
      const hLine = handlerLineByCallback.get(cb)
      const reg = regPosByCallback.get(cb)
      if (hLine == null || !reg) return []
      return [
        { uri: `file://${handlersFile}`, range: { start: { line: hLine, character: 0 } } },
        { uri: `file://${registrationsFile}`, range: { start: { line: reg.line, character: reg.char } } },
      ]
    }),
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
  tmpRoot = mkdtempSync(path.join(tmpdir(), "clangd-mcp-all-patterns-"))
  handlersFile = path.join(tmpRoot, "handlers.c")
  registrationsFile = path.join(tmpRoot, "registrations.c")
  copyFileSync(path.join(FIXTURE_DIR, "handlers.c"), handlersFile)
  copyFileSync(path.join(FIXTURE_DIR, "registrations.c"), registrationsFile)

  indexFixturePositions()

  const mockLsp = createMockLspClient()
  const tracker = new IndexTracker()
  tracker.markReady()
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") return void res.writeHead(404).end("Not found")
    const sessionId = (req.headers["mcp-session-id"] as string) ?? randomUUID()
    let transport = sessions.get(sessionId)
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id) => sessions.set(id, transport!),
      })
      const server = await createMcpServer(() => Promise.resolve(mockLsp as any), tracker)
      await server.connect(transport)
      sessions.set(sessionId, transport)
    }
    await transport.handleRequest(req, res)
  })

  await new Promise<void>((resolve) => httpServer.listen(0, () => resolve()))
  const port = (httpServer.address() as any).port
  client = new Client({ name: "indirect-all-patterns", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)))
})

afterAll(async () => {
  await client?.close()
  httpServer?.close()
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe("lsp_indirect_callers all-pattern no-cache discovery", () => {
  it("finds indirect callers for every known pattern case", async () => {
    for (const c of CASES) {
      const line0 = handlerLineByCallback.get(c.callback)
      try {
        expect(line0, `Missing handler line for ${c.callback}`).toBeDefined()

        const result = await client.callTool({
          name: "lsp_indirect_callers",
          arguments: { file: handlersFile, line: (line0 as number) + 1, character: 1 },
        }) as any

        const text = result.content?.[0]?.type === "text" ? result.content[0].text : ""
        expect(text).toContain(`Callers of ${c.callback}`)

        if (c.autoClassified) {
          // API was removed from registry — now handled by auto-classifier.
          // Annotation tag won't appear, but source text should still contain the API name.
          expect(text).toContain(c.expectedApi)
        } else {
          expect(text).toContain(`[${c.expectedApi}:${c.expectedKey}]`)
        }
        expect(text).not.toContain("[cache: hit")

        console.log(`✅ ${c.callback} <= ${c.expectedApi}:${c.expectedKey}`)
      } catch (err) {
        console.log(`❌ ${c.callback} <= ${c.expectedApi}:${c.expectedKey}`)
        throw err
      }
    }
  })
})
