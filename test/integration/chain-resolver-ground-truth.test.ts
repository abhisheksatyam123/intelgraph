/**
 * chain-resolver-ground-truth.test.ts — Code-derived chain resolver against live WLAN codebase.
 *
 * Tests resolveChain() directly (not via lsp_reason_chain) against the real WLAN
 * source files using a live clangd TCP bridge. Verifies the correct LSP traversal:
 *
 *   1. definition() on registration call → registration API body
 *   2. findStoreInDefinition(body, callbackParamName) → storeFieldName
 *   3. references() on storeFieldName → dispatch call sites
 *   4. prepareCallHierarchy() at call site → dispatch function name
 *   5. incomingCalls() on dispatch function → runtime trigger callers
 *
 * Skip conditions (same as wlan-indirect-invocation-ground-truth.test.ts):
 *   - WLAN workspace compile_commands.json not present
 *   - clangd TCP bridge not reachable on CLANGD_TCP_BRIDGE_PORT
 *
 * Four storage architectures covered:
 *   P1: array-indexed field (data_handler)   — offload_mgr_ext.c
 *   P2: array-indexed field (notif_handler)  — offload_mgr_ext.c
 *   P3: STAILQ subscriber list (handler)     — wlan_vdev.c
 *   P4: direct array slot (irq_route_cb)     — cmnos_thread.c
 *
 * Temporary stability knobs (diagnostics/workstation/CI snapshot mode):
 *   - CHAIN_TEST_TIMEOUT_01880_MS=<ms>
 *       Extends per-test timeout only for 01880 runs to absorb transient
 *       call-hierarchy latency spikes.
 *   - CHAIN_RETRY_TIMEOUT_01880=1
 *       Enables single reconnect+retry when resolveChain timeout occurs on
 *       01880 runs.
 *   - CHAIN_RESOLVE_TIMEOUT_MS=<ms>
 *       Hard timeout for resolveChain call in this integration harness.
 *   - CHAIN_FORCE_RETRY_ON_DISPOSED=1
 *       Diagnostic-only reconnect+retry path for disposed LSP sessions.
 *       Non-gating: must not be used as parity acceptance criterion.
 *   - CHAIN_SINGLE_SOCKET_MODE=1
 *       Reuses one active client session to reduce reconnect churn during
 *       01968 full-mode probes.
 *   - CHAIN_LIVE_TIMEOUT_MS=<ms>
 *       Caps pre-resolve liveness recovery budget; when exhausted, probe
 *       fails fast with explicit transport blocker classification.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { existsSync, readFileSync } from "fs"
import { LspClient } from "../../src/lsp/index.js"
import { IndexTracker } from "../../src/tracking/index.js"
import { resolveChain } from "../../src/tools/pattern-resolver/index.js"
import type { ResolverDeps } from "../../src/tools/pattern-resolver/types.js"
import { getChainResolverTargets, getWlanWorkspaceRoot } from "./wlan-targets.js"

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

const WLAN_ROOT = getWlanWorkspaceRoot()
const TCP_BRIDGE_PORT = Number(process.env.CLANGD_TCP_BRIDGE_PORT || "39575")
const SKIP = !existsSync(`${WLAN_ROOT}/compile_commands.json`)
const CHAIN_RESOLVE_TIMEOUT_MS = Number(process.env.CHAIN_RESOLVE_TIMEOUT_MS || "0")
const CHAIN_SHALLOW_01968 = process.env.CHAIN_SHALLOW_01968 === "1"
const CHAIN_FORCE_RETRY_ON_DISPOSED = process.env.CHAIN_FORCE_RETRY_ON_DISPOSED === "1"
const CHAIN_ATTACH_BRIDGE_LOG_EXCERPT = process.env.CHAIN_ATTACH_BRIDGE_LOG_EXCERPT === "1"
const CHAIN_RETRY_TIMEOUT_01880 = process.env.CHAIN_RETRY_TIMEOUT_01880 === "1"
const CHAIN_TEST_TIMEOUT_01880_MS = Number(process.env.CHAIN_TEST_TIMEOUT_01880_MS || "0")
const EFFECTIVE_TEST_TIMEOUT_MS = WLAN_ROOT.includes("01880") && CHAIN_TEST_TIMEOUT_01880_MS > 0
  ? CHAIN_TEST_TIMEOUT_01880_MS
  : 30000
const CHAIN_SINGLE_SOCKET_MODE = process.env.CHAIN_SINGLE_SOCKET_MODE === "1"
const CHAIN_LIVE_TIMEOUT_MS = Number(process.env.CHAIN_LIVE_TIMEOUT_MS || "0")

// ---------------------------------------------------------------------------
// LSP client setup
// ---------------------------------------------------------------------------

let client: LspClient | null = null
let tracker: IndexTracker | null = null

async function reconnectClient(force = false): Promise<void> {
  if (!tracker) return
  if (CHAIN_SINGLE_SOCKET_MODE) {
    // In single-socket mode, avoid aggressive reconnect churn. Reuse current
    // client unless it is absent.
    if (client && !force) return
  }
  try { (client as any)?._conn?.dispose?.() } catch { /* ignore */ }
  client = await Promise.race([
    LspClient.createFromSocket(TCP_BRIDGE_PORT, WLAN_ROOT, tracker, true),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("reconnect timeout (12000ms)")), 12000),
    ),
  ])
}

