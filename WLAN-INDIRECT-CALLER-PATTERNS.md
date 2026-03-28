# WLAN Indirect Caller Pattern Spec

Source-verified specification for programmatic (no-LLM) indirect caller detection.
Each pattern is a self-contained task: detector → resolver → store → render.

Workspace: `/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/`

---

## Pattern 1: WMI Event Handler Registry (event_id-keyed parallel arrays)

**Registration API:** `wmi_unified_register_event_handler(wmi_handle, event_id, handler_func)`

**Storage:** `struct wmi_unified` — parallel arrays `event_id[256]` + `event_handler[256]`

**Registration write** (`wmi_unified.c:177-178`):
```c
wmi_handle->event_handler[idx] = handler_func;
wmi_handle->event_id[idx] = event_id;
```

**Dispatch site** (`wmi_unified.c:252-263`):
```c
idx = wmi_unified_get_event_handler_ix(wmi_handle, id);
wmi_handle->event_handler[idx](0, wmi_cmd_struct_ptr, len);
```

**Dispatch gating:** event_id match + null check

**Registration example** (`wls_fw.c:2935`):
```c
wmi_unified_register_event_handler(&wls_fw_wmi_instance,
                                   WMI_LPI_RESULT_EVENTID,
                                   wls_fw_scan_result_handler);
```

**Metadata:** `WMI_EVT_ID` (e.g., `WMI_LPI_RESULT_EVENTID`)

**Detection cues:** `grep wmi_unified_register_event_handler`, `grep event_handler[idx]`

**Files:**
- Struct: `wlssvr/src/wmi/src/wmi_unified_priv.h:52-57`
- Registration: `wlssvr/src/wls/core/wls_fw.c:2933-2954`
- Dispatch: `wlssvr/src/wmi/src/wmi_unified.c:160-264`

**Implementation steps:**
1. LSP: `references` on target callback fn → find all reference sites
2. Parse: for each reference site, read enclosing line → check for `wmi_unified_register_event_handler` call
3. Extract: event_id argument (2nd positional arg)
4. Store: `calledBy` with `connectionKind: 'event'`, `viaRegistrationApi: 'wmi_unified_register_event_handler'`

---

## Pattern 2: WMI Command Dispatch Table (linked list of dispatch tables)

**Registration API:** `WMI_RegisterDispatchTable(&table)`

**Storage:** Singly-linked list of `WMI_DISPATCH_TABLE` off `g_pWMI->pDispatchHead`

**Struct** (`wmi_svc_api.h:137-158`):
```c
typedef struct _WMI_DISPATCH_ENTRY {
    WMI_CMD_HANDLER pCmdHandler;  // function pointer
    A_UINT32        CmdID;        // WMI command ID key
    A_UINT16        CheckLength;
} WMI_DISPATCH_ENTRY;

typedef struct _WMI_DISPATCH_TABLE {
    struct _WMI_DISPATCH_TABLE *pNext;
    A_UINT32 minCmd, maxCmd;
    int NumberOfEntries;
    WMI_DISPATCH_ENTRY *pTable;
} WMI_DISPATCH_TABLE;
```

**Registration** (`wlan_d0wow.c:293-304`):
```c
WMI_DISPATCH_ENTRY d0wow_dispatch_entries[] = {
    {_d0wow_wmi_cmd_handler, WMI_D0_WOW_ENABLE_DISABLE_CMDID, 0}
};
static WMI_DECLARE_DISPATCH_TABLE(d0wow_dispatch_table, d0wow_dispatch_entries);
WMI_RegisterDispatchTable(&d0wow_dispatch_table);
```

**Dispatch** (`wmi_svc.c:633-670`):
```c
pCurrentTable = g_pWMI->pDispatchHead;
while (pCurrentTable != NULL) {
    for (i = 0; i < pCurrentTable->NumberOfEntries; i++, pCurrentEntry++) {
        if (pCurrentEntry->CmdID == cmd) {
            pCmdHandler = pCurrentEntry->pCmdHandler;
        }
    }
    pCurrentTable = pCurrentTable->pNext;
}
```

**Detection cues:** `grep WMI_RegisterDispatchTable`, `grep WMI_DISPATCH_ENTRY`, `grep WMI_DECLARE_DISPATCH_TABLE`

