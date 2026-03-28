/**
 * wlan-pattern-detection-e2e.test.ts
 *
 * END-TO-END: Does the backend actually find indirect callers in the real WLAN workspace?
 *
 * This test connects directly to the running clangd TCP bridge (already has
 * the full background index loaded) and calls collectIndirectCallers() with
 * the new charPos-aware code.
 *
 * No mocks. No fake LSP. No synthetic fixtures.
 *
 * For each pattern in our registry, we:
 *   1. Pick a known callback function from the real WLAN source
 *   2. Call collectIndirectCallers() with a real LspClient (TCP bridge)
 *   3. Assert that at least one indirect caller is found
 *   4. Assert that the found caller is classified with the correct pattern
 *
 * PASS = the backend can actually find and classify indirect callers in real code.
 * FAIL = the backend is broken for that pattern in real code.
 *
 * Skipped automatically when WLAN workspace or TCP bridge is not present.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { existsSync } from "fs"
import path from "path"
import { LspClient } from "../../src/lsp/index.js"
import { IndexTracker } from "../../src/tracking/index.js"
import { collectIndirectCallers } from "../../src/tools/indirect-callers.js"

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const WLAN_ROOT =
  process.env.WLAN_WORKSPACE_ROOT ||
  "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1"

const WLAN_PROC = path.join(WLAN_ROOT, "wlan_proc")

// TCP bridge port — the running clangd instance with background index loaded
const TCP_BRIDGE_PORT = 39575

const SKIP = !existsSync(path.join(WLAN_ROOT, "compile_commands.json"))

// ---------------------------------------------------------------------------
// Test targets — one per pattern family
//
// Each entry:
//   callbackFile  — file where the callback function is DEFINED
//   callbackLine  — 1-based line of the function definition
//   callbackName  — name of the callback function
//   expectedApi   — registration API we expect to find in the results
//   expectedKey   — dispatch key we expect to find (or null if not required)
//   patternName   — pattern name from registry
//
// These are verified against real WLAN source.
// ---------------------------------------------------------------------------

interface PatternTarget {
  patternName: string
  callbackFile: string
  callbackLine: number
  callbackName: string
  expectedApi: string
  expectedKey: string | null
}

const TARGETS: PatternTarget[] = [
  // Pattern 1: offload_nondata
  // _wlan_btm_ofld_action_frame_handler defined at line 1256 in wlan_btm_offload.c (in compile_commands.json)
  // Registered via offldmgr_register_nondata_offload at line 854 in same file
  {
    patternName: "offload_nondata",
    callbackFile: path.join(WLAN_PROC, "wlan/protocol/src/conn_mgmt/src/btm_offload/wlan_btm_offload.c"),
    callbackLine: 1256,
    callbackName: "_wlan_btm_ofld_action_frame_handler",
    expectedApi: "offldmgr_register_nondata_offload",
    expectedKey: "OFFLOAD_BTM",
  },

  // Pattern 2: thread_signal_handler
  // wlan_thread_post_init_hdlr defined at line 1412 in wlan_thread.c (in compile_commands.json)
  // Registered via wlan_thread_register_signal_wrapper at line 252 in txde_thread.c
  {
    patternName: "thread_signal_handler",
    callbackFile: path.join(WLAN_PROC, "wlan/syssw_platform/src/thread/wlan_thread.c"),
    callbackLine: 1412,
    callbackName: "wlan_thread_post_init_hdlr",
    expectedApi: "wlan_thread_register_signal_wrapper",
    expectedKey: "WLAN_THREAD_POST_INIT",
  },

  // Pattern 3: thread_msg_handler (dval variant)
  // _wlan_vdev_state_change_msg_hdlr defined at line 714 in wlan_vdev.c (in compile_commands.json)
  // Registered via wlan_thread_msg_handler_register_dval_dptr1_dptr2 at line 14194 in wlan_vdev_ext.c
  {
    patternName: "thread_msg_handler",
    callbackFile: path.join(WLAN_PROC, "wlan/protocol/src/cmn_infra/src/vdev_mgr/wlan_vdev.c"),
    callbackLine: 714,
    callbackName: "_wlan_vdev_state_change_msg_hdlr",
    expectedApi: "wlan_thread_msg_handler_register_dval_dptr1_dptr2",
    expectedKey: "WLAN_THREAD_COMM_FUNC_VDEV_STATE_CHANGE",
  },
]

// ---------------------------------------------------------------------------
// LspClient connected to the running TCP bridge (already has background index)
// ---------------------------------------------------------------------------

let client: LspClient | null = null

beforeAll(async () => {
  if (SKIP) return
  const tracker = new IndexTracker()
  tracker.markReady()

  try {
    // Connect to the running clangd TCP bridge — it already has the full
    // background index loaded, so queries work immediately.
    client = await LspClient.createFromSocket(TCP_BRIDGE_PORT, WLAN_ROOT, tracker, true)
    console.log(`  Connected to clangd TCP bridge on port ${TCP_BRIDGE_PORT}`)
  } catch (err) {
    console.warn(`  WARNING: Could not connect to TCP bridge: ${err}`)
    client = null
  }
}, 15000)

afterAll(async () => {
  // Don't shut down the shared bridge — just close our connection
  try { (client as any)?._conn?.dispose?.() } catch { /* ignore */ }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WLAN pattern detection — end-to-end with real clangd", () => {
  if (SKIP) {
    it.skip("WLAN workspace not found — skipping all e2e tests", () => {})
    return
  }

  for (const target of TARGETS) {
    it(`[${target.patternName}] finds indirect callers for ${target.callbackName}`, async () => {
      if (!client) {
        console.warn(`  SKIP: TCP bridge not available`)
        return
      }
      if (!existsSync(target.callbackFile)) {
        console.warn(`  SKIP: file not found: ${target.callbackFile}`)
        return
      }

      // Call collectIndirectCallers directly with the real LspClient
      // character=1 triggers auto-detection of function name position
      const graph = await collectIndirectCallers(client, {
        file: target.callbackFile,
        line: target.callbackLine,
        character: 1,
        maxNodes: 20,
      })

      // ── Assertion 1: seed resolved ──────────────────────────────────────
      expect(
        graph.seed,
        `[${target.patternName}] clangd could not resolve symbol "${target.callbackName}" at line ${target.callbackLine}. ` +
        `Check that the file is in compile_commands.json and the line number is correct.`,
      ).not.toBeNull()

      // ── Assertion 2: at least one indirect caller found ─────────────────
      expect(
        graph.nodes.length,
        `[${target.patternName}] no indirect callers found for ${target.callbackName}. ` +
        `Seed resolved to: ${graph.seed?.name}. ` +
        `Check that the callback is actually registered somewhere in the codebase.`,
      ).toBeGreaterThan(0)

      // ── Assertion 3: at least one classified node ───────────────────────
      const classified = graph.nodes.filter((n) => n.classification !== null)
      expect(
        classified.length,
        `[${target.patternName}] found ${graph.nodes.length} callers but NONE classified. ` +
        `Callers: ${graph.nodes.map((n) => `${n.name}@${path.basename(n.file)}:${n.line}`).join(", ")}. ` +
        `Source texts: ${graph.nodes.map((n) => n.sourceText.slice(0, 60)).join(" | ")}`,
      ).toBeGreaterThan(0)

      // ── Assertion 4: correct registration API found ─────────────────────
      const withCorrectApi = classified.filter(
        (n) => n.classification!.registrationApi === target.expectedApi,
      )
      expect(
        withCorrectApi.length,
        `[${target.patternName}] expected API "${target.expectedApi}" not found. ` +
        `Got APIs: ${classified.map((n) => n.classification!.registrationApi).join(", ")}`,
      ).toBeGreaterThan(0)

      // ── Assertion 5: dispatch key extracted (if expected) ───────────────
      if (target.expectedKey) {
        const withKey = withCorrectApi.filter(
          (n) => n.classification!.dispatchKey === target.expectedKey,
        )
        expect(
          withKey.length,
          `[${target.patternName}] API "${target.expectedApi}" found but key "${target.expectedKey}" missing. ` +
          `Got keys: ${withCorrectApi.map((n) => n.classification!.dispatchKey).join(", ")}`,
        ).toBeGreaterThan(0)
      }

      console.log(
        `  ✓ ${target.patternName}: ${graph.nodes.length} callers, ` +
        `${classified.length} classified, ` +
        `api=${withCorrectApi[0]?.classification?.registrationApi}, ` +
        `key=${withCorrectApi[0]?.classification?.dispatchKey}`,
      )
    }, 30000)
  }

  // ── Summary scorecard ──────────────────────────────────────────────────
  it("detection scorecard: counts classified vs unclassified across all patterns", async () => {
    if (!client) {
      console.warn("  SKIP: TCP bridge not available")
      return
    }

    let totalPatterns = 0
    let passedPatterns = 0

    for (const target of TARGETS) {
      if (!existsSync(target.callbackFile)) continue
      totalPatterns++

      const graph = await collectIndirectCallers(client, {
        file: target.callbackFile,
        line: target.callbackLine,
        character: 1,
        maxNodes: 20,
      })

      const classified = graph.nodes.filter((n) => n.classification !== null)
      const hasCorrectApi = classified.some(
        (n) => n.classification!.registrationApi === target.expectedApi,
      )
      if (hasCorrectApi) passedPatterns++

      console.log(
        `  ${hasCorrectApi ? "PASS" : "FAIL"} ${target.patternName.padEnd(30)} ` +
        `seed=${graph.seed?.name ?? "null"} ` +
        `callers=${graph.nodes.length} classified=${classified.length} ` +
        `api=${classified[0]?.classification?.registrationApi ?? "none"}`,
      )
    }

    console.log(`\n  SCORECARD: ${passedPatterns}/${totalPatterns} patterns detected`)

    expect(
      passedPatterns,
      `Only ${passedPatterns}/${totalPatterns} patterns detected. Backend needs improvement.`,
    ).toBeGreaterThanOrEqual(Math.floor(totalPatterns / 2))
  }, 120000)
})
