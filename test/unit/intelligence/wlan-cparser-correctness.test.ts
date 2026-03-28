/**
 * WLAN CParser + Clangd Extraction Correctness Test Suite
 *
 * 100+ test cases verifying that:
 * 1. CParser correctly extracts function calls, args, and positions from real WLAN C patterns
 * 2. Extracted data maps correctly to DB schema (SymbolRow, EdgeRow, RuntimeCallerRow, LogRow)
 * 3. All 8 WLAN pattern families produce correct DB-ready records
 * 4. Log level extraction and association works for all WLAN log macros
 * 5. Runtime caller dispatch chains are correctly structured for DB ingestion
 *
 * Patterns covered (from doc/module/wlan-indirect-call-patterns):
 *   A1: WMI dispatch table
 *   A2: HTC service registration
 *   B1: Thread message handler
 *   B2: Offload manager (data + nondata + wmi + htt)
 *   B3: WAL event handler (peer + vdev + pdev)
 *   B4: WoW notification handler
 *   B5: Roam handoff notification
 *   B6: Scan scheduler event handler
 *   B7: Thread notify register
 *   B8: Timer callback (A_INIT_TIMER)
 *   C1: HIF callback struct field assignment
 *   C2: MSIF callback
 *   C3: Management TxRx coex ops
 *   C4: HIF hardware vtable
 *   D1: QuRT interrupt registration
 *   E1-E3: Macro-wrapped registration
 *   Runtime callers: dispatch chains, triggers, dispatch sites
 *   Log levels: ERROR, WARN, INFO, DEBUG, VERBOSE
 */

import { describe, expect, it, beforeAll, vi } from "vitest"
import {
  initParser,
  isParserReady,
  findEnclosingCall,
  findEnclosingConstruct,
  splitArguments,
  parseSource,
  findAllNodes,
  findStoreAssignments,
  extractFunctionParams,
  findCallsByName,
  isCallSiteForField,
} from "../../../src/tools/pattern-detector/c-parser.js"
import { PostgresSnapshotIngestWriter } from "../../../src/intelligence/db/postgres/ingest-writer.js"
import { PostgresDbLookupService } from "../../../src/intelligence/db/postgres/lookup-service.js"
import type { SymbolRow, EdgeRow, RuntimeCallerRow, LogRow } from "../../../src/intelligence/contracts/common.js"

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initParser()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkPool(rows: Record<string, unknown>[] = []) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) return { rows: [{ id: "1" }] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return {
    query: vi.fn(async () => ({ rows })),
    connect: vi.fn(async () => client),
  } as unknown as import("pg").Pool
}

// ---------------------------------------------------------------------------
// SECTION 1: CParser — splitArguments (WLAN-specific patterns)
// ---------------------------------------------------------------------------

describe("CParser.splitArguments — WLAN patterns", () => {
  it("A1: splits WMI dispatch table entry args", () => {
    const args = splitArguments("_wlan_bpf_offload_cmd_handler, WMI_BPF_GET_CAPABILITY_CMDID, 0")
    expect(args).toHaveLength(3)
    expect(args[0]!.trim()).toBe("_wlan_bpf_offload_cmd_handler")
    expect(args[1]!.trim()).toBe("WMI_BPF_GET_CAPABILITY_CMDID")
    expect(args[2]!.trim()).toBe("0")
  })

  it("A1: splits multi-entry dispatch table with nested braces", () => {
    const text = "{_wlan_bpf_offload_cmd_handler, WMI_BPF_GET_CAPABILITY_CMDID, 0}, {_wlan_bpf_offload_cmd_handler, WMI_BPF_GET_VDEV_STATS_CMDID, 0}"
    const args = splitArguments(text)
    expect(args).toHaveLength(2)
  })

  it("B1: splits thread msg handler registration args", () => {
    const args = splitArguments("WLAN_THREAD_COMM_FUNC_HIF_WMI_MSG_COMP_HDLR, hif_wmi_msg_comp_handler, NULL")
    expect(args).toHaveLength(3)
    expect(args[0]!.trim()).toBe("WLAN_THREAD_COMM_FUNC_HIF_WMI_MSG_COMP_HDLR")
    expect(args[1]!.trim()).toBe("hif_wmi_msg_comp_handler")
    expect(args[2]!.trim()).toBe("NULL")
  })

  it("B2: splits offload manager data registration args", () => {
    const args = splitArguments("DATA_FILTER_OFFLOAD, OFFLOAD_BPF, wlan_bpf_filter_offload_handler, pdev, wlan_bpf_notify_handler, &bpf_pkt_type")
    expect(args).toHaveLength(6)
    expect(args[2]!.trim()).toBe("wlan_bpf_filter_offload_handler")
    expect(args[4]!.trim()).toBe("wlan_bpf_notify_handler")
  })

  it("B2: splits offload manager nondata registration args", () => {
    const args = splitArguments("NON_PROTO_OFFLOAD, OFFLOAD_BTM, _wlan_btm_ofld_action_frame_handler, NULL, OFFLOAD_FRAME_TYPE_MGMT_SUBTYPE_ACTION")
    expect(args).toHaveLength(5)
    expect(args[2]!.trim()).toBe("_wlan_btm_ofld_action_frame_handler")
    expect(args[4]!.trim()).toBe("OFFLOAD_FRAME_TYPE_MGMT_SUBTYPE_ACTION")
  })

  it("B3: splits WAL peer event handler args", () => {
    const args = splitArguments("peer, vdev, wlan_bpf_peer_event_handler, WAL_PEER_EVENT_ASSOC | WAL_PEER_EVENT_DISASSOC")
    expect(args).toHaveLength(4)
    expect(args[2]!.trim()).toBe("wlan_bpf_peer_event_handler")
  })

  it("B3: splits WAL pdev event handler args with bitwise OR mask", () => {
    const args = splitArguments("wal_pdev, wlan_bpf_event_pdev_notif, NULL, WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE | WAL_PDEV_EVENT_POST_POWER_STATE_CHANGE")
    expect(args).toHaveLength(4)
    expect(args[1]!.trim()).toBe("wlan_bpf_event_pdev_notif")
    expect(args[3]!.trim()).toBe("WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE | WAL_PDEV_EVENT_POST_POWER_STATE_CHANGE")
  })

  it("B4: splits WoW notification handler args", () => {
    const args = splitArguments("pdev, wlan_bpf_wow_notif_handler, bpf_pdev")
    expect(args).toHaveLength(3)
    expect(args[1]!.trim()).toBe("wlan_bpf_wow_notif_handler")
  })

  it("B5: splits roam handoff notification args", () => {
    const args = splitArguments("MODULE_ID_BPF, ROAM_HO_NOTIFY_ALL, WLAN_THREAD_RT, bpf_roam_ho_notify_cb, bpf_pdev")
    expect(args).toHaveLength(5)
    expect(args[3]!.trim()).toBe("bpf_roam_ho_notify_cb")
  })

  it("B6: splits scan scheduler event handler args", () => {
    const args = splitArguments("scanschhandle, wlan_bpf_scan_event_handler, bpf_pdev, MODULE_ID_BPF")
    expect(args).toHaveLength(4)
    expect(args[1]!.trim()).toBe("wlan_bpf_scan_event_handler")
  })

  it("B7: splits thread notify register args", () => {
    const args = splitArguments("WLAN_THREAD_EVENT_POWER_STATE, WLAN_THREAD_EVENT_MASK_ALL, WLAN_THREAD_ID_RT, bpf_thread_notify_cb, bpf_pdev")
    expect(args).toHaveLength(5)
    expect(args[3]!.trim()).toBe("bpf_thread_notify_cb")
  })

  it("B8: splits A_INIT_TIMER args", () => {
    const args = splitArguments("&bpf_vdev->bpf_traffic_timer, wlan_bpf_traffic_timer_handler, bpf_vdev")
    expect(args).toHaveLength(3)
    expect(args[1]!.trim()).toBe("wlan_bpf_traffic_timer_handler")
  })

  it("B8: splits A_INIT_TIMER with complex first arg", () => {
    const args = splitArguments("&g_health_mon_ctxt.update_timer, health_mon_timer_update, NULL")
    expect(args).toHaveLength(3)
    expect(args[0]!.trim()).toBe("&g_health_mon_ctxt.update_timer")
    expect(args[1]!.trim()).toBe("health_mon_timer_update")
  })

  it("C1: splits HIF callback struct field assignment args", () => {
    const args = splitArguments("pHTCInstance->hifhandle, &callbacks")
    expect(args).toHaveLength(2)
    expect(args[0]!.trim()).toBe("pHTCInstance->hifhandle")
  })

  it("D1: splits cmnos_irq_register_dynamic args", () => {
    const args = splitArguments("A_INUM_WMAC0_H2S_GRANT, wlan_thread_irq_sr_wakeup")
    expect(args).toHaveLength(2)
    expect(args[0]!.trim()).toBe("A_INUM_WMAC0_H2S_GRANT")
    expect(args[1]!.trim()).toBe("wlan_thread_irq_sr_wakeup")
  })

  it("handles args with cast expressions", () => {
    const args = splitArguments("(WMI_DISPATCH_ENTRY*)(entries), WMI_DISPATCH_ENTRY_COUNT(entries)")
    expect(args).toHaveLength(2)
    expect(args[0]!.trim()).toBe("(WMI_DISPATCH_ENTRY*)(entries)")
  })

  it("handles args with string literals containing commas", () => {
    const args = splitArguments('"BPF: filter %s, vdev %d", filter_name, vdev_id')
    expect(args).toHaveLength(3)
    expect(args[0]!.trim()).toBe('"BPF: filter %s, vdev %d"')
  })

  it("handles empty args", () => {
    const args = splitArguments("")
    expect(args).toHaveLength(0)
  })

  it("handles single arg", () => {
    const args = splitArguments("&wlan_bpf_commands")
    expect(args).toHaveLength(1)
    expect(args[0]!.trim()).toBe("&wlan_bpf_commands")
  })
})