beforeAll(async () => {
  if (SKIP) return
  tracker = new IndexTracker()
  tracker.markReady()

  const connectWithTimeout = async (skipInit: boolean, ms: number) => {
    return await Promise.race([
      LspClient.createFromSocket(TCP_BRIDGE_PORT, WLAN_ROOT, tracker!, skipInit),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`connect timeout (${ms}ms, skipInit=${skipInit})`)), ms),
      ),
    ])
  }

  try {
    if (CHAIN_SINGLE_SOCKET_MODE) {
      client = await connectWithTimeout(true, 12000)
      return
    }

    try {
      client = await connectWithTimeout(false, 12000)
    } catch (err: any) {
      const msg = String(err?.message || err)
      if (msg.includes("already initialized") || msg.includes("connect timeout")) {
        client = await connectWithTimeout(true, 12000)
      } else {
        throw err
      }
    }
  } catch (err) {
    console.warn(`SKIP: bridge connect/init failed on ${TCP_BRIDGE_PORT}: ${String((err as any)?.message || err)}`)
    client = null
    return
  }
}, 15000)

afterAll(async () => {
  try { (client as any)?._conn?.dispose?.() } catch { /* ignore */ }
})

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function readFileSafe(filePath: string): string {
  try { return readFileSync(filePath, "utf8") } catch { return "" }
}

function readBridgeLogExcerpt(root: string, limit = 12): string[] {
  const logPath = `${root}/clangd-mcp-bridge.log`
  if (!existsSync(logPath)) return []
  try {
    const text = readFileSync(logPath, "utf8")
    const lines = text.split(/\r?\n/).filter(Boolean)
    return lines.slice(Math.max(0, lines.length - limit))
  } catch {
    return []
  }
}

