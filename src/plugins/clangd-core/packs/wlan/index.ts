/**
 * packs/wlan/index.ts — Qualcomm/Atheros WLAN firmware pattern pack.
 *
 * Holds the registration patterns originally hardcoded in
 * src/tools/pattern-detector/registry.ts before the pack refactor.
 * Every entry here is specific to the WLAN/CMNOS firmware codebase
 * (the WLAN.CNG.* tree) and is unlikely to be useful for any other
 * C project.
 *
 * Auto-detection: the pack is gated on finding `cmnos`, `wmi`, or
 * `wlan` directory entries near the workspace root. This keeps WLAN
 * patterns from leaking into Linux / FreeBSD / general C projects.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { PatternPack } from "../types.js"
import wlanLogMacros from "./log-macros.js"

const wlanPack: PatternPack = {
  name: "wlan",
  description:
    "Qualcomm/Atheros WLAN firmware patterns (CMNOS IRQ registration, WMI event handlers, WMI dispatch tables).",

  callPatterns: [
    // ── IRQ ────────────────────────────────────────────────────────────────
    // hover() on the callback arg returns CMNOS_THREAD_IRQ_ROUTE_CB_T (an
    // opaque typedef). The auto-classifier would need an extra definition()
    // call to confirm fn-ptr; the fast path avoids that round trip.
    {
      name: "irq_dynamic",
      registrationApi: "cmnos_irq_register_dynamic",
      connectionKind: "hw_interrupt",
      keyArgIndex: 0,
      keyDescription: "IRQ number constant",
    },
    {
      name: "irq_signal_register",
      registrationApi: "cmnos_irq_register",
      connectionKind: "hw_interrupt",
      keyArgIndex: 0,
      keyDescription: "IRQ number constant",
    },

    // ── WMI event handler ──────────────────────────────────────────────────
    // wmi_unified_register_event_handler(handle, event_id, handler) — the
    // callback is arg 2 but the dispatch key is arg 1. The auto-classifier
    // would correctly detect this via hover, but the fast path avoids LSP
    // round trips for the most common WMI pattern.
    {
      name: "wmi_event_handler",
      registrationApi: "wmi_unified_register_event_handler",
      connectionKind: "event",
      keyArgIndex: 1,
      keyDescription: "WMI_EVT_ID constant",
    },
  ],

  initPatterns: [
    // ── WMI dispatch table ────────────────────────────────────────────────
    // Brace-delimited initializer list rather than a function call. The
    // auto-classifier does not handle struct initializers, so this entry
    // is the only path for classifying WMI command handlers.
    {
      name: "wmi_dispatch_entry",
      registrationApi: "WMI_RegisterDispatchTable",
      connectionKind: "api_call",
      markerArgIndex: 2,
      markerRegex: /\d+/,
      keyArgIndex: 1,
      keyDescription: "WMI CMDID constant",
    },
  ],

  logMacros: wlanLogMacros,

  appliesTo: (workspaceRoot: string) => {
    // Heuristic: a WLAN firmware checkout always has a `wlan/` or `wmi/`
    // top-level directory, or a `cmnos` subdirectory somewhere visible.
    const candidates = [
      join(workspaceRoot, "wlan"),
      join(workspaceRoot, "wmi"),
      join(workspaceRoot, "cmnos"),
      join(workspaceRoot, "wlan_proc"),
    ]
    return candidates.some((p) => existsSync(p))
  },
}

export default wlanPack
