# Multi-language fixture testing infra

This directory holds the **per-project fixture suites** and the **test
runners** that verify intelgraph's extractor pipeline correctly populates
the SQLite intelligence graph for every entity and relation we expect.

It is designed around three distinct test harnesses, each answering a
different question about the backend:

| Runner | Question | Verification surface |
|---|---|---|
| `linux/run-fixtures.mjs` | "Does the live MCP daemon return the expected callers/callees for a symbol?" | clangd LSP via `lsp_incoming_calls` / `lsp_indirect_callers` (text-mode) |
| `run-multi-lang.mjs` | "Does the extractor put the symbol's NODE into the SQLite graph at all?" | direct `graph_nodes` lookup by canonical_name |
| **`verify-fixtures.mjs`** | **"Does every RELATION in the fixture match an actual edge in the graph?"** | direct `graph_edges` lookup per relation kind, per direction, per expected referrer/referent |

The third one — `verify-fixtures.mjs` — is the load-bearing test infra
the user asked for. It is the only runner that produces a true
relation-level pass rate ("74% of relations matched") rather than a
fixture-level pass rate ("9 of 10 fixtures had their nodes extracted").

## Layout

```
test/fixtures/
├── TESTING.md                       ← you are here
├── run-multi-lang.mjs               ← node-level verifier (one symbol = one row)
├── verify-fixtures.mjs              ← deep relation verifier (one symbol = N relations)
├── oracle-fixture.mjs               ← derive a fixture from the daemon's MCP tools (C/C++)
├── c/
│   ├── linux/                       ← linux kernel fixtures
│   │   ├── api/<category>/          ← organized by symbol category
│   │   ├── results/                 ← runner output snapshots
│   │   ├── README.md
│   │   ├── GAP-SUMMARY.md           ← which categories of relation the backend can/can't find
│   │   ├── NEXT-90-SYMBOLS.md       ← roadmap for the next 100 fixtures
│   │   └── run-fixtures.mjs         ← linux-specific MCP-tool runner
│   └── wlan/                        ← 60 pre-existing WLAN fixtures
├── ts/
│   └── intelgraph/                  ← intelgraph-self TS fixtures
│       ├── api/<category>/
│       └── results/
└── rust/
    └── markdown-oxide/              ← markdown-oxide Rust fixtures
        ├── api/<category>/
        └── results/
```

Inside each `<project>/api/` the fixtures are grouped by symbol category
(`vfs_callback/`, `irq_handler/`, `function/`, `class/`, `interface/`,
`enum/`, `struct/`, `impl_trait/`, `module/`, `derive/`, …) so you can
target one category at a time with the runner's `FIXTURE_FILTER` env var
or by passing a directory deeper than `api/`.

## Fixture format

One JSON file per API/symbol. Required top-level fields:

```jsonc
{
  "kind": "function",                     // node kind expected in graph_nodes
  "canonical_name": "module:src/foo.ts#bar",  // exact key the verifier looks up
  "category": "exported_function",        // grouping label
  "source": {
    "file": "src/foo.ts",
    "line": 42,
    "character": 8                        // 1-based; matches LSP position semantics
  },
  "description": "...",
  "relations": {
    // every relation kind below is optional; only the ones you list
    // get verified. The deep verifier walks each present key.
    "calls_in_direct":    [{ "caller": "...", "file": "...", "line": 42 }, ...],
    "calls_out":          [{ "callee": "..." }, ...],
    "references_type_in": [{ "referrer": "...", "type": "..." }, ...],
    "references_type":    [{ "type": "..." }, ...],   // outgoing
    "imports_out":        [{ "to": "..." }, ...],
    "implements":         [{ "type": "..." }, ...],
    "extends":            [{ "type": "..." }, ...],
    "contains_methods":          ["constructor", "run", ...],
    "contains_top_level_exports":["foo", "bar", ...],
    "contains_modules":          ["mod_a", "mod_b", ...],
    "contains_variants":         ["Ignore", "Smart", ...],
    "field_kinds_present":       ["a", "b", ...]
  },
  "contract": {
    "required_node_kinds": ["function"],
    "minimum_caller_count": 1,             // optional minimums
    "notes": "..."
  },
  "ground_truth_metadata": {
    "extracted_from": "intelgraph_self",
    "method": "manual_grep_against_/home/abhi/qprojects/intelgraph"
  }
}
```

## Pass criteria — `verify-fixtures.mjs`

For each fixture:

1. **Node lookup**: the fixture's `canonical_name` must resolve to a row in
   `graph_nodes` for the snapshot we just wrote. If not → `node-missing`.
2. **Per-relation check**: for every key in `fixture.relations` that has a
   corresponding checker in the verifier, query `graph_edges` for the
   matching `edge_kind` in the right direction, then verify each expected
   entry (by name match against the actual `dst_node_id`/`src_node_id`).
3. **Reported status**:
   - `pass` — every relation key matched 100%
   - `partial` — some relations matched, some have missing entries
   - `fail-all-relations` — node found but every relation reported zero matches
   - `node-only` — node exists, fixture had no relation expectations
   - `node-missing` — fixture's symbol not in the graph

The runner also reports a global **relation-level pass rate** —
`X/Y relations matched (Z%)` — which is the metric to optimise.

## Iteration loop — oracle → verify → patch