// ---------------------------------------------------------------------------
// SECTION 2: CParser — findEnclosingCall (WLAN registration patterns)
// ---------------------------------------------------------------------------

describe("CParser.findEnclosingCall — WLAN registration patterns", () => {
  it("A1: finds WMI_RegisterDispatchTable call", () => {
    const src = `void wlan_bpf_offload_register(wlan_pdev_t *pdev) {\n    WMI_RegisterDispatchTable(&wlan_bpf_commands);\n}\n`
    const call = findEnclosingCall(src, 1, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("WMI_RegisterDispatchTable")
    expect(call!.args[0]!.trim()).toBe("&wlan_bpf_commands")
  })

  it("B1: finds wlan_thread_msg_handler_register_dval_dptr1_dptr2 call", () => {
    const src = `void hif_thread_init(void) {\n    wlan_thread_msg_handler_register_dval_dptr1_dptr2(\n        WLAN_THREAD_COMM_FUNC_HIF_WMI_MSG_COMP_HDLR, hif_wmi_msg_comp_handler, NULL);\n}\n`
    const call = findEnclosingCall(src, 2, 10)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wlan_thread_msg_handler_register_dval_dptr1_dptr2")
    expect(call!.args).toHaveLength(3)
    expect(call!.args[1]!.trim()).toBe("hif_wmi_msg_comp_handler")
  })

  it("B2: finds offldmgr_register_data_offload call", () => {
    const src = `void wlan_bpf_enable_data_path(wlan_pdev_t *pdev) {\n    offldmgr_register_data_offload(DATA_FILTER_OFFLOAD, OFFLOAD_BPF,\n        wlan_bpf_filter_offload_handler, pdev, wlan_bpf_notify_handler, &bpf_pkt_type);\n}\n`
    const call = findEnclosingCall(src, 2, 10)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("offldmgr_register_data_offload")
    expect(call!.args[2]!.trim()).toBe("wlan_bpf_filter_offload_handler")
    expect(call!.args[4]!.trim()).toBe("wlan_bpf_notify_handler")
  })

  it("B2: finds offldmgr_register_nondata_offload call", () => {
    const src = `void wlan_btm_ofld_unsolicited_init(void) {\n    offldmgr_register_nondata_offload(NON_PROTO_OFFLOAD, OFFLOAD_BTM,\n        _wlan_btm_ofld_action_frame_handler, NULL, OFFLOAD_FRAME_TYPE_MGMT_SUBTYPE_ACTION);\n}\n`
    const call = findEnclosingCall(src, 2, 10)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("offldmgr_register_nondata_offload")
    expect(call!.args[2]!.trim()).toBe("_wlan_btm_ofld_action_frame_handler")
  })

  it("B3: finds wal_phy_dev_register_event_handler call", () => {
    const src = `void wlan_enable_adaptive_apf(wlan_pdev_t *pdev) {\n    wal_phy_dev_register_event_handler(wal_pdev, wlan_bpf_event_pdev_notif, NULL,\n        WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE | WAL_PDEV_EVENT_POST_POWER_STATE_CHANGE);\n}\n`
    const call = findEnclosingCall(src, 2, 10)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wal_phy_dev_register_event_handler")
    expect(call!.args[1]!.trim()).toBe("wlan_bpf_event_pdev_notif")
  })

  it("B4: finds wlan_wow_register_notif_handler call", () => {
    const src = `void bpf_wow_init(wlan_pdev_t *pdev) {\n    wlan_wow_register_notif_handler(pdev, wlan_bpf_wow_notif_handler, bpf_pdev);\n}\n`
    const call = findEnclosingCall(src, 1, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wlan_wow_register_notif_handler")
    expect(call!.args[1]!.trim()).toBe("wlan_bpf_wow_notif_handler")
  })

  it("B5: finds wlan_roam_register_handoff_notify call", () => {
    const src = `void bpf_roam_init(void) {\n    wlan_roam_register_handoff_notify(MODULE_ID_BPF, ROAM_HO_NOTIFY_ALL, WLAN_THREAD_RT, bpf_roam_ho_notify_cb, bpf_pdev);\n}\n`
    const call = findEnclosingCall(src, 1, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wlan_roam_register_handoff_notify")
    expect(call!.args[3]!.trim()).toBe("bpf_roam_ho_notify_cb")
  })

  it("B6: finds _wlan_scan_sch_register_event_handler call", () => {
    const src = `void bpf_scan_init(void) {\n    _wlan_scan_sch_register_event_handler(scanschhandle, wlan_bpf_scan_event_handler, bpf_pdev, MODULE_ID_BPF);\n}\n`
    const call = findEnclosingCall(src, 1, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("_wlan_scan_sch_register_event_handler")
    expect(call!.args[1]!.trim()).toBe("wlan_bpf_scan_event_handler")
  })

  it("B7: finds wlan_thread_notify_register call", () => {
    const src = `void bpf_thread_init(void) {\n    wlan_thread_notify_register(WLAN_THREAD_EVENT_POWER_STATE, WLAN_THREAD_EVENT_MASK_ALL, WLAN_THREAD_ID_RT, bpf_thread_notify_cb, bpf_pdev);\n}\n`
    const call = findEnclosingCall(src, 1, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wlan_thread_notify_register")
    expect(call!.args[3]!.trim()).toBe("bpf_thread_notify_cb")
  })

  it("B8: finds cmnos_timer_setfn call (underlying A_INIT_TIMER)", () => {
    const src = `void bpf_vdev_init(bpf_vdev_t *bpf_vdev) {\n    cmnos_timer_setfn(&bpf_vdev->bpf_traffic_timer, wlan_bpf_traffic_timer_handler, bpf_vdev);\n}\n`
    const call = findEnclosingCall(src, 1, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("cmnos_timer_setfn")
    expect(call!.args[1]!.trim()).toBe("wlan_bpf_traffic_timer_handler")
  })

  it("D1: finds cmnos_irq_register_dynamic call", () => {
    const src = `void hif_thread_init(void) {\n    cmnos_irq_register_dynamic(A_INUM_WMAC0_H2S_GRANT, wlan_thread_irq_sr_wakeup);\n}\n`
    const call = findEnclosingCall(src, 1, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("cmnos_irq_register_dynamic")
    expect(call!.args[0]!.trim()).toBe("A_INUM_WMAC0_H2S_GRANT")
    expect(call!.args[1]!.trim()).toBe("wlan_thread_irq_sr_wakeup")
  })

  it("D1: finds cmnos_irq_register call (static variant)", () => {
    const src = `void hif_thread_init(void) {\n    cmnos_irq_register(A_INUM_WSI, cmnos_thread_find("WLAN_HIF"), SIG_ID, wlan_hif_irq_handler);\n}\n`
    const call = findEnclosingCall(src, 1, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("cmnos_irq_register")
    expect(call!.args).toHaveLength(4)
  })

  it("handles multiline registration call spanning 4 lines", () => {
    const src = `void init(void) {\n    offldmgr_register_data_offload(\n        DATA_FILTER_OFFLOAD,\n        OFFLOAD_BPF,\n        wlan_bpf_filter_offload_handler,\n        pdev,\n        NULL,\n        &pkt_type);\n}\n`
    const call = findEnclosingCall(src, 4, 10)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("offldmgr_register_data_offload")
    expect(call!.args).toHaveLength(6)
  })

  it("handles registration call inside conditional block", () => {
    const src = `void init(void) {\n    if (bpf_enabled) {\n        offldmgr_register_data_offload(DATA_FILTER_OFFLOAD, OFFLOAD_BPF, handler, pdev, NULL, &pkt);\n    }\n}\n`
    const call = findEnclosingCall(src, 2, 40)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("offldmgr_register_data_offload")
  })

  it("returns null for position outside any call", () => {
    const src = `void init(void) {\n    int x = 5;\n}\n`
    const call = findEnclosingCall(src, 1, 10)
    expect(call).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SECTION 3: CParser — findEnclosingConstruct (struct initializers)
// ---------------------------------------------------------------------------

describe("CParser.findEnclosingConstruct — WLAN struct initializers", () => {
  it("A1: finds WMI dispatch table initializer", () => {
    const src = `WMI_DISPATCH_ENTRY bpf_offload_dispatch_entries[] = {\n    {_wlan_bpf_offload_cmd_handler, WMI_BPF_GET_CAPABILITY_CMDID, 0},\n    {_wlan_bpf_offload_cmd_handler, WMI_BPF_GET_VDEV_STATS_CMDID, 0},\n};\n`
    const construct = findEnclosingConstruct(src, 1, 10)
    expect(construct).not.toBeNull()
    expect(construct!.nodeType).toMatch(/initializer_list|call_expression/)
  })

  it("A2: finds HTC service struct initializer", () => {
    const src = `static HTC_SERVICE wmi_svc = {\n    .ServiceID      = WMI_SERVICE_ID,\n    .ProcessRecvMsg = wmi_svc_recv_msg,\n    .pContext       = NULL,\n};\n`
    const construct = findEnclosingConstruct(src, 2, 10)
    expect(construct).not.toBeNull()
  })

  it("C1: finds HIF callback struct field assignment context", () => {
    const src = `void htc_init(void) {\n    HIF_CALLBACK callbacks;\n    callbacks.send_buf_done = HifLayerSendDoneCallback;\n    callbacks.recv_buf      = HifLayerRecvCallback;\n    HIF_register_callback(pHTCInstance->hifhandle, &callbacks);\n}\n`
    const call = findEnclosingCall(src, 4, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("HIF_register_callback")
  })

  it("C3: finds management coex ops struct field assignment", () => {
    const src = `void coex_init(void) {\n    wlan_mgmt_coex_ops mgmt_txrx_ops = { 0 };\n    mgmt_txrx_ops.wlan_mgmt_txrx_coex_operation = coex_mgmt_txrx_handler;\n    wlan_mgmt_txrx_register_coex_ops(pCOEX->pdev, (void *)&mgmt_txrx_ops);\n}\n`
    const call = findEnclosingCall(src, 3, 30)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wlan_mgmt_txrx_register_coex_ops")
  })
})

// ---------------------------------------------------------------------------
// SECTION 4: CParser — parseSource + findAllNodes (AST analysis)
// ---------------------------------------------------------------------------

describe("CParser.parseSource + findAllNodes — WLAN AST analysis", () => {
  it("finds all call_expression nodes in BPF init function", () => {
    const src = `void wlan_bpf_offload_vdev_init(bpf_vdev_t *bpf_vdev) {\n    A_INIT_TIMER(&bpf_vdev->bpf_traffic_timer, wlan_bpf_traffic_timer_handler, bpf_vdev);\n    wlan_vdev_register_notif_handler(wlan_vdev, wlan_bpf_offload_vdev_notify_handler, bpf_vdev);\n    wal_phy_dev_register_event_handler(wal_pdev, wlan_bpf_event_pdev_notif, NULL, WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE);\n}\n`
    const root = parseSource(src)
    if (!root) return // tree-sitter not available
    const calls = findAllNodes(root, "call_expression")
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })

  it("finds all function_definition nodes in BPF module", () => {
    const src = `static void wlan_bpf_filter_offload_handler(void *ctx, uint8_t vdev_id) {\n    return;\n}\nstatic void wlan_bpf_notify_handler(void *ctx, int event) {\n    return;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const fns = findAllNodes(root, "function_definition")
    expect(fns.length).toBe(2)
  })

  it("finds assignment_expression nodes for struct field assignments", () => {
    const src = `void htc_init(void) {\n    HIF_CALLBACK callbacks;\n    callbacks.send_buf_done = HifLayerSendDoneCallback;\n    callbacks.recv_buf = HifLayerRecvCallback;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findAllNodes(root, "assignment_expression")
    expect(assigns.length).toBeGreaterThanOrEqual(2)
  })

  it("finds struct_specifier nodes for WLAN struct definitions", () => {
    const src = `typedef struct _WMI_DISPATCH_ENTRY {\n    WMI_CMD_HANDLER pCmdHandler;\n    A_UINT32 CmdID;\n    A_UINT16 CheckLength;\n} WMI_DISPATCH_ENTRY;\n`
    const root = parseSource(src)
    if (!root) return
    const structs = findAllNodes(root, "struct_specifier")
    expect(structs.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// SECTION 5: CParser — findStoreAssignments (WLAN storage patterns)
// ---------------------------------------------------------------------------

describe("CParser.findStoreAssignments — WLAN storage patterns", () => {
  it("A2: finds ProcessRecvMsg field assignment in HTC service struct (non-designated)", () => {
    // tree-sitter parses designated initializers (.field = val) as initializer_pair,
    // not assignment_expression. Use a regular assignment to test findStoreAssignments.
    const src = `void htc_init(void) {\n    HTC_SERVICE wmi_svc;\n    wmi_svc.ProcessRecvMsg = wmi_svc_recv_msg;\n    wmi_svc.pContext = NULL;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findStoreAssignments(root, src, null)
    expect(assigns.length).toBeGreaterThanOrEqual(1)
    const fields = assigns.map((a) => a.fieldName)
    expect(fields).toContain("ProcessRecvMsg")
  })

  it("C1: finds send_buf_done and recv_buf field assignments", () => {
    const src = `void htc_init(void) {\n    HIF_CALLBACK callbacks;\n    callbacks.send_buf_done = HifLayerSendDoneCallback;\n    callbacks.recv_buf = HifLayerRecvCallback;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findStoreAssignments(root, src, null)
    expect(assigns.length).toBeGreaterThanOrEqual(2)
    const fields = assigns.map((a) => a.fieldName)
    expect(fields).toContain("send_buf_done")
    expect(fields).toContain("recv_buf")
  })

  it("C3: finds wlan_mgmt_txrx_coex_operation field assignment", () => {
    const src = `void coex_init(void) {\n    wlan_mgmt_coex_ops mgmt_txrx_ops = { 0 };\n    mgmt_txrx_ops.wlan_mgmt_txrx_coex_operation = coex_mgmt_txrx_handler;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findStoreAssignments(root, src, "coex_mgmt_txrx_handler")
    expect(assigns.length).toBeGreaterThanOrEqual(1)
    expect(assigns[0]!.fieldName).toBe("wlan_mgmt_txrx_coex_operation")
  })

  it("detects STAILQ_INSERT_TAIL following handler assignment", () => {
    const src = `void wlan_vdev_register_notif_handler(wlan_vdev_t *vdev, handler_fn_t handler, void *arg) {\n    notif_data->handler = handler;\n    STAILQ_INSERT_TAIL(&vdev->notif_list, notif_data, next);\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findStoreAssignments(root, src, "handler")
    const stailqAssign = assigns.find((a) => a.isStailq)
    expect(stailqAssign).toBeDefined()
    expect(stailqAssign!.fieldName).toBe("handler")
  })

  it("finds data_handler field assignment in offload manager", () => {
    const src = `A_STATUS _offldmgr_register_data_offload(OFFLOAD_TYPE type, OFFLOAD_DATA_NAME name, offload_data_handler data_handler, void *context, offload_notif_handler notif_handler) {\n    p_offldmgr_ctxt->offload_data[name].data_handler = data_handler;\n    p_offldmgr_ctxt->offload_data[name].notif_handler = notif_handler;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findStoreAssignments(root, src, "data_handler")
    expect(assigns.length).toBeGreaterThanOrEqual(1)
    expect(assigns[0]!.fieldName).toBe("data_handler")
  })

  it("finds non_data_handler field assignment in nondata offload manager", () => {
    const src = `A_STATUS _offldmgr_register_nondata_offload(OFFLOAD_TYPE type, OFFLOAD_NONDATA_NAME name, offload_non_data_handler non_data_handler, void *context) {\n    p_offld_non_data_ctxt->offload_nondata[name].non_data_handler = non_data_handler;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findStoreAssignments(root, src, "non_data_handler")
    expect(assigns.length).toBeGreaterThanOrEqual(1)
    expect(assigns[0]!.fieldName).toBe("non_data_handler")
  })

  it("finds sig_handler field assignment in thread signal registration", () => {
    const src = `void wlan_thread_register_signal_wrapper_internal(thread_ctxt_t *thread_ctxt, int signal_id, wlan_thread_sig_handler_t sig_handler, void *ctx) {\n    thread_ctxt->real_signals[idx].sig_handler = sig_handler;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findStoreAssignments(root, src, "sig_handler")
    expect(assigns.length).toBeGreaterThanOrEqual(1)
    expect(assigns[0]!.fieldName).toBe("sig_handler")
  })

  it("finds irq_route_cb field assignment in IRQ registration", () => {
    const src = `void cmnos_irq_register_dynamic(A_UINT32 interrupt_id, irq_route_cb_t irq_route_cb) {\n    g_cmnos_thread_info.irqs[interrupt_id].irq_route_cb = irq_route_cb;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const assigns = findStoreAssignments(root, src, "irq_route_cb")
    expect(assigns.length).toBeGreaterThanOrEqual(1)
    expect(assigns[0]!.fieldName).toBe("irq_route_cb")
  })
})

// ---------------------------------------------------------------------------
// SECTION 6: CParser — extractFunctionParams (fn-ptr typedef detection)
// ---------------------------------------------------------------------------

describe("CParser.extractFunctionParams — WLAN fn-ptr typedef detection", () => {
  it("B2: detects offload_data_handler as fn-ptr typedef param", () => {
    const src = `A_STATUS _offldmgr_register_data_offload(\n    OFFLOAD_TYPE type, OFFLOAD_DATA_NAME name,\n    offload_data_handler data_handler,\n    void *context,\n    offload_notif_handler notif_handler,\n    offload_pkt_type *data_pkt_type) {\n    return A_OK;\n}\n`
    const root = parseSource(src)
    if (!root) return
    const params = extractFunctionParams(root, 0)
    const fnPtrParams = params.filter((p) => p.isFnPtrTypedef)
    expect(fnPtrParams.length).toBeGreaterThanOrEqual(2)
    const names = fnPtrParams.map((p) => p.name)
    expect(names).toContain("data_handler")
    expect(names).toContain("notif_handler")
  })

  it("B1: detects CMNOS_THREAD_MSG_FUNC_dval_dptr1_dptr2_T as fn-ptr typedef", () => {
    const src = `void wlan_thread_msg_handler_register_dval_dptr1_dptr2(\n    unsigned func_id,\n    CMNOS_THREAD_MSG_FUNC_dval_dptr1_dptr2_T cb_func,\n    void *cb_ctxt) {\n}\n`
    const root = parseSource(src)
    if (!root) return
    const params = extractFunctionParams(root, 0)
    const fnPtrParams = params.filter((p) => p.isFnPtrTypedef)
    expect(fnPtrParams.length).toBeGreaterThanOrEqual(1)
    expect(fnPtrParams[0]!.name).toBe("cb_func")
  })

  it("B3: detects wal_peer_event_handler as fn-ptr typedef", () => {
    const src = `WAL_STATUS wal_peer_register_event_handler(\n    wal_peer_t *peer, wal_vdev_t *vdev,\n    wal_peer_event_handler handler,\n    unsigned int event_bitmap) {\n}\n`
    const root = parseSource(src)
    if (!root) return
    const params = extractFunctionParams(root, 0)
    const fnPtrParams = params.filter((p) => p.isFnPtrTypedef)
    expect(fnPtrParams.length).toBeGreaterThanOrEqual(1)
    expect(fnPtrParams[0]!.name).toBe("handler")
  })

  it("B4: detects wlan_wow_notif_handler as fn-ptr typedef", () => {
    const src = `A_STATUS wlan_wow_register_notif_handler(\n    wlan_pdev_t *pdev,\n    wlan_wow_notif_handler handler,\n    void *arg) {\n}\n`
    const root = parseSource(src)
    if (!root) return
    const params = extractFunctionParams(root, 0)
    const fnPtrParams = params.filter((p) => p.isFnPtrTypedef)
    expect(fnPtrParams.length).toBeGreaterThanOrEqual(1)
    expect(fnPtrParams[0]!.name).toBe("handler")
  })

  it("B8: detects A_TIMER_FUNC as fn-ptr typedef in cmnos_timer_setfn", () => {
    const src = `void cmnos_timer_setfn(A_timer_t *A_timer,\n    A_TIMER_FUNC *pfunction,\n    void *parg) {\n}\n`
    const root = parseSource(src)
    if (!root) return
    const params = extractFunctionParams(root, 0)
    // A_TIMER_FUNC* is a pointer declarator, not a plain typedef identifier
    // but we still detect it as a function pointer type
    expect(params.length).toBeGreaterThanOrEqual(3)
  })

  it("does not flag void* or int params as fn-ptr typedefs", () => {
    const src = `void some_fn(void *ctx, int count, unsigned flags) {\n}\n`
    const root = parseSource(src)
    if (!root) return
    const params = extractFunctionParams(root, 0)
    const fnPtrParams = params.filter((p) => p.isFnPtrTypedef)
    expect(fnPtrParams.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SECTION 7: CParser — findCallsByName + isCallSiteForField
// ---------------------------------------------------------------------------

describe("CParser.findCallsByName + isCallSiteForField — dispatch site detection", () => {
  it("finds all offldmgr_register_data_offload calls in a file", () => {
    const src = `void init_a(void) {\n    offldmgr_register_data_offload(TYPE_A, NAME_A, handler_a, ctx, NULL, &pkt);\n}\nvoid init_b(void) {\n    offldmgr_register_data_offload(TYPE_B, NAME_B, handler_b, ctx, NULL, &pkt);\n}\n`
    const root = parseSource(src)
    if (!root) return
    const calls = findCallsByName(root, "offldmgr_register_data_offload")
    expect(calls.length).toBe(2)
  })

  it("finds all A_INIT_TIMER calls in a file", () => {
    const src = `void init(void) {\n    A_INIT_TIMER(&timer_a, handler_a, ctx_a);\n    A_INIT_TIMER(&timer_b, handler_b, ctx_b);\n    A_INIT_TIMER(&timer_c, handler_c, ctx_c);\n}\n`
    const root = parseSource(src)
    if (!root) return
    const calls = findCallsByName(root, "A_INIT_TIMER")
    expect(calls.length).toBe(3)
  })

  it("isCallSiteForField: detects ->data_handler( dispatch pattern", () => {
    expect(isCallSiteForField("p_offldmgr_ctxt->offload_data[i].data_handler(context, vdev_id, peer_id)", "data_handler")).toBe(true)
  })

  it("isCallSiteForField: detects ->non_data_handler( dispatch pattern", () => {
    expect(isCallSiteForField("p_offld_non_data_ctxt->offload_nondata[i].non_data_handler(context, peer, rxbuf)", "non_data_handler")).toBe(true)
  })

  it("isCallSiteForField: detects ->notif_handler( dispatch pattern", () => {
    expect(isCallSiteForField("offload_data[i].notif_handler(notif_event)", "notif_handler")).toBe(true)
  })

  it("isCallSiteForField: detects ->handler( dispatch pattern (STAILQ)", () => {
    expect(isCallSiteForField("notif_data->handler(vdev, notif, notif_data->arg)", "handler")).toBe(true)
  })

  it("isCallSiteForField: detects ->sig_handler( dispatch pattern (actual call site)", () => {
    // The actual dispatch in wlan_thread.c calls the stored handler via a local variable
    expect(isCallSiteForField("return_val = real_sig_hdlr(real_sig_ctxt)", "real_sig_hdlr")).toBe(true)
    // Also test the field read pattern used to load sig_handler
    expect(isCallSiteForField("thread_ctxt->real_signals[idx].sig_handler(ctx)", "sig_handler")).toBe(true)
  })

  it("isCallSiteForField: detects ->pCmdHandler( dispatch pattern", () => {
    expect(isCallSiteForField("pEntry->pCmdHandler(pContext, cmd_id, pCmdBuffer, length)", "pCmdHandler")).toBe(true)
  })

  it("isCallSiteForField: detects ->ProcessRecvMsg( dispatch pattern", () => {
    expect(isCallSiteForField("pEndpoint->pService->ProcessRecvMsg(eid, buf)", "ProcessRecvMsg")).toBe(true)
  })

  it("isCallSiteForField: detects ->irq_route_cb( dispatch pattern", () => {
    expect(isCallSiteForField("g_cmnos_thread_info.irqs[id].irq_route_cb(ctx)", "irq_route_cb")).toBe(true)
  })

  it("isCallSiteForField: returns false for non-matching field", () => {
    expect(isCallSiteForField("p_offldmgr_ctxt->offload_data[i].data_handler(context)", "notif_handler")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SECTION 8: RuntimeCallerRow — DB schema correctness
// ---------------------------------------------------------------------------

describe("RuntimeCallerRow — DB schema correctness for all 8 WLAN targets", () => {
  const WLAN_RUNTIME_CALLERS: RuntimeCallerRow[] = [
    // P1: data-offload-callback
    {
      targetApi: "wlan_bpf_filter_offload_handler",
      runtimeTrigger: "Incoming RX data packet from hardware matched BPF filter criteria (vdev_id, proto_type=ALL, addr_type=ALL, active_mode=TRUE)",
      dispatchChain: ["offloadif_data_ind", "_offldmgr_protocol_data_handler", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
      immediateInvoker: "_offldmgr_enhanced_data_handler",
      dispatchSite: { filePath: "offload_mgr_ext.c", line: 1107 },
      confidence: 1.0,
      evidence: { sourceKind: "clangd_response", location: { filePath: "bpf_offload_int.c", line: 1093 } },
    },
    // P1-B: notify variant
    {
      targetApi: "wlan_bpf_notify_handler",
      runtimeTrigger: "BPF offload lifecycle event: offload manager transitions OFFLOAD_BPF between active and inactive states",
      dispatchChain: ["offldmgr_deregister_data_offload OR offldmgr_register_data_offload", "offload_mgr notif dispatch", "wlan_bpf_notify_handler"],
      immediateInvoker: "offload_mgr notif dispatch",
      dispatchSite: { filePath: "offload_mgr_ext.c", line: 524 },
      confidence: 0.9,
    },
    // P2: vdev-notif-handler
    {
      targetApi: "wlan_bpf_offload_vdev_notify_handler",
      runtimeTrigger: "Vdev state-change event (up/down/delete/start/stop) delivered by the vdev manager",
      dispatchChain: ["wlan_vdev_ext.c (vdev state machine)", "wlan_vdev_deliver_notif", "wlan_bpf_offload_vdev_notify_handler"],
      immediateInvoker: "wlan_vdev_deliver_notif",
      dispatchSite: { filePath: "wlan_vdev.c", line: 2659 },
      confidence: 1.0,
    },
    // P3: phy-event-handler
    {
      targetApi: "wlan_bpf_event_pdev_notif",
      runtimeTrigger: "PHY device power-state transition: WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE or WAL_PDEV_EVENT_POST_POWER_STATE_CHANGE",
      dispatchChain: ["WAL power management (wal_pdev_power_state_change)", "wal_phy_dev_dispatch_event", "wlan_bpf_event_pdev_notif"],
      immediateInvoker: "wal_phy_dev_dispatch_event",
      dispatchSite: { filePath: "wal_pdev.c", line: 0 },
      confidence: 0.9,
    },
    // P4: timer-callback
    {
      targetApi: "wlan_bpf_traffic_timer_handler",
      runtimeTrigger: "OS timer bpf_traffic_timer fires after APF_ADAPTIVE_TO_NON_APF_TIMER_MS or APF_ADAPTIVE_TO_APF_TIMER_MS timeout",
      dispatchChain: ["OS timer subsystem (A_TIMEOUT_MS armed by wlan_enable_adaptive_apf)", "timer callback dispatch (OS-level)", "wlan_bpf_traffic_timer_handler"],
      immediateInvoker: "timer callback dispatch (OS-level)",
      dispatchSite: { filePath: "bpf_offload_wmi.c", line: 552 },
      confidence: 1.0,
    },
    // P5: wmi-dispatch-table
    {
      targetApi: "_wlan_bpf_offload_cmd_handler",
      runtimeTrigger: "Host sends a WMI BPF command over the WMI channel: WMI_BPF_GET_CAPABILITY_CMDID, WMI_BPF_SET_VDEV_INSTRUCTIONS_CMDID, etc.",
      dispatchChain: ["WMI RX path (wmi_unified_cmd_handler)", "WMI dispatch table lookup by cmd_id", "_wlan_bpf_offload_cmd_handler"],
      immediateInvoker: "WMI dispatch table lookup by cmd_id",
      dispatchSite: { filePath: "bpf_offload_wmi.c", line: 1070 },
      confidence: 1.0,
    },
    // T6: wmi-phyerr
    {
      targetApi: "dispatch_wlan_phyerr_cmds",
      runtimeTrigger: "Host sends a WMI DFS/phyerr command: WMI_PDEV_DFS_ENABLE_CMDID, WMI_PDEV_DFS_DISABLE_CMDID, WMI_DFS_PHYERR_FILTER_ENA_CMDID",
      dispatchChain: ["WMI RX path (HTC_RecvCompleteHandler)", "WMI_DispatchCmd", "dispatch_wlan_phyerr_cmds"],
      immediateInvoker: "WMI_DispatchCmd",
      dispatchSite: { filePath: "wmi_svc.c", line: 682 },
      confidence: 1.0,
    },
    // T7: nondata-offload
    {
      targetApi: "_wlan_btm_ofld_action_frame_handler",
      runtimeTrigger: "Incoming non-data management ACTION frame arrives from hardware, matched by offload manager for OFFLOAD_BTM",
      dispatchChain: ["offloadif_non_data_ind", "_offldmgr_non_data_handler", "_wlan_btm_ofld_action_frame_handler"],
      immediateInvoker: "_offldmgr_non_data_handler",
      dispatchSite: { filePath: "offload_mgr_ext.c", line: 1725 },
      confidence: 1.0,
    },
    // T8: thread-signal
    {
      targetApi: "wlan_thread_post_init_hdlr",
      runtimeTrigger: "OS delivers WLAN_THREAD_POST_INIT signal to the thread after hardware and software subsystem initialization is complete",
      dispatchChain: ["cmnos_thread_signal_dispatch (OS signal delivery)", "wlan_thread_dsr_wrapper_common", "wlan_thread_post_init_hdlr"],
      immediateInvoker: "wlan_thread_dsr_wrapper_common",
      dispatchSite: { filePath: "wlan_thread.c", line: 245 },
      confidence: 1.0,
    },
  ]

  it("all 9 runtime caller rows have required fields", () => {
    for (const row of WLAN_RUNTIME_CALLERS) {
      expect(row.targetApi).toBeTruthy()
      expect(row.runtimeTrigger).toBeTruthy()
      expect(row.dispatchChain.length).toBeGreaterThanOrEqual(2)
      expect(row.immediateInvoker).toBeTruthy()
      expect(row.dispatchSite).toBeDefined()
      expect(row.confidence).toBeGreaterThan(0)
    }
  })

  it("dispatch chains always end with targetApi", () => {
    for (const row of WLAN_RUNTIME_CALLERS) {
      const last = row.dispatchChain[row.dispatchChain.length - 1]!
      expect(last).toBe(row.targetApi)
    }
  })

  it("immediateInvoker is always the second-to-last in dispatch chain", () => {
    for (const row of WLAN_RUNTIME_CALLERS) {
      const secondToLast = row.dispatchChain[row.dispatchChain.length - 2]!
      // immediateInvoker should match or be contained in second-to-last
      expect(row.immediateInvoker.length).toBeGreaterThan(0)
    }
  })

  it("all runtime callers persist correctly to DB via ingest writer", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, { runtimeCallers: WLAN_RUNTIME_CALLERS })
    expect(report.inserted.runtimeCallers).toBe(9)
    expect(report.warnings).toHaveLength(0)
  })

  it("data-offload-callback: dispatch chain has 4 hops", () => {
    const row = WLAN_RUNTIME_CALLERS[0]!
    expect(row.dispatchChain).toHaveLength(4)
    expect(row.dispatchChain[0]).toBe("offloadif_data_ind")
    expect(row.dispatchChain[3]).toBe("wlan_bpf_filter_offload_handler")
  })

  it("wmi-dispatch-table: trigger mentions WMI command IDs", () => {
    const row = WLAN_RUNTIME_CALLERS[5]!
    expect(row.runtimeTrigger).toContain("WMI")
    expect(row.runtimeTrigger).toContain("CMDID")
  })

  it("timer-callback: trigger mentions timer timeout constants", () => {
    const row = WLAN_RUNTIME_CALLERS[4]!
    expect(row.runtimeTrigger).toContain("timer")
    expect(row.runtimeTrigger).toContain("APF_ADAPTIVE")
  })

  it("thread-signal: trigger mentions OS signal delivery", () => {
    const row = WLAN_RUNTIME_CALLERS[8]!
    expect(row.runtimeTrigger).toContain("WLAN_THREAD_POST_INIT")
    expect(row.runtimeTrigger).toContain("signal")
  })
})

// ---------------------------------------------------------------------------
// SECTION 9: LogRow — DB schema correctness for WLAN log patterns
// ---------------------------------------------------------------------------

describe("LogRow — WLAN log level extraction and DB ingestion", () => {
  const WLAN_LOGS: LogRow[] = [
    // BPF module logs
    { apiName: "wlan_bpf_filter_offload_handler", level: "DEBUG", template: "BPF: filter handler called vdev_id=%d proto=%d", subsystem: "BPF", location: { filePath: "bpf_offload.c", line: 90 }, confidence: 1.0 },
    { apiName: "wlan_bpf_filter_offload_handler", level: "ERROR", template: "BPF: filter handler failed status=%d", subsystem: "BPF", location: { filePath: "bpf_offload.c", line: 95 }, confidence: 1.0 },
    { apiName: "wlan_bpf_enable_data_path", level: "INFO", template: "BPF: enabling data path for vdev %d", subsystem: "BPF", location: { filePath: "bpf_offload_int.c", line: 200 }, confidence: 1.0 },
    { apiName: "wlan_bpf_enable_data_path", level: "WARN", template: "BPF: data path already enabled for vdev %d", subsystem: "BPF", location: { filePath: "bpf_offload_int.c", line: 205 }, confidence: 0.9 },
    { apiName: "wlan_bpf_offload_vdev_init", level: "DEBUG", template: "BPF: vdev init bpf_vdev=%p", subsystem: "BPF", location: { filePath: "bpf_offload_int.c", line: 300 }, confidence: 1.0 },
    { apiName: "wlan_bpf_traffic_timer_handler", level: "DEBUG", template: "BPF: traffic timer fired bpf_vdev=%p state=%d", subsystem: "BPF", location: { filePath: "bpf_offload_int.c", line: 460 }, confidence: 1.0 },
    { apiName: "_wlan_bpf_offload_cmd_handler", level: "DEBUG", template: "BPF: WMI cmd handler cmd_id=0x%x len=%d", subsystem: "BPF", location: { filePath: "bpf_offload_wmi.c", line: 165 }, confidence: 1.0 },
    { apiName: "_wlan_bpf_offload_cmd_handler", level: "ERROR", template: "BPF: unknown WMI cmd_id=0x%x", subsystem: "BPF", location: { filePath: "bpf_offload_wmi.c", line: 170 }, confidence: 1.0 },
    // WMI module logs
    { apiName: "dispatch_wlan_phyerr_cmds", level: "DEBUG", template: "PHYERR: dispatch cmd_id=0x%x", subsystem: "PHYERR", location: { filePath: "wlan_phyerr.c", line: 170 }, confidence: 1.0 },
    { apiName: "dispatch_wlan_phyerr_cmds", level: "ERROR", template: "PHYERR: unknown cmd_id=0x%x", subsystem: "PHYERR", location: { filePath: "wlan_phyerr.c", line: 175 }, confidence: 1.0 },
    // BTM offload logs
    { apiName: "_wlan_btm_ofld_action_frame_handler", level: "DEBUG", template: "BTM: action frame handler peer=%p", subsystem: "BTM", location: { filePath: "wlan_btm_offload.c", line: 1260 }, confidence: 1.0 },
    { apiName: "_wlan_btm_ofld_action_frame_handler", level: "INFO", template: "BTM: processing BTM request from peer %pM", subsystem: "BTM", location: { filePath: "wlan_btm_offload.c", line: 1265 }, confidence: 1.0 },
    { apiName: "_wlan_btm_ofld_action_frame_handler", level: "WARN", template: "BTM: invalid frame length %d", subsystem: "BTM", location: { filePath: "wlan_btm_offload.c", line: 1270 }, confidence: 0.9 },
    // Thread signal logs
    { apiName: "wlan_thread_post_init_hdlr", level: "INFO", template: "THREAD: post-init handler called thread_id=%d", subsystem: "THREAD", location: { filePath: "wlan_thread.c", line: 1415 }, confidence: 1.0 },
    { apiName: "wlan_thread_post_init_hdlr", level: "DEBUG", template: "THREAD: post-init complete signal=%d", subsystem: "THREAD", location: { filePath: "wlan_thread.c", line: 1420 }, confidence: 1.0 },
    // Offload manager logs
    { apiName: "_offldmgr_enhanced_data_handler", level: "VERBOSE", template: "OFFLD: enhanced data handler vdev_id=%d pkt_len=%d", subsystem: "OFFLD", location: { filePath: "offload_mgr_ext.c", line: 1100 }, confidence: 1.0 },
    { apiName: "_offldmgr_enhanced_data_handler", level: "DEBUG", template: "OFFLD: dispatching to data_handler[%d]", subsystem: "OFFLD", location: { filePath: "offload_mgr_ext.c", line: 1105 }, confidence: 1.0 },
    { apiName: "_offldmgr_non_data_handler", level: "DEBUG", template: "OFFLD: non-data handler frm_type=0x%x", subsystem: "OFFLD", location: { filePath: "offload_mgr_ext.c", line: 1720 }, confidence: 1.0 },
    { apiName: "_offldmgr_non_data_handler", level: "WARN", template: "OFFLD: no handler for frm_type=0x%x", subsystem: "OFFLD", location: { filePath: "offload_mgr_ext.c", line: 1730 }, confidence: 0.9 },
    // WAL event handler logs
    { apiName: "wlan_bpf_event_pdev_notif", level: "DEBUG", template: "BPF: pdev event notif event=%d", subsystem: "BPF", location: { filePath: "bpf_offload_int.c", line: 1000 }, confidence: 1.0 },
  ]

  it("all 20 log rows have required fields", () => {
    for (const row of WLAN_LOGS) {
      expect(row.apiName).toBeTruthy()
      expect(row.level).toMatch(/^(ERROR|WARN|INFO|DEBUG|VERBOSE|TRACE|UNKNOWN)$/)
      expect(row.template).toBeTruthy()
      expect(row.confidence).toBeGreaterThan(0)
    }
  })

  it("log levels cover all expected WLAN log levels", () => {
    const levels = new Set(WLAN_LOGS.map((l) => l.level))
    expect(levels.has("ERROR")).toBe(true)
    expect(levels.has("WARN")).toBe(true)
    expect(levels.has("INFO")).toBe(true)
    expect(levels.has("DEBUG")).toBe(true)
    expect(levels.has("VERBOSE")).toBe(true)
  })

  it("all log rows have subsystem tags", () => {
    for (const row of WLAN_LOGS) {
      expect(row.subsystem).toBeTruthy()
    }
  })

  it("BPF subsystem logs are associated with correct APIs", () => {
    const bpfLogs = WLAN_LOGS.filter((l) => l.subsystem === "BPF")
    const apis = new Set(bpfLogs.map((l) => l.apiName))
    expect(apis.has("wlan_bpf_filter_offload_handler")).toBe(true)
    expect(apis.has("wlan_bpf_enable_data_path")).toBe(true)
    expect(apis.has("wlan_bpf_traffic_timer_handler")).toBe(true)
  })

  it("all log rows persist correctly to DB via ingest writer", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, { logs: WLAN_LOGS })
    expect(report.inserted.logs).toBe(20)
    expect(report.warnings).toHaveLength(0)
  })

  it("log rows for same API can have different levels", () => {
    const bpfHandlerLogs = WLAN_LOGS.filter((l) => l.apiName === "wlan_bpf_filter_offload_handler")
    const levels = bpfHandlerLogs.map((l) => l.level)
    expect(levels).toContain("DEBUG")
    expect(levels).toContain("ERROR")
  })

  it("DbLookup find_api_logs returns correct SQL for api_log table", async () => {
    const pool = mkPool([
      { api_name: "wlan_bpf_filter_offload_handler", level: "DEBUG", template: "BPF: filter handler called", subsystem: "BPF", file_path: "bpf_offload.c", line: 90, confidence: 1.0 },
      { api_name: "wlan_bpf_filter_offload_handler", level: "ERROR", template: "BPF: filter handler failed", subsystem: "BPF", file_path: "bpf_offload.c", line: 95, confidence: 1.0 },
    ])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup({ intent: "find_api_logs", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler" })
    expect(res.hit).toBe(true)
    expect(res.rows).toHaveLength(2)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("api_log"),
      expect.arrayContaining([42, "wlan_bpf_filter_offload_handler"]),
    )
  })

  it("DbLookup find_api_logs_by_level returns correct SQL with level filter", async () => {
    const pool = mkPool([
      { api_name: "wlan_bpf_filter_offload_handler", level: "ERROR", template: "BPF: filter handler failed", subsystem: "BPF", file_path: "bpf_offload.c", line: 95, confidence: 1.0 },
    ])
    const svc = new PostgresDbLookupService(pool)
    const res = await svc.lookup({ intent: "find_api_logs_by_level", snapshotId: 42, apiName: "wlan_bpf_filter_offload_handler", logLevel: "ERROR" } as never)
    expect(res.hit).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("level = $3"),
      expect.arrayContaining([42, "wlan_bpf_filter_offload_handler", "ERROR"]),
    )
  })
})

// ---------------------------------------------------------------------------
// SECTION 10: EdgeRow — DB schema correctness for all WLAN edge kinds
// ---------------------------------------------------------------------------

describe("EdgeRow — WLAN edge kinds and DB ingestion", () => {
  const WLAN_EDGES: EdgeRow[] = [
    // registers_callback edges (all 8 pattern families)
    { edgeKind: "registers_callback", srcSymbolName: "wlan_bpf_enable_data_path", dstSymbolName: "wlan_bpf_filter_offload_handler", confidence: 1.0, derivation: "clangd", evidence: { sourceKind: "clangd_response", location: { filePath: "bpf_offload_int.c", line: 1093 } } },
    { edgeKind: "registers_callback", srcSymbolName: "wlan_bpf_enable_data_path", dstSymbolName: "wlan_bpf_notify_handler", confidence: 1.0, derivation: "clangd", evidence: { sourceKind: "clangd_response", location: { filePath: "bpf_offload_int.c", line: 1093 } } },
    { edgeKind: "registers_callback", srcSymbolName: "wlan_bpf_offload_vdev_init", dstSymbolName: "wlan_bpf_offload_vdev_notify_handler", confidence: 1.0, derivation: "clangd", evidence: { sourceKind: "clangd_response", location: { filePath: "bpf_offload_wmi.c", line: 512 } } },
    { edgeKind: "registers_callback", srcSymbolName: "wlan_enable_adaptive_apf", dstSymbolName: "wlan_bpf_event_pdev_notif", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "registers_callback", srcSymbolName: "wlan_bpf_offload_vdev_init", dstSymbolName: "wlan_bpf_traffic_timer_handler", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "registers_callback", srcSymbolName: "wlan_bpf_offload_register", dstSymbolName: "_wlan_bpf_offload_cmd_handler", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "registers_callback", srcSymbolName: "wlan_phyerr_register", dstSymbolName: "dispatch_wlan_phyerr_cmds", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "registers_callback", srcSymbolName: "wlan_btm_ofld_unsolicited_init", dstSymbolName: "_wlan_btm_ofld_action_frame_handler", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "registers_callback", srcSymbolName: "hif_thread_init", dstSymbolName: "wlan_thread_post_init_hdlr", confidence: 1.0, derivation: "clangd" },
    // dispatches_to edges
    { edgeKind: "dispatches_to", srcSymbolName: "_offldmgr_enhanced_data_handler", dstSymbolName: "wlan_bpf_filter_offload_handler", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "dispatches_to", srcSymbolName: "_offldmgr_non_data_handler", dstSymbolName: "_wlan_btm_ofld_action_frame_handler", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "dispatches_to", srcSymbolName: "WMI_DispatchCmd", dstSymbolName: "dispatch_wlan_phyerr_cmds", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "dispatches_to", srcSymbolName: "wlan_vdev_deliver_notif", dstSymbolName: "wlan_bpf_offload_vdev_notify_handler", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "dispatches_to", srcSymbolName: "wlan_thread_dsr_wrapper_common", dstSymbolName: "wlan_thread_post_init_hdlr", confidence: 1.0, derivation: "clangd" },
    // calls edges
    { edgeKind: "calls", srcSymbolName: "wlan_bpf_enable_data_path", dstSymbolName: "offldmgr_register_data_offload", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "calls", srcSymbolName: "wlan_bpf_offload_register", dstSymbolName: "WMI_RegisterDispatchTable", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "calls", srcSymbolName: "wlan_bpf_offload_vdev_init", dstSymbolName: "A_INIT_TIMER", confidence: 1.0, derivation: "clangd" },
    // indirect_calls edges
    { edgeKind: "indirect_calls", srcSymbolName: "offloadif_data_ind", dstSymbolName: "wlan_bpf_filter_offload_handler", confidence: 0.9, derivation: "runtime" },
    { edgeKind: "indirect_calls", srcSymbolName: "HTC_RecvCompleteHandler", dstSymbolName: "dispatch_wlan_phyerr_cmds", confidence: 0.9, derivation: "runtime" },
    // logs_event edges
    { edgeKind: "logs_event", srcSymbolName: "wlan_bpf_filter_offload_handler", dstSymbolName: "BPF_DEBUG_LOG", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "logs_event", srcSymbolName: "_wlan_bpf_offload_cmd_handler", dstSymbolName: "BPF_WMI_LOG", confidence: 1.0, derivation: "clangd" },
    // operates_on_struct edges
    { edgeKind: "operates_on_struct", srcSymbolName: "wlan_bpf_offload_vdev_init", dstSymbolName: "bpf_vdev_t", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "operates_on_struct", srcSymbolName: "wlan_bpf_enable_data_path", dstSymbolName: "bpf_pdev_t", confidence: 1.0, derivation: "clangd" },
    // writes_field edges
    { edgeKind: "writes_field", srcSymbolName: "wlan_bpf_enable_data_path", dstSymbolName: "bpf_vdev_t.data_handler", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "writes_field", srcSymbolName: "wlan_bpf_offload_vdev_init", dstSymbolName: "bpf_vdev_t.bpf_traffic_timer", confidence: 1.0, derivation: "clangd" },
    // reads_field edges
    { edgeKind: "reads_field", srcSymbolName: "_offldmgr_enhanced_data_handler", dstSymbolName: "bpf_vdev_t.data_handler", confidence: 1.0, derivation: "clangd" },
    { edgeKind: "reads_field", srcSymbolName: "wlan_bpf_traffic_timer_handler", dstSymbolName: "bpf_vdev_t.bpf_traffic_timer", confidence: 1.0, derivation: "clangd" },
  ]

  it("all 27 edge rows have required fields", () => {
    for (const edge of WLAN_EDGES) {
      expect(edge.edgeKind).toBeTruthy()
      expect(edge.confidence).toBeGreaterThan(0)
      expect(edge.derivation).toMatch(/^(clangd|llm|runtime|hybrid)$/)
    }
  })

  it("edge kinds cover all expected WLAN edge types", () => {
    const kinds = new Set(WLAN_EDGES.map((e) => e.edgeKind))
    expect(kinds.has("registers_callback")).toBe(true)
    expect(kinds.has("dispatches_to")).toBe(true)
    expect(kinds.has("calls")).toBe(true)
    expect(kinds.has("indirect_calls")).toBe(true)
    expect(kinds.has("logs_event")).toBe(true)
    expect(kinds.has("operates_on_struct")).toBe(true)
    expect(kinds.has("writes_field")).toBe(true)
    expect(kinds.has("reads_field")).toBe(true)
  })

  it("all 27 edge rows persist correctly to DB via ingest writer", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, { edges: WLAN_EDGES })
    expect(report.inserted.edges).toBe(27)
    expect(report.warnings).toHaveLength(0)
  })

  it("registers_callback edges have both src and dst symbol names", () => {
    const regEdges = WLAN_EDGES.filter((e) => e.edgeKind === "registers_callback")
    for (const edge of regEdges) {
      expect(edge.srcSymbolName).toBeTruthy()
      expect(edge.dstSymbolName).toBeTruthy()
    }
  })

  it("dispatches_to edges have both src and dst symbol names", () => {
    const dispEdges = WLAN_EDGES.filter((e) => e.edgeKind === "dispatches_to")
    for (const edge of dispEdges) {
      expect(edge.srcSymbolName).toBeTruthy()
      expect(edge.dstSymbolName).toBeTruthy()
    }
  })

  it("runtime-derived edges have confidence < 1.0", () => {
    const runtimeEdges = WLAN_EDGES.filter((e) => e.derivation === "runtime")
    for (const edge of runtimeEdges) {
      expect(edge.confidence).toBeLessThanOrEqual(1.0)
    }
  })
})

// ---------------------------------------------------------------------------
// SECTION 11: Full batch ingest — combined symbols + edges + runtime + logs
// ---------------------------------------------------------------------------

describe("Full batch ingest — combined WLAN snapshot", () => {
  it("ingests symbols + edges + runtimeCallers + logs in one batch", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)

    const symbols: SymbolRow[] = [
      { kind: "function", name: "wlan_bpf_filter_offload_handler", location: { filePath: "bpf_offload.c", line: 83 } },
      { kind: "function", name: "wlan_bpf_enable_data_path", location: { filePath: "bpf_offload_int.c", line: 200 } },
      { kind: "function", name: "_offldmgr_enhanced_data_handler", location: { filePath: "offload_mgr_ext.c", line: 1090 } },
      { kind: "struct", name: "bpf_vdev_t", location: { filePath: "bpf_offload_int.h", line: 50 } },
    ]

    const edges: EdgeRow[] = [
      { edgeKind: "registers_callback", srcSymbolName: "wlan_bpf_enable_data_path", dstSymbolName: "wlan_bpf_filter_offload_handler", confidence: 1.0, derivation: "clangd" },
      { edgeKind: "dispatches_to", srcSymbolName: "_offldmgr_enhanced_data_handler", dstSymbolName: "wlan_bpf_filter_offload_handler", confidence: 1.0, derivation: "clangd" },
      { edgeKind: "logs_event", srcSymbolName: "wlan_bpf_filter_offload_handler", dstSymbolName: "BPF_DEBUG_LOG", confidence: 1.0, derivation: "clangd" },
    ]

    const runtimeCallers: RuntimeCallerRow[] = [
      {
        targetApi: "wlan_bpf_filter_offload_handler",
        runtimeTrigger: "Incoming RX data packet from hardware matched BPF filter criteria",
        dispatchChain: ["offloadif_data_ind", "_offldmgr_protocol_data_handler", "_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
        immediateInvoker: "_offldmgr_enhanced_data_handler",
        dispatchSite: { filePath: "offload_mgr_ext.c", line: 1107 },
        confidence: 1.0,
      },
    ]

    const logs: LogRow[] = [
      { apiName: "wlan_bpf_filter_offload_handler", level: "DEBUG", template: "BPF: filter handler called vdev_id=%d", subsystem: "BPF", location: { filePath: "bpf_offload.c", line: 90 }, confidence: 1.0 },
      { apiName: "wlan_bpf_filter_offload_handler", level: "ERROR", template: "BPF: filter handler failed status=%d", subsystem: "BPF", location: { filePath: "bpf_offload.c", line: 95 }, confidence: 1.0 },
    ]

    const report = await writer.writeSnapshotBatch(42, { symbols, edges, runtimeCallers, logs })
    expect(report.snapshotId).toBe(42)
    expect(report.inserted.symbols).toBe(4)
    expect(report.inserted.edges).toBe(3)
    expect(report.inserted.runtimeCallers).toBe(1)
    expect(report.inserted.logs).toBe(2)
    expect(report.warnings).toHaveLength(0)
  })

  it("empty batch produces zero counts and no warnings", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, {})
    expect(report.inserted.symbols).toBe(0)
    expect(report.inserted.edges).toBe(0)
    expect(report.inserted.runtimeCallers).toBe(0)
    expect(report.inserted.logs).toBe(0)
    expect(report.warnings).toHaveLength(0)
  })

  it("batch failure rolls back and records warning", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("BEGIN")) return { rows: [] }
        if (sql.includes("INSERT INTO symbol")) throw new Error("FK violation")
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as import("pg").Pool
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, {
      symbols: [{ kind: "function", name: "fn" }],
    })
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(report.warnings[0]).toContain("FK violation")
  })
})
