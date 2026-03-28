/**
 * registrations.c — Registration calls referencing callback functions from handlers.c.
 * Each call site is a potential indirect-caller detection target.
 */

#include <stdint.h>

typedef void* offld_ctx_t;
typedef uint32_t pkt_type_t;

/* Forward declarations (names shortened to avoid collision with registration call sites) */
extern void bpf_offload_fn(offld_ctx_t ctx, uint32_t filter_id, pkt_type_t *pkt);
extern void scan_result_fn(void *wmi_ctx, void *event_buf, uint32_t event_id);
extern void irq_route_fn(uint32_t irq_num);
extern void tqm_sig_hdlr_fn(void *thread, uint32_t sig_id);
extern void tqm_sync_fn(void *msg_buf);
extern void lpi_scan_fn(offld_ctx_t ctx, uint32_t scan_id);
extern void wow_cmd_fn(void *wmi, void *cmd_buf, uint32_t len);
extern void vdev_start_fn(void *vdev, uint32_t event, void *arg);
extern void rx_ce_fn(uint32_t ce_id, void *msg);
extern void wow_wakeup_fn(void *wow, uint32_t event);
extern void low_prio_irq_fn(uint32_t irq_num);
extern void low_prio_sig_fn(void *thread, uint32_t sig_id);
extern void varlen_msg_fn(void *msg_buf, uint32_t msg_len);
extern void wal_phy_event_fn(void *pdev, uint32_t event_mask);
extern void coex_state_fn(uint32_t state);
extern void tbd_cfg_fn(uint32_t key, void *ctx);
extern void coex_notify_fn(uint32_t evt, void *ctx);
extern void roam_handoff_fn(void *vdev, uint32_t state);
extern void nan_event_fn(void *nan, uint32_t event);
extern void traffic_notify_fn(void *soc, uint32_t stats_id);

/* Offload manager calls */
void setup_offloads(offld_ctx_t ctx) {
    offldmgr_register_data_offload(DATA_FILTER_OFFLOAD, OFFLOAD_BPF, wlan_bpf_filter_offload_handler, ctx, NULL, 0);
    offldmgr_register_nondata_offload(NON_PROTO_OFFLOAD, OFFLOAD_LPI_SCAN, wlan_lpi_scan_cb, ctx, 0xFFFF);
}

/* WMI event handler registration */
void setup_wmi_handlers(void *wmi_handle) {
    wmi_unified_register_event_handler(wmi_handle, WMI_LPI_RESULT_EVENTID, wls_fw_scan_result_handler);
}

/* IRQ registration */
void setup_irqs(void) {
    cmnos_irq_register_dynamic(A_INUM_WSI, wsi_high_prio_irq_route);
}

/* Thread signal registration */
void setup_thread_signals(void *thread_ctxt) {
    wlan_thread_register_signal_wrapper(thread_ctxt, WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR, wal_tqm_hipri_status_intr_sig_hdlr, NULL, NULL);
}

/* Thread message handler registration */
void setup_thread_msgs(void) {
    wlan_thread_msg_handler_register_dval_dptr1_dptr2(WLAN_THREAD_COMM_FUNC_TQM_NOTIFY, wal_tqm_sync_notify_hdlr, NULL);
}

/* WMI dispatch table (struct initializer) */
struct WMI_DISPATCH_ENTRY {
    void *handler;
    uint32_t cmd_id;
    uint32_t flags;
};

struct WMI_DISPATCH_ENTRY wow_dispatch_entries[] = {
    {_d0wow_wmi_cmd_handler, WMI_D0_WOW_ENABLE_DISABLE_CMDID, 0},
};

/* VDEV notification handler */
void setup_vdev(void *vdev) {
    wlan_vdev_register_notif_handler(vdev, WLAN_VDEV_SM_EV_START_RESP, vdev_start_resp_handler, NULL);
}

/* CE callback registration */
void setup_ce(void) {
    ce_callback_register(CE_ID_0, htt_rx_ce_handler, NULL);
}

/* WOW notification handler */
void setup_wow(void *wow) {
    wlan_wow_register_notif_handler(wow, WOW_WAKEUP_EVENT, wow_wakeup_handler, NULL);
}

/* IRQ registration (non-dynamic variant) */
void setup_irqs_low(void) {
    cmnos_irq_register(A_INUM_WSI_LOW, wsi_low_prio_irq_route);
}

/* Thread signal registration (non-wrapper variant) */
void setup_thread_signals_low(void *thread_ctxt) {
    wlan_thread_register_signal(thread_ctxt, WLAN_THREAD_SIG_TQM_LOPRI_STATUS_HW_INTR, wal_tqm_low_prio_sig_hdlr, NULL);
}

/* Thread message handler registration (var-len variant) */
void setup_thread_msgs_varlen(void) {
    wlan_thread_msg_handler_register_var_len_buf(WLAN_THREAD_COMM_FUNC_TQM_NOTIFY_VARLEN, wal_tqm_varlen_notify_hdlr, NULL);
}

/* WAL phy device event handler registration */
void setup_wal_phy(void *wal_pdev) {
    wal_phy_dev_register_event_handler(wal_pdev, WAL_PDEV_EVENT_PRE_POWER_STATE_CHANGE, wal_phy_sleep_wake_event_hdlr, NULL, NULL);
}

/* COEX ASM registration */
void setup_coex(void) {
    coex_asm_register(COEX_ASM_CLIENT_WLAN, coex_wlan_state_handler);
}

/* COEX ASM notify registration */
void setup_coex_notify(void *ctx) {
    coex_asm_register_notify(COEX_ASM_NOTIFY_WLAN, coex_wlan_notify_handler, ctx);
}

/* TBD callback registration */
void setup_tbd(void *ctx) {
    tbd_register_tbd_callback(TBD_CFG_WLAN, tbd_wlan_cfg_callback, ctx);
}

/* Roam handoff notify registration */
void setup_roam_handoff(void *vdev) {
    wlan_roam_register_handoff_notify(vdev, ROAM_HANDOFF_PRE_AUTH, wlan_roam_handoff_state_handler);
}

/* NAN event notify registration */
void setup_nan_events(void *nan_ctx) {
    wlan_nan_register_event_notify(nan_ctx, NAN_EVENT_LINK_STATE, wlan_nan_event_state_handler);
}

/* Traffic notify registration */
void setup_traffic_notify(void *soc_ctx) {
    wlan_traffic_register_notify_handler(TRAFFIC_NOTIFY_TXRX, wlan_traffic_mon_notify_handler, soc_ctx);
}

/* Unrelated code — should NOT match any pattern */
void unrelated_function(void) {
    int x = 42;
    x = x + 1;
}