The user's goal is a workflow where:

```
        ┌─────────────────────────────────────────────────────┐
        │  ORACLE (manual or LLM-driven, via file ops + LSP)  │
        │  Looks at a symbol, derives every relation it has   │
        │  from raw source + ripgrep + clangd's call hierarchy│
        │  → emits a fixture JSON                             │
        └─────────────────────────────┬───────────────────────┘
                                      │
                                      ▼
        ┌─────────────────────────────────────────────────────┐
        │  EXTRACTOR (intelgraph's BUILT_IN_EXTRACTORS)       │
        │  Processes the workspace into graph_nodes/edges     │
        └─────────────────────────────┬───────────────────────┘
                                      │
                                      ▼
        ┌─────────────────────────────────────────────────────┐
        │  DEEP VERIFIER (verify-fixtures.mjs)                │
        │  Compares the oracle's fixture against the graph.   │
        │  Reports per-relation PASS / PARTIAL / MISSING with │
        │  exact missing entries.                             │
        └─────────────────────────────┬───────────────────────┘
                                      │
                                      ▼
        ┌─────────────────────────────────────────────────────┐
        │  PATCH (whichever is the smaller change)            │
        │  - Backend extractor missing a pattern? → add it    │
        │    to the appropriate sub-pack                      │
        │    (e.g. src/plugins/clangd-core/packs/linux/)      │
        │  - Or core code path needed? → add it to the plugin │
        │    extractor itself                                 │
        │  - Or schema gap? → enhance schema (rare)           │
        └─────────────────────────────┬───────────────────────┘
                                      │
                                      ▼
                          re-run verify ⟳
```

The `oracle-fixture.mjs` script is the **mechanized oracle**: it spawns
no LLM, but it walks the same MCP tool endpoints an LLM would walk and
emits a fixture from what it sees. Currently it works best for C/C++
workspaces because intelgraph's `lsp_*` MCP tools route through clangd
and clangd is the language server with the richest call-hierarchy data.
For TypeScript and Rust the oracle path is:

1. Run `verify-fixtures.mjs` against the workspace → it produces the
   on-disk SQLite graph at `/tmp/intelgraph-verify-<lang>-<project>.db`.
2. Pick the symbol you want to fixture.
3. Query `graph_edges` directly for every edge involving that symbol.
4. Have a human (or LLM) cross-check the result against the actual
   source — anything the source has that the graph DOESN'T points at a
   missing pattern in the relevant sub-plugin pack.
5. Add the pattern, re-run, repeat.

For this iteration I authored fixtures **manually** (carefully grepping
each symbol against the actual source), which is itself a valid oracle —
just with a human in the loop. The mechanized oracle is the next
unlock so we can scale from 30 fixtures to 300 without grep RSI.

## Live results — first deep-verify pass

| project | fixture-level | relation-level | notes |
|---|---|---|---|
| **ts/intelgraph** | 2 pass · 6 partial · 1 fail · 1 node-only | **51/69 = 74%** | Real backend: needs smarter caller-name matching for member calls (`JSON.parse`, `path.resolve`) |
| **rust/markdown-oxide** | 5 pass · 1 partial · 2 fail · 2 node-only | **35/44 = 80%** | Real backend gap: rust-core doesn't extract calls inside trait method bodies |
| **c/linux** (lib scope) | 0 pass · 1 partial · 3 fail · 7 node-missing | **1/22 = 5%** | Cold clangd extraction + 200-file walk limit; documented gaps from earlier turns |

The **74% / 80% / 5%** spread is the real backend coverage signal,
unmuddied by fixture-level pass/fail. The verifier exposes:

- **Real backend gaps** that need a sub-plugin pack pattern (rust-core
  trait-method-body call extraction; ts-core member-call name normalization)
- **Real fixture quality bugs** (Vault field names I guessed wrong before
  reading the source; impl_trait fixtures pointing at non-existent nodes)

Both classes of issue are useful. The first becomes a backend patch; the
second becomes a fixture rewrite.

## Adding a new fixture (manual oracle)

```bash
# 1. Pick a symbol with `git grep` or your editor
# 2. Read the surrounding code; note its callers, callees, fields, etc.
# 3. Author the fixture JSON in test/fixtures/<lang>/<project>/api/<category>/<symbol>.json
# 4. Run the deep verifier
npx tsx test/fixtures/verify-fixtures.mjs <lang> <project> <workspace_root>
# 5. If a relation reports MISSING:
#    - confirm in the source whether the relation actually exists
#    - if it does → backend gap → patch the pack or plugin
#    - if it doesn't → fixture bug → fix the fixture
```

## Adding a new fixture (mechanized oracle)

For C/C++ workspaces — has a running daemon:

```bash
MCP_URL=http://127.0.0.1:7785/mcp \
  node test/fixtures/oracle-fixture.mjs \
    --workspace /home/abhi/qprojects/linux \
    --file lib/kstrtox.c \
    --line 259 --character 5 \
    --out test/fixtures/c/linux/api/oracle/kstrtoint.json
```

For TypeScript or Rust workspaces (extract first, then query the graph
directly) — TODO, the script currently goes through `lsp_*` tools which
are clangd-only. The path forward is to teach the oracle to use the
SQLite graph as its evidence source for non-C languages.
