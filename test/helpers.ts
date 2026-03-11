/**
 * test/helpers.ts — shared fixtures, assertion helpers, MCP HTTP client.
 *
 * All tests import from here. Nothing in this file spawns clangd or starts
 * any server — that is left to each test file's beforeAll/afterAll.
 */

import { createServer, createConnection, type Server, type Socket } from "net"
import { spawn, type ChildProcess } from "child_process"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"

// ── Workspace constants ───────────────────────────────────────────────────────

export const WORKSPACE =
  "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1"

export const CLANGD = "/usr/local/bin/clangd-20"

export const CLANGD_ARGS = [
  "--background-index",
  "--enable-config",
  `--compile-commands-dir=${WORKSPACE}`,
  "--log=error",
  "--clang-tidy=false",
  "--completion-style=detailed",
  "--header-insertion=never",
]

// Source files with verified symbol positions (1-based line/col)
export const FILES = {
  ESP_C:  `${WORKSPACE}/wlan_proc/wlan/perf_algs/src/sched_algo/esp_calculation.c`,
  RU_C:   `${WORKSPACE}/wlan_proc/wlan/perf_algs/src/sched_algo/ru_allocator.c`,
  SCHED_C:`${WORKSPACE}/wlan_proc/wlan/perf_algs/src/sched_algo/sched_algo.c`,
  SCHED_H:`${WORKSPACE}/wlan_proc/wlan/perf_algs/src/sched_algo/sched_algo.h`,
}

// Verified symbol positions — confirmed against source on 2026-03-10
export const POS = {
  // esp_calculation.c
  PMLO_DEF:   { file: FILES.ESP_C,   line: 27,  character: 6  }, // pmlo_account_ppdu_duration def
  ESP_DEF:    { file: FILES.ESP_C,   line: 47,  character: 6  }, // esp_account_ppdu_duration def
  ESP_NEFF:   { file: FILES.ESP_C,   line: 69,  character: 10 }, // esp_get_neffective def
  PMLO_CALL:  { file: FILES.ESP_C,   line: 56,  character: 5  }, // pmlo_account_ppdu_duration call
  // ru_allocator.c
  RU_INIT:    { file: FILES.RU_C,    line: 188, character: 24 }, // ru_alloc_init def
  RU_LEGAL:   { file: FILES.RU_C,    line: 258, character: 8  }, // ru_alloc_legal_ru_size def
  RU_STATIC:  { file: FILES.RU_C,    line: 236, character: 8  }, // ru_alloc_is_static_mode_enabled def
  // sched_algo.c
  SCHED_DELAY:{ file: FILES.SCHED_C, line: 426, character: 8  }, // sched_algo_delay_lower_ac def
  SCHED_POL:  { file: FILES.SCHED_C, line: 803, character: 10 }, // sched_algo_get_policy def
  // sched_algo.h
  SCHED_STRUCT:{ file: FILES.SCHED_H, line: 789, character: 16 }, // sched_txq_ctxt struct
}

// ── LSP framing helpers ───────────────────────────────────────────────────────

export function frameLsp(body: object): Buffer {
  const json = JSON.stringify(body)
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(json, "utf8")])
}

export function parseLspFrames(buf: Buffer): object[] {
  const messages: object[] = []
  let pos = 0
  while (pos < buf.length) {
    const sep = buf.indexOf("\r\n\r\n", pos)
    if (sep === -1) break
    const header = buf.slice(pos, sep).toString("ascii")
    const m = header.match(/Content-Length:\s*(\d+)/i)
    if (!m) { pos++; continue }
    const bodyLen = parseInt(m[1], 10)
    const bodyStart = sep + 4
    if (buf.length < bodyStart + bodyLen) break
    const body = JSON.parse(buf.slice(bodyStart, bodyStart + bodyLen).toString("utf8"))
    messages.push(body)
    pos = bodyStart + bodyLen
  }
  return messages
}

// ── Free port helper ──────────────────────────────────────────────────────────

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (!addr || typeof addr === "string") { srv.close(); return reject(new Error("no addr")) }
      const port = addr.port
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

// ── TCP client helper ─────────────────────────────────────────────────────────

export function connectTcp(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ port, host: "127.0.0.1" })
    sock.once("connect", () => resolve(sock))
    sock.once("error", reject)
  })
}

