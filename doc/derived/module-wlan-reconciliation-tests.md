---
tags:
  - status/wip
description: [Index](#index) — test suite identity and role
---

# module-wlan-reconciliation-tests

## Index

- [Index](#index) — L9
- [Purpose](#purpose) — L18
- [Test structure](#test-structure) — L30
- [Family-intent mapping](#family-intent-mapping) — L56
- [Edge kind translation](#edge-kind-translation) — L95
- [Data flow](#data-flow) — L125
- [Quality](#quality) — L152

## Purpose

Layer 3 of the WLAN ground-truth verification stack. For every entity fixture in the corpus, the backend reconciliation test suite:
1. Loads fixture relations from `test/fixtures/wlan/{family}/{name}.json`
2. Translates fixture edge_kind (protocol format) to DB edge_kind (storage format) via PROTOCOL_TO_DB_EDGE_KIND map
3. Builds mock DB rows (records to inject into the backend query layer)
4. Calls intelligence_query tool with entity canonical_name and family-specific intents
5. Compares backend response to fixture contract expectations
6. Reports mismatches at (entity, relation_bucket, field) granularity

Tests run entirely with mocked DB rows — no live backend required. The fixture is the source of truth; the backend must match it.

## Test structure

Test file: `test/unit/intelligence/backend-reconciliation.test.ts`

Core functions:
- `loadManifest()` — reads `test/fixtures/wlan/index.json`, returns { families: Record<family, name[]> }
- `loadFixture(family, name)` — reads `test/fixtures/wlan/{family}/{name}.json`
- `PROTOCOL_TO_DB_EDGE_KIND` — translates fixture edge_kind to backend vocabulary:
  - call_direct → calls
  - call_runtime → runtime_calls
  - register → registers_callback
  - dispatch → dispatches_to
  - read/write/init/mutate → reads_field/writes_field
  - emit_log → logs_event
  - use → operates_on_struct
  - owner → owns

Execution flow per family:
1. Iterate SUPPORTED_FAMILIES: api, struct, ring, hw_block, thread, signal, interrupt, timer, dispatch_table, message, log_point
2. Load all fixtures for that family from manifest
3. For each fixture, iterate FAMILY_INTENTS[family] (query intents specific to that family)
4. Build mock rows from fixture.relations by translating edge_kind via PROTOCOL_TO_DB_EDGE_KIND
5. Call setIntelligenceDeps({ queryRows: mockRows })
6. Call intelligence_query(tool, ctx) with canonical_name and intent
7. Validate backend response against fixture.contract expectations

## Family-intent mapping

FAMILY_INTENTS: Record<EntityFamily, string[]> defines which intelligence_query intents exercise each family:

**api**: who_calls_api, who_calls_api_at_runtime, what_api_calls, show_registration_chain, find_api_logs, find_api_struct_reads, find_api_struct_writes
- Exercises calls_in_direct, calls_in_runtime, calls_out, registrations_in, structures, logs

**struct**: where_struct_modified, where_struct_initialized, find_struct_readers, find_struct_writers, find_struct_owners
- Exercises structures, owns

**ring**: who_calls_api_at_runtime, find_callback_registrars
- Exercises calls_in_runtime, registrations_in

**hw_block**: who_calls_api_at_runtime, find_callback_registrars
- Exercises calls_in_runtime, registrations_in

**thread**: who_calls_api_at_runtime, what_api_calls, find_callback_registrars
- Exercises calls_in_runtime, calls_out, registrations_in

**signal**: who_calls_api_at_runtime
- Exercises calls_in_runtime

**interrupt**: what_api_calls, find_callback_registrars
- Exercises calls_out, registrations_in

**timer**: find_api_timer_triggers, find_callback_registrars
- Exercises calls_out, registrations_in

**dispatch_table**: show_dispatch_sites, find_callback_registrars
- Exercises calls_out (dispatch edges), registrations_in

**message**: who_calls_api_at_runtime, show_dispatch_sites
- Exercises calls_in_runtime, calls_out

**log_point**: find_api_logs, find_api_logs_by_level
- Exercises logs

INTENT_EXPECTED_BUCKETS: Record<string, string[]> maps each intent to the relation buckets it should populate in responses.

## Edge kind translation

PROTOCOL_TO_DB_EDGE_KIND: Record<string, string> maps fixture protocol format to backend storage vocabulary:

Fixture format (protocol) → Backend format (DB storage):
- call_direct → calls
- call_runtime → runtime_calls
- register → registers_callback
- dispatch → dispatches_to
- read → reads_field
- write → writes_field
- init → reads_field
- mutate → writes_field
- owner → owns
- use → operates_on_struct
- inherit → calls
- implement → calls
- emit_log → logs_event

The translation is necessary because:
- Fixture edge_kind reflects semantic intent (e.g., "this is a runtime invocation")
- Backend DB edge_kind is storage-layer vocabulary (e.g., "runtime_calls")
- Tests build mock DB rows using DB edge_kind, then compare backend responses against fixture semantic intent

Mock row production: iterate fixture.relations[bucket] entries, for each entry:
1. Extract source, target, and evidence
2. Look up edge_kind → DB edge_kind via PROTOCOL_TO_DB_EDGE_KIND
3. Create a DB row with DB edge_kind
4. Inject into mock rows

## Data flow

Test execution flow:

1. Test suite loads manifest from `test/fixtures/wlan/index.json`
2. For each family in SUPPORTED_FAMILIES:
   - For each fixture name in families[family]:
     - Load fixture from `test/fixtures/wlan/{family}/{name}.json`
     - For each intent in FAMILY_INTENTS[family]:
       - Build mock DB rows from fixture.relations:
         - For each relation bucket (calls_in_direct, calls_in_runtime, etc.):
           - For each edge in bucket:
             - Translate edge_kind to DB edge_kind via PROTOCOL_TO_DB_EDGE_KIND
             - Create mock DB row (source, target, edge_kind, confidence, evidence)
       - Inject mock rows via setIntelligenceDeps({ queryRows: mockRows })
       - Call intelligence_query tool: tool("intelligence_query")(canonical_name, intent)
       - Capture backend NodeProtocolResponse
       - Validate response against fixture.contract expectations:
         - Check required_relation_kinds present
         - Check minimum_counts met per bucket
         - Check required_directions respected
         - Validate path patterns

3. Report mismatches at (entity, relation_bucket, field) granularity

Test isolation: each test fixture gets fresh mock rows; no cross-fixture contamination

## Quality

**Test coverage:**
- All 11 entity families covered
- 69 total fixtures with family-specific intents
- API family (61 fixtures) most heavily tested
- Edge kind translation validated for all 13 protocol formats

**Limitations:**
- Tests use mocked DB rows only — no live backend required but also no live integration testing
- Mock rows are built from fixture relations — if fixture is incomplete, test coverage reflects incompleteness
- Path pattern validation not fully implemented (required_path_patterns present but not validated)
- No trend tracking or confidence degradation detection yet

**Integration points:**
- Fixture source: [[doc/derived/module-wlan-fixture-corpus]]
- Query tool: intelligence_query (mocked via setIntelligenceDeps)
- Test kit: test-kit.ts (tool and ctx helpers)
