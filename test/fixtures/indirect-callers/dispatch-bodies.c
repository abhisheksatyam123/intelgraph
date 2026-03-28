/**
 * dispatch-bodies.c — Dispatch function bodies for dispatch-finder unit tests.
 *
 * These contain the fn-ptr call sites that findDispatchSite must locate.
 * The dispatch finder uses references() on the stored field name to find
 * these call sites, then identifies the enclosing function as the dispatch fn.
 *
 * Three dispatch patterns covered:
 *   Dispatch 1: STAILQ iteration with fn-ptr call  (like wlan_vdev_deliver_notif)
 *   Dispatch 2: array loop with fn-ptr call         (like _offldmgr_enhanced_data_handler)
 *   Dispatch 3: direct slot fn-ptr call             (like cmnos_thread_irq)
 */

typedef void (*handler_fn_t)(void *ctx, void *event, void *arg);
typedef void (*data_fn_t)(void *ctx, void *pkt);
typedef void (*irq_fn_t)(int irq_num);

struct entry {
    handler_fn_t handler;
    void *arg;
};

struct data_entry {
    data_fn_t data_handler;
    void *ctx;
};

struct irq_entry {
    irq_fn_t irq_route_cb;
};

typedef struct entry *event_t;

static struct data_entry table[64];
static struct irq_entry g_irqs[32];

/* ── Dispatch 1: STAILQ iteration ──────────────────────────────────────────
 * Mirrors wlan_vdev_deliver_notif:
 *   STAILQ_FOREACH_SAFE(notif_data, &vdev->notif_list, link_notif_data, tmp)
 *     notif_data->handler(vdev, notif, notif_data->arg);
 */
void stailq_dispatch(void *c, void *ev)
{
    struct entry *e, *tmp;
    STAILQ_FOREACH_SAFE(e, &((struct ctx *)c)->list, link, tmp) {
        if (e->handler) {
            e->handler(c, ev, e->arg);
        }
    }
}

/* ── Dispatch 2: array loop ─────────────────────────────────────────────────
 * Mirrors _offldmgr_enhanced_data_handler:
 *   if (p_offldmgr_ctxt->offload_data[i].data_handler != NULL)
 *     status = p_offldmgr_ctxt->offload_data[i].data_handler(ctx, vdev_id, ...)
 */
void array_dispatch(int name, void *pkt)
{
    if (table[name].data_handler) {
        table[name].data_handler(table[name].ctx, pkt);
    }
}

/* ── Dispatch 3: direct slot call ───────────────────────────────────────────
 * Mirrors cmnos_thread_irq:
 *   g_cmnos_thread_info.irqs[irq_num].irq_route_cb(irq_num)
 */
void direct_dispatch(int irq_num)
{
    if (g_irqs[irq_num].irq_route_cb) {
        g_irqs[irq_num].irq_route_cb(irq_num);
    }
}
