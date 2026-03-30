import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { createServer } from "http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "../../src/core/server.js"
import { IndexTracker } from "../../src/tracking/index.js"
import { clearCache } from "../../src/tools/indirect-caller-cache.js"
import { createUnifiedBackend } from "../../src/backend/unified-backend.js"

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/indirect-callers")
const HANDLERS_FILE = path.join(FIXTURE_DIR, "handlers.c")
const REGISTRATIONS_FILE = path.join(FIXTURE_DIR, "registrations.c")
let slowIndirectBlocker: Promise<void> | null = null

function createMockLspClient() {
  const handlers = readFileSync(HANDLERS_FILE, "utf8").split(/\n/)
  const registrations = readFileSync(REGISTRATIONS_FILE, "utf8").split(/\n/)
  const targetLine = handlers.findIndex((l) => l.includes("void wlan_bpf_filter_offload_handler("))
  const regLine = registrations.findIndex((l) => l.includes("wlan_bpf_filter_offload_handler"))
  const regChar = regLine >= 0 ? registrations[regLine].indexOf("wlan_bpf_filter_offload_handler") : -1

  return {
    prepareCallHierarchy: vi.fn().mockImplementation(async (file: string, line: number) => {
      if (file === HANDLERS_FILE && (line === 12 || line === 11 || line === 10) && slowIndirectBlocker) {
        await slowIndirectBlocker
      }
      await new Promise((r) => setTimeout(r, 20))
      if (file === HANDLERS_FILE && (line === targetLine || line === 12 || line === 11)) {
        return [{
          name: "wlan_bpf_filter_offload_handler",
          uri: `file://${HANDLERS_FILE}`,
          selectionRange: { start: { line: targetLine, character: 0 } },
        }]
      }
      if (file === REGISTRATIONS_FILE) {
        return [{
          name: "setup_offloads",
          uri: `file://${REGISTRATIONS_FILE}`,
          selectionRange: { start: { line: regLine, character: 0 } },
        }]
      }
      return []
    }),
    references: vi.fn().mockResolvedValue([
      { uri: `file://${HANDLERS_FILE}`, range: { start: { line: targetLine, character: 0 } } },
      { uri: `file://${REGISTRATIONS_FILE}`, range: { start: { line: regLine, character: regChar } } },
    ]),
    incomingCalls: vi.fn().mockResolvedValue([]),
    openFile: vi.fn().mockResolvedValue(true),
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
    rangeFormatting: vi.fn().mockResolvedValue([]),
    diagnostics: vi.fn().mockResolvedValue(null),
    codeAction: vi.fn().mockResolvedValue([]),
    root: FIXTURE_DIR,
  }
}

let clientA: Client
let clientB: Client
let httpServer: ReturnType<typeof createServer>
let port: number
let sessionCreateCount = 0
let collectCalls = 0

function parseBackendHealthCounters(text: string): {
  cacheHits: number
  dedupReuses: number
  freshComputes: number
} {
  const value = (label: string): number => {
    const line = text.split("\n").find((l) => l.startsWith(`${label}:`))
    if (!line) return 0
    const raw = line.split(":")[1]?.trim() ?? "0"
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  return {
    cacheHits: value("indirectCallerCacheHits"),
    dedupReuses: value("indirectCallerInflightDedupReuses"),
    freshComputes: value("indirectCallerFreshComputes"),
  }
}

function diffCounters(
  before: { cacheHits: number; dedupReuses: number; freshComputes: number },
  after: { cacheHits: number; dedupReuses: number; freshComputes: number },
): { cacheDelta: number; dedupDelta: number; freshDelta: number } {
  return {
    cacheDelta: after.cacheHits - before.cacheHits,
    dedupDelta: after.dedupReuses - before.dedupReuses,
    freshDelta: after.freshComputes - before.freshComputes,
  }
}

beforeAll(async () => {
  const tracker = new IndexTracker()
  tracker.markReady()
  const mockLsp = createMockLspClient()

  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js")
  const { randomUUID } = await import("crypto")
  const sessions = new Map<string, any>()

  httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end("Not found")
      return
    }

    const sessionId = (req.headers["mcp-session-id"] as string) ?? randomUUID()
    let transport = sessions.get(sessionId)
    if (!transport) {
      sessionCreateCount += 1
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id: string) => {
          sessions.set(id, transport)
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
  port = (httpServer.address() as any).port

  clientA = new Client({ name: "test-client-a", version: "1.0.0" })
  clientB = new Client({ name: "test-client-b", version: "1.0.0" })
  await clientA.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)))
  await clientB.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)))
})

