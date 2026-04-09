/**
 * packs/linux/hw-entities.ts — Linux kernel HW/device entity definitions.
 *
 * These become first-class nodes in the intelligence graph. Each entity
 * declares which dispatch chain step names it matches — when the extractor
 * builds a runtime_calls edge, chain steps matching an HW entity get
 * materialized as real graph nodes (kind=hw_block/interrupt/timer/etc.)
 * instead of plain metadata strings.
 *
 * This is the project-specific knowledge layer: the Linux kernel's HW
 * subsystem architecture encoded as graph entities. A different project
 * (WLAN firmware, embedded RTOS, etc.) would define completely different
 * HW entities in its own pack.
 */

import type { HWEntityDef } from "../types.js"

const linuxHWEntities: readonly HWEntityDef[] = [
  // ── IRQ subsystem ───────────────────────────────────────────────────────
  {
    name: "IRQ Subsystem",
    kind: "interrupt",
    description: "Linux hardware interrupt dispatch — do_IRQ → handle_irq_event → handler",
    matchesChainSteps: ["hardware_irq", "do_IRQ", "handle_irq_event", "irq_thread_fn"],
  },

  // ── Timer subsystem ─────────────────────────────────────────────────────
  {
    name: "Timer Subsystem",
    kind: "timer",
    description: "Linux kernel timer dispatch — run_timer_softirq → call_timer_fn → handler",
    matchesChainSteps: ["timer_expiry", "run_timer_softirq", "call_timer_fn"],
  },

  // ── Workqueue subsystem ─────────────────────────────────────────────────
  {
    name: "Workqueue",
    kind: "thread",
    description: "Linux workqueue deferred-work dispatch — process_one_work → handler",
    matchesChainSteps: ["workqueue_thread", "process_one_work"],
  },

  // ── Softirq / tasklet subsystem ─────────────────────────────────────────
  {
    name: "Tasklet/Softirq",
    kind: "interrupt",
    description: "Linux softirq dispatch — tasklet_action → handler",
    matchesChainSteps: ["softirq", "tasklet_action"],
  },

  // ── Kthread subsystem ───────────────────────────────────────────────────
  {
    name: "Kthread",
    kind: "thread",
    description: "Linux kernel thread — kthread → handler",
    matchesChainSteps: ["kthread"],
  },

  // ── VFS subsystem ───────────────────────────────────────────────────────
  {
    name: "VFS (read path)",
    kind: "hw_block",
    description: "Virtual Filesystem read dispatch — userspace read() → vfs_read → f_op->read → handler",
    matchesChainSteps: ["userspace_read_syscall", "ksys_read", "vfs_read", "call_read_iter"],
  },
  {
    name: "VFS (write path)",
    kind: "hw_block",
    description: "Virtual Filesystem write dispatch — userspace write() → vfs_write → f_op->write → handler",
    matchesChainSteps: ["userspace_write_syscall", "ksys_write", "vfs_write", "call_write_iter"],
  },
  {
    name: "VFS (open path)",
    kind: "hw_block",
    description: "Virtual Filesystem open dispatch — userspace open() → do_filp_open → f_op->open → handler",
    matchesChainSteps: ["userspace_open_syscall", "do_sys_openat2", "do_filp_open"],
  },
  {
    name: "VFS (ioctl path)",
    kind: "hw_block",
    description: "Virtual Filesystem ioctl dispatch — userspace ioctl() → do_vfs_ioctl → handler",
    matchesChainSteps: ["userspace_ioctl_syscall", "do_vfs_ioctl", "compat_sys_ioctl"],
  },
  {
    name: "VFS (mmap path)",
    kind: "hw_block",
    description: "Virtual Filesystem mmap dispatch — userspace mmap() → do_mmap → call_mmap → handler",
    matchesChainSteps: ["userspace_mmap_syscall", "do_mmap", "call_mmap"],
  },
  {
    name: "VFS (lseek path)",
    kind: "hw_block",
    description: "Virtual Filesystem lseek dispatch — userspace lseek() → vfs_llseek → handler",
    matchesChainSteps: ["userspace_lseek_syscall", "ksys_lseek", "vfs_llseek"],
  },
  {
    name: "VFS (poll path)",
    kind: "hw_block",
    description: "Virtual Filesystem poll dispatch — userspace poll() → vfs_poll → handler",
    matchesChainSteps: ["userspace_poll_syscall", "do_sys_poll", "vfs_poll"],
  },
  {
    name: "VFS (release path)",
    kind: "hw_block",
    description: "Virtual Filesystem release dispatch — __fput → f_op->release → handler",
    matchesChainSteps: ["__fput"],
  },

  // ── PCI bus ─────────────────────────────────────────────────────────────
  {
    name: "PCI Bus",
    kind: "hw_block",
    description: "PCI bus device enumeration and driver binding",
    matchesChainSteps: ["pci_bus_match", "pci_device_probe", "pci_device_remove"],
  },

  // ── Platform bus ────────────────────────────────────────────────────────
  {
    name: "Platform Bus",
    kind: "hw_block",
    description: "Platform bus device enumeration and driver binding",
    matchesChainSteps: ["platform_bus_match", "platform_probe", "platform_remove"],
  },

  // ── Character device subsystem ──────────────────────────────────────────
  {
    name: "Character Device",
    kind: "device",
    description: "Character device dispatch — chrdev_open → fops → handler",
    matchesChainSteps: ["userspace_open", "chrdev_open", "fops_dispatch"],
  },

  // ── Notifier chains ─────────────────────────────────────────────────────
  {
    name: "Notifier Chain",
    kind: "signal",
    description: "Kernel notifier chain broadcast mechanism",
    matchesChainSteps: ["notifier_call_chain"],
  },

  // ── VM subsystem ────────────────────────────────────────────────────────
  {
    name: "VM Fault Handler",
    kind: "hw_block",
    description: "Virtual memory page fault dispatch",
    matchesChainSteps: ["handle_pte_fault", "do_fault", "vma_open", "vma_close", "mmap_region"],
  },

  // ── proc/debugfs ────────────────────────────────────────────────────────
  {
    name: "procfs",
    kind: "device",
    description: "/proc filesystem — userspace reads trigger show callbacks",
    matchesChainSteps: ["userspace_read_proc", "proc_reg_read", "single_open", "seq_read"],
  },
  {
    name: "debugfs",
    kind: "device",
    description: "debugfs filesystem — userspace reads trigger file callbacks",
    matchesChainSteps: ["userspace_read_debugfs", "debugfs_file_read"],
  },

  // ── io_uring ────────────────────────────────────────────────────────────
  {
    name: "io_uring",
    kind: "ring",
    description: "io_uring async I/O submission ring",
    matchesChainSteps: ["io_uring_submit", "io_uring_cmd"],
  },

  // ── AGP subsystem ───────────────────────────────────────────────────────
  {
    name: "AGP Bridge",
    kind: "hw_block",
    description: "AGP Accelerated Graphics Port bridge driver subsystem",
    matchesChainSteps: ["agp_backend_initialize", "agp_backend_cleanup", "agp_generic_mask_memory", "agp_generic_alloc_page"],
  },

  // ── Intel GTT ───────────────────────────────────────────────────────────
  {
    name: "Intel GTT",
    kind: "hw_block",
    description: "Intel Graphics Translation Table — page table management for GPU memory",
    matchesChainSteps: ["intel_gtt_init", "intel_gtt_cleanup", "intel_gtt_insert_sg_entries", "intel_gtt_chipset_flush"],
  },

  // ── Network stack ───────────────────────────────────────────────────────
  {
    name: "Network Stack (TX)",
    kind: "hw_block",
    description: "Linux network transmit path — dev_queue_xmit → ndo_start_xmit → handler",
    matchesChainSteps: ["dev_queue_xmit", "__dev_queue_xmit"],
  },
  {
    name: "Network Stack (open)",
    kind: "hw_block",
    description: "Linux network interface open — dev_open → ndo_open → handler",
    matchesChainSteps: ["dev_open"],
  },
]

export default linuxHWEntities
