import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { existsSync } from "fs"
import { LspClient } from "../../src/lsp/index.js"
import { IndexTracker } from "../../src/tracking/index.js"
import { collectIndirectCallers } from "../../src/tools/indirect-callers.js"
import { getWlanTargets, getWlanWorkspaceRoot } from "./wlan-targets.js"

const WLAN_ROOT = getWlanWorkspaceRoot()
const TCP_BRIDGE_PORT = Number(process.env.CLANGD_TCP_BRIDGE_PORT || "39575")
const SKIP = !existsSync(`${WLAN_ROOT}/compile_commands.json`)

let client: LspClient | null = null

beforeAll(async () => {
  if (SKIP) return
  const tracker = new IndexTracker()
  tracker.markReady()
  try {
    // Simple robust connect: try fresh init first, then warm reconnect.
    try {
      client = await LspClient.createFromSocket(TCP_BRIDGE_PORT, WLAN_ROOT, tracker, false)
    } catch (err: any) {
      if (String(err?.message || err).includes("already initialized")) {
        client = await LspClient.createFromSocket(TCP_BRIDGE_PORT, WLAN_ROOT, tracker, true)
      } else {
        throw err
      }
    }
  } catch (err) {
    console.warn(`SKIP: clangd TCP bridge connect/init failed on ${TCP_BRIDGE_PORT}: ${String((err as any)?.message || err)}`)
    client = null
  }
}, 15000)

afterAll(async () => {
  try { (client as any)?._conn?.dispose?.() } catch { /* ignore */ }
})

describe("WLAN known-pattern indirect callers (real workspace)", () => {
  if (SKIP) {
    it.skip("WLAN workspace not available", () => {})
    return
  }

  const targets = getWlanTargets()

  async function waitForIndexReady(c: LspClient, timeoutMs = 90_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const syms = await c.workspaceSymbol("wlan_")
      if (Array.isArray(syms) && syms.length > 200) return true
      await new Promise((r) => setTimeout(r, 1500))
    }
    return false
  }

  it("finds known indirect callers for each WLAN target", async () => {
    if (!client) {
      console.warn(`SKIP: clangd TCP bridge not available on ${TCP_BRIDGE_PORT}`)
      return
    }

    const ready = await waitForIndexReady(client)
    if (!ready) {
      console.warn("SKIP: clangd index not ready within timeout")
      return
    }

    for (const t of targets) {
      if (!existsSync(t.file)) {
        console.log(`❌ ${t.id}: missing file ${t.file}`)
        throw new Error(`Missing WLAN file for target ${t.id}`)
      }

      const graph = await collectIndirectCallers(client, {
        file: t.file,
        line: t.line,
        character: t.character,
        maxNodes: 50,
      })

      const foundNames = new Set(graph.nodes.map((n) => n.name))
      const missing = t.expectedIndirectCallers.filter((name) => !foundNames.has(name))

      if (missing.length === 0) {
        console.log(`✅ ${t.id}: found all known indirect callers (${t.expectedIndirectCallers.join(", ")})`)
      } else {
        console.log(`❌ ${t.id}: missing indirect callers (${missing.join(", ")})`)
      }

      expect(
        missing,
        `${t.id} missing known indirect callers. Found: ${graph.nodes.map((n) => n.name).join(", ")}`,
      ).toHaveLength(0)
    }
  }, 180000)
})
