---
tags:
  - status/wip
description: [Index](#index) — component identity and overview
---

# module-wlan-fixture-corpus

## Index

- [Index](#index) — L9
- [Purpose](#purpose) — L19
- [Canonical fields](#canonical-fields) — L28
- [Entity families](#entity-families) — L42
- [Relation buckets](#relation-buckets) — L112
- [Contract model](#contract-model) — L145
- [Data flow](#data-flow) — L192
- [Quality](#quality) — L204

## Purpose

The WLAN fixture corpus is the source of truth for entity-family schema, relations, and verification contracts. Each JSON fixture file represents one entity (API, struct, ring, thread, etc.) with:
- Canonical metadata (kind, canonical_name, source location, description, aliases)
- Relations buckets containing cross-references (calls, registrations, structures, logs, etc.)
- Contract expectations (required relation kinds, minimum counts, required path patterns)

The fixture corpus feeds into backend reconciliation tests: mock DB rows are built from fixture relations, injected into intelligence_query tool, and compared against backend responses. Mismatches are reported at (entity, relation_bucket, field) granularity.

## Canonical fields

Every entity fixture contains these required fields:
- `kind` (string) — entity family identifier: api, struct, ring, hw_block, thread, signal, interrupt, timer, dispatch_table, message, log_point
- `kind_verbose` (string) — human-readable family label (e.g. "application_programming_interface", "structure_type")
- `canonical_name` (string) — stable identifier used in queries and backend lookups
- `aliases` (array of strings) — alternate names/symbols from source code (may be empty)
- `source` (object) — location in WLAN workspace:
  - `file` (string) — relative path from workspace root
  - `line` (number) — declaration line number
- `description` (string) — semantic description of the entity's role
- `relations` (object) — relation buckets (see [[#Relation buckets]])
- `contract` (object, optional) — verification expectations; present on most entities (see [[#Contract model]])

## Entity families

11 entity families in the fixture corpus (from `test/fixtures/wlan/index.json`):

**API** (61 fixtures)
- Application entry points, handlers, lifecycle functions
- Canonical: wlan_thread_irq_route_wmac_tx, WMIRecvMessageHandler, wal_tqm_process_status_ring
- Family-specific: may have complex call chains, runtime dispatch derivations, registrations
- Relations: calls_in_direct, calls_in_runtime, calls_out, registrations_in, registrations_out, structures, logs, owns, uses

**Struct** (2 fixtures)
- Data structures with field access patterns
- Canonical: wlan_peer_t, bpf_vdev_t
- Family-specific: has `fields` array describing struct members
- Relations: structures (field reads/writes), owns, uses

**Ring** (1 fixture)
- Hardware ring endpoints (DMA rings)
- Canonical: wbm_release_ring
- Family-specific: registrations_out (ring → handler callback), uses (runtime consumer)
- Relations: registrations_out, uses

**HW block** (1 fixture)
- Hardware execution engines
- Canonical: reo_destination
- Family-specific: registrations_out (hw → handler), uses (thread consumer)
- Relations: registrations_out, uses

**Thread** (1 fixture)
- Firmware execution threads
- Canonical: data_offld_thread
- Family-specific: calls_in_runtime (hw/ring triggers), calls_out (dispatch to handlers), registrations_out
- Relations: calls_in_runtime, calls_out, registrations_out

**Signal** (1 fixture)
- Inter-thread synchronization signals
- Canonical: cmnos_thread_irq_signal
- Family-specific: calls_in_runtime (fired by ISR); typically no outgoing
- Relations: calls_in_runtime

**Interrupt** (1 fixture)
- Hardware interrupt sources
- Canonical: A_INUM_TQM_STATUS_HI
- Family-specific: calls_out (hw → thread), registrations_out (hw → ISR handler)
- Relations: calls_out, registrations_out

**Timer** (1 fixture)
- OS timer triggers
- Canonical: cmnos_timer_nondef_private
- Family-specific: calls_out (timer → callback), registrations_out (timer → handler)
- Relations: calls_out, registrations_out

**Dispatch table** (1 fixture)
- Packet/message routing tables
- Canonical: offldmgr_dispatch_table
- Family-specific: calls_out (dispatch edges to handlers), registrations_in (handlers register)
- Relations: calls_out, registrations_in

**Message** (1 fixture)
- Inter-thread message IDs
- Canonical: OFFLD_MSG_NON_DATA
- Family-specific: calls_in_runtime (source thread), calls_out (dispatch to handler)
- Relations: calls_in_runtime, calls_out

**Log point** (1 fixture)
- Static log emission sites
- Canonical: bpf_filter_log
- Family-specific: logs only; maps to source API name
- Relations: logs

## Relation buckets

Each fixture's `relations` object contains buckets for cross-references. All buckets are present but may be empty arrays:

**Incoming flow:**
- `calls_in_direct` — static direct calls to this entity
- `calls_in_runtime` — runtime invocations (dispatch chains, hw triggers)
- `registrations_in` — registrations where this entity is the callback/handler

**Outgoing flow:**
- `calls_out` — direct calls made by this entity
- `registrations_out` — registrations this entity registers with (handler or consumer)

**Data structure references:**
- `structures` — struct field access (reads/writes) by APIs

**Logs:**
- `logs` — log emission sites linked to APIs

**Ownership and use:**
- `owns` — data ownership relationships
- `uses` — dependency/operational relationships

Each relation entry is an object containing:
- Core metadata: caller/callee, registrar/callback, api/struct/field
- `edge_kind` — protocol format (call_direct, call_runtime, register, dispatch, read, write, mutate, emit_log, use, etc.)
- `edge_kind_verbose` — human-readable equivalent
- `derivation` — source of knowledge (clangd, runtime, c_parser)
- `confidence` (0.0 - 1.0) — derivation confidence
- `evidence` — supporting evidence (loc with file/line)
- `dispatch_chain` (optional) — runtime path for runtime_invokes_api edges
- `runtime_trigger` (optional) — human description for runtime edges

## Contract model

Each fixture contains an optional `contract` object specifying verification expectations. This is the fixture's self-declared ground truth.

Contract fields:
- `required_relation_kinds` (array) — edge_kind values that MUST be present (e.g. ["call_runtime", "register"])
- `required_directions` (array) — allowed flow directions: "incoming", "outgoing", "bidirectional"
- `minimum_counts` (object) — per-bucket minimums (e.g. { "calls_in_runtime": 1, "calls_out": 1 })
- `required_path_patterns` (array) — topological invariants:
  - `name` — pattern identifier
  - `nodes` — sequence of entity families that must form a path
  - `description` — semantic meaning

Example (API):
```json
{
  "required_relation_kinds": ["call_runtime", "call_direct", "register"],
  "required_directions": ["incoming", "outgoing"],
  "minimum_counts": {
    "calls_in_runtime": 1,
    "calls_out": 1,
    "registrations_in": 1
  }
}
```

Example (Ring):
```json
{
  "required_relation_kinds": ["register", "use"],
  "required_directions": ["outgoing"],
  "minimum_counts": {
    "registrations_out": 1,
    "uses": 1
  },
  "required_path_patterns": [
    {
      "name": "ring_to_isr",
      "nodes": ["interrupt", "ring", "api"],
      "description": "HW interrupt → ring → handler"
    }
  ]
}
```

The contract is the source of truth for backend reconciliation tests: fixture relations are used to build mock DB rows; backend query results are validated against contract expectations.

## Data flow

Source → Fixture → Reconciliation tests:

1. **Fixture generation**: Binary analysis extracts entity metadata, relations, and call chains from WLAN workspace source
2. **Storage**: Canonical JSON fixture per entity, organized by family in `test/fixtures/wlan/{family}/{canonical_name}.json`
3. **Manifest**: `test/fixtures/wlan/index.json` lists all 69 fixtures grouped by family
4. **Mock DB row production**: Backend reconciliation tests (`test/unit/intelligence/backend-reconciliation.test.ts`) build mock DB rows by translating fixture relations to backend edge_kind vocabulary (PROTOCOL_TO_DB_EDGE_KIND map)
5. **Query execution**: Mock rows injected via setIntelligenceDeps; intelligence_query tool called with canonical_name and family-specific intents
6. **Comparison**: Backend response compared against fixture contract expectations at (entity, relation_bucket, field) granularity
7. **Reporting**: Mismatches reported as schema violations, confidence degradation

## Quality

**Inventory completeness:**
- 11 entity families documented with 69 total fixtures
- 61 APIs (64+ pre-enrich versions for enrichment tracking)
- 2 structs, 1 ring, 1 hw_block, 1 thread, 1 signal, 1 interrupt, 1 timer, 1 dispatch_table, 1 message, 1 log_point
- Schema is homogeneous: all entities follow the same canonical-fields + relations + contract structure
- Contracts present on most fixtures; contract fields are optional but recommended

**Gaps and inconsistencies:**
- Some fixtures may be empty (e.g., registrations_out present but empty if not applicable)
- Contract fields are currently optional; some fixtures may lack explicit verification contracts
- Struct fixtures (2) have `fields` array not present on other families — struct-specific extension
- Log point fixtures focus only on `logs` bucket; other buckets empty
- Derivation mix: clangd (static analysis), runtime (dispatch chain analysis), c_parser (field access) — confidence varies by source
- Pre-enrich versions (.pre-enrich) mark fixtures before enrichment; post-enrich versions are authoritative

**Audit artifacts:**
- `test/fixtures/wlan/wlan-gap-audit-report.json` — completeness audit by API
- `test/fixtures/wlan/_ground_truth_symbol_audit.json` — symbol coverage report
- `test/fixtures/wlan/relation-alias-candidates-batch2.json` — candidate alias refinements
- `test/fixtures/wlan/runtime-caller-*` — coverage and comparison reports

**Next steps (for subsequent items):**
- Contract validation: ensure all fixtures have explicit contracts before reconciliation
- Mismatch taxonomy: define severity and remediation rules per mismatch class
- Confidence scoring: map fixture completeness (tier1/tier2/tier3) to release confidence thresholds