**Concrete examples:**
```c
// Single entry (wlan_d0wow.c:293)
WMI_DISPATCH_ENTRY d0wow_dispatch_entries[] = {
    {_d0wow_wmi_cmd_handler, WMI_D0_WOW_ENABLE_DISABLE_CMDID, 0}
};

// Multi-entry (wlan_nan.c:731)
WMI_DISPATCH_ENTRY wlan_nan_dispatch_entries[] = {
    { NAN_WmiCmdHdlr, WMI_NAN_CMDID , 0 },
    { NAN_WmiCmdHdlr, WMI_NDI_GET_CAP_REQ_CMDID , 0 },
    { NAN_WmiCmdHdlr, WMI_NDP_INITIATOR_REQ_CMDID , 0 },
};

// Different callbacks per CMDID (wlan_tdls.c:825)
WMI_DISPATCH_ENTRY wlan_tdls_wmi_dispatch_entries[] = {
    { wlan_tdls_wmi_set_state_cmd, WMI_TDLS_SET_STATE_CMDID, 0 },
    { wlan_tdls_wmi_peer_update_cmd, WMI_TDLS_PEER_UPDATE_CMDID, 0 },
};
```

**Regex:** Match callback fn in struct initializer:
```
\{\s*(\w+)\s*,\s*(WMI_\w+)\s*,\s*(\d+)\s*\}
```
Extract: `callback_fn`, `cmdid`, `check_length`

**Implementation steps:**
1. LSP: `references` on target callback → find reference sites
2. Read: enclosing line(s) → check for `WMI_DISPATCH_ENTRY` context
3. Regex: match `\{\s*callback_name\s*,\s*(WMI_\w+)\s*` → extract `CmdID`
4. Store: `calledBy` with `connectionKind: 'api_call'`, `viaRegistrationApi: 'WMI_RegisterDispatchTable'`

---

## Pattern 3: Offload Manager Non-Data Handler (name-indexed, frame-type gated)

**Registration API:** `offldmgr_register_nondata_offload(type, name, handler, context, frm_types_flg)`
Macro: `#define offldmgr_register_nondata_offload(...)` → `_offldmgr_register_nondata_offload(...)`

**Storage:** `OFFLOAD_NONDATA_CTXT_T.offload_nondata[name]` indexed by `OFFLOAD_NONDATA_NAME` enum

**Registration write** (`offload_mgr_ext.c:193-196`):
```c
p_offld_non_data_ctxt->offload_nondata[name].non_data_handler = non_data_handler;
p_offld_non_data_ctxt->offload_nondata[name].context = context;
p_offld_non_data_ctxt->offload_nondata[name].frm_type_flag = frm_types_flg;
```

**Dispatch** (`offload_mgr_ext.c:1720-1750`):
```c
for (i = 0; i < OFFLOAD_WOW_MGMT; i++) {
    if ((p_offld_non_data_ctxt->offload_nondata[i].non_data_handler) &&
        (p_offld_non_data_ctxt->offload_nondata[i].frm_type_flag & frame_type)) {
        sub_status = p_offld_non_data_ctxt->offload_nondata[i].non_data_handler(
            p_offld_non_data_ctxt->offload_nondata[i].context, peer, rxbuf);
    }
}
```

**Detection cues:** `grep offldmgr_register_nondata_offload`, `grep offload_nondata[.*].non_data_handler`

**Implementation steps:**
1. LSP: `references` on target callback
2. Parse: check enclosing line for `offldmgr_register_nondata_offload` call
3. Extract: `name` argument (3rd positional, enum like `OFFLOAD_LPI_SCAN`)
4. Store: `calledBy` with `connectionKind: 'api_call'`, `viaRegistrationApi: 'offldmgr_register_nondata_offload'`

---

## Pattern 4: Offload Manager Data Handler (name-indexed, vdev+proto+addr gated)

**Registration API:** `offldmgr_register_data_offload(type, name, data_handler, context, notif_handler, data_pkt_type)`
Macro: `#define offldmgr_register_data_offload(...)` → `_offldmgr_register_data_offload(...)`

**Storage:** `OFFLOADMGR_CONTEXT.offload_data[name]` indexed by `OFFLOAD_DATA_NAME` enum

**Registration write** (`offload_mgr_ext.c:221-226`):
```c
p_offldmgr_ctxt->offload_data[name].data_handler = data_handler;
p_offldmgr_ctxt->offload_data[name].vdev_bitmap |= 1<<data_pkt_type->vdev_id;
```

**Dispatch** (`offload_mgr_ext.c:1079-1100`):
```c
if ((p_offldmgr_ctxt->offload_data[i].data_handler != NULL)
    && (p_offldmgr_ctxt->offload_data[i].vdev_bitmap & (1<<vdev_id))
    && (p_offldmgr_ctxt->offload_data[i].data_pkt_type.proto_type & data_type)
    && (p_offldmgr_ctxt->offload_data[i].data_pkt_type.addr_type & addr_type))
{
    status = p_offldmgr_ctxt->offload_data[i].data_handler(
        p_offldmgr_ctxt->offload_data[i].context, vdev_id, peer_id, tid, buf, len, pAttr);
}
```

