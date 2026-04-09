/**
 * Ground-truth WLAN indirect-caller target registry.
 *
 * These are WLAN-specific test fixtures used to validate the reason engine
 * against known ground-truth. They are NOT the reasoning rules — those live
 * in doc/atomic/skill/indirect-caller-reasoning-rules.md and are generic.
 *
 * Each entry records the verified invocation reason for a real WLAN BPF API
 * so the test harness can assert the engine produces structurally correct
 * output (runtimeTrigger, dispatchChain, dispatchSite, registrationGate)
 * without hardcoding exact WLAN strings in the test assertions themselves.
 */

import path from "path"
import type { InvocationReason } from "../../src/tools/reason-engine/contracts.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Open string type — any codebase can define its own pattern family labels.
 * The WLAN fixtures use descriptive labels; other codebases may use different ones.
 */
export type PatternFamily = string

export interface WlanTarget {
  /** Short stable identifier used in test names and DB keys. */
  id: string
  /** Absolute path to the source file containing the target function definition. */
  file: string
  /** 1-based line number of the function definition. */
  line: number
  /** 1-based character offset on that line. */
  character: number
  /**
   * Ground-truth indirect callers: functions that invoke this target
   * indirectly via a registration/dispatch mechanism.
   * These are the REGISTRAR functions (Layer A), not the dispatch site.
   */
  expectedIndirectCallers: string[]
  /** The registration API used to wire the callback (Layer A). */
  registrationApi: string
  /** Pattern family label. */
  patternFamily: PatternFamily
  /**
   * Ground-truth invocation reason (Layers A + B + C).
   * This is what the LLM/cache layer must return — not just the registrar.
   */
  groundTruthInvocationReason: InvocationReason
}

// ---------------------------------------------------------------------------
// Workspace root
// ---------------------------------------------------------------------------

export const CANONICAL_WLAN_WORKSPACE = "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1"

export function getWlanWorkspaceRoot(): string {
  return (
    process.env.WLAN_WORKSPACE_ROOT ||
    process.env.INTELGRAPH_WORKSPACE_ROOT ||
    process.env.CLANGD_MCP_WORKSPACE_ROOT ||
    CANONICAL_WLAN_WORKSPACE
  )
}

// ---------------------------------------------------------------------------
// Target registry
// ---------------------------------------------------------------------------

