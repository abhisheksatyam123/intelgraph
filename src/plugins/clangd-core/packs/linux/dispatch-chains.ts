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

  // ── Additional file_operations fields ──────────────────────────────────
  {
    registrationApi: "__struct_field:file_operations.poll",
    chain: ["userspace_poll_syscall", "do_sys_poll", "vfs_poll", "f_op->poll", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace poll()/select()/epoll() → VFS poll dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.fasync",
    chain: ["userspace_fcntl_syscall", "do_fcntl", "f_op->fasync", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace fcntl(F_SETFL, FASYNC) → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.read_iter",
    chain: ["userspace_read_syscall", "ksys_read", "vfs_read", "call_read_iter", "f_op->read_iter", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace read() → VFS read_iter dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.write_iter",
    chain: ["userspace_write_syscall", "ksys_write", "vfs_write", "call_write_iter", "f_op->write_iter", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace write() → VFS write_iter dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.splice_read",
    chain: ["userspace_splice_syscall", "do_splice", "f_op->splice_read", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace splice() → VFS splice_read dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.splice_write",
    chain: ["userspace_splice_syscall", "do_splice", "f_op->splice_write", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace splice() → VFS splice_write dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.compat_ioctl",
    chain: ["userspace_ioctl_syscall", "compat_sys_ioctl", "f_op->compat_ioctl", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Userspace ioctl() (compat) → VFS dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.uring_cmd",
    chain: ["io_uring_submit", "io_uring_cmd", "f_op->uring_cmd", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "io_uring command → f_op->uring_cmd dispatch",
  },
  {
    registrationApi: "__struct_field:file_operations.get_unmapped_area",
    chain: ["mmap_region", "get_unmapped_area", "f_op->get_unmapped_area", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "mmap address selection → f_op->get_unmapped_area dispatch",
  },

  // ── PCI driver ──────────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:pci_driver.probe",
    chain: ["pci_bus_match", "pci_device_probe", "drv->probe", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "PCI device probe on bus enumeration",
  },
  {
    registrationApi: "__struct_field:pci_driver.remove",
    chain: ["pci_device_remove", "drv->remove", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "PCI device remove on driver unbind",
  },

  // ── Platform driver ─────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:platform_driver.probe",
    chain: ["platform_bus_match", "platform_probe", "drv->probe", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Platform device probe on bus enumeration",
  },
  {
    registrationApi: "__struct_field:platform_driver.remove",
    chain: ["platform_remove", "drv->remove", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Platform device remove on driver unbind",
  },

  // ── Notifier chains ─────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:notifier_block.notifier_call",
    chain: ["notifier_call_chain", "nb->notifier_call", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Kernel notifier chain callback",
  },

  // ── VM operations ───────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:vm_operations_struct.fault",
    chain: ["handle_pte_fault", "do_fault", "vma->vm_ops->fault", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Page fault → VM ops fault handler",
  },
  {
    registrationApi: "__struct_field:vm_operations_struct.open",
    chain: ["vma_open", "vma->vm_ops->open", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VMA open → VM ops open handler",
  },
  {
    registrationApi: "__struct_field:vm_operations_struct.close",
    chain: ["vma_close", "vma->vm_ops->close", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "VMA close → VM ops close handler",
  },

  // ── AGP bridge driver ───────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:agp_bridge_driver.configure",
    chain: ["agp_backend_initialize", "bridge->driver->configure", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP bridge configure on initialization",
  },
  {
    registrationApi: "__struct_field:agp_bridge_driver.cleanup",
    chain: ["agp_backend_cleanup", "bridge->driver->cleanup", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP bridge cleanup on teardown",
  },
  {
    registrationApi: "__struct_field:agp_bridge_driver.fetch_size",
    chain: ["agp_backend_initialize", "bridge->driver->fetch_size", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP bridge aperture size fetch",
  },
  {
    registrationApi: "__struct_field:agp_bridge_driver.tlb_flush",
    chain: ["agp_generic_mask_memory", "bridge->driver->tlb_flush", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP TLB flush on memory mapping",
  },
  {
    registrationApi: "__struct_field:agp_bridge_driver.mask_memory",
    chain: ["agp_generic_alloc_page", "bridge->driver->mask_memory", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "AGP memory mask on allocation",
  },

  // ── Intel GTT driver ────────────────────────────────────────────────────
  {
    registrationApi: "__struct_field:intel_gtt_driver.setup",
    chain: ["intel_gtt_init", "driver->setup", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT setup on initialization",
  },
  {
    registrationApi: "__struct_field:intel_gtt_driver.cleanup",
    chain: ["intel_gtt_cleanup", "driver->cleanup", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT cleanup on teardown",
  },
  {
    registrationApi: "__struct_field:intel_gtt_driver.write_entry",
    chain: ["intel_gtt_insert_sg_entries", "driver->write_entry", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT page table write entry",
  },
  {
    registrationApi: "__struct_field:intel_gtt_driver.check_flags",
    chain: ["intel_gtt_insert_sg_entries", "driver->check_flags", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT flags validation",
  },
  {
    registrationApi: "__struct_field:intel_gtt_driver.chipset_flush",
    chain: ["intel_gtt_chipset_flush", "driver->chipset_flush", "%CALLBACK%"],
    triggerKind: "event",
    triggerDescription: "Intel GTT chipset flush",
  },
]

export default linuxDispatchChains