export function collectTcpData(sock: Socket, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      sock.removeAllListeners("data")
      resolve(Buffer.concat(chunks))
    }, timeoutMs)
    sock.on("data", (chunk: Buffer) => chunks.push(chunk))
    sock.once("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)) })
  })
}

// ── MCP HTTP client ───────────────────────────────────────────────────────────

export class McpClient {
  private _sid: string | null = null
  constructor(private _url: string) {}

  async init(): Promise<void> {
    const res = await fetch(this._url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} on initialize`)
    this._sid = res.headers.get("mcp-session-id")
    if (!this._sid) throw new Error("No mcp-session-id in response")
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this._sid) throw new Error("Not initialized")
    const res = await fetch(this._url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": this._sid,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9),
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} calling ${tool}`)
    const ct = res.headers.get("content-type") ?? ""
    let data: any
    if (ct.includes("text/event-stream")) {
      const text = await res.text()
      const dataLine = text.split("\n").find(l => l.startsWith("data:"))
      if (!dataLine) throw new Error(`No data line in SSE for ${tool}`)
      data = JSON.parse(dataLine.slice(5).trim())
    } else {
      data = await res.json()
    }
    if (data.error) throw new Error(`Tool error: ${JSON.stringify(data.error)}`)
    const content = data.result?.content
    if (!Array.isArray(content) || !content[0]) throw new Error(`No content in result for ${tool}`)
    return content[0].text as string
  }

  get sessionId(): string { return this._sid ?? "" }
}

// ── Process helpers ───────────────────────────────────────────────────────────

export function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() > deadline) return reject(new Error(`Port ${port} not open after ${timeoutMs}ms`))
      const sock = createConnection({ port, host: "127.0.0.1" })
      sock.once("connect", () => { sock.destroy(); resolve() })
      sock.once("error", () => setTimeout(attempt, 200))
    }
    attempt()
  })
}

export function spawnBridge(port: number, logFile: string): ChildProcess {
  const bridgeScript = path.join(__dirname, "../dist/bridge.js")
  return spawn(process.execPath, [
    bridgeScript,
    "--port", String(port),
    "--root", WORKSPACE,
    "--clangd", CLANGD,
    "--clangd-args", CLANGD_ARGS.join(","),
    "--log", logFile,
  ], { detached: false, stdio: "ignore" })
}

export function spawnHttpDaemon(httpPort: number, logFile: string): ChildProcess {
  const indexScript = path.join(__dirname, "../dist/index.js")
  return spawn(process.execPath, [
    indexScript,
    "--http-daemon",
    "--http-port", String(httpPort),
    "--root", WORKSPACE,
    "--clangd", CLANGD,
    "--clangd-args", CLANGD_ARGS.join(","),
  ], { detached: false, stdio: ["ignore", "ignore", "pipe"] })
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

export function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
}

export function assertContains(text: string, substr: string, label = ""): void {
  if (!text.includes(substr))
    throw new Error(`Expected ${label ? `[${label}] ` : ""}output to contain "${substr}"\nGot: ${text.slice(0, 300)}`)
}

export function assertMatches(text: string, re: RegExp, label = ""): void {
  if (!re.test(text))
    throw new Error(`Expected ${label ? `[${label}] ` : ""}output to match ${re}\nGot: ${text.slice(0, 300)}`)
}

export function assertNotError(text: string, label = ""): void {
  const lower = text.toLowerCase()
  if (lower.includes("error:") || lower.includes("failed to") || lower.includes("not found"))
    throw new Error(`${label ? `[${label}] ` : ""}Unexpected error in output: ${text.slice(0, 200)}`)
}

export function assertFileLineRange(text: string, file: string, minLine: number, maxLine: number): void {
  const base = path.basename(file)
  assertContains(text, base, "file name")
  const m = text.match(new RegExp(`${base}:(\\d+)`))
  if (!m) throw new Error(`No line number found for ${base} in: ${text.slice(0, 200)}`)
  const line = parseInt(m[1], 10)
  if (line < minLine || line > maxLine)
    throw new Error(`Line ${line} for ${base} outside expected range [${minLine}, ${maxLine}]`)
}

// ── Temp dir helper ───────────────────────────────────────────────────────────

export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "clangd-mcp-test-"))
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} } }
}
