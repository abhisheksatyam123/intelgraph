# Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all known gaps to make intelgraph production-ready for C/C++, TS, and Rust code intelligence.

**Architecture:** 5 independent fixes, each touching different files, mergeable in any order. All follow the existing `core >> plugin >> sub-plugin` architecture.

**Tech Stack:** TypeScript, tree-sitter, clangd LSP, SQLite (better-sqlite3), Vitest

---

### Task 1: TS cross-file .js/.ts extension normalization

**Problem:** When TS code imports `from "./foo.js"`, ts-core stores the edge dst as `module:src/foo.js#bar` but the node is `module:src/foo.ts#bar`. The `.js`→`.ts` mismatch breaks cross-file caller lookups.

**Files:**
- Modify: `src/plugins/ts-core/extractor.ts` — normalize `.js`→`.ts` when resolving import-based call destinations
- Test: `test/unit/plugins/ts-core.test.ts` — add test for cross-extension resolution

- [ ] Step 1: In ts-core's call-edge emission, when the resolved dst contains `.js` and a `.ts` file exists at that path, normalize to `.ts`
- [ ] Step 2: Run ts-core unit tests
- [ ] Step 3: Re-run deep verifier on ts/intelgraph — expect relation match to rise from 8,645 toward 8,653
- [ ] Step 4: Commit

---

### Task 2: WLAN dispatch chain templates + HW entities

**Problem:** `wlan/index.ts` has `dispatchChains: []` and `hwEntities: []`. WLAN callbacks can't get runtime chain resolution during extraction.

**Files:**
- Create: `src/plugins/clangd-core/packs/wlan/dispatch-chains.ts`
- Create: `src/plugins/clangd-core/packs/wlan/hw-entities.ts`
- Modify: `src/plugins/clangd-core/packs/wlan/index.ts` — wire new files

- [ ] Step 1: Create dispatch-chains.ts with templates for CMNOS IRQ, WMI event dispatch, offload manager, WoW notification
- [ ] Step 2: Create hw-entities.ts with CMNOS firmware, WMI subsystem, HIF transport, offload manager entities
- [ ] Step 3: Wire into wlan/index.ts
- [ ] Step 4: Typecheck + unit tests
- [ ] Step 5: Commit

---

### Task 3: SYSCALL_DEFINE macro detection

**Problem:** `SYSCALL_DEFINE0(restart_syscall)` expands to `__do_sys_restart_syscall` which clangd can't resolve at the macro line.

**Files:**
- Create: `src/plugins/clangd-core/phases/syscall-macros.ts` — detect SYSCALL_DEFINE* lines and emit symbols + edges
- Modify: `src/plugins/clangd-core/extractor.ts` — add Phase 8 call
- Modify: `src/plugins/clangd-core/packs/linux/pm.ts` — add SYSCALL_DEFINE* patterns if needed

- [ ] Step 1: Write a tree-sitter/regex detector for lines matching `SYSCALL_DEFINE[0-6](name, ...)` that emits a function node for `__do_sys_<name>` and a `registers_callback` edge from `syscall_table` to the handler
- [ ] Step 2: Add dispatch chain template for syscall dispatch
- [ ] Step 3: Wire as Phase 8 in extractor.ts
- [ ] Step 4: Test against Linux kernel/signal.c (restart_syscall, pause) and kernel/sched/syscalls.c (sched_yield)
- [ ] Step 5: Commit

---

### Task 4: Integration tests for Phases 3-7

**Problem:** Only Phases 1-2 have unit tests. Phases 3-7 have no automated tests — only manual fixture verification.

**Files:**
- Create: `test/integration/clangd-core-phases.test.ts` — integration test that extracts a small C fixture workspace and verifies all edge kinds are produced

- [ ] Step 1: Create a minimal C fixture workspace in test/fixtures with 2-3 files containing: a function that calls another, a struct-field initializer (.read = handler), a log macro call (printk), struct field access (ptr->field), and a #include
- [ ] Step 2: Write integration test that runs ExtractorRunner on the fixture, then queries the SQLite db for each edge kind
- [ ] Step 3: Assert: calls > 0, contains > 0, imports > 0, logs_event > 0, reads_field > 0, writes_field > 0, registers_callback > 0
- [ ] Step 4: Run and verify
- [ ] Step 5: Commit

---

### Task 5: Merge to main

- [ ] Step 1: Run full test suite: `bun x vitest run test/unit/`
- [ ] Step 2: Run deep verifier on all 3 languages
- [ ] Step 3: `git checkout main && git merge --no-ff feat/multi-lang-fixture-infra`
- [ ] Step 4: Push (if requested)
