# Linux kernel ground-truth fixtures

Per-symbol JSON fixtures used to verify intelgraph's c/cpp backend can correctly
discover **every relation** for a diverse set of real Linux kernel symbols.

Mirror of `test/fixtures/wlan/api/` but for the Linux kernel checkout at
`/home/abhi/qprojects/linux`. Each fixture is the **ground truth** for one
symbol — extracted manually via `grep`/`rg` against real kernel source — and
the fixture runner (`test/fixtures/linux/run-fixtures.mjs`) compares the live
backend's MCP responses against this ground truth, marking each relation kind
PASS or FAIL.

A fixture only **passes** when the backend can correctly answer every required
relation:

- **`calls_in_direct`** — direct callers via `lsp_incoming_calls`
- **`calls_in_runtime`** — runtime invokers via the dispatch chain (e.g. VFS
  layer for `file_operations` callbacks, IRQ subsystem for IRQ handlers)
- **`calls_out`** — direct callees via `lsp_outgoing_calls`
- **`registrations_in`** — APIs that register this function as a callback
  (`register_chrdev`, `request_irq`, struct-field assignment, `module_init`, …)
- **`registrations_out`** — callbacks this function itself registers
- **`structures`** — struct fields this function reads/writes
- **`logs`** — log emission sites in this function

## File layout

```
test/fixtures/linux/
├── README.md                  ← this file
├── api/                       ← per-symbol fixtures, one JSON per symbol
│   ├── argv_split.json
│   ├── argv_free.json
│   ├── ...
├── results/                   ← runner output, one JSON per pass
│   └── pass-<timestamp>.json
└── run-fixtures.mjs           ← the comparator runner
```

## Workspace assumption

Fixtures are written against `/home/abhi/qprojects/linux` (Linux kernel 6.12,
7,845 compile units in `compile_commands.json`). Source-line numbers in the
fixtures are valid for that exact tree.

## Pass criteria

A fixture is **PASS** iff for every entry in `contract.required_relation_kinds`:

1. The backend returns at least `contract.minimum_counts[relation]` rows.
2. Every entry in the fixture's `relations.<kind>[]` array is matched by a row
   in the backend response (by `caller`/`callee`/`registrar` name + file:line).

A fixture is **FAIL** if any required relation kind is missing or any expected
ground-truth row is absent. The runner reports the specific missing pieces so
the backend can be improved iteratively.

## Iteration loop

The backend is **not** expected to pass every fixture today — many relations
(struct-field reads/writes, file_operations callback registration chains,
runtime caller resolution) are documented backend gaps. The fixtures act as a
TDD-style coverage matrix: as the backend implements each missing pipeline,
fixtures flip from FAIL to PASS one at a time, and the gap report shrinks.