**Detection cues:** `grep offldmgr_register_data_offload`, `grep offload_data[.*].data_handler`

**Implementation steps:**
1. LSP: `references` on target callback
2. Parse: check enclosing line for `offldmgr_register_data_offload` call
3. Extract: `name` argument (3rd positional, enum like `DATA_FILTER_OFFLOAD`)
4. Store: `calledBy` with `connectionKind: 'api_call'`, `viaRegistrationApi: 'offldmgr_register_data_offload'`

---

## Pattern 5a: IRQ-to-Signal Bridge (signal-based)

**Registration API:** `cmnos_irq_register(irq_id, thread, signal_id)`

**Storage:** `g_cmnos_thread_info.irqs[irq].{hub, signal_id}`

**Registration write** (`cmnos_thread.c:1922-1934`):
```c
g_cmnos_thread_info.irqs[interrupt_id].hub       = thread->p_signal_hub;
g_cmnos_thread_info.irqs[interrupt_id].signal_id = signal_id;
```

**Dispatch** (`cmnos_thread.c:2051-2054`):
```c
QURT_SIGNAL_SET(g_cmnos_thread_info.irqs[irq_num].hub,
                CMNOS_SIGNAL_BIT_SHIFT_LEFT(g_cmnos_thread_info.irqs[irq_num].signal_id));
```

**Detection cues:** `grep cmnos_irq_register`, `grep QURT_SIGNAL_SET`

**Key insight:** This is a 2-stage pattern requiring TWO API calls correlated by `signal_id`:
1. `cmnos_irq_register(irq_id, thread, signal_id)` — maps IRQ → signal
2. `wlan_thread_register_signal_wrapper(thread_ctxt, signal_id, callback_fn, ctxt, wrapper)` — maps signal → callback

**Concrete chain example (TQM):**
```c
// Step 1: IRQ registration (tqm_thread.c:310)
cmnos_irq_register(A_INUM_TQM_STATUS_HI, me, WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR);

// Step 2: Signal handler registration (tqm_thread.c:222)
wlan_thread_register_signal_wrapper(thread_ctxt,
    WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR,
    wal_tqm_hipri_status_intr_sig_hdlr, me, tqm_thread_dsr_wrapper);
```

**Regex for Step 1:**
```
cmnos_irq_register\(\s*(A_INUM_\w+)\s*,\s*\w+\s*,\s*(WLAN_THREAD_SIG_\w+)\s*\)
```
Extract: `irq_id`, `signal_id`

**Regex for Step 2:**
```
wlan_thread_register_signal_wrapper\(\s*\w+\s*,\s*(WLAN_THREAD_SIG_\w+)\s*,\s*(\w+)\s*,
```
Extract: `signal_id`, `callback_fn`

**Implementation steps:**
1. Scan file for `cmnos_irq_register` → build `signal_id → irq_id` map
2. Scan file for `wlan_thread_register_signal_wrapper` → build `signal_id → callback_fn` map
3. For each target callback, look up its `signal_id` in signal→callback map, then look up `irq_id` in signal→irq map
4. Store: `systemNode` with `kind: 'hw_interrupt'`, `connectionKind: 'hw_interrupt'`

---

## Pattern 5b: IRQ-to-Signal Bridge (dynamic callback)

**Registration API:** `cmnos_irq_register_dynamic(irq_id, irq_route_cb)`

**Storage:** `g_cmnos_thread_info.irqs[irq].irq_route_cb`

**Registration write** (`cmnos_thread.c:1977`):
```c
g_cmnos_thread_info.irqs[interrupt_id].irq_route_cb = irq_route_cb;
```

**Dispatch** (`cmnos_thread.c:2049`):
```c
g_cmnos_thread_info.irqs[irq_num].irq_route_cb(irq_num);
```

**Detection cues:** `grep cmnos_irq_register_dynamic`

**Concrete examples:**
```c
// WSI (wsi_thread.c:51)
cmnos_irq_register_dynamic(A_INUM_WSI, wsi_high_prio_irq_route);

// HIF thread — multiple IRQs, shared callback (hif_thread.c:518)
cmnos_irq_register_dynamic(A_INUM_WMAC0_H2S_GRANT, wlan_thread_irq_sr_wakeup);
cmnos_irq_register_dynamic(A_INUM_PCIE_WAKE, pcie_soc_wrap_int_handler);

// Platform errors (cmnos_intr_ext.c:272)
cmnos_irq_register_dynamic(A_INUM_PCIE_ACMT, platform_acmt_int_handler);
cmnos_irq_register_dynamic(A_INUM_BM_ERR_INTR_GLOBAL, plat_bus_err_interrupt_handle);
```

