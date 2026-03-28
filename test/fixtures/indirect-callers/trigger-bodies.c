/**
 * trigger-bodies.c — Trigger function bodies for trigger-finder unit tests.
 *
 * These are the runtime callers of the dispatch functions.
 * findTriggerSite uses incomingCalls() on the dispatch function to find these.
 *
 * Three trigger patterns covered:
 *   Trigger 1: RX packet arrival drives array dispatch   (rx_packet)
 *   Trigger 2: hardware IRQ fires                        (hw_interrupt)
 *   Trigger 3: vdev state change drives STAILQ dispatch  (vdev_state_change)
 */

/* ── Trigger 1: RX packet arrival ───────────────────────────────────────────
 * Mirrors offloadif_data_ind → _offldmgr_protocol_data_handler
 *   → _offldmgr_enhanced_data_handler (array_dispatch)
 */
void rx_data_ind(void *pkt, int vdev_id)
{
    array_dispatch(vdev_id, pkt);
}

/* ── Trigger 2: hardware IRQ fires ─────────────────────────────────────────
 * Mirrors cmnos_thread_irq_handler → cmnos_thread_irq (direct_dispatch)
 */
void hw_irq_handler(int irq_num)
{
    direct_dispatch(irq_num);
}

/* ── Trigger 3: vdev state change ───────────────────────────────────────────
 * Mirrors wlan_vdev_ext.c state machine → wlan_vdev_deliver_notif (stailq_dispatch)
 */
void vdev_state_change(void *vdev, int state)
{
    void *ev = make_event(state);
    stailq_dispatch(vdev, ev);
}
