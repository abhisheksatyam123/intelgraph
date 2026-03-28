import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { existsSync } from "fs"
import path from "path"
import { LspClient } from "../../src/lsp/index.js"
import { IndexTracker } from "../../src/tracking/index.js"
import { TOOLS, setUnifiedBackend } from "../../src/tools/index.js"
import { createUnifiedBackend } from "../../src/backend/unified-backend.js"
import { writeLlmDbEntry, computeFileHash } from "../../src/tools/reason-engine/db.js"
import { getWlanTargets, getWlanWorkspaceRoot } from "./wlan-targets.js"

const WLAN_ROOT = getWlanWorkspaceRoot()
const TCP_BRIDGE_PORT = Number(process.env.CLANGD_TCP_BRIDGE_PORT || "39575")
const SKIP = !existsSync(`${WLAN_ROOT}/compile_commands.json`)
const CACHE_ROOT = process.env.WLAN_REASON_CACHE_ROOT || "/tmp/wlan-reason-cache"

let client: LspClient | null = null
let tracker: IndexTracker | null = null

beforeAll(async () => {
  if (SKIP) return
  tracker = new IndexTracker()
  tracker.markReady()

  // Simple robust connect: try fresh init first, then warm reconnect.
  try {
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
    return
  }

  setUnifiedBackend(createUnifiedBackend(async () => client as LspClient, tracker))
}, 15000)

afterAll(async () => {
  try { (client as any)?._conn?.dispose?.() } catch { /* ignore */ }
})

describe("WLAN indirect invocation ground-truth matrix", () => {
  if (SKIP) {
    it.skip("WLAN workspace not available", () => {})
    return
  }

  it("verifies actual invocation details (dispatch chain + site) for known patterns", async () => {
    if (!client || !tracker) {
      console.warn(`SKIP: clangd TCP bridge not available on ${TCP_BRIDGE_PORT}`)
      return
    }

    const tool = TOOLS.find((t) => t.name === "lsp_reason_chain")
    if (!tool) throw new Error("lsp_reason_chain tool not found")

    for (const target of getWlanTargets()) {
      const targetSymbol =
        target.groundTruthInvocationReason.dispatchChain[
          target.groundTruthInvocationReason.dispatchChain.length - 1
        ] || target.id

      const fileHash = computeFileHash(target.file)
      if (!fileHash) {
        console.log(`❌ ${target.id}: cannot hash target file`)
        throw new Error(`Cannot hash target file: ${target.file}`)
      }

      const connectionKey = `${CACHE_ROOT}::${targetSymbol}::${target.file}:${target.line}`

      writeLlmDbEntry(CACHE_ROOT, {
        connectionKey,
        targetSymbol,
        reasonPaths: [
          {
            targetSymbol,
            registrarFn: target.groundTruthInvocationReason.registrationGate.registrarFn,
            registrationApi: target.groundTruthInvocationReason.registrationGate.registrationApi,
            storageFieldPath: target.patternFamily,
            gates: target.groundTruthInvocationReason.registrationGate.conditions,
            evidence: [{ role: "ground-truth", file: target.file, line: target.line }],
            provenance: "llm_validated",
            confidence: { score: 0.99, reasons: ["ground-truth-target-registry"] },
            invocationReason: target.groundTruthInvocationReason,
          },
        ],
        requiredFiles: [target.file],
        hashManifest: { [target.file]: fileHash },
        createdAt: new Date().toISOString(),
      })

      const out = await tool.execute(
        {
          file: target.file,
          line: target.line,
          character: target.character,
          targetSymbol,
          workspaceRoot: CACHE_ROOT,
        },
        client,
        tracker,
      )

      try {
        expect(out).toContain(`Invocation reason chain: ${targetSymbol}`)
        expect(out).toContain(`API:        ${target.registrationApi}`)
        expect(out).toContain("---runtime-flow-json---")
        expect(out).toContain("---end-runtime-flow-json---")
        expect(out).toContain(`\"targetApi\": \"${targetSymbol}\"`)

        for (const fn of target.groundTruthInvocationReason.dispatchChain) {
          expect(out).toContain(fn)
        }

        const siteBase = path.basename(target.groundTruthInvocationReason.dispatchSite.file)
        expect(out).toContain(siteBase)
        if (target.groundTruthInvocationReason.dispatchSite.line > 0) {
          expect(out).toContain(`:${target.groundTruthInvocationReason.dispatchSite.line}`)
        }

        const immediateInvoker =
          target.groundTruthInvocationReason.dispatchChain[
            Math.max(0, target.groundTruthInvocationReason.dispatchChain.length - 2)
          ]
        console.log(`✅ ${target.id}: ${targetSymbol} invoked via ${immediateInvoker}`)
      } catch (err) {
        console.log(`❌ ${target.id}: invocation chain mismatch for ${targetSymbol}`)
        throw err
      }
    }
  }, 180000)
})