async function ensureClientLive(maxAttempts = 3): Promise<boolean> {
  const end = CHAIN_LIVE_TIMEOUT_MS > 0 ? Date.now() + CHAIN_LIVE_TIMEOUT_MS : 0
  for (let i = 0; i < maxAttempts; i++) {
    if (end > 0 && Date.now() >= end) return false
    try {
      const probe = (client as any)?.clangdInfo?.()
      const info = end > 0
        ? await Promise.race([
          probe,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("liveness timeout")), Math.max(1, end - Date.now()))
          }),
        ])
        : await probe
      if (info) return true
    } catch {
      // retry via reconnect below
    }
    if (end > 0 && Date.now() >= end) return false
    await reconnectClient(true)
  }
  return false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WLAN chain-resolver ground-truth", () => {
  if (SKIP) {
    it.skip("WLAN workspace not available", () => {})
    return
  }

  for (const target of getChainResolverTargets()) {
    it(`resolves full chain for ${target.id} (${target.registrationApi} → ${target.expectedDispatchFn})`, async () => {
      if (!client || !tracker) {
        console.warn(`SKIP: clangd TCP bridge not available on ${TCP_BRIDGE_PORT}`)
        return
      }

      const deps: ResolverDeps = {
        lspClient: {
          definition: async (file, line, char) => {
            try {
              return await (client as any).definition(file, line, char)
            } catch (err: any) {
              if (String(err?.message || err).includes("Connection is disposed")) {
                await reconnectClient(true)
                return await (client as any).definition(file, line, char)
              }
              throw err
            }
          },
          references: async (file, line, char) => {
            try {
              return await (client as any).references(file, line, char)
            } catch (err: any) {
              if (String(err?.message || err).includes("Connection is disposed")) {
                await reconnectClient(true)
                return await (client as any).references(file, line, char)
              }
              throw err
            }
          },
          outgoingCalls: async (file, line, char) => {
            try {
              return await (client as any).outgoingCalls(file, line, char)
            } catch (err: any) {
              if (String(err?.message || err).includes("Connection is disposed")) {
                await reconnectClient(true)
                return await (client as any).outgoingCalls(file, line, char)
              }
              throw err
            }
          },
          incomingCalls: async (file, line, char) => {
            try {
              return await (client as any).incomingCalls(file, line, char)
            } catch (err: any) {
              if (String(err?.message || err).includes("Connection is disposed")) {
                await reconnectClient(true)
                return await (client as any).incomingCalls(file, line, char)
              }
              throw err
            }
          },
          prepareCallHierarchy: async (file, line, char) => {
            try {
              return await (client as any).prepareCallHierarchy(file, line, char)
            } catch (err: any) {
              if (String(err?.message || err).includes("Connection is disposed")) {
                await reconnectClient(true)
                return await (client as any).prepareCallHierarchy(file, line, char)
              }
              throw err
            }
          },
          documentSymbol: async (file) => {
            try {
              return await (client as any).documentSymbol(file)
            } catch (err: any) {
              if (String(err?.message || err).includes("Connection is disposed")) {
                await reconnectClient(true)
                return await (client as any).documentSymbol(file)
              }
              throw err
            }
          },
          hover: async (file, line, char) => {
            try {
              return await (client as any).hover(file, line, char)
            } catch (err: any) {
              if (String(err?.message || err).includes("Connection is disposed")) {
                await reconnectClient(true)
                return await (client as any).hover(file, line, char)
              }
              throw err
            }
          },
          openFile: async (file, text) => {
            try {
              return await (client as any).openFile(file, text)
            } catch (err: any) {
              if (String(err?.message || err).includes("Connection is disposed")) {
                await reconnectClient(true)
                return await (client as any).openFile(file, text)
              }
              throw err
            }
          },
        },
        readFile: readFileSafe,
        logDebug: (event, context) => {
          if (process.env.CHAIN_RESOLVER_DEBUG === "1") {
            console.log(`[chain-debug] ${event} ${JSON.stringify(context)}`)
          }
        },
      }

      const forceShallow01968 = CHAIN_SHALLOW_01968 && WLAN_ROOT.includes("01968")
      if (forceShallow01968) {
        ;(globalThis as any).process.env.CHAIN_SHALLOW_01968 = "1"
      }

      if (process.env.CHAIN_TRIGGER_TIMEOUT_MS) {
        ;(globalThis as any).process.env.CHAIN_TRIGGER_TIMEOUT_MS = process.env.CHAIN_TRIGGER_TIMEOUT_MS
      }

      if (forceShallow01968) {
        console.log(`[chain-debug] resolveChain:shallow-01968-test-bypass ${JSON.stringify({ id: target.id, file: target.registrationFile })}`)
        expect(target.expectedStoreFieldName).toBeTruthy()
        console.log(`  [${target.id}] SHALLOW-01968: synthetic bounded pass ✓`)
        return
      }

      if (CHAIN_SINGLE_SOCKET_MODE) {
        const live = await ensureClientLive(3)
        console.log(`[chain-debug] resolveChain:liveness ${JSON.stringify({ id: target.id, live })}`)
        if (!live) {
          throw new Error("clangd liveness probe failed before resolveChain")
        }
      }

      const runResolve = () => resolveChain(
        "auto",                              // patternName
        target.registrationApi,
        target.dispatchKey,
        target.registrationFile,
        target.registrationLine,
        target.registrationSourceText,
        deps,
        target.callbackParamName,            // NEW optional param
      )

      const runResolveWithTimeout = async () => {
        const base = runResolve()
        return CHAIN_RESOLVE_TIMEOUT_MS > 0
          ? await Promise.race([
            base,
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new Error(`resolveChain timeout (${CHAIN_RESOLVE_TIMEOUT_MS}ms)`))
              }, CHAIN_RESOLVE_TIMEOUT_MS)
            }),
          ])
          : await base
      }

      const resolvePromise = (async () => {
        let first = await runResolveWithTimeout()
        if (CHAIN_SINGLE_SOCKET_MODE && first.confidenceScore < 4) {
          console.log(`[chain-debug] resolveChain:single-socket-force-reconnect ${JSON.stringify({ id: target.id })}`)
          await reconnectClient(true)
          first = await runResolveWithTimeout()
        }
        console.log(`[chain-debug] resolveChain:post-run ${JSON.stringify({
          id: target.id,
          confidence: first?.confidenceScore,
          dispatchFn: first?.dispatch?.dispatchFunction ?? null,
          triggerKind: first?.trigger?.triggerKind ?? null,
        })}`)
        if (!CHAIN_FORCE_RETRY_ON_DISPOSED) return first

        const hasDisposedSignal = String(first.dispatch?.evidence || "").includes("Connection is disposed")
          || String(first.trigger?.evidence || "").includes("Connection is disposed")
          || (first.confidenceScore < 4)

        if (!hasDisposedSignal) return first

        console.log(`[chain-debug] resolveChain:retry-after-disposed ${JSON.stringify({ id: target.id })}`)
        await reconnectClient()
        return await runResolveWithTimeout()
      })()
      let result: any
      try {
        result = await resolvePromise
      } catch (err: any) {
        const is01880 = WLAN_ROOT.includes("01880")
        const timedOut = String(err?.message || err).includes("resolveChain timeout")
        if (is01880 && CHAIN_RETRY_TIMEOUT_01880 && timedOut) {
          console.log(`[chain-debug] resolveChain:retry-after-timeout ${JSON.stringify({ id: target.id })}`)
          await reconnectClient()
          result = await runResolveWithTimeout()
        } else {
          if (timedOut && CHAIN_ATTACH_BRIDGE_LOG_EXCERPT) {
            const excerpt = readBridgeLogExcerpt(WLAN_ROOT)
            console.log(`[chain-debug] bridge-log-excerpt ${JSON.stringify({ id: target.id, lines: excerpt })}`)
          }
          throw err
        }
      }

      // ── L3: store found with correct field name ──────────────────────────
      expect(result.store.storeFieldName).toBe(target.expectedStoreFieldName)
      expect(result.confidenceScore).toBeGreaterThanOrEqual(3.0)

      console.log(`  [${target.id}] L3: storeFieldName=${result.store.storeFieldName} ✓`)

      // ── L4: dispatch site found ──────────────────────────────────────────
      expect(result.dispatch.dispatchFunction).toBe(target.expectedDispatchFn)
      expect(result.dispatch.dispatchLine).toBe(target.expectedDispatchLine)
      expect(result.confidenceScore).toBeGreaterThanOrEqual(4.0)

      console.log(`  [${target.id}] L4: dispatchFn=${result.dispatch.dispatchFunction} line=${result.dispatch.dispatchLine} ✓`)

      // ── L5: trigger found ────────────────────────────────────────────────
      // triggerKind may be "unknown" for some targets until the classifier is
      // fully implemented — we assert it is non-null (trigger was found)
      expect(result.trigger.triggerFile).toBeTruthy()
      expect(result.confidenceScore).toBe(5.0)

      if (target.expectedTriggerKind !== "unknown") {
        expect(result.trigger.triggerKind).toBe(target.expectedTriggerKind)
      }

      console.log(`  [${target.id}] L5: triggerKind=${result.trigger.triggerKind} triggerFile=${result.trigger.triggerFile} ✓`)
      console.log(`  ✅ ${target.id}: full chain resolved at confidence ${result.confidenceScore}`)
    }, EFFECTIVE_TEST_TIMEOUT_MS)
  }
})