**Regex:** Direct — callback is 2nd argument:
```
cmnos_irq_register_dynamic\(\s*(A_INUM_\w+)\s*,\s*(\w+)\s*\)
```
Extract: `irq_id`, `callback_fn`

**Implementation steps:**
1. LSP: `references` on target callback
2. Regex: match enclosing line for `cmnos_irq_register_dynamic(A_INUM_*, callback_name)`
3. Extract: `irq_id`
4. Store: `calledBy` with `connectionKind: 'hw_interrupt'`, `viaRegistrationApi: 'cmnos_irq_register_dynamic'`

---

## Pattern 6: Signal Handler Array Dispatch (thread event loop)

**Registration:** Static `CMNOS_THREAD_SIG_HANDLER_T signals[]` arrays in thread init

**Storage:** Per-thread `signals[]` with `sig_handler` + `sig_handler_ctxt`

**Dispatch** (`cmnos_thread.c:2185-2203`):
```c
if ((active_signals & (me->signal_mask)) & CMNOS_SIGNAL_BIT_SHIFT_LEFT(signal_id)) {
    next = signals[j].sig_handler(signals[j].sig_handler_ctxt);
}
```

**Detection cues:** `grep CMNOS_THREAD_SIG_HANDLER_T`, `grep wlan_thread_register_signal`

**Key insight:** Arrays are NOT statically initialized. They're populated IMPERATIVELY via `wlan_thread_register_signal()` / `wlan_thread_register_signal_wrapper()`. This makes detection easier — just grep for the registration calls.

**Concrete examples:**
```c
// TQM thread (tqm_thread.c:89)
wlan_thread_register_signal_wrapper(thread_ctxt, WLAN_THREAD_POST_INIT,
    wlan_thread_post_init_hdlr, NULL, tqm_thread_dsr_wrapper);

wlan_thread_register_signal_wrapper(thread_ctxt, WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR,
    wal_tqm_hipri_status_intr_sig_hdlr, me, tqm_thread_dsr_wrapper);

wlan_thread_register_signal(thread_ctxt, WLAN_TQM_SIG_SCH2TQM_TRIGGER,
    wal_tqm_sch2tqm_sig_hdlr, tqm_thread_dsr_wrapper);

// HIF thread (hif_thread.c:316)
wlan_thread_register_signal(thread_ctxt, WLAN_THREAD_SIG_PROCESS_CE_LOW_PRIO_TQM_RING_ELEMENTS,
    htt_ce_tqm_low_prio_ring_sig_handler, 0);
```

**Regex:** Match registration calls:
```
wlan_thread_register_signal(?:_wrapper)?\(\s*\w+\s*,\s*(\w+)\s*,\s*(\w+)\s*,
```
Extract: `signal_id`, `callback_fn`

**Implementation steps:**
1. LSP: `references` on target callback
2. Regex: match enclosing line for `wlan_thread_register_signal[_wrapper](thread, signal_id, callback_name, ...)`
3. Extract: `signal_id`
4. Store: `calledBy` with `connectionKind: 'event'`, `viaRegistrationApi: 'wlan_thread_register_signal'`

---

## Pattern 7: Thread Message Handler Registry (func_id-keyed array)

**Registration APIs:** `wlan_thread_msg_handler_register_dval_dptr1_dptr2(func_id, cb, ctxt)`
`wlan_thread_msg_handler_register_var_len_buf(func_id, cb, ctxt)`

**Storage:** `g_msg_handlers[func_id].cb_func.{dval_dptr1_dptr2, var_len_buf}`

**Registration write** (`wlan_thread.c:457`):
```c
g_msg_handlers[func_id].cb_func.dval_dptr1_dptr2 = cb_func;
g_msg_handlers[func_id].cb_ctxt = cb_ctxt;
```

**Dispatch** (`cmnos_thread.c:2860-2876`):
```c
thread->msg_queue.handler_table[func_id].cb_func.dval_dptr1_dptr2(
    thread->msg_queue.handler_table[func_id].cb_ctxt,
    data_value, data_ptr1, data_ptr2);
```

**Detection cues:** `grep wlan_thread_msg_handler_register_`, `grep handler_table[.*].cb_func`

**Implementation steps:**
1. LSP: `references` on target callback
2. Parse: check enclosing line for `wlan_thread_msg_handler_register_*` call
3. Extract: `func_id` (1st positional arg, enum like `WLAN_THREAD_COMM_FUNC_TQM_NOTIFY`)
4. Store: `calledBy` with `connectionKind: 'api_call'`, `viaRegistrationApi: 'wlan_thread_msg_handler_register'`

