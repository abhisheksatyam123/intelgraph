# Runtime Caller Resolution — Design Spec

**Date**: 2026-04-09
**Status**: Implementation-ready
**Goal**: Trace how a C function gets invoked at runtime through HW
interrupts, callback registrations, dispatch tables, and fn-ptr chains.
This is the core reason intelgraph exists.

## Current State

The pattern-resolver (`src/tools/pattern-resolver/index.ts`, 1400 LOC)
has a 4-stage pipeline: Registration → Store → Dispatch → Trigger. It
works for WLAN's custom APIs but fails on Linux kernel patterns because
Linux uses macros + inline functions that clangd's LSP can't resolve.

## Architecture: clangd + rg + tree-sitter (all three)

```
                    ┌──────────────────────────────────────┐
                    │  Pattern Resolver (4 stages)          │
                    │                                        │
                    │  For each stage, try 3 sources:        │
                    │  1. clangd LSP (definition, refs, …)   │
                    │  2. ripgrep (text search across files)  │
                    │  3. tree-sitter (AST walk in body)      │
                    │                                        │
                    │  Pick the highest-confidence result.    │
                    └──────────────────────────────────────┘
```

Core principle: **clangd for what it's good at (cross-file symbol
resolution, call hierarchy), ripgrep for fast text search (finding
registration sites, dispatch patterns), tree-sitter for precise
local-scope analysis (argument extraction, field access parsing).**

## The 4 Fixes

### Fix 1: IRQ/Timer/Workqueue dispatch short-circuits (sub-plugin)

**Problem**: `request_irq(IRQ, handler)` is detected as a registration,
but the resolver can't trace through the kernel IRQ subsystem to find
`do_IRQ → handle_irq_event → handler` because the store/dispatch are in
kernel core code that clangd doesn't fully index.

**Fix**: Add **dispatch chain templates** to the sub-plugin pack. For
well-known registration APIs whose runtime dispatch path is architecturally
fixed, the pack contributes a pre-built dispatch chain:

```typescript
// In packs/linux/dispatch-chains.ts
export interface DispatchChainTemplate {
  /** Registration API this template applies to. */
  registrationApi: string
  /** The fixed runtime dispatch chain from trigger to callback. */
  chain: string[]
  /** What triggers the dispatch. */
  triggerKind: "hardware_interrupt" | "timer_expiry" | "workqueue" | "signal" | "event"
  /** Human-readable trigger description template. %KEY% is replaced with the dispatch key. */
  triggerDescription: string
}

const linuxDispatchChains: DispatchChainTemplate[] = [
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
    registrationApi: "timer_setup",
    chain: ["timer_expiry", "run_timer_softirq", "call_timer_fn", "%CALLBACK%"],
    triggerKind: "timer_expiry",
    triggerDescription: "Timer expiry callback",
  },
  {
    registrationApi: "INIT_WORK",
    chain: ["workqueue_thread", "process_one_work", "%CALLBACK%"],
    triggerKind: "workqueue",
    triggerDescription: "Workqueue deferred work callback",
  },
  // ... similar for kthread_run, register_chrdev → VFS, etc.
]
```

When the resolver's L3 (store) fails, it checks if the registration API
has a dispatch-chain template. If so, it uses the template to fill in the
chain directly — L3/L4/L5 are all satisfied in one shot.

**Effort**: Small (~50 LOC in pack, ~30 LOC in resolver). Highest leverage.

### Fix 2: VFS container → registration site chaining (rg + tree-sitter)

**Problem**: The struct-field classifier detects `.read = read_mem` in
`mem_fops` but doesn't follow `mem_fops` to where it's registered (e.g.
`register_chrdev(MEM_MAJOR, "mem", &memory_fops)`).

**Fix**: After the struct-field classifier returns a `viaRegistrationApi`
(the container variable name, e.g. `mem_fops`), use **ripgrep** to find
all references to that variable across the workspace:

```
rg --json "\\bmem_fops\\b" --glob "*.c" --glob "*.h"
```

Then for each hit, use tree-sitter to check if the reference is an
**argument to a known registration API** (from the pack's callPatterns).
If so, chain them: callback → container → registration call.

This produces the dispatch chain:
`read() syscall → vfs_read → fp->f_op->read → read_mem`

**Effort**: Medium (~100 LOC). Uses existing rg service + pack callPatterns.

### Fix 3: Function-body fn-ptr assignment detection (tree-sitter)

**Problem**: `current->restart_block.fn = do_no_restart_syscall` is an
assignment_expression inside a function body, not a file-scope struct
initializer. The generic classifier only handles initializer_list nodes.

**Fix**: Add a third classification pass in `classifyReference()`:

```
Pass 1: function-call registration (CALL_PATTERNS)
Pass 2: struct-field initializer (INIT_PATTERNS + generic)
Pass 3: NEW — assignment_expression where RHS is the callback name
```

For Pass 3: when `findEnclosingCall` and `findEnclosingConstruct` both
return null, use tree-sitter to find the nearest `assignment_expression`
node that contains the callback identifier as the RHS. Extract the LHS
field path (`current->restart_block.fn`) as the registration container.

**Effort**: Medium (~80 LOC in detector.ts).

### Fix 4: Write runtime_calls edges to SQLite during extraction (not just query-time)

**Problem**: Currently `runtime_calls` edges are only written when the
`intelligence_ingest` MCP tool is explicitly called with WLAN ground-truth
records. The fixture verifier checks the SQLite graph but finds nothing
because no extraction phase produces runtime_calls.

**Fix**: Add a Phase 4 to the clangd-core extractor that, for each
function, runs the pattern-resolver's chain resolution and writes the
result as a `runtime_calls` edge to the graph store. This makes the
runtime caller graph queryable from the SQLite DB without a running daemon.

**Effort**: Medium (~100 LOC in extractor.ts). Depends on Fixes 1-3 being
in place so the resolver actually produces results.

## Implementation Order

1. **Fix 1** (dispatch chain templates) — highest leverage, unblocks i8042_interrupt runtime chain
2. **Fix 2** (container → registration chaining) — unblocks read_mem VFS chain
3. **Fix 3** (fn-body assignment detection) — unblocks do_no_restart_syscall
4. **Fix 4** (write to SQLite during extraction) — makes everything queryable

## Fixture Coverage Target

After all 4 fixes:
- `i8042_interrupt.calls_in_runtime`: PASS (dispatch chain template for request_irq)
- `read_mem.calls_in_runtime`: PASS (container→registration + VFS template)
- `write_mem.calls_in_runtime`: PASS (same)
- `null_lseek.calls_in_runtime`: PASS (same)
- `do_no_restart_syscall.calls_in_runtime`: PASS (fn-body assignment)
- `__do_sys_restart_syscall` / `__do_sys_sched_yield`: Still FAIL (SYSCALL_DEFINE macro — separate issue)

## Sub-plugin Separation

All project-specific knowledge stays in packs:
- **linux/dispatch-chains.ts**: IRQ, timer, workqueue, VFS dispatch templates
- **wlan/dispatch-chains.ts**: WMI dispatch, CMNOS IRQ, offload manager chains
- **Core resolver** (`pattern-resolver/index.ts`): generic 4-stage logic + template fallback

No Linux or WLAN knowledge in the resolver itself.
