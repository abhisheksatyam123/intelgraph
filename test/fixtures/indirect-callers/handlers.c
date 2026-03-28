/**
 * handlers.c — Callback function definitions for test fixtures.
 * These are the targets whose indirect callers we want to detect.
 */

#include <stdint.h>

typedef void* offld_ctx_t;
typedef uint32_t pkt_type_t;

/* Handler 1: offload data filter handler */
void wlan_bpf_filter_offload_handler(offld_ctx_t ctx, uint32_t filter_id, pkt_type_t *pkt) {
    /* implementation irrelevant for detection */
}

/* Handler 2: WMI event handler */
void wls_fw_scan_result_handler(void *wmi_ctx, void *event_buf, uint32_t event_id) {
    /* implementation irrelevant */
}

/* Handler 3: IRQ handler */
void wsi_high_prio_irq_route(uint32_t irq_num) {
    /* implementation irrelevant */
}

/* Handler 4: thread signal handler */
void wal_tqm_hipri_status_intr_sig_hdlr(void *thread, uint32_t sig_id) {
    /* implementation irrelevant */
}

/* Handler 5: thread message handler */
void wal_tqm_sync_notify_hdlr(void *msg_buf) {
    /* implementation irrelevant */
}

/* Handler 6: offload nondata handler */
void wlan_lpi_scan_cb(offld_ctx_t ctx, uint32_t scan_id) {
    /* implementation irrelevant */
}

/* Handler 7: WMI command handler for dispatch table */
void _d0wow_wmi_cmd_handler(void *wmi, void *cmd_buf, uint32_t len) {
    /* implementation irrelevant */
}

/* Handler 8: vdev notification handler */
void vdev_start_resp_handler(void *vdev, uint32_t event, void *arg) {
    /* implementation irrelevant */
}

/* Handler 9: CE handler */
void htt_rx_ce_handler(uint32_t ce_id, void *msg) {
    /* implementation irrelevant */
}

/* Handler 10: WOW notification handler */
void wow_wakeup_handler(void *wow, uint32_t event) {
    /* implementation irrelevant */
}

/* Handler 11: irq signal register variant */
void wsi_low_prio_irq_route(uint32_t irq_num) {
    /* implementation irrelevant */
}

/* Handler 12: thread signal (non-wrapper) variant */
void wal_tqm_low_prio_sig_hdlr(void *thread, uint32_t sig_id) {
    /* implementation irrelevant */
}

/* Handler 13: thread msg var-len variant */
void wal_tqm_varlen_notify_hdlr(void *msg_buf, uint32_t msg_len) {
    /* implementation irrelevant */
}

/* Handler 14: WAL phy event handler */
void wal_phy_sleep_wake_event_hdlr(void *pdev, uint32_t event_mask) {
    /* implementation irrelevant */
}

/* Handler 15: COEX asm register handler */
void coex_wlan_state_handler(uint32_t state) {
    /* implementation irrelevant */
}

/* Handler 16: TBD callback */
void tbd_wlan_cfg_callback(uint32_t key, void *ctx) {
    /* implementation irrelevant */
}

/* Handler 17: COEX notify registration variant */
void coex_wlan_notify_handler(uint32_t evt, void *ctx) {
    /* implementation irrelevant */
}

/* Handler 18: Roam handoff notify registration */
void wlan_roam_handoff_state_handler(void *vdev, uint32_t state) {
    /* implementation irrelevant */
}

/* Handler 19: NAN event notify registration */
void wlan_nan_event_state_handler(void *nan, uint32_t event) {
    /* implementation irrelevant */
}

/* Handler 20: traffic notify registration */
void wlan_traffic_mon_notify_handler(void *soc, uint32_t stats_id) {
    /* implementation irrelevant */
}