---

## Pattern 8: HTC Service Callback Struct (ops/vtable style)

**Registration:** Field assignment on `HTC_SERVICE` struct + `HTC_RegisterService(&svc)`

**Storage:** `HTC_SERVICE.ProcessRecvMsg`, `.ProcessSendBufferComplete`, `.ExProcessRecvMsg`

**Dispatch** (`htc.c:2159-2177`):
```c
if (pEndpoint->pService->ExProcessRecvMsg) {
    pEndpoint->pService->ExProcessRecvMsg(pEndpoint->pService, eid, HTCBuffers[i]);
} else if (pEndpoint->pService->ProcessRecvMsg != NULL) {
    pEndpoint->pService->ProcessRecvMsg(pEndpoint->Eid, HTCBuffers[i]);
}
```

**Detection cues:** `grep ->ProcessRecvMsg(`, `grep HTC_RegisterService`

**Implementation steps:**
1. LSP: `references` on target callback
2. Parse: check if enclosing context is `HTC_SERVICE` struct initializer or field assignment
3. Extract: field name (`ProcessRecvMsg`, `ExProcessRecvMsg`, etc.)
4. Store: `calledBy` with `connectionKind: 'api_call'`, `viaRegistrationApi: 'HTC_RegisterService'`

---

## Pattern 9: WLIF Callback Registration (context struct field assignment)

**Registration API:** `wlif_register_callback(rx_notify_cb, tx_done_cb)`

**Storage:** `g_wlif_ctxt->wlif_node[node].rx_notify` and `.tx_done`

**Registration write** (`wls_wlif.c:203-204`):
```c
WLIF_RX_NOTIFY_CB(WLIF_NODE_WLS) = rx_notify_callback;
WLIF_TX_DONE_CB(WLIF_NODE_WLS)   = tx_done_callback;
```

**Dispatch** (`wls_wlif.c:321`):
```c
WLIF_RX_NOTIFY_CB(WLIF_NODE_WLS)(bufQueued, len);
```

**Detection cues:** `grep wlif_register_callback`, `grep WLIF_RX_NOTIFY_CB(`

**Implementation steps:**
1. LSP: `references` on target callback
2. Parse: check enclosing line for `wlif_register_callback` or `WLIF_*_CB` assignment
3. Extract: callback type (rx_notify vs tx_done)
4. Store: `calledBy` with `connectionKind: 'api_call'`, `viaRegistrationApi: 'wlif_register_callback'`

---

## Pattern 10: Macro-Mediated Registration Aliases

**Definition** (`offload_mgr.h:617-621`):
```c
#define offldmgr_register_nondata_offload(type, name, handler, context, flg) \
    OFFLDMGR_FN(_offldmgr_register_nondata_offload((type), (name), (handler), (context), (flg)))

#define offldmgr_register_data_offload(type, name, data_handler, context, notif_handler, data_pkt_type) \
    OFFLDMGR_FN(_offldmgr_register_data_offload((type), (name), (data_handler), (context), (notif_handler), (data_pkt_type)))
```

**Implication:** Analyzer must expand macros before classifying Patterns 3/4.

**Implementation steps:**
1. LSP: `definition` on macro → get expanded form
2. Normalize: replace macro names with underlying `_offldmgr_register_*` functions
3. Continue with Pattern 3/4 detection on the normalized name

---

## Implementation Order (verifiable, incremental)

| # | Pattern | Difficulty | Sites | Regex complexity | Priority |
|---|---------|-----------|-------|-----------------|----------|
| 4 | Offload data | Easy | 40+ | 1 regex: fn in registration call | **P1** |
| 3 | Offload non-data | Easy | 48+ | 1 regex: fn in registration call | **P1** |
| 9 | WLIF callback | Easy | 2 | 1 regex: fn in registration call | **P1** |
| 5b | IRQ dynamic | Easy | 30+ | 1 regex: `cmnos_irq_register_dynamic(A_INUM_*, fn)` | **P1** — direct, no indirection |
| 7 | Thread msg handler | Easy | 400+ | 1 regex: `wlan_thread_msg_handler_register_*(id, fn, ...)` | **P1** — direct, no indirection |
| 1 | WMI event handler | Medium | 5 | 1 regex: `wmi_unified_register_event_handler(wmi, id, fn)` | **P2** |
| 2 | WMI dispatch table | Medium | 80+ | 1 regex: `{fn, WMI_CMDID, 0}` in struct initializer | **P2** — struct init parsing |
| 8 | HTC service | Medium | ~7 | Field assignment: `svc.field = fn` | **P2** |
| 5a | IRQ signal bridge | Hard | 141 | 2 regexes + correlation by signal_id | **P3** — 2-stage mediation |
| 6 | Signal handler | Easy | per-thread | 1 regex: `wlan_thread_register_signal[_wrapper](thread, sig_id, fn, ...)` | **P1** — imperative, not static |

