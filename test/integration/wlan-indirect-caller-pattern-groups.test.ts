import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { existsSync } from "fs"
import { LspClient } from "../../src/lsp/index.js"
import { IndexTracker } from "../../src/tracking/index.js"
import { collectIndirectCallers } from "../../src/tools/indirect-callers.js"
import { getWlanTargets, getWlanWorkspaceRoot } from "./wlan-targets.js"

const WLAN_ROOT = getWlanWorkspaceRoot()
const TCP_BRIDGE_PORT = Number(process.env.CLANGD_TCP_BRIDGE_PORT || "39575")
const SKIP = !existsSync(`${WLAN_ROOT}/compile_commands.json`)

type PatternGroupCase = {
  label: string
  targetId: string
  expectedIndirectCallers?: string[]
  expectedRegistrationApi?: string
  expectedDispatchKeyContains?: string
}

const GROUP_CASES: PatternGroupCase[] = [
  {
    label: "registration",
    targetId: "bpf-filter-offload-handler",
    expectedIndirectCallers: ["wlan_bpf_enable_data_path", "wlan_bpf_offload_test_route_uc_active"],
  },
  {
    label: "signals",
    targetId: "bpf-vdev-notify-handler",
    expectedIndirectCallers: ["wlan_bpf_offload_vdev_init"],
  },
  {
    label: "thread-communication",
    targetId: "bpf-wmi-cmd-handler",
    // For WMI dispatch-table patterns clangd may surface the table symbol
    // (bpf_offload_dispatch_entries) instead of registrar function name.
    // Validate via parser classification to ensure indirect path is detected.
    expectedRegistrationApi: "WMI_RegisterDispatchTable",
    expectedDispatchKeyContains: "WMI_BPF_",
  },
  {
    label: "irq",
    // WLAN target registry currently has no direct cmnos IRQ callback target;
    // use hardware-event callback family as closest real-workspace IRQ-like path.
    targetId: "bpf-event-pdev-notif",
    expectedIndirectCallers: ["wlan_enable_adaptive_apf"],
  },
]

let client: LspClient | null = null

async function waitForIndexReady(c: LspClient, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const probeFile = getWlanTargets()[0]?.file
  while (Date.now() < deadline) {
    const syms = await c.workspaceSymbol("wlan_")
    if (Array.isArray(syms) && syms.length >= 50) return true
    if (probeFile && existsSync(probeFile)) {
      const doc = await c.documentSymbol(probeFile)
      if (Array.isArray(doc) && doc.length > 0) return true
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

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
    console.warn(`SKIP: bridge connect/init failed on ${TCP_BRIDGE_PORT}: ${String((err as any)?.message || err)}`)
    client = null
  }
}, 15000)

afterAll(async () => {
  try { (client as any)?._conn?.dispose?.() } catch { /* ignore */ }
})

describe("WLAN indirect-caller pattern groups", () => {
  if (SKIP) {
    it.skip("WLAN workspace not available", () => {})
    return
  }

  const targets = getWlanTargets()

  it("finds indirect callers for registration/signals/thread/irq pattern groups", async () => {
    if (!client) {
      console.warn(`SKIP: clangd TCP bridge not available on ${TCP_BRIDGE_PORT}`)
      return
    }

    const ready = await waitForIndexReady(client)
    if (!ready) {
      console.warn("SKIP: clangd index not ready within timeout")
      return
    }

    for (const gc of GROUP_CASES) {
      const t = targets.find((x) => x.id === gc.targetId)
      if (!t) {
        console.log(`❌ ${gc.label}: target not found (${gc.targetId})`)
        throw new Error(`Missing target id: ${gc.targetId}`)
      }
      if (!existsSync(t.file)) {
        console.log(`❌ ${gc.label}: file missing (${t.file})`)
        throw new Error(`Missing file: ${t.file}`)
      }

      const graph = await collectIndirectCallers(client, {
        file: t.file,
        line: t.line,
        character: t.character,
        maxNodes: 50,
      })

      if (gc.expectedIndirectCallers && gc.expectedIndirectCallers.length > 0) {
        const found = new Set(graph.nodes.map((n) => n.name))
        const missing = gc.expectedIndirectCallers.filter((name) => !found.has(name))
        if (missing.length === 0) {
          console.log(`✅ ${gc.label}: ${t.id} => ${gc.expectedIndirectCallers.join(", ")}`)
        } else {
          console.log(`❌ ${gc.label}: ${t.id} missing ${missing.join(", ")}`)
        }
        expect(missing, `${gc.label} failed. Found: ${graph.nodes.map((n) => n.name).join(", ")}`).toHaveLength(0)
      }

      if (gc.expectedRegistrationApi) {
        const matched = graph.nodes.find(
          (n) => n.classification?.registrationApi === gc.expectedRegistrationApi,
        )
        const hasKey = gc.expectedDispatchKeyContains
          ? !!matched?.classification?.dispatchKey?.includes(gc.expectedDispatchKeyContains)
          : true
        if (matched && hasKey) {
          console.log(`✅ ${gc.label}: ${t.id} => ${gc.expectedRegistrationApi}:${matched.classification?.dispatchKey ?? ""}`)
        } else {
          console.log(`❌ ${gc.label}: ${t.id} classification missing ${gc.expectedRegistrationApi}`)
        }
        expect(!!matched && hasKey, `${gc.label} classification missing. Found: ${graph.nodes.map((n) => `${n.name}[${n.classification?.registrationApi ?? "-"}:${n.classification?.dispatchKey ?? "-"}]`).join(", ")}`).toBe(true)
      }
    }
  }, 180000)
})
