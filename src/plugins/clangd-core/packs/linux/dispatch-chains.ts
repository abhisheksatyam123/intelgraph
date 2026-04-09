/**
 * packs/linux/dispatch-chains.ts — pre-built dispatch chain templates
 * for Linux kernel registration APIs whose runtime dispatch path is
 * architecturally fixed.
 *
 * When the pattern-resolver's store/dispatch/trigger stages fail (because
 * clangd can't resolve through kernel macros/inlines), these templates
 * provide the known dispatch chain directly. The resolver fills in
 * %CALLBACK% with the actual callback name and %KEY% with the dispatch
 * key (e.g. IRQ number, timer name).
 *
 * Each template encodes the kernel's runtime dispatch architecture:
 *   hardware IRQ → do_IRQ → handle_irq_event → handler
 *   timer expiry → run_timer_softirq → call_timer_fn → handler
 *   workqueue    → process_one_work → handler
 *   tasklet      → tasklet_action → handler
 *   kthread      → kthread → handler
 *   VFS read     → ksys_read → vfs_read → f_op->read → handler
 *   VFS write    → ksys_write → vfs_write → f_op->write → handler
 *   chrdev       → register_chrdev → chrdev_open → f_op dispatch
 */

import type { DispatchChainTemplate } from "../types.js"

const linuxDispatchChains: readonly DispatchChainTemplate[] = [
  // ── Hardware interrupts ──────────────────────────────────────────────────
  {
    registrationApi: "request_irq",
    chain: ["hardware_irq", "do_IRQ", "handle_irq_event", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "Hardware interrupt IRQ %KEY%",
  },
  {
    registrationApi: "request_threaded_irq",
    chain: ["hardware_irq", "do_IRQ", "handle_irq_event", "irq_thread_fn", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "Threaded IRQ handler for IRQ %KEY%",
  },
  {
    registrationApi: "devm_request_irq",
    chain: ["hardware_irq", "do_IRQ", "handle_irq_event", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "devm-managed IRQ handler for IRQ %KEY%",
  },
  {
    registrationApi: "devm_request_threaded_irq",
    chain: ["hardware_irq", "do_IRQ", "handle_irq_event", "irq_thread_fn", "%CALLBACK%"],
    triggerKind: "hardware_interrupt",
    triggerDescription: "devm-managed threaded IRQ handler for IRQ %KEY%",
  },

  // ── Timers ───────────────────────────────────────────────────────────────
  {
    registrationApi: "timer_setup",
    chain: ["timer_expiry", "run_timer_softirq", "call_timer_fn", "%CALLBACK%"],
    triggerKind: "timer_expiry",
    triggerDescription: "Kernel timer expiry callback",
  },

  // ── Workqueues ───────────────────────────────────────────────────────────
  {
    registrationApi: "INIT_WORK",
    chain: ["workqueue_thread", "process_one_work", "%CALLBACK%"],
    triggerKind: "workqueue",
    triggerDescription: "Workqueue deferred work callback",
  },
  {
    registrationApi: "INIT_DELAYED_WORK",
    chain: ["workqueue_thread", "process_one_work", "%CALLBACK%"],
    triggerKind: "workqueue",
    triggerDescription: "Delayed workqueue callback",
  },

  // ── Tasklets ─────────────────────────────────────────────────────────────
  {
    registrationApi: "tasklet_init",
    chain: ["softirq", "tasklet_action", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Tasklet softirq callback",
  },

  // ── Kernel threads ───────────────────────────────────────────────────────
  {
    registrationApi: "kthread_run",
    chain: ["kthread", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Kernel thread entry point",
  },
  {
    registrationApi: "kthread_create",
    chain: ["kthread", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Kernel thread entry point",
  },

  // ── VFS file operations ──────────────────────────────────────────────────
  // These are for the struct-field registration pattern, keyed by the
  // struct-field name (.read, .write, .open, etc.). The registrationApi
  // here is the container variable name which the resolver matches against
  // the generic struct-field classifier's viaRegistrationApi output.
  // We use a wildcard approach: any file_operations container triggers
  // the VFS dispatch template based on the field name.
  {
    registrationApi: "__struct_field:file_operations.read",
    chain: ["userspace_read_syscall", "ksys_read", "vfs_read", "f_op->read", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace read() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.write",
    chain: ["userspace_write_syscall", "ksys_write", "vfs_write", "f_op->write", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace write() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.open",
    chain: ["userspace_open_syscall", "do_sys_openat2", "do_filp_open", "f_op->open", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace open() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.release",
    chain: ["__fput", "f_op->release", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "File descriptor close → VFS release dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.llseek",
    chain: ["userspace_lseek_syscall", "ksys_lseek", "vfs_llseek", "f_op->llseek", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace lseek() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.mmap",
    chain: ["userspace_mmap_syscall", "do_mmap", "call_mmap", "f_op->mmap", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace mmap() syscall → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.unlocked_ioctl",
    chain: ["userspace_ioctl_syscall", "do_vfs_ioctl", "f_op->unlocked_ioctl", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace ioctl() syscall → VFS dispatch",
  },

  // ── Character device registration ────────────────────────────────────────
  {
    registrationApi: "register_chrdev",
    chain: ["userspace_open", "chrdev_open", "fops_dispatch", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Character device open for major %KEY%",
  },

  // ── Net device ops ───────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:net_device_ops.ndo_open",
    chain: ["dev_open", "ndo_open", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Network interface open → ndo_open dispatch",
  },
  {
    registrationApi: "__struct_field:net_device_ops.ndo_start_xmit",
    chain: ["dev_queue_xmit", "__dev_queue_xmit", "ndo_start_xmit", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Network packet transmit → ndo_start_xmit dispatch",
  },

  // ── proc/debugfs ─────────────────────────────────────────────────────────
  {
    registrationApi: "proc_create",
    chain: ["userspace_read_proc", "proc_reg_read", "f_op_dispatch", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace reads /proc/%KEY%",
  },
  {
    registrationApi: "debugfs_create_file",
    chain: ["userspace_read_debugfs", "debugfs_file_read", "f_op_dispatch", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace reads debugfs file %KEY%",
  },
]

export default linuxDispatchChains