---

## Atomic Pattern Abstraction

Every pattern is a **lookup table** — the only difference is the data structure and key:

| Pattern | Storage structure | Lookup key | Lookup method |
|---------|------------------|------------|---------------|
| 4. Offload data | Fixed-size array | `OFFLOAD_DATA_NAME` enum | `array[name]` |
| 3. Offload non-data | Fixed-size array | `OFFLOAD_NONDATA_NAME` enum | `array[name]` |
| 1. WMI event handler | Parallel arrays | `WMI_EVT_ID` | linear scan for `event_id[idx] == id` |
| 2. WMI dispatch table | Linked list of arrays | `CmdID` | list walk + array scan for `CmdID == cmd` |
| 5a. IRQ signal bridge | `irqs[irq].{hub, signal_id}` | `IRQ_NUM` | `irqs[irq]` → signal → thread → handler |
| 5b. IRQ dynamic | `irqs[irq].irq_route_cb` | `IRQ_NUM` | `irqs[irq].irq_route_cb(irq_num)` |
| 7. Thread msg handler | Global array `g_msg_handlers[]` | `func_id` | `g_msg_handlers[func_id]` |
| 8. HTC service | Linked list of structs | `ServiceID` | list walk for service match |
| 6. Signal handler | Per-thread `signals[]` array | `signal_id` | linear scan for `signal_id` match |
| 9. WLIF callback | Context struct field | `node_id` | `wlif_node[node].field` |

### Detection algorithm (universal)

For ALL patterns, the detection algorithm is:

1. **LSP `references`** on target callback fn → find all sites where fn is used
2. **Source line read** at each reference site → get the enclosing statement
3. **Pattern match** on the enclosing statement → identify registration API + extract key
4. **Store** as `calledBy` with `connectionKind` + `viaRegistrationApi` + key metadata

The smallest reusable unit is: **given a function reference site, classify which registration pattern it belongs to and extract the dispatch key.**

---

## Correlation Rules (registration → invoker, all deterministic)

### Rule 1: File-to-Thread mapping

Every thread file uses a deterministic thread handle. The mapping:

| File | Thread name | Thread enum |
|------|-------------|-------------|
| `tqm_thread.c` | `"WLAN_TQM"` | `WLAN_THREAD_TQM` |
| `rt_thread.c` | `"WLAN RT0"` | `WLAN_THREAD_RT0` |
| `hif_thread.c` | `"WLAN_HIF"` | `WLAN_THREAD_HIF` |
| `txde_thread.c` | `"WLAN_UMAC_TX"` | `WLAN_THREAD_TX_DE` |
| `tx_compl_thread.c` | (per-MAC) | `WLAN_THREAD_TX_COMPL_*` |
| `be_thread.c` | `"WLAN_BE"` | `WLAN_THREAD_BE` |

**Rule:** `file_name` → `WLAN_THREAD_<NAME>` is deterministic. Every `cmnos_irq_register(irq, me, sig_id)` and `wlan_thread_register_signal_wrapper(thread_ctxt, sig_id, fn, ...)` call is in a file whose thread is known.

### Rule 2: IRQ-to-Thread correlation (Pattern 5a)

The `me` parameter in `cmnos_irq_register(irq, me, sig_id)` is always:
- `cmnos_thread_find("WLAN_<THREAD>")` — explicit thread name string
- `cmnos_this_thread()` — only in `rt_thread.c` for RT0

**Rule:** Given an IRQ registration call, the thread is determined by the file it's in. The signal_id connects to the handler registered via `wlan_thread_register_signal_wrapper(thread_ctxt, sig_id, fn)` in the SAME file.

### Rule 3: Signal-to-Handler correlation (Pattern 6)

The `thread_ctxt` in `wlan_thread_register_signal_wrapper(thread_ctxt, sig_id, fn, ctxt, wrapper)` is always:
- `CNSS_THREAD_CTXT(WLAN_THREAD_<THREAD>)` — deterministic from file

**Rule:** The signal_id in `cmnos_irq_register(irq, me, sig_id)` matches the signal_id in `wlan_thread_register_signal_wrapper(thread_ctxt, sig_id, fn, ...)` in the SAME thread file. Both are in the same file. Match by signal_id.

### Rule 4: WMI CMDID resolution (Pattern 2)

