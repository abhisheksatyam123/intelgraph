# Next 90+ candidate symbols for the Linux fixture suite

Organized by category to maximize coverage of distinct backend code paths.
The 11 starter fixtures already in `api/` cover 5 categories; this list
extends to ~15 categories × 6-10 symbols each.

For each row: pick the symbol, run `grep -n "<symbol>" --include="*.c"
--include="*.h"` against `/home/abhi/qprojects/linux` to gather ground
truth, then write a per-symbol fixture in `api/<symbol>.json`.

## A. Pure leaf helpers (exported, lib/) — 8 symbols

Exercise direct-caller and direct-callee with cross-file indexing.

| Symbol             | File                            | Line  | Why                                      |
|--------------------|---------------------------------|-------|------------------------------------------|
| `strscpy`          | `lib/string.c`                  | ~91   | Heavy cross-file caller test             |
| `memchr_inv`       | `lib/string.c`                  | ~919  | Single callsite vs. heavy callsite       |
| `kstrdup`          | `mm/util.c`                     | ~57   | Inlined from header sometimes            |
| `__check_object_size` | `mm/usercopy.c`              | ~286  | Hardened-usercopy entry                  |
| `crc32_be`         | `lib/crc32.c`                   | ~191  | LUT-based pure function                  |
| `bitmap_zero`      | `include/linux/bitmap.h`        | inline | Inline header function — clangd may skip |
| `strim`            | `lib/string_helpers.c`          | ~530  | String trim                              |
| `seq_puts`         | `fs/seq_file.c`                 | ~778  | proc/sysfs writer entry                  |

## B. VFS file_operations callbacks — 12 symbols

Exercise Gap 4 (struct-field registration) and Gap 3 (VFS dispatch).

| Symbol               | File                                  | fops table              | Field      |
|----------------------|---------------------------------------|-------------------------|------------|
| `read_zero`          | `drivers/char/mem.c`                  | `zero_fops`             | `.read`    |
| `write_null`         | `drivers/char/mem.c`                  | `null_fops`             | `.write`   |
| `write_zero`         | `drivers/char/mem.c`                  | `zero_fops`             | `.write`   |
| `mmap_zero`          | `drivers/char/mem.c`                  | `zero_fops`             | `.mmap`    |
| `mem_open`           | `drivers/char/mem.c`                  | dispatch table          | `.open`    |
| `random_read_iter`   | `drivers/char/random.c`               | `random_fops`           | `.read_iter`|
| `urandom_read_iter`  | `drivers/char/random.c`               | `urandom_fops`          | `.read_iter`|
| `proc_pid_status`    | `fs/proc/array.c`                     | (`task_dir_fops` family)| `.show`    |
| `proc_pid_cmdline_read` | `fs/proc/base.c`                   | `proc_pid_cmdline_ops`  | `.read`    |
| `tty_open`           | `drivers/tty/tty_io.c`                | `tty_fops`              | `.open`    |
| `tty_release`        | `drivers/tty/tty_io.c`                | `tty_fops`              | `.release` |
| `pipe_read`          | `fs/pipe.c`                           | `pipefifo_fops`         | `.read_iter`|

## C. IRQ handlers (request_irq style) — 8 symbols

Exercise Gap 3 (IRQ subsystem dispatch) and the existing auto-classifier path.

| Symbol                  | File                                       |
|-------------------------|--------------------------------------------|
| `i8042_aux_test_irq`    | `drivers/input/serio/i8042.c`              |
| `serial8250_interrupt`  | `drivers/tty/serial/8250/8250_core.c`      |
| `e1000_intr`            | `drivers/net/ethernet/intel/e1000/e1000_main.c` |
| `xhci_irq`              | `drivers/usb/host/xhci-ring.c`             |
| `nvme_irq`              | `drivers/nvme/host/pci.c`                  |
| `ahci_thread_fn`        | `drivers/ata/libahci.c`                    |
| `acpi_ev_gpe_xrupt_handler` | `drivers/acpi/acpica/evgpe.c`          |
| `timer_interrupt`       | arch-specific, e.g. `arch/x86/kernel/time.c`|

## D. Syscall handlers (SYSCALL_DEFINE*) — 12 symbols

Exercise Gap 5 (macro-expanded names + syscall table registration).

| Symbol            | File                          | Macro             |
|-------------------|-------------------------------|-------------------|
| `getpid`          | `kernel/sys.c`                | SYSCALL_DEFINE0   |
| `getuid`          | `kernel/sys.c`                | SYSCALL_DEFINE0   |
| `pause`           | `kernel/signal.c`             | SYSCALL_DEFINE0   |
| `vfork`           | `kernel/fork.c`               | SYSCALL_DEFINE0   |
| `read`            | `fs/read_write.c`             | SYSCALL_DEFINE3   |
| `write`           | `fs/read_write.c`             | SYSCALL_DEFINE3   |
| `open`            | `fs/open.c`                   | SYSCALL_DEFINE3   |
| `close`           | `fs/open.c`                   | SYSCALL_DEFINE1   |
| `mmap`            | `mm/mmap.c`                   | SYSCALL_DEFINE6   |
| `getrandom`       | `drivers/char/random.c`       | SYSCALL_DEFINE3   |
| `clock_gettime`   | `kernel/time/posix-timers.c`  | SYSCALL_DEFINE2   |
| `kill`            | `kernel/signal.c`             | SYSCALL_DEFINE2   |