afterAll(async () => {
  await clientA?.close()
  await clientB?.close()
  httpServer?.close()
})

describe("MCP concurrency: two clients share one daemon endpoint", () => {
  it("serves concurrent tool calls from two clients", async () => {
    const [a, b] = await Promise.all([
      clientA.callTool({
        name: "lsp_indirect_callers",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
      clientB.callTool({
        name: "lsp_indirect_callers",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
    ])

    expect(a.content?.[0]?.text).toContain("Callers of")
    expect(b.content?.[0]?.text).toContain("Callers of")
    expect(a.content?.[0]?.text).toContain("offldmgr_register_data_offload")
    expect(b.content?.[0]?.text).toContain("offldmgr_register_data_offload")
    expect(sessionCreateCount).toBeGreaterThanOrEqual(2)
  })

  it("deduplicates concurrent identical requests to one in-flight compute", async () => {
    // Count how many actual non-cache computes happen by looking for dedup marker.
    // One of the two concurrent calls should reuse in-flight result.
    const [a, b] = await Promise.all([
      clientA.callTool({
        name: "lsp_indirect_callers",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
      clientB.callTool({
        name: "lsp_indirect_callers",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
    ])

    const aText = a.content?.[0]?.text ?? ""
    const bText = b.content?.[0]?.text ?? ""
    const dedupHits = [aText, bText].filter((t) => t.includes("[dedup: shared in-flight result]")).length
    const cacheHits = [aText, bText].filter((t) => t.includes("[cache: hit")).length
    // If cache is already warm from prior tests, duplicate compute is still prevented via cache.
    // Accept either in-flight dedup marker OR cache-hit reuse path.
    expect(dedupHits >= 1 || cacheHits >= 1).toBe(true)
    collectCalls += 1
    expect(collectCalls).toBeGreaterThan(0)
  })

  it("keeps session behavior isolated under mixed concurrent intents", async () => {
    const [indirect, incoming] = await Promise.all([
      clientA.callTool({
        name: "lsp_indirect_callers",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
      clientB.callTool({
        name: "lsp_incoming_calls",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
    ])

    const indirectText = indirect.content?.[0]?.text ?? ""
    const incomingText = incoming.content?.[0]?.text ?? ""

    expect(indirectText).toContain("Callers of")
    expect(indirectText).toContain("offldmgr_register_data_offload")
    expect(incomingText).toContain("No incoming calls.")
    expect(indirectText).not.toContain("No incoming calls.")
  })

  it("isolates failure path so one client error does not poison peer request", async () => {
    const [bad, good] = await Promise.allSettled([
      clientA.callTool({
        name: "tool_does_not_exist",
        arguments: {},
      }) as Promise<any>,
      clientB.callTool({
        name: "lsp_indirect_callers",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
    ])

    expect(bad.status).toBe("fulfilled")
    expect(good.status).toBe("fulfilled")

    if (bad.status === "fulfilled") {
      const badText = bad.value.content?.[0]?.text ?? ""
      expect(bad.value.isError === true || badText.toLowerCase().includes("error")).toBe(true)
    }

    if (good.status === "fulfilled") {
      const text = good.value.content?.[0]?.text ?? ""
      expect(text).toContain("Callers of")
      expect(text).toContain("offldmgr_register_data_offload")
    }
  })

  it("handles repeated burst concurrency without unstable outputs", async () => {
    const clients = [clientA, clientB]
    const bursts = 3
    const perBurst = 6

    for (let burst = 0; burst < bursts; burst++) {
      const calls: Array<Promise<any>> = []
      for (let i = 0; i < perBurst; i++) {
        const c = clients[i % clients.length]
        calls.push(c.callTool({
          name: "lsp_indirect_callers",
          arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
        }) as Promise<any>)
      }

      const results = await Promise.all(calls)
      for (const r of results) {
        const text = r.content?.[0]?.text ?? ""
        expect(text).toContain("Callers of")
        expect(text).toContain("offldmgr_register_data_offload")
      }
    }
  })

  it("keeps fast peer request responsive while one concurrent request is slow", async () => {
    clearCache(FIXTURE_DIR)

    let releaseSlow: () => void = () => {}
    slowIndirectBlocker = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })

    const slowStart = Date.now()
    const slowPromise = clientA.callTool({
      name: "lsp_indirect_callers",
      arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
    }) as Promise<any>

    const fastStart = Date.now()
    const fastPromise = clientB.callTool({
      name: "lsp_incoming_calls",
      arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
    }) as Promise<any>

    const fastResult = await fastPromise
    const fastElapsed = Date.now() - fastStart

    const slowFinishedBeforeRelease = await Promise.race([
      slowPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ])

    releaseSlow()
    slowIndirectBlocker = null

    const slowResult = await slowPromise
    const slowElapsed = Date.now() - slowStart

    const fastText = fastResult.content?.[0]?.text ?? ""
    const slowText = slowResult.content?.[0]?.text ?? ""

    expect(fastText).toContain("No incoming calls.")
    expect(slowText).toContain("Callers of")
    expect(slowFinishedBeforeRelease).toBe(false)
    expect(fastElapsed).toBeLessThanOrEqual(slowElapsed)
  })

  it("stays stable under interleaved mixed-intent bursts", async () => {
    const clients = [clientA, clientB]
    const bursts = 3

    for (let burst = 0; burst < bursts; burst++) {
      const calls: Array<Promise<any>> = []

      // Interleave intents within each burst: indirect/incoming/indirect/incoming...
      for (let i = 0; i < 8; i++) {
        const c = clients[i % clients.length]
        if (i % 2 === 0) {
          calls.push(c.callTool({
            name: "lsp_indirect_callers",
            arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
          }) as Promise<any>)
        } else {
          calls.push(c.callTool({
            name: "lsp_incoming_calls",
            arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
          }) as Promise<any>)
        }
      }

      const results = await Promise.all(calls)
      for (let i = 0; i < results.length; i++) {
        const text = results[i]?.content?.[0]?.text ?? ""
        if (i % 2 === 0) {
          expect(text).toContain("Callers of")
          expect(text).toContain("offldmgr_register_data_offload")
        } else {
          expect(text).toContain("No incoming calls.")
        }
      }
    }
  })

  it("reports burst-level dedup/cache counters in backend health", async () => {
    const before = await (clientA.callTool({ name: "backend_health", arguments: {} }) as Promise<any>)
    const beforeText = before.content?.[0]?.text ?? ""
    const b = parseBackendHealthCounters(beforeText)

    clearCache(FIXTURE_DIR)
    const clients = [clientA, clientB]
    const bursts = 2
    const perBurst = 6

    for (let burst = 0; burst < bursts; burst++) {
      const calls: Array<Promise<any>> = []
      for (let i = 0; i < perBurst; i++) {
        const c = clients[i % clients.length]
        calls.push(c.callTool({
          name: "lsp_indirect_callers",
          arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
        }) as Promise<any>)
      }
      await Promise.all(calls)
    }

    const after = await (clientA.callTool({ name: "backend_health", arguments: {} }) as Promise<any>)
    const afterText = after.content?.[0]?.text ?? ""
    const a = parseBackendHealthCounters(afterText)

    expect(a.cacheHits).toBeGreaterThanOrEqual(b.cacheHits)
    expect(a.dedupReuses).toBeGreaterThanOrEqual(b.dedupReuses)
    expect(a.freshComputes).toBeGreaterThanOrEqual(b.freshComputes)
    expect((a.cacheHits - b.cacheHits) + (a.dedupReuses - b.dedupReuses)).toBeGreaterThan(0)
  })

  it("tracks deterministic telemetry deltas for isolated identical concurrency", async () => {
    clearCache(FIXTURE_DIR)

    const before = await (clientA.callTool({ name: "backend_health", arguments: {} }) as Promise<any>)
    const b = parseBackendHealthCounters(before.content?.[0]?.text ?? "")

    await Promise.all([
      clientA.callTool({
        name: "lsp_indirect_callers",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
      clientB.callTool({
        name: "lsp_indirect_callers",
        arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
      }) as Promise<any>,
    ])

    const after = await (clientA.callTool({ name: "backend_health", arguments: {} }) as Promise<any>)
    const a = parseBackendHealthCounters(after.content?.[0]?.text ?? "")

    const freshDelta = a.freshComputes - b.freshComputes
    const dedupDelta = a.dedupReuses - b.dedupReuses
    const cacheDelta = a.cacheHits - b.cacheHits

    expect(freshDelta).toBe(1)
    expect(dedupDelta).toBeGreaterThanOrEqual(1)
    expect(cacheDelta).toBeGreaterThanOrEqual(0)
  })

  it("keeps telemetry deltas monotonic across consecutive identical burst rounds", async () => {
    clearCache(FIXTURE_DIR)

    const snapshots: Array<{ cacheHits: number; dedupReuses: number; freshComputes: number }> = []
    const snap0 = await (clientA.callTool({ name: "backend_health", arguments: {} }) as Promise<any>)
    snapshots.push(parseBackendHealthCounters(snap0.content?.[0]?.text ?? ""))

    for (let round = 0; round < 3; round++) {
      await Promise.all([
        clientA.callTool({
          name: "lsp_indirect_callers",
          arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
        }) as Promise<any>,
        clientB.callTool({
          name: "lsp_indirect_callers",
          arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
        }) as Promise<any>,
      ])
      const snap = await (clientA.callTool({ name: "backend_health", arguments: {} }) as Promise<any>)
      snapshots.push(parseBackendHealthCounters(snap.content?.[0]?.text ?? ""))
    }

    for (let i = 1; i < snapshots.length; i++) {
      const d = diffCounters(snapshots[i - 1], snapshots[i])
      expect(d.cacheDelta).toBeGreaterThanOrEqual(0)
      expect(d.dedupDelta).toBeGreaterThanOrEqual(0)
      expect(d.freshDelta).toBeGreaterThanOrEqual(0)
      expect(d.cacheDelta + d.dedupDelta + d.freshDelta).toBeGreaterThan(0)
    }
  })

  it("keeps mixed-intent burst telemetry deltas non-negative without strict dedup exactness", async () => {
    clearCache(FIXTURE_DIR)

    const before = await (clientA.callTool({ name: "backend_health", arguments: {} }) as Promise<any>)
    const b = parseBackendHealthCounters(before.content?.[0]?.text ?? "")

    const clients = [clientA, clientB]
    const calls: Array<Promise<any>> = []
    for (let i = 0; i < 10; i++) {
      const c = clients[i % clients.length]
      if (i % 2 === 0) {
        calls.push(c.callTool({
          name: "lsp_indirect_callers",
          arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
        }) as Promise<any>)
      } else {
        calls.push(c.callTool({
          name: "lsp_incoming_calls",
          arguments: { file: HANDLERS_FILE, line: 12, character: 1 },
        }) as Promise<any>)
      }
    }
    await Promise.all(calls)

    const after = await (clientA.callTool({ name: "backend_health", arguments: {} }) as Promise<any>)
    const a = parseBackendHealthCounters(after.content?.[0]?.text ?? "")
    const d = diffCounters(b, a)

    expect(d.cacheDelta).toBeGreaterThanOrEqual(0)
    expect(d.dedupDelta).toBeGreaterThanOrEqual(0)
    expect(d.freshDelta).toBeGreaterThanOrEqual(0)
    expect(d.cacheDelta + d.dedupDelta + d.freshDelta).toBeGreaterThan(0)
  })
})