`WMI_*_CMDID` constants are defined as `#define` in `fwcommon/fw_interface/include/wmi_unified.h`. The thread routing is determined by the `ctrl` field in `WMI_DISPATCH_TABLE`:
- `WMI_DISPATCH_TABLE_HANDLE_IN_RT` → RT thread
- `WMI_DISPATCH_TABLE_HANDLE_IN_BE` → BE thread
- `WMI_DISPATCH_TABLE_HANDLE_IN_DATA_OFFLOAD` → data offload thread

### Rule 5: Macro expansion (Pattern 10)

All macro-wrapped registration APIs expand to known functions:
- `offldmgr_register_data_offload(...)` → `_offldmgr_register_data_offload(...)`
- `offldmgr_register_nondata_offload(...)` → `_offldmgr_register_nondata_offload(...)`
- `A_REGISTER_CRASH_CB` → `cmnos_misc_register_crash_cb`

**Rule:** Before pattern matching, normalize macro names to their expanded forms. The expanded forms are deterministic.

### Rule 6: New patterns discovered

| # | Pattern | Registration API | Sites |
|---|---------|-----------------|-------|
| 11 | Crash callback | `cmnos_misc_register_crash_cb` / `A_REGISTER_CRASH_CB` | global array |
| 12 | Subscriber notification | `wlan_thread_notify_register` | linked list with `thread_id_mask` |
| 13 | HIF callback | `HIF_register_callback` / `HIF_register_pipe_callback` | vtable dispatch |
| 14 | PCIe notification | `pcie_register_notification_cb` | callback field |
| 15 | VDEV notification handler | `wlan_vdev_register_notif_handler` | per-vdev subscriber list | **156+** |
| 16 | WAL PHY device event | `wal_phy_dev_register_event_handler` | per-pdev handler list with bitmap | **89+** |
| 17 | COEX ASM registration | `coex_asm_register` + `coex_asm_register_notify` | per-client handle | **51** |
| 18 | WOW notification | `wlan_wow_register_notif_handler` | per-pdev subscriber list | **33** |
| 19 | TBD timer callback | `tbd_register_tbd_callback` | global `tbd_values[]` array | **25** |
| 20 | NAN event notification | `wlan_nan_register_event_notify` | STAILQ keyed by module_id | **18** |
| 21 | Roam handoff notification | `wlan_roam_register_handoff_notify` | pool-allocated STAILQ | **16** |
| 22 | Pause request callback | `pause_req->cb = cb` | per-request `cb` field | **16+** |
| 23 | CE callback | `ce_callback_register` | per-CE-handle struct | **12** |
| 24 | MLO manager event | `resmgr_mlomgr_register_event_callback` | per-ml-bss STAILQ | **12** |
| 25 | Traffic monitor notification | `wlan_traffic_register_soc_notify_handler` | pool-allocated STAILQ | **11** |

### Architectural patterns

The codebase uses 6 storage architectures for callbacks:

1. **Enum-indexed arrays** (patterns 3, 4, 15, 19, 23): `array[name] = handler`. Direct lookup by enum.
2. **Parallel arrays** (pattern 1): `event_id[idx]` + `event_handler[idx]`. Linear scan by key.
3. **Per-instance subscriber lists** (patterns 11, 12, 13, 16, 17, 18, 20, 21, 24, 25): STAILQ or linked list per vdev/pdev/soc.
4. **Global arrays** (patterns 5b, 7, 8, 16, 22, 26): Fixed-size global array indexed by enum.
5. **Struct field assignment** (patterns 9, 22, 27, 28): Direct `struct.field = fn`.
6. **Linked dispatch tables** (pattern 2): Linked list of arrays, scan for key match.

### Universal detection algorithm

For ALL 34 patterns, the detection algorithm is the same:

1. LSP `references` on target callback fn → reference sites
2. Read enclosing line → identify registration API (from spec)
3. Extract dispatch key (enum, event_id, signal_id, func_id, etc.)
4. Apply correlation rule (file-to-thread, signal_id match, etc.)
5. Store as `calledBy[]` with `connectionKind` + `viaRegistrationApi`

**Coverage: ~800+ registration sites across 34 patterns.**

---

## End-to-End Chains

---

## End-to-End Chains (registration → storage → dispatch → invocation)

