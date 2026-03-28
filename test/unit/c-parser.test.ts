import { describe, it, expect, beforeAll } from "vitest"
import {
  initParser,
  isParserReady,
  findEnclosingCall,
  findEnclosingConstruct,
  splitArguments,
  findEnclosingOpenParen,
} from "../../src/tools/pattern-detector/c-parser.js"

beforeAll(async () => {
  await initParser()
})

// ── initParser ──────────────────────────────────────────────────────────────

describe("initParser", () => {
  it("initializes successfully", () => {
    expect(isParserReady()).toBe(true)
  })
})

// ── splitArguments (direct) ──────────────────────────────────────────────────

describe("splitArguments", () => {
  it("splits simple comma-separated args", () => {
    const args = splitArguments("a, b, c")
    expect(args).toEqual(["a", " b", " c"])
  })

  it("splits nested parens correctly", () => {
    const text = 'A_INUM_WSI, cmnos_thread_find("WLAN_HIF"), SIG_ID'
    const args = splitArguments(text)
    expect(args).toHaveLength(3)
    expect(args[0]).toBe("A_INUM_WSI")
    expect(args[2]).toBe(" SIG_ID")
  })

  it("splits string with parens correctly", () => {
    const text = '"hello (world)", arg2'
    const args = splitArguments(text)
    expect(args).toHaveLength(2)
  })

  it("handles double-quoted strings", () => {
    const args = splitArguments('"hello, world", arg2')
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('"hello, world"')
    expect(args[1]).toBe(" arg2")
  })
})

// ── findEnclosingCall ────────────────────────────────────────────────────────

describe("findEnclosingCall", () => {
  it("finds single-line function call", () => {
    const source = "int x = my_func(a, b, c);\n"
    const call = findEnclosingCall(source, 0, 19) // position of 'b'
    expect(call).not.toBeNull()
    expect(call!.name).toBe("my_func")
    expect(call!.args).toEqual(["a", "b", "c"])
  })

  it("finds multi-line function call", () => {
    const source = [
      "offldmgr_register_data_offload(DATA_FILTER_OFFLOAD,",
      "    OFFLOAD_BPF,",
      "    wlan_bpf_filter_offload_handler,",
      "    ctx, NULL, &pkt_type);",
    ].join("\n")

    const call = findEnclosingCall(source, 2, 4)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("offldmgr_register_data_offload")
    expect(call!.args).toHaveLength(6)
    expect(call!.args[0]).toBe("DATA_FILTER_OFFLOAD")
    expect(call!.args[1].trim()).toBe("OFFLOAD_BPF")
    expect(call!.args[2]).toBe("wlan_bpf_filter_offload_handler")
    expect(call!.args[3]).toBe("ctx")
  })

  it("handles nested parens in args", () => {
    const source = "cmnos_irq_register(A_INUM_WSI, cmnos_thread_find(x), SIG_ID);\n"
    const call = findEnclosingCall(source, 0, 54) // position of 'I' in SIG_ID
    expect(call).not.toBeNull()
    expect(call!.name).toBe("cmnos_irq_register")
    expect(call!.args).toEqual(["A_INUM_WSI", "cmnos_thread_find(x)", "SIG_ID"])
  })

  it("handles call spanning 5+ lines", () => {
    const source = [
      "wlan_thread_register_signal_wrapper(",
      "    thread_ctxt,",
      "    WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR,",
      "    wal_tqm_hipri_status_intr_sig_hdlr,",
      "    me,",
      "    tqm_thread_dsr_wrapper);",
    ].join("\n")

    const call = findEnclosingCall(source, 3, 4)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wlan_thread_register_signal_wrapper")
    expect(call!.args).toHaveLength(5)
    expect(call!.args[2]).toBe("wal_tqm_hipri_status_intr_sig_hdlr")
  })

  it("handles call with string containing parens", () => {
    const source = 'my_func("hello (world)", arg2);\n'
    const call = findEnclosingCall(source, 0, 23)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("my_func")
    expect(call!.args).toHaveLength(2)
  })

  it("handles macro invocation", () => {
    const source = "A_REGISTER_CRASH_CB(my_crash_handler, ctx);\n"
    const call = findEnclosingCall(source, 0, 22)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("A_REGISTER_CRASH_CB")
    expect(call!.args).toHaveLength(2)
  })

  it("handles real WLAN registration call", () => {
    const source = [
      "    wmi_unified_register_event_handler(&wls_fw_wmi_instance,",
      "                                       WMI_LPI_RESULT_EVENTID,",
      "                                       wls_fw_scan_result_handler);",
    ].join("\n")

    const call = findEnclosingCall(source, 2, 39)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wmi_unified_register_event_handler")
    expect(call!.args).toHaveLength(3)
    expect(call!.args[1].trim()).toBe("WMI_LPI_RESULT_EVENTID")
    expect(call!.args[2]).toBe("wls_fw_scan_result_handler")
  })

  it("handles cmnos_irq_register_dynamic", () => {
    const source = "    cmnos_irq_register_dynamic(A_INUM_WSI, wsi_high_prio_irq_route);\n"
    const call = findEnclosingCall(source, 0, 50)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("cmnos_irq_register_dynamic")
    expect(call!.args).toHaveLength(2)
    expect(call!.args[1]).toBe("wsi_high_prio_irq_route")
  })

  it("handles thread msg handler registration", () => {
    const source =
      "    wlan_thread_msg_handler_register_dval_dptr1_dptr2(WLAN_THREAD_COMM_FUNC_TQM_NOTIFY, wal_tqm_sync_notify_hdlr, NULL);\n"
    const call = findEnclosingCall(source, 0, 95)
    expect(call).not.toBeNull()
    expect(call!.name).toBe("wlan_thread_msg_handler_register_dval_dptr1_dptr2")
    expect(call!.args).toHaveLength(3)
    expect(call!.args[1]).toBe("wal_tqm_sync_notify_hdlr")
  })

  it("returns null when not in a call", () => {
    const source = "int x = 42;\n"
    const call = findEnclosingCall(source, 0, 8)
    expect(call).toBeNull()
  })
})

// ── findEnclosingConstruct ───────────────────────────────────────────────────

describe("findEnclosingConstruct", () => {
  it("finds initializer_list for struct array", () => {
    const source = [
      "WMI_DISPATCH_ENTRY entries[] = {",
      "    {handler, WMI_D0_WOW_ENABLE_DISABLE_CMDID, 0}",
      "};",
    ].join("\n")

    const result = findEnclosingConstruct(source, 1, 6)
    expect(result).not.toBeNull()
  })

  it("finds multi-entry WMI dispatch table", () => {
    const source = [
      "WMI_DISPATCH_ENTRY wow_dispatch_entries[] = {",
      "    {_wow_wmi_cmd_handler, WMI_WOW_ENABLE_DISABLE_WAKE_EVENT_CMDID, 0},",
      "    {_wow_wmi_cmd_handler, WMI_WOW_HOSTWAKEUP_FROM_SLEEP_CMDID, 0},",
      "    {_wow_wmi_cmd_handler, WMI_WOW_ENABLE_CMDID, 0},",
      "};",
    ].join("\n")

    const result = findEnclosingConstruct(source, 1, 6)
    expect(result).not.toBeNull()
  })
})
