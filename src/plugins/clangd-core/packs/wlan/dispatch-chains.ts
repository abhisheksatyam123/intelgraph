/**
 * packs/wlan/dispatch-chains.ts — WLAN firmware dispatch chain templates.
 *
 * Encodes the Qualcomm/Atheros WLAN firmware's runtime dispatch paths
 * for callback invocation via CMNOS IRQ, WMI event handlers, offload
 * manager data/notification flows, and thread signal routing.
 */

import type { DispatchChainTemplate } from "../types.js"

const wlanDispatchChains: readonly DispatchChainTemplate[] = [
  // ── CMNOS IRQ dispatch ──────────────────────────────────────────────────
  {
    registrationApi: "cmnos_irq_register_dynamic",
    chain: ["hardware_irq", "cmnos_irq_dispatch", "irq_route_handler", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "CMNOS hardware interrupt IRQ %KEY%",
  },
  {
    registrationApi: "cmnos_irq_register",
    chain: ["hardware_irq", "cmnos_irq_dispatch", "irq_route_handler", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "CMNOS hardware interrupt IRQ %KEY%",
  },

  // ── WMI event handler dispatch ──────────────────────────────────────────
  {
    registrationApi: "wmi_unified_register_event_handler",
    chain: ["wmi_rx_event", "wmi_event_dispatch", "event_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WMI event %KEY% received from firmware",
  },

  // ── WMI command dispatch table ──────────────────────────────────────────
  {
    registrationApi: "WMI_RegisterDispatchTable",
    chain: ["wmi_rx_cmd", "wmi_dispatch_cmd", "cmd_handler_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WMI command %KEY% dispatched from host",
  },

  // ── Offload manager data path ───────────────────────────────────────────
  {
    registrationApi: "offldmgr_register_data_offload",
    chain: ["data_rx_path", "_offldmgr_enhanced_data_handler", "data_offload_table", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Offload manager data path dispatch",
  },

  // ── Offload manager notification ────────────────────────────────────────
  {
    registrationApi: "offldmgr_register_wow_notify",
    chain: ["wow_notif_dispatch", "_offldmgr_wow_notify_event", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "WoW notification event for offload",
  },

  // ── Thread signal routing ───────────────────────────────────────────────
  {
    registrationApi: "wlan_thread_register_signal_handler",
    chain: ["wlan_thread_signal_route", "signal_handler_table", "%CALLBACK%"],
    triggerKind: "signal",
    triggerDescription: "WLAN thread signal routed to handler",
  },
]

export default wlanDispatchChains