| Pattern | Registration API | Storage location | Dispatch mechanism | Invocation site |
|---------|-----------------|------------------|-------------------|-----------------|
| 4 | `_offldmgr_register_data_offload` | `OFFLOADMGR_CONTEXT.offload_data[name].data_handler` | for-loop, null + gate check | `offload_mgr_ext.c:1098` — `data_handler(context, ...)` |
| 3 | `_offldmgr_register_nondata_offload` | per-thread `offload_nondata[name].non_data_handler` | indexed by name enum | `offload_mgr_ext.c` — `non_data_handler(context, ...)` |
| 1 | `wmi_unified_register_event_handler` | `wmi_unified.event_handler[idx]` + `event_id[idx]` | linear scan for `event_id[idx] == id` | `wmi_unified.c:263` — `event_handler[idx](0, buf, len)` |
| 2 | `_WMI_RegisterDispatchTable` | `WMI_SVC_CONTEXT.pDispatchHead` linked list | list walk + array scan for `CmdID == cmd` | `wmi_svc.c:750` — `pCmdHandler(ctx, cmd, buf, len)` |
| 5a | `cmnos_irq_register` | `thread_info.irqs[irq].{hub, signal_id}` | `QURT_SIGNAL_SET` → thread event loop → signal handler | `cmnos_thread.c:2330` — `signals[j].sig_handler(ctxt)` |
| 5b | `cmnos_irq_register_dynamic` | `thread_info.irqs[irq].irq_route_cb` | direct callback from `cmnos_thread_irq` | `cmnos_thread.c:2049` — `irq_route_cb(irq_num)` |
| 6 | `wlan_thread_register_signal_wrapper` | `signal_handlers[idx].sig_handler=wrapper` + `real_signals[idx].sig_handler=real` | wrapper → real_sig_index lookup | `wlan_thread.c:252` — `real_sig_hdlr(ctxt)` |
| 7 | `wlan_thread_msg_handler_register_*` | `g_msg_handlers[func_id].cb_func` | msg FIFO → func_id lookup | `cmnos_thread.c:2862` — `handler_table[func_id].cb_func(ctxt, ...)` |
| 8 | `HTC_RegisterService` | `HTC_SERVICE.ProcessRecvMsg` field | null check + fallback chain | `htc.c:2177` — `ProcessRecvMsg(eid, buf)` |
| 9 | `wlif_register_callback` | `wlif_node[node].rx_notify` | direct field invocation | `wls_wlif.c:321` — `RX_NOTIFY_CB(node)(buf, len)` |

### Storage → invocation trace for each pattern

**Pattern 4 (offload data):**
```
_offldmgr_register_data_offload() → offload_data[name].data_handler = handler
  _offldmgr_enhanced_data_handler() → for i in 0..OFFLOAD_DATA_MAX:
    if (data_handler != NULL && vdev_bitmap & gate && proto & type && addr & type)
      data_handler(context, vdev_id, peer_id, buf, len)
```

**Pattern 1 (WMI event):**
```
wmi_unified_register_event_handler() → event_handler[idx] = handler; event_id[idx] = event_id
  wmi_process_rx_data() → dequeue event → get event_id
    wmi_unified_get_event_handler_ix() → linear scan event_id[idx] == id → return idx
    event_handler[idx](0, buf, len)
```

**Pattern 2 (WMI dispatch table):**
```
_WMI_RegisterDispatchTable() → append table to pDispatchHead linked list
  WMI_DispatchCmd() → walk pDispatchHead:
    if (minCmd <= cmd <= maxCmd):
      scan entries for CmdID == cmd → pCmdHandler = entry.pCmdHandler
    pCmdHandler(ctx, cmd, buf, len)
```

**Pattern 5a (IRQ signal bridge):**
```
cmnos_irq_register() → irqs[irq].hub = signal_hub; irqs[irq].signal_id = sig_id
  HW interrupt → cmnos_thread_irq(irq_num) → QURT_SIGNAL_SET(irqs[irq].hub, 1 << sig_id)
    cmnos_thread_event_loop() → QURT_SIGNAL_WAIT → iterate signals by priority
      signals[j].sig_handler(signals[j].sig_handler_ctxt)  [for matching signal_id]
```

**Pattern 5b (IRQ dynamic):**
```
cmnos_irq_register_dynamic() → irqs[irq].irq_route_cb = callback
  HW interrupt → cmnos_thread_irq(irq_num) → irqs[irq].irq_route_cb(irq_num)
```

**Pattern 7 (thread msg handler):**
```
wlan_thread_msg_handler_register_*(func_id, cb, ctxt) → g_msg_handlers[func_id].cb_func = cb
  sender → cmnos_thread_msg_send(thread, func_id, val, p1, p2) → enqueue FIFO
  receiver thread → CMNOS_THREAD_SIG_MSG_QUEUE fires → read FIFO → extract func_id
    cmnos_thread_msg_queue_rx_invoke() → handler_table[func_id].cb_func(ctxt, val, p1, p2)
```
