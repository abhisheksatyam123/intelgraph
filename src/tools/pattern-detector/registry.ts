/**
 * pattern-detector/registry.ts — Minimal fast-path pattern registry.
 *
 * The auto-classifier (auto-classifier.ts) handles unknown registration calls
 * via LSP hover() + definition(). This registry is a fast-path override for
 * cases where the auto-classifier would be unreliable:
 *
 *   1. APIs where hover() returns an opaque typedef and the callback arg
 *      position is non-obvious (e.g. IRQ patterns where the callback is
 *      the last arg but the key is the first).
 *   2. APIs where the auto-classifier's macro-expansion path may resolve
 *      to the wrong function body.
 *
 * All other registration APIs are handled by the auto-classifier.
 * The struct initializer pattern (WMI dispatch table) lives in INIT_PATTERNS.
 *
 * Registry target: ≤5 entries.
 */

import type { CallPattern, InitPattern } from "./types.js"

// ---------------------------------------------------------------------------
// Call-name patterns — fast-path overrides for the auto-classifier
// ---------------------------------------------------------------------------

export const CALL_PATTERNS: CallPattern[] = [
  // ── IRQ ──────────────────────────────────────────────────────────────────
  // Kept because: hover() on the callback arg returns CMNOS_THREAD_IRQ_ROUTE_CB_T
  // (an opaque typedef). The auto-classifier would need an extra definition()
  // call to confirm it's a fn-ptr. Fast-path avoids the extra round trip.
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

  // ── WMI event handler ────────────────────────────────────────────────────
  // Kept because: wmi_unified_register_event_handler takes (handle, event_id, handler)
  // where the callback is arg 2 but the key is arg 1. The auto-classifier would
  // correctly detect this via hover, but the fast-path avoids LSP round trips
  // for the most common WMI pattern.
  {
    name: "wmi_event_handler",
    registrationApi: "wmi_unified_register_event_handler",
    connectionKind: "event",
    keyArgIndex: 1,
    keyDescription: "WMI_EVT_ID constant",
  },
]

// ---------------------------------------------------------------------------
// Struct-initializer patterns — matched when the enclosing construct is a
// brace-delimited initializer list, not a function call.
// The auto-classifier does not handle struct initializers.
// ---------------------------------------------------------------------------

export const INIT_PATTERNS: InitPattern[] = [
  {
    name: "wmi_dispatch_entry",
    registrationApi: "WMI_RegisterDispatchTable",
    connectionKind: "api_call",
    markerArgIndex: 2,
    markerRegex: /\d+/,
    keyArgIndex: 1,
    keyDescription: "WMI CMDID constant",
  },
]

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Find a call pattern by registration API name. */
export function findCallPatternByApi(apiName: string): CallPattern | undefined {
  return CALL_PATTERNS.find((p) => p.registrationApi === apiName)
}

/** Get all registration API names. */
export function getAllApiNames(): string[] {
  return CALL_PATTERNS.map((p) => p.registrationApi)
}
