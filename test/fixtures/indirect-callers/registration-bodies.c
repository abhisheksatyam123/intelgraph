/**
 * registration-bodies.c — Registration API bodies for store-scanner unit tests.
 *
 * These are NOT call sites — they are the bodies of registration APIs themselves.
 * The store scanner (findStoreInDefinition) reads these bodies to find where the
 * callback parameter is stored, extracting the storeFieldName for use in
 * references() lookup to find the dispatch call site.
 *
 * Three storage architectures covered:
 *   Body 1: struct field + STAILQ subscriber list  (like wlan_vdev_register_notif_handler)
 *   Body 2: array-indexed field, two fn-ptr params  (like _offldmgr_register_data_offload)
 *   Body 3: direct array slot                       (like cmnos_irq_register_dynamic)
 */

typedef void (*handler_fn_t)(void *ctx, void *event, void *arg);
typedef void (*data_fn_t)(void *ctx, void *pkt);
typedef void (*notif_fn_t)(void *notif);
typedef void (*irq_fn_t)(int irq_num);

struct entry {
    handler_fn_t handler;
    void *arg;
};

struct data_entry {
    data_fn_t data_handler;
    void *ctx;
    notif_fn_t notif_handler;
};

struct irq_entry {
    irq_fn_t irq_route_cb;
    int active;
};

struct ctx {
    void *pool;
    /* list head for STAILQ */
};

static struct data_entry table[64];
static struct irq_entry g_irqs[32];

/* ── Body 1: struct field + STAILQ subscriber list ─────────────────────────
 * Mirrors wlan_vdev_register_notif_handler:
 *   notif_data->handler = handler;
 *   STAILQ_INSERT_TAIL(&vdev->notif_list, notif_data, link_notif_data);
 */
void stailq_register(struct ctx *c, handler_fn_t handler, void *arg)
{
    struct entry *e = pool_alloc(c->pool);
    e->handler = handler;
    e->arg = arg;
    STAILQ_INSERT_TAIL(&c->list, e, link);
}

/* ── Body 2: array-indexed field, two fn-ptr params ────────────────────────
 * Mirrors _offldmgr_register_data_offload:
 *   p_offldmgr_ctxt->offload_data[name].data_handler = data_handler;
 *   p_offldmgr_ctxt->offload_data[name].notif_handler = notif_handler;
 */
void array_register(int name, data_fn_t data_handler, void *ctx, notif_fn_t notif_handler)
{
    table[name].data_handler = data_handler;
    table[name].ctx = ctx;
    table[name].notif_handler = notif_handler;
}

/* ── Body 3: direct array slot ─────────────────────────────────────────────
 * Mirrors cmnos_irq_register_dynamic:
 *   g_cmnos_thread_info.irqs[interrupt_id].irq_route_cb = irq_route_cb;
 */
void direct_register(int irq_id, irq_fn_t irq_route_cb)
{
    g_irqs[irq_id].irq_route_cb = irq_route_cb;
}