## E. Workqueue handlers (work_struct callbacks) — 6 symbols

Exercise Gap 4 with `INIT_WORK(&w, handler)` registration.

| Symbol                   | File                                  | Registrar             |
|--------------------------|---------------------------------------|-----------------------|
| `console_callback`       | `drivers/tty/vt/vt.c`                 | `INIT_WORK`           |
| `vmstat_update`          | `mm/vmstat.c`                         | `INIT_DEFERRABLE_WORK`|
| `cgroup_release_agent`   | `kernel/cgroup/cgroup-v1.c`           | `INIT_WORK`           |
| `delayed_work_timer_fn`  | `kernel/workqueue.c`                  | timer_setup           |
| `idle_inject_fn`         | `drivers/powercap/idle_inject.c`      | `INIT_WORK`           |
| `bdi_wb_workfn`          | `mm/backing-dev.c`                    | `INIT_DELAYED_WORK`   |

## F. Timer callbacks (timer_setup) — 6 symbols

Same pattern as workqueue but via `timer_setup(t, fn, flags)`.

| Symbol                  | File                              |
|-------------------------|-----------------------------------|
| `process_timeout`       | `kernel/time/timer.c`             |
| `it_real_fn`            | `kernel/itimer.c`                 |
| `idle_worker_timeout`   | `kernel/workqueue.c`              |
| `pool_mayday_timeout`   | `kernel/workqueue.c`              |
| `clusterip_tg_destroy_timer` | (depends on netfilter cluster)|
| `tcp_keepalive_timer`   | `net/ipv4/tcp_timer.c`            |

## G. Network device ops callbacks — 6 symbols

Exercise the `net_device_ops` struct-field family (parallel to file_operations).

| Symbol                  | File                              | Container             |
|-------------------------|-----------------------------------|-----------------------|
| `loopback_dev_init`     | `drivers/net/loopback.c`          | `loopback_ops`        |
| `loopback_xmit`         | `drivers/net/loopback.c`          | `loopback_ops.ndo_start_xmit` |
| `e1000_open`            | `drivers/net/ethernet/intel/e1000/e1000_main.c` | `e1000_netdev_ops` |
| `e1000_close`           | `drivers/net/ethernet/intel/e1000/e1000_main.c` | `e1000_netdev_ops` |
| `bond_open`             | `drivers/net/bonding/bond_main.c` | `bond_netdev_ops`     |
| `tun_chr_open`          | `drivers/net/tun.c`               | `tun_fops` (file_op)  |

## H. Macros — 6 symbols

