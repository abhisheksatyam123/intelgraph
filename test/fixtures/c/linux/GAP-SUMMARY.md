# Linux fixture gap summary — first iteration

Snapshot from running 11 starter fixtures against the live intelgraph daemon
on `/home/abhi/qprojects/linux` (Linux kernel 6.12, 7,845 compile units),
clangd background index ~37% warm.

## Result matrix

| Symbol                   | Category                   | direct callers | callees | runtime callers | registrations |
|--------------------------|----------------------------|----------------|---------|-----------------|---------------|
| `count_argc`             | static helper              | ✅ pass         | n/a     | n/a              | n/a            |
| `kstrtoint`              | heavily-called helper      | ✅ 42 callers   | ✅ pass  | n/a              | n/a            |
| `argv_free`              | exported leaf helper       | ⚠ cold index   | ✅ pass  | n/a              | n/a            |
| `argv_split`             | exported leaf helper       | ⚠ cold index   | ⚠ macro/inline drift | n/a   | n/a            |
| `i8042_interrupt`        | IRQ handler (request_irq)  | ⚠ name drift   | n/a     | ❌ no IRQ dispatch | ✅ request_irq |
| `read_mem`               | VFS file_operations.read   | n/a            | ⚠ macro/inline drift | ❌ no VFS dispatch | ❌ no struct-field reg |
| `write_mem`              | VFS file_operations.write  | n/a            | n/a     | ❌ no VFS dispatch | ❌ no struct-field reg |
| `null_lseek`             | VFS file_operations.llseek | n/a            | n/a     | ❌ no VFS dispatch | ❌ no struct-field reg |
| `do_no_restart_syscall`  | fn-ptr-via-struct-field    | n/a            | n/a     | ❌ no fn-ptr-field dispatch | ❌ no struct-field reg |
| `__do_sys_restart_syscall` | SYSCALL_DEFINE0           | n/a            | n/a     | ❌ no syscall table | ❌ macro not detected |
| `__do_sys_sched_yield`   | SYSCALL_DEFINE0            | n/a            | n/a     | ❌ no syscall table | ❌ macro not detected |

**Summary: 2 pass · 9 fail.**

## Gap categories

### Gap 1 — Cold cross-file index (transient, not a backend bug)
The backend faithfully reports what clangd's background index has built so
far. At 37% index, exported helpers like `argv_free`/`argv_split` only see
within-file callers; the dozens of cross-file callers in `kernel/trace/`,
`kernel/reboot.c`, etc. are still pending. **Will resolve as the index warms
to ~80%+.** Affects: `argv_free`, `argv_split`. The runner already prints
the index progress alongside each result.

### Gap 2 — Macro / inline outgoing-call drift (clangd limitation)
clangd's `outgoingCalls` does not always record macro-expanded or inlined
callees. For example `read_mem` calls `kmalloc` (a macro) and `kstrndup`
(inline header function); `argv_split` calls `kmalloc_array` and `isspace`.
These show up as "missing" entries even though the names are correct in the
source. **Currently surfaced as `WARN-CONTENT-DRIFT`** so it doesn't drown
out hard failures. Would need either tree-sitter-based callee extraction or
preprocessor expansion to fully cover.

### Gap 3 — Indirect / runtime caller resolution **(real backend gap)**
The big one. Symbols invoked through a **runtime dispatch path** are not
reported as having those runtime callers:

- **VFS dispatch**: `vfs_read → fp->f_op->read → read_mem` is invisible.
  `lsp_indirect_callers` returns the *container variable* (`mem_fops`)
  instead of the actual runtime caller (`vfs_read`). The dispatch chain
  itself is never reconstructed.
- **IRQ subsystem dispatch**: `do_IRQ → handle_irq_event → i8042_interrupt`
  is invisible, even though the `request_irq()` registration site IS
  detected.
- **Fn-ptr-via-struct-field dispatch**: `current->restart_block.fn(...)`
  → `do_no_restart_syscall` is invisible.

Affects 6 of 11 fixtures (every callback that isn't called directly).

### Gap 4 — Struct-field assignment as registration **(real backend gap)**
When a callback is registered by *assigning it to a struct field* (the
dominant Linux pattern: `static const struct file_operations memory_fops = {
.read = read_mem, ... };`), `lsp_indirect_callers` does not classify the
assignment as a registration. The hardcoded `INIT_PATTERNS` registry only
contains 1 entry, for the WLAN dispatch table. So:

- `memory_fops.read = read_mem` → not classified as a registration
- `memory_fops.write = write_mem` → not classified
- `null_fops.llseek = null_lseek` → not classified
- `restart_block.fn = do_no_restart_syscall` → not classified

Without this classification, the chain resolver never starts, so the
container → registration call (`register_chrdev(MEM_MAJOR, "mem", &memory_fops)`)
is also never followed.

Affects 4 of 11 fixtures.

### Gap 5 — Macro-expanded symbol names **(real backend gap)**
`SYSCALL_DEFINE0(restart_syscall) { ... }` expands (via the kernel's
SYSCALL_DEFINE machinery) to:
- `__do_sys_restart_syscall`  — the actual syscall entry
- `__se_sys_restart_syscall`  — the sign-extension wrapper
- `__x64_sys_restart_syscall` — the arch-specific wrapper

clangd's `prepareCallHierarchy` at the `SYSCALL_DEFINE0(...)` source line
returns nothing, because that line is the macro invocation, not the
function definition. To make these fixtures pass, the backend would need
to:
1. Detect that the line is a `SYSCALL_DEFINE*` macro and extract the syscall
   name (`restart_syscall`).
2. Resolve to the macro-expanded function names and query call hierarchy on
   those.
3. Recognize the macro itself as a "register into syscall table" pattern.

Affects 2 of 11 fixtures (will affect ~hundreds across the kernel).

## What works ✅

- **Direct caller queries** via `lsp_incoming_calls` work correctly when
  clangd's background index has reached the relevant translation units.
  At 37% index, `kstrtoint` returns 42 cross-file callers cleanly.
- **Direct callee queries** via `lsp_outgoing_calls` work for non-macro,
  non-inline callees.
- **request_irq-style registration** is detected by the auto-classifier
  (`registrations_in: PASS` for `i8042_interrupt`).
- **Within-file caller queries** (e.g. `count_argc` ← `argv_split`) work
  even with a fully cold cross-file index.

## Recommended fix order (for the next iteration)

1. **Add a generic struct-field-callback classifier** (~50 LOC change in
   `src/tools/pattern-detector/auto-classifier.ts` plus an INIT_PATTERN
   fallback). Closes Gap 4 entirely.
2. **Walk container → registration call** (~150 LOC change to follow the
   container variable to its registration site via `lsp_references`).
   Closes Gap 3 partially for the VFS family.
3. **Detect SYSCALL_DEFINE\* macro lines** (~80 LOC, new pattern in the
   detector). Closes Gap 5.
4. **Add a "Linux core registration APIs" pattern pack** (15-20 entries
   for `register_chrdev`, `request_irq`, `proc_create`, `debugfs_create_file`,
   etc., parallel to the WLAN pack). Closes the rest of Gap 3.