export function getWlanTargets(): WlanTarget[] {
  const root = getWlanWorkspaceRoot()
  const bpfDir = "wlan_proc/wlan/protocol/src/offloads/src/l2/bpf"
  const offldmgrFile = path.join(
    root,
    "wlan_proc/wlan/protocol/src/cmn_infra/src/offload_mgr/offload_mgr_ext.c",
  )
  const vdevFile = path.join(
    root,
    "wlan_proc/wlan/protocol/src/cmn_infra/src/vdev_mgr/wlan_vdev.c",
  )
  const phyerrFile = path.join(
    root,
    "wlan_proc/wlan/protocol/src/misc/src/phyerr/wlan_phyerr.c",
  )
  const btmOffloadFile = path.join(
    root,
    "wlan_proc/wlan/protocol/src/conn_mgmt/src/btm_offload/wlan_btm_offload.c",
  )
  const wlanThreadFile = path.join(
    root,
    "wlan_proc/wlan/syssw_platform/src/thread/wlan_thread.c",
  )
  const wmiSvcFile = path.join(
    root,
    "wlan_proc/wlan/syssw_platform/src/hostif/wmisvc/wmi_svc.c",
  )

  return [
    // =========================================================================
    // P1-A  data-offload-callback — main BPF packet filter
    //
    // Target:  wlan_bpf_filter_offload_handler  (bpf_offload.c:83)
    //
    // Layer A (registration gate):
    //   wlan_bpf_enable_data_path() calls
    //   offldmgr_register_data_offload(DATA_FILTER_OFFLOAD, OFFLOAD_BPF, fn, ...)
    //   → stores fn in p_offldmgr_ctxt->offload_data[OFFLOAD_BPF].data_handler
    //
    // Layer B (dispatch site):
    //   _offldmgr_enhanced_data_handler() iterates offload_data[] and calls:
    //   p_offldmgr_ctxt->offload_data[i].data_handler(context, vdev_id, ...)
    //   (offload_mgr_ext.c:1107)
    //
    // Layer C (runtime trigger):
    //   An incoming RX data packet arrives from hardware.
    //   offloadif_data_ind → _offldmgr_protocol_data_handler
    //   → _offldmgr_enhanced_data_handler → dispatch loop → TARGET
    // =========================================================================
    {
      id: "bpf-filter-offload-handler",
      file: path.join(root, bpfDir, "bpf_offload.c"),
      line: 83,
      character: 1,
      expectedIndirectCallers: [
        "wlan_bpf_enable_data_path",
        "wlan_bpf_offload_test_route_uc_active",
      ],
      registrationApi: "offldmgr_register_data_offload",
      patternFamily: "data-offload-callback",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "Incoming RX data packet from hardware matched BPF filter criteria " +
          "(vdev_id, proto_type=ALL, addr_type=ALL, active_mode=TRUE)",
        dispatchChain: [
          "offloadif_data_ind",
          "_offldmgr_protocol_data_handler",
          "_offldmgr_enhanced_data_handler",
          "wlan_bpf_filter_offload_handler",
        ],
        dispatchSite: {
          file: offldmgrFile,
          line: 1107,
          snippet:
            "status = p_offldmgr_ctxt->offload_data[i].data_handler(" +
            "p_offldmgr_ctxt->offload_data[i].context, vdev_id, peer_id, tid, pDataBuf, pktLen, pAttr)",
        },
        registrationGate: {
          registrarFn: "wlan_bpf_enable_data_path",
          registrationApi: "offldmgr_register_data_offload",
          conditions: [
            "offload_data[i].vdev_bitmap & (1 << vdev_id)",
            "offload_data[i].data_pkt_type.proto_type & data_type",
            "offload_data[i].data_pkt_type.addr_type & addr_type",
            "offload_data[i].data_pkt_type.active_mode == TRUE OR wow_data_state != NON_WOW_STATE",
          ],
        },
      },
    },

    // =========================================================================
    // P1-B  data-offload-callback — notify variant
    //
    // Target:  wlan_bpf_notify_handler  (bpf_offload_int.c:394)
    //
    // Layer A: same call in wlan_bpf_enable_data_path(), 5th arg (notify callback)
    //   offldmgr_register_data_offload(..., wlan_bpf_notify_handler, ...)
    //   → stored in offload_data[OFFLOAD_BPF].notif_handler
    //
    // Layer B (dispatch site):
    //   offload manager calls notif_handler on offload lifecycle events
    //   (enable/disable transitions).  The exact dispatch is in offload_mgr_ext.c
    //   via the notif_handler field.
    //
    // Layer C (runtime trigger):
    //   Offload enable/disable lifecycle event — e.g. when the offload manager
    //   transitions the BPF offload between active and inactive states.
    // =========================================================================
    {
      id: "bpf-notify-handler",
      file: path.join(root, bpfDir, "bpf_offload_int.c"),
      line: 394,
      character: 6,
      expectedIndirectCallers: [
        "wlan_bpf_enable_data_path",
      ],
      registrationApi: "offldmgr_register_data_offload",
      patternFamily: "data-offload-callback",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "BPF offload lifecycle event: offload manager transitions OFFLOAD_BPF " +
          "between active and inactive states (enable/disable)",
        dispatchChain: [
          "offldmgr_deregister_data_offload OR offldmgr_register_data_offload",
          "offload_mgr notif dispatch",
          "wlan_bpf_notify_handler",
        ],
        dispatchSite: {
          file: offldmgrFile,
          line: 0, // exact line TBD by LLM — notif_handler dispatch in offload_mgr_ext.c
          snippet:
            "offload_data[i].notif_handler(notif_event)",
        },
        registrationGate: {
          registrarFn: "wlan_bpf_enable_data_path",
          registrationApi: "offldmgr_register_data_offload",
          conditions: [
            "offload_data[OFFLOAD_BPF].notif_handler != NULL",
            "offload manager triggers lifecycle notification",
          ],
        },
      },
    },

    // =========================================================================
    // P2  vdev-notif-handler
    //
    // Target:  wlan_bpf_offload_vdev_notify_handler  (bpf_offload_int.c:366)
    //
    // Layer A: wlan_bpf_offload_vdev_init() calls
    //   wlan_vdev_register_notif_handler(wlan_vdev, fn, bpf_vdev)
    //   → appended to vdev->notif_list STAILQ
    //
    // Layer B (dispatch site):
    //   wlan_vdev_deliver_notif() iterates notif_list and calls:
    //   notif_data->handler(vdev, notif, notif_data->arg)
    //   (wlan_vdev.c:2659)
    //
    // Layer C (runtime trigger):
    //   A vdev state-change event (up/down/delete/start/stop) is delivered.
    //   wlan_vdev_ext.c calls wlan_vdev_deliver_notif() on vdev state transitions.
    // =========================================================================
    {
      id: "bpf-vdev-notify-handler",
      file: path.join(root, bpfDir, "bpf_offload_int.c"),
      line: 366,
      character: 6,
      expectedIndirectCallers: [
        "wlan_bpf_offload_vdev_init",
      ],
      registrationApi: "wlan_vdev_register_notif_handler",
      patternFamily: "vdev-notif-handler",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "Vdev state-change event (up/down/delete/start/stop) delivered by the vdev manager",
        dispatchChain: [
          "wlan_vdev_ext.c (vdev state machine)",
          "wlan_vdev_deliver_notif",
          "wlan_bpf_offload_vdev_notify_handler",
        ],
        dispatchSite: {
          file: vdevFile,
          line: 2659,
          snippet: "notif_data->handler(vdev, notif, notif_data->arg)",
        },
        registrationGate: {
          registrarFn: "wlan_bpf_offload_vdev_init",
          registrationApi: "wlan_vdev_register_notif_handler",
          conditions: [
            "notif_data->handler != NULL",
            "vdev->notif_list contains the registered entry",
          ],
        },
      },
    },

    // =========================================================================
    // P3  phy-event-handler
    //
    // Target:  wlan_bpf_event_pdev_notif  (bpf_offload_int.c:997)
    //
    // Layer A: wlan_enable_adaptive_apf() calls
    //   wal_phy_dev_register_event_handler(wal_pdev, fn, NULL,
    //       WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE | WAL_PDEV_EVENT_POST_POWER_STATE_CHANGE)
    //
    // Layer B (dispatch site):
    //   WAL layer iterates registered event handlers and calls fn(event)
    //   when a matching WAL_PDEV_EVENT fires.
    //
    // Layer C (runtime trigger):
    //   PHY device power-state transition (pre/post sleep or wake).
    //   WAL power management → wal_phy_dev_dispatch_event
    //   → registered handler list → TARGET
    // =========================================================================
    {
      id: "bpf-event-pdev-notif",
      file: path.join(root, bpfDir, "bpf_offload_int.c"),
      line: 997,
      character: 6,
      expectedIndirectCallers: [
        "wlan_enable_adaptive_apf",
      ],
      registrationApi: "wal_phy_dev_register_event_handler",
      patternFamily: "phy-event-handler",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "PHY device power-state transition: WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE " +
          "or WAL_PDEV_EVENT_POST_POWER_STATE_CHANGE (pre/post sleep or wake)",
        dispatchChain: [
          "WAL power management (wal_pdev_power_state_change)",
          "wal_phy_dev_dispatch_event",
          "wlan_bpf_event_pdev_notif",
        ],
        dispatchSite: {
          file: path.join(
            root,
            "wlan_proc/wlan/protocol/src/cmn_infra/src/wal/wal_pdev.c",
          ),
          line: 0, // exact line TBD by LLM
          snippet: "handler->fn(handler->ctx, event)",
        },
        registrationGate: {
          registrarFn: "wlan_enable_adaptive_apf",
          registrationApi: "wal_phy_dev_register_event_handler",
          conditions: [
            "bpf_pdev->adaptive_uc_mask == 0 (first vdev enabling adaptive APF)",
            "event_mask matches WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE | WAL_PDEV_EVENT_POST_POWER_STATE_CHANGE",
          ],
        },
      },
    },

    // =========================================================================
    // P4  timer-callback
    //
    // Target:  wlan_bpf_traffic_timer_handler  (bpf_offload_int.c:452)
    //
    // Layer A: wlan_bpf_offload_vdev_init() calls
    //   A_INIT_TIMER(&bpf_vdev->bpf_traffic_timer, fn, bpf_vdev)
    //   → stores fn in the OS timer struct
    //   Timer is armed later via A_TIMEOUT_MS(&bpf_vdev->bpf_traffic_timer, ms, 0)
    //
    // Layer B (dispatch site):
    //   OS timer subsystem calls the registered callback when the timer fires.
    //   The timer is a one-shot timer re-armed inside the handler itself.
    //
    // Layer C (runtime trigger):
    //   OS timer bpf_traffic_timer fires after the configured timeout
    //   (APF_ADAPTIVE_TO_NON_APF_TIMER_MS or APF_ADAPTIVE_TO_APF_TIMER_MS).
    //   Timer is armed by wlan_enable_adaptive_apf / wlan_bpf_next_adaptive_state.
    // =========================================================================
    {
      id: "bpf-traffic-timer-handler",
      file: path.join(root, bpfDir, "bpf_offload_int.c"),
      line: 452,
      character: 6,
      expectedIndirectCallers: [
        "wlan_bpf_offload_vdev_init",
      ],
      registrationApi: "A_INIT_TIMER",
      patternFamily: "timer-callback",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "OS timer bpf_traffic_timer fires after APF_ADAPTIVE_TO_NON_APF_TIMER_MS " +
          "or APF_ADAPTIVE_TO_APF_TIMER_MS timeout. " +
          "Timer is armed by wlan_enable_adaptive_apf() or wlan_bpf_next_adaptive_state().",
        dispatchChain: [
          "OS timer subsystem (A_TIMEOUT_MS armed by wlan_enable_adaptive_apf)",
          "timer callback dispatch (OS-level)",
          "wlan_bpf_traffic_timer_handler",
        ],
        dispatchSite: {
          file: path.join(root, bpfDir, "bpf_offload_wmi.c"),
          line: 552,
          snippet: "A_INIT_TIMER(&bpf_vdev->bpf_traffic_timer, wlan_bpf_traffic_timer_handler, bpf_vdev)",
        },
        registrationGate: {
          registrarFn: "wlan_bpf_offload_vdev_init",
          registrationApi: "A_INIT_TIMER",
          conditions: [
            "bpf_vdev != NULL",
            "timer armed via A_TIMEOUT_MS() by wlan_enable_adaptive_apf or wlan_bpf_next_adaptive_state",
          ],
        },
      },
    },

    // =========================================================================
    // P5  wmi-dispatch-table
    //
    // Target:  _wlan_bpf_offload_cmd_handler  (bpf_offload_wmi.c:159)
    //
    // Layer A: wlan_bpf_offload_register() calls
    //   WMI_RegisterDispatchTable(&wlan_bpf_commands)
    //   where wlan_bpf_commands contains bpf_offload_dispatch_entries[] with
    //   {_wlan_bpf_offload_cmd_handler, WMI_BPF_*_CMDID, 0} entries.
    //
    // Layer B (dispatch site):
    //   WMI layer receives a command from the host, looks up the dispatch table
    //   by command ID, and calls entry->fn(context, cmd_id, buffer, length).
    //
    // Layer C (runtime trigger):
    //   Host sends a WMI BPF command (WMI_BPF_GET_CAPABILITY_CMDID,
    //   WMI_BPF_SET_VDEV_INSTRUCTIONS_CMDID, etc.) over the WMI channel.
    // =========================================================================
    {
      id: "bpf-wmi-cmd-handler",
      file: path.join(root, bpfDir, "bpf_offload_wmi.c"),
      line: 159,
      character: 1,
      expectedIndirectCallers: [
        "wlan_bpf_offload_register",
      ],
      registrationApi: "WMI_RegisterDispatchTable",
      patternFamily: "wmi-dispatch-table",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "Host sends a WMI BPF command over the WMI channel: " +
          "WMI_BPF_GET_CAPABILITY_CMDID, WMI_BPF_GET_VDEV_STATS_CMDID, " +
          "WMI_BPF_SET_VDEV_INSTRUCTIONS_CMDID, WMI_BPF_DEL_VDEV_INSTRUCTIONS_CMDID, " +
          "WMI_BPF_SET_VDEV_ACTIVE_MODE_CMDID, WMI_BPF_SET_VDEV_ENABLE_CMDID, " +
          "WMI_BPF_SET_VDEV_WORK_MEMORY_CMDID, WMI_BPF_SET_SUPPORTED_OFFLOAD_BITMAP_CMDID, " +
          "or WMI_BPF_SET_APF_MODE_CMDID",
        dispatchChain: [
          "WMI RX path (wmi_unified_cmd_handler)",
          "WMI dispatch table lookup by cmd_id",
          "_wlan_bpf_offload_cmd_handler",
        ],
        dispatchSite: {
          file: path.join(root, bpfDir, "bpf_offload_wmi.c"),
          line: 1070,
          snippet:
            "WMI_DISPATCH_ENTRY bpf_offload_dispatch_entries[] = { " +
            "{_wlan_bpf_offload_cmd_handler, WMI_BPF_GET_CAPABILITY_CMDID, 0}, ... }",
        },
        registrationGate: {
          registrarFn: "wlan_bpf_offload_register",
          registrationApi: "WMI_RegisterDispatchTable",
          conditions: [
            "WMI_SERVICE_BPF_OFFLOAD registered",
            "cmd_id matches one of the WMI_BPF_*_CMDID entries in bpf_offload_dispatch_entries[]",
          ],
        },
      },
    },

    // =========================================================================
    // T6  wmi-dispatch-table — phyerr WMI command handler
    //
    // Target:  dispatch_wlan_phyerr_cmds  (wlan_phyerr.c:166)
    //
    // Layer A (registration gate):
    //   wlan_phyerr_register() calls
    //   WMI_RegisterDispatchTable(&wlan_phyerr_commands)
    //   → links wlan_phyerr_commands into g_pWMI->pDispatchHead linked list
    //   → wlan_phyerr_dispatchentries[] maps DFS/phyerr CMDIDs to dispatch_wlan_phyerr_cmds
    //
    // Layer B (dispatch site):
    //   WMI_DispatchCmd() iterates pDispatchHead, matches cmd_id, and calls:
    //   pCmdHandler(pContext, cmd, pCmdBuffer, length)
    //   (wmi_svc.c:682)
    //
    // Layer C (runtime trigger):
    //   Host sends a WMI DFS/phyerr command over the WMI channel.
    //   HTC RX → WMI_DispatchCmd → dispatch table lookup → TARGET
    // =========================================================================
    {
      id: "wmi-phyerr-cmd-handler",
      file: phyerrFile,
      line: 166,
      character: 13,
      expectedIndirectCallers: [
        "wlan_phyerr_register",
      ],
      registrationApi: "WMI_RegisterDispatchTable",
      patternFamily: "wmi-dispatch-table",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "Host sends a WMI DFS/phyerr command over the WMI channel: " +
          "WMI_PDEV_DFS_ENABLE_CMDID, WMI_PDEV_DFS_DISABLE_CMDID, " +
          "WMI_DFS_PHYERR_FILTER_ENA_CMDID, or WMI_DFS_PHYERR_FILTER_DIS_CMDID",
        dispatchChain: [
          "WMI RX path (HTC_RecvCompleteHandler)",
          "WMI_DispatchCmd",
          "dispatch_wlan_phyerr_cmds",
        ],
        dispatchSite: {
          file: wmiSvcFile,
          line: 682,
          snippet:
            "pCmdHandler(pContext, cmd, pCmdBuffer, length)",
        },
        registrationGate: {
          registrarFn: "wlan_phyerr_register",
          registrationApi: "WMI_RegisterDispatchTable",
          conditions: [
            "WMI_SERVICE_PHYERR registered",
            "cmd_id matches one of WMI_PDEV_DFS_ENABLE_CMDID, WMI_PDEV_DFS_DISABLE_CMDID, " +
              "WMI_DFS_PHYERR_FILTER_ENA_CMDID, WMI_DFS_PHYERR_FILTER_DIS_CMDID",
          ],
        },
      },
    },

    // =========================================================================
    // T7  nondata-offload-callback — BTM action frame handler
    //
    // Target:  _wlan_btm_ofld_action_frame_handler  (wlan_btm_offload.c:1256)
    //
    // Layer A (registration gate):
    //   wlan_btm_ofld_unsolicited_init() calls
    //   offldmgr_register_nondata_offload(NON_PROTO_OFFLOAD, OFFLOAD_BTM, fn, NULL,
    //       OFFLOAD_FRAME_TYPE_MGMT_SUBTYPE_ACTION)
    //   → stores fn in p_offld_non_data_ctxt->offload_nondata[OFFLOAD_BTM].non_data_handler
    //
    // Layer B (dispatch site):
    //   _offldmgr_non_data_handler() iterates offload_nondata[] and calls:
    //   p_offld_non_data_ctxt->offload_nondata[i].non_data_handler(context, peer, rxbuf)
    //   (offload_mgr_ext.c:1725)
    //
    // Layer C (runtime trigger):
    //   Incoming non-data management ACTION frame arrives from hardware.
    //   offloadif_non_data_ind → _offldmgr_non_data_handler → dispatch loop → TARGET
    // =========================================================================
    {
      id: "btm-ofld-action-frame-handler",
      file: btmOffloadFile,
      line: 1256,
      character: 1,
      expectedIndirectCallers: [
        "wlan_btm_ofld_unsolicited_init",
      ],
      registrationApi: "offldmgr_register_nondata_offload",
      patternFamily: "nondata-offload-callback",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "Incoming non-data management ACTION frame arrives from hardware, " +
          "matched by offload manager for OFFLOAD_BTM with OFFLOAD_FRAME_TYPE_MGMT_SUBTYPE_ACTION",
        dispatchChain: [
          "offloadif_non_data_ind",
          "_offldmgr_non_data_handler",
          "_wlan_btm_ofld_action_frame_handler",
        ],
        dispatchSite: {
          file: offldmgrFile,
          line: 1725,
          snippet:
            "sub_status = p_offld_non_data_ctxt->offload_nondata[i].non_data_handler(" +
            "p_offld_non_data_ctxt->offload_nondata[i].context, peer, rxbuf)",
        },
        registrationGate: {
          registrarFn: "wlan_btm_ofld_unsolicited_init",
          registrationApi: "offldmgr_register_nondata_offload",
          conditions: [
            "offload_nondata[OFFLOAD_BTM].non_data_handler != NULL",
            "offload_nondata[OFFLOAD_BTM].frm_type_flag & OFFLOAD_FRAME_TYPE_MGMT_SUBTYPE_ACTION",
          ],
        },
      },
    },

    // =========================================================================
    // T8  thread-signal-handler — post-init signal handler
    //
    // Target:  wlan_thread_post_init_hdlr  (wlan_thread.c:1412)
    //
    // Layer A (registration gate):
    //   Multiple thread init functions (hif_thread_init, tqm_thread_init, etc.) call
    //   wlan_thread_register_signal_wrapper(thread_ctxt, WLAN_THREAD_POST_INIT, fn, NULL, wrapper)
    //   → macro expands to wlan_thread_register_signal_wrapper_internal()
    //   → stores fn in thread_ctxt->real_signals[idx].sig_handler
    //
    // Layer B (dispatch site):
    //   wlan_thread_dsr_wrapper_common() reads the stored handler and calls:
    //   real_sig_hdlr = thread_ctxt->real_signals[real_sig_hdlr_idx].sig_handler
    //   return_val = real_sig_hdlr(real_sig_ctxt)
    //   (wlan_thread.c:245)
    //
    // Layer C (runtime trigger):
    //   OS delivers WLAN_THREAD_POST_INIT signal to the thread after hardware
    //   and software subsystem initialization is complete.
    // =========================================================================
    {
      id: "thread-post-init-handler",
      file: wlanThreadFile,
      line: 1412,
      character: 1,
      expectedIndirectCallers: [
        "hif_thread_init",
        "tqm_thread_init",
        "be_thread_init",
      ],
      registrationApi: "wlan_thread_register_signal_wrapper",
      patternFamily: "thread-signal-handler",
      groundTruthInvocationReason: {
        runtimeTrigger:
          "OS delivers WLAN_THREAD_POST_INIT signal to the thread after hardware " +
          "and software subsystem initialization is complete",
        dispatchChain: [
          "cmnos_thread_signal_dispatch (OS signal delivery)",
          "wlan_thread_dsr_wrapper_common",
          "wlan_thread_post_init_hdlr",
        ],
        dispatchSite: {
          file: wlanThreadFile,
          line: 245,
          snippet:
            "real_sig_hdlr = thread_ctxt->real_signals[real_sig_hdlr_idx].sig_handler",
        },
        registrationGate: {
          registrarFn: "hif_thread_init",
          registrationApi: "wlan_thread_register_signal_wrapper",
          conditions: [
            "signal_id == WLAN_THREAD_POST_INIT",
            "thread_ctxt->signal_register_bitmask does not already have WLAN_THREAD_POST_INIT set",
          ],
        },
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Chain-resolver ground-truth targets
//
// These entries test resolveChain() directly against the live WLAN codebase.
// Each entry provides:
//   - The target callback function (file + line)
//   - The registration call site (registrationFile + registrationLine)
//   - callbackParamName: the parameter name in the registration API body
//   - expectedStoreFieldName: the field name the store scanner should extract
//   - expectedDispatchFn: the function that calls the stored fn-ptr at runtime
//   - expectedDispatchLine: 0-based line of the fn-ptr call in the dispatch fn
//   - expectedTriggerKind: the classified runtime trigger kind
//
// Storage architectures covered:
//   P1: array-indexed field, data_handler   (offload_mgr_ext.c)
//   P2: array-indexed field, notif_handler  (offload_mgr_ext.c)
//   P3: STAILQ subscriber list, handler     (wlan_vdev.c)
//   P4: direct array slot, irq_route_cb     (cmnos_thread.c)
//   P5: WMI dispatch table, pCmdHandler     (wmi_svc.c)
//   P6: nondata offload array, non_data_handler (offload_mgr_ext.c)
//   P7: thread signal slot, sig_handler     (wlan_thread.c)
// ---------------------------------------------------------------------------

export interface ChainResolverTarget {
  /** Short stable identifier used in test names. */
  id: string
  /** Absolute path to the target callback function definition. */
  targetFile: string
  /** 1-based line of the target function definition. */
  targetLine: number
  /** Absolute path to the file containing the registration call. */
  registrationFile: string
  /** 0-based line of the registration call (for resolveChain). */
  registrationLine: number
  /** Source text of the registration call (for resolveChain). */
  registrationSourceText: string
  /** The registration API name. */
  registrationApi: string
  /** Dispatch key extracted from the registration call (or null). */
  dispatchKey: string | null
  /**
   * Parameter name in the registration API body that holds the target callback.
   * This is the new optional param passed to resolveChain().
   */
  callbackParamName: string
  /** Expected storeFieldName extracted by findStoreInDefinition. */
  expectedStoreFieldName: string
  /** Expected dispatch function name found by findDispatchSite. */
  expectedDispatchFn: string
  /** Expected 0-based line of the fn-ptr call in the dispatch function. */
  expectedDispatchLine: number
  /** Expected trigger kind classified by findTriggerSite. */
  expectedTriggerKind: string
}

export function getChainResolverTargets(): ChainResolverTarget[] {
  const root = getWlanWorkspaceRoot()

  const bpfDir = "wlan_proc/wlan/protocol/src/offloads/src/l2/bpf"
  const offldmgrFile = path.join(
    root,
    "wlan_proc/wlan/protocol/src/cmn_infra/src/offload_mgr/offload_mgr_ext.c",
  )
  const vdevFile = path.join(
    root,
    "wlan_proc/wlan/protocol/src/cmn_infra/src/vdev_mgr/wlan_vdev.c",
  )
  const cthreadFile = path.join(
    root,
    "wlan_proc/wlan/syssw_services/src/osif/src/cmnos_thread.c",
  )
  const bpfIntFile = path.join(root, bpfDir, "bpf_offload_int.c")
  const bpfWmiFile = path.join(root, bpfDir, "bpf_offload_wmi.c")
  const wlanThreadFile = path.join(
    root,
    "wlan_proc/wlan/syssw_platform/src/thread/wlan_thread.c",
  )
  const hifThreadFile = path.join(
    root,
    "wlan_proc/wlan/syssw_platform/src/thread/hif_thread.c",
  )
  const phyerrFile = path.join(
    root,
    "wlan_proc/wlan/protocol/src/misc/src/phyerr/wlan_phyerr.c",
  )
  const btmOffloadFile = path.join(
    root,
    "wlan_proc/wlan/protocol/src/conn_mgmt/src/btm_offload/wlan_btm_offload.c",
  )
  const wmiSvcFile = path.join(
    root,
    "wlan_proc/wlan/syssw_platform/src/hostif/wmisvc/wmi_svc.c",
  )

  return [
    // =========================================================================
    // P1 — array-indexed field: data_handler
    //
    // Target:  wlan_bpf_filter_offload_handler  (bpf_offload.c:83)
    // Registration: offldmgr_register_data_offload in bpf_offload_int.c:1093
    //   → stores fn in offload_data[OFFLOAD_BPF].data_handler
    // Dispatch: _offldmgr_enhanced_data_handler calls data_handler at line 1098
    // Trigger:  offloadif_data_ind → _offldmgr_protocol_data_handler → dispatch
    // =========================================================================
    {
      id: "bpf-filter-data-handler",
      targetFile: path.join(root, bpfDir, "bpf_offload.c"),
      targetLine: 83,
      registrationFile: bpfIntFile,
      registrationLine: 1092,  // 0-based: offldmgr_register_data_offload( starts at line 1093
      registrationSourceText: "offldmgr_register_data_offload(DATA_FILTER_OFFLOAD, OFFLOAD_BPF, wlan_bpf_filter_offload_handler, pdev, wlan_bpf_notify_handler, &pkt_type)",
      registrationApi: "offldmgr_register_data_offload",
      dispatchKey: "OFFLOAD_BPF",
      callbackParamName: "data_handler",
      expectedStoreFieldName: "data_handler",
      expectedDispatchFn: "_offldmgr_enhanced_data_handler",
      expectedDispatchLine: 1097,  // 0-based: line 1098 in file
      expectedTriggerKind: "unknown",  // will be classified by impl; rx_data_ind path
    },

    // =========================================================================
    // P2 — array-indexed field: notif_handler
    //
    // Target:  wlan_bpf_notify_handler  (bpf_offload_int.c:394)
    // Registration: same offldmgr_register_data_offload call, 5th arg
    //   → stores fn in offload_data[OFFLOAD_BPF].notif_handler
    // Dispatch: _offldmgr_wow_notify_event calls notif_handler at line 524
    // Trigger:  WOW enable/disable lifecycle event
    // =========================================================================
    {
      id: "bpf-notify-handler",
      targetFile: bpfIntFile,
      targetLine: 394,
      registrationFile: bpfIntFile,
      registrationLine: 1092,
      registrationSourceText: "offldmgr_register_data_offload(DATA_FILTER_OFFLOAD, OFFLOAD_BPF, wlan_bpf_filter_offload_handler, pdev, wlan_bpf_notify_handler, &pkt_type)",
      registrationApi: "offldmgr_register_data_offload",
      dispatchKey: "OFFLOAD_BPF",
      callbackParamName: "notif_handler",
      expectedStoreFieldName: "notif_handler",
      expectedDispatchFn: "_offldmgr_wow_notify_event",
      expectedDispatchLine: 523,  // 0-based: line 524 in file
      expectedTriggerKind: "unknown",  // lifecycle event — classified by impl
    },

    // =========================================================================
    // P3 — STAILQ subscriber list: handler
    //
    // Target:  wlan_bpf_offload_vdev_notify_handler  (bpf_offload_int.c:366)
    // Registration: wlan_vdev_register_notif_handler in bpf_offload_wmi.c:512
    //   → stores fn in notif_data->handler, STAILQ_INSERT_TAIL into vdev->notif_list
    // Dispatch: wlan_vdev_deliver_notif calls handler at line 2659
    // Trigger:  vdev state-change event
    // =========================================================================
    {
      id: "bpf-vdev-notify-handler",
      targetFile: bpfIntFile,
      targetLine: 366,
      registrationFile: bpfWmiFile,
      registrationLine: 511,  // 0-based: wlan_vdev_register_notif_handler( at line 512
      registrationSourceText: "wlan_vdev_register_notif_handler(wlan_vdev, wlan_bpf_offload_vdev_notify_handler, bpf_vdev)",
      registrationApi: "wlan_vdev_register_notif_handler",
      dispatchKey: null,
      callbackParamName: "handler",
      expectedStoreFieldName: "handler",
      expectedDispatchFn: "wlan_vdev_deliver_notif",
      expectedDispatchLine: 2658,  // 0-based: line 2659 in file
      expectedTriggerKind: "unknown",  // vdev state change — classified by impl
    },

    // =========================================================================
    // P4 — direct array slot: irq_route_cb
    //
    // Target:  wlan_thread_irq_sr_wakeup  (wlan_thread.c:617)
    // Registration: cmnos_irq_register_dynamic in hif_thread.c:518
    //   → stores fn in g_cmnos_thread_info.irqs[interrupt_id].irq_route_cb
    // Dispatch: cmnos_thread_irq calls irq_route_cb at line 2049
    // Trigger:  hardware IRQ fires (WMAC0 H2S grant)
    // =========================================================================
    {
      id: "wlan-irq-sr-wakeup",
      targetFile: wlanThreadFile,
      targetLine: 617,
      registrationFile: hifThreadFile,
      registrationLine: 517,  // 0-based: cmnos_irq_register_dynamic( at line 518
      registrationSourceText: "cmnos_irq_register_dynamic(A_INUM_WMAC0_H2S_GRANT, wlan_thread_irq_sr_wakeup)",
      registrationApi: "cmnos_irq_register_dynamic",
      dispatchKey: "A_INUM_WMAC0_H2S_GRANT",
      callbackParamName: "irq_route_cb",
      expectedStoreFieldName: "irq_route_cb",
      expectedDispatchFn: "cmnos_thread_irq",
      expectedDispatchLine: 2048,  // 0-based: line 2049 in file
      expectedTriggerKind: "hardware_interrupt",
    },

    // =========================================================================
    // P5 — WMI dispatch table: pCmdHandler
    //
    // Target:  dispatch_wlan_phyerr_cmds  (wlan_phyerr.c:166)
    // Registration: WMI_RegisterDispatchTable in wlan_phyerr.c:156
    //   → links wlan_phyerr_commands into g_pWMI->pDispatchHead
    //   → wlan_phyerr_dispatchentries[].pCmdHandler = dispatch_wlan_phyerr_cmds
    // Dispatch: WMI_DispatchCmd calls pCmdHandler at wmi_svc.c:682
    // Trigger:  host sends WMI DFS/phyerr command
    // =========================================================================
    {
      id: "wmi-phyerr-cmd-handler",
      targetFile: phyerrFile,
      targetLine: 166,
      registrationFile: phyerrFile,
      registrationLine: 155,  // 0-based: WMI_RegisterDispatchTable( at line 156
      registrationSourceText: "WMI_RegisterDispatchTable(&wlan_phyerr_commands)",
      registrationApi: "WMI_RegisterDispatchTable",
      dispatchKey: "WMI_PDEV_DFS_ENABLE_CMDID",
      callbackParamName: "pCmdHandler",
      expectedStoreFieldName: "pCmdHandler",
      expectedDispatchFn: "WMI_DispatchCmd",
      expectedDispatchLine: 681,  // 0-based: pCmdHandler(pContext, cmd, pCmdBuffer, length) at line 682
      expectedTriggerKind: "event",
    },

    // =========================================================================
    // P6 — nondata offload array: non_data_handler
    //
    // Target:  _wlan_btm_ofld_action_frame_handler  (wlan_btm_offload.c:1256)
    // Registration: offldmgr_register_nondata_offload in wlan_btm_offload.c:854
    //   → stores fn in offload_nondata[OFFLOAD_BTM].non_data_handler
    // Dispatch: _offldmgr_non_data_handler calls non_data_handler at offload_mgr_ext.c:1725
    // Trigger:  incoming non-data management ACTION frame from hardware
    // =========================================================================
    {
      id: "btm-ofld-action-frame-handler",
      targetFile: btmOffloadFile,
      targetLine: 1256,
      registrationFile: btmOffloadFile,
      registrationLine: 853,  // 0-based: offldmgr_register_nondata_offload( at line 854
      registrationSourceText: "offldmgr_register_nondata_offload(NON_PROTO_OFFLOAD, OFFLOAD_BTM, _wlan_btm_ofld_action_frame_handler, NULL, OFFLOAD_FRAME_TYPE_MGMT_SUBTYPE_ACTION)",
      registrationApi: "offldmgr_register_nondata_offload",
      dispatchKey: "OFFLOAD_BTM",
      callbackParamName: "non_data_handler",
      expectedStoreFieldName: "non_data_handler",
      expectedDispatchFn: "_offldmgr_non_data_handler",
      expectedDispatchLine: 1724,  // 0-based: non_data_handler(...) at line 1725
      expectedTriggerKind: "unknown",  // incoming mgmt frame — classified by impl
    },

    // =========================================================================
    // P7 — thread signal slot: sig_handler
    //
    // Target:  wlan_thread_post_init_hdlr  (wlan_thread.c:1412)
    // Registration: wlan_thread_register_signal_wrapper in hif_thread.c:227
    //   → macro → wlan_thread_register_signal_wrapper_internal()
    //   → stores fn in thread_ctxt->real_signals[idx].sig_handler
    // Dispatch: wlan_thread_dsr_wrapper_common reads sig_handler at wlan_thread.c:245
    // Trigger:  OS delivers WLAN_THREAD_POST_INIT signal after subsystem init
    // =========================================================================
    {
      id: "thread-post-init-handler",
      targetFile: wlanThreadFile,
      targetLine: 1412,
      registrationFile: hifThreadFile,
      registrationLine: 226,  // 0-based: wlan_thread_register_signal_wrapper( at line 227
      registrationSourceText: "wlan_thread_register_signal_wrapper(thread_ctxt, WLAN_THREAD_POST_INIT, wlan_thread_post_init_hdlr, NULL, hif_thread_wmac_dsr_wrapper)",
      registrationApi: "wlan_thread_register_signal_wrapper",
      dispatchKey: "WLAN_THREAD_POST_INIT",
      callbackParamName: "sig_handler",
      expectedStoreFieldName: "sig_handler",
      expectedDispatchFn: "wlan_thread_dsr_wrapper_common",
      expectedDispatchLine: 244,  // 0-based: real_sig_hdlr = ... at line 245
      expectedTriggerKind: "signal",
    },
  ]
}