C/C++ extractor explicitly does not extract macros today
(`mapLspSymbolKind` doesn't return `"macro"`). These fixtures will all fail
on existence — they're a TODO marker for c-core enhancement.

| Symbol            | File                              |
|-------------------|-----------------------------------|
| `min_t`           | `include/linux/minmax.h`          |
| `max_t`           | `include/linux/minmax.h`          |
| `BUG_ON`          | `include/asm-generic/bug.h`       |
| `WARN_ON_ONCE`    | `include/asm-generic/bug.h`       |
| `container_of`    | `include/linux/container_of.h`    |
| `READ_ONCE`       | `include/asm-generic/rwonce.h`    |

## I. Inline functions in headers — 6 symbols

Exercise Gap 2 (inline-callee detection) from the *callee* side.

| Symbol            | File                              |
|-------------------|-----------------------------------|
| `kref_get`        | `include/linux/kref.h`            |
| `kref_put`        | `include/linux/kref.h`            |
| `list_add`        | `include/linux/list.h`            |
| `list_del`        | `include/linux/list.h`            |
| `atomic_inc`      | `arch/x86/include/asm/atomic.h`   |
| `spin_lock`       | `include/linux/spinlock.h`        |

## J. Global variables — 6 symbols

Exercise the `global_var` symbol kind (currently NOT extracted by clangd-core
— `mapLspSymbolKind` returns `function` for unknown LSP kinds, so globals
become functions in the graph).

| Symbol            | File                              |
|-------------------|-----------------------------------|
| `init_task`       | `init/init_task.c`                |
| `init_mm`         | `mm/init-mm.c`                    |
| `jiffies`         | `kernel/time/timer.c`             |
| `system_state`    | `kernel/main.c`                   |
| `nr_threads`      | `kernel/fork.c`                   |
| `console_drivers` | `kernel/printk/printk.c`          |

## K. Enums and typedefs — 6 symbols

Exercise the `enum`/`typedef` symbol kinds.

| Symbol            | File                              |
|-------------------|-----------------------------------|
| `gfp_t`           | `include/linux/types.h`           |
| `pid_t`           | `include/linux/types.h`           |
| `loff_t`          | `include/linux/types.h`           |
| `irqreturn_t`     | `include/linux/irqreturn.h`       |
| `enum cpuhp_state`| `include/linux/cpuhotplug.h`      |
| `enum lru_list`   | `include/linux/mmzone.h`          |

## L. Structs — 6 symbols

Exercise the `struct` symbol kind plus field extraction (Gap: clangd-core
returns `fields=[]`).

| Symbol            | File                              |
|-------------------|-----------------------------------|
| `task_struct`     | `include/linux/sched.h`           |
| `file`            | `include/linux/fs.h`              |
| `inode`           | `include/linux/fs.h`              |
| `mm_struct`       | `include/linux/mm_types.h`        |
| `sk_buff`         | `include/linux/skbuff.h`          |
| `device`          | `include/linux/device.h`          |

## M. module_init / module_exit pairs — 6 symbols

Exercise Gap 5 (macro-based registration). `module_init(fn)` is a macro that
registers `fn` into the boot-time init array.

| Symbol                | Module file                                 |
|-----------------------|---------------------------------------------|
| `loopback_init`       | `drivers/net/loopback.c` (built-in)         |
| `tun_init`            | `drivers/net/tun.c`                         |
| `mem_init`            | `drivers/char/mem.c`                        |
| `random_init`         | `drivers/char/random.c`                     |
| `dummy_init_module`   | `drivers/net/dummy.c`                       |
| `vt_init`             | `drivers/tty/vt/vt_ioctl.c`                 |

## N. proc / sysfs / debugfs creation — 6 symbols

| Symbol                  | File                              | Registrar              |
|-------------------------|-----------------------------------|------------------------|
| `meminfo_proc_show`     | `fs/proc/meminfo.c`               | `proc_create_single`   |
| `loadavg_proc_show`     | `fs/proc/loadavg.c`               | `proc_create_single`   |
| `version_proc_show`     | `fs/proc/version.c`               | `proc_create_single`   |
| `kernel_attr_show`      | `kernel/ksysfs.c`                 | `sysfs_create_group`   |
| `cpuinfo_open`          | `fs/proc/cpuinfo.c`               | `proc_create_seq`      |
| `stat_open`             | `fs/proc/stat.c`                  | `proc_create`          |

## O. Debugfs file callbacks — 6 symbols

Same pattern as proc, via `debugfs_create_file(name, mode, parent, data, fops)`.

| Symbol                  | File                                   |
|-------------------------|----------------------------------------|
| `clk_summary_show`      | `drivers/clk/clk.c`                    |
| `gpio_pin_show`         | `drivers/gpio/gpiolib-sysfs.c`         |
| `wakeup_sources_stats_open` | `drivers/base/power/wakeup_stats.c`|
| `pm_debug_messages_show` | `kernel/power/main.c`                 |
| `bdi_debug_stats_show`  | `mm/backing-dev.c`                     |
| `slab_debug_trace_open` | `mm/slub.c`                            |

---

**Running total: 11 (already done) + 100 (above) = 111 fixtures.**

After hand-authoring each fixture (or generating it semi-automatically by
querying clangd for the actual call hierarchy and dumping it to JSON), run:

```bash
MCP_URL=http://127.0.0.1:7785/mcp \
  node test/fixtures/linux/run-fixtures.mjs
```

A symbol passes when every relation in `contract.required_relation_kinds`
either reports PASS or `n/a`. WARN-CONTENT-DRIFT is acceptable for the
direct-caller/callee axes (where macro/inline drift is unavoidable) but
should be investigated case-by-case.

The expected first-pass coverage trajectory (assuming the four fixes in
GAP-SUMMARY.md are implemented in order):

| Iteration | New backend capability                                | Expected pass count |
|-----------|-------------------------------------------------------|---------------------|
| 0 (today) | nothing — baseline                                    | 2 / 11              |
| +Fix 1    | generic struct-field-callback classifier              | 6 / 11              |
| +Fix 2    | walk container → registration call                   | 9 / 11              |
| +Fix 3    | SYSCALL_DEFINE* macro detection                       | 11 / 11             |
| +Fix 4    | Linux core registration pack (proc_create, etc.)      | enables N/O fixtures|
| +Fix 5    | macro and global_var extraction in clangd-core        | enables H/J fixtures|
| +Fix 6    | struct field extraction (closes `fields=[]` gap)      | enables L fixtures  |

Each future iteration: add fixtures for the next category, run, fix the
backend until they pass, commit. Don't skip a category — the fixture suite
is a TDD ratchet.
