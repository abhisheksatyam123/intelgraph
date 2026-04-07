---
tags:
  - status/wip
description: [Index](#index) — schema mapping purpose
---

# module-wlan-fixture-schema

## Index

- [Index](#index) — L9
- [Purpose](#purpose) — L86
- [Entity family schemas](#entity-family-schemas) — L106
- [Canonical fields](#canonical-fields) — L129
- [Relation bucket support](#relation-bucket-support) — L158
- [Family-specific quirks](#family-specific-quirks) — L191
- [Contract field patterns](#contract-field-patterns) — L212
- [Common base fields (required on every family fixture)](#common-base-fields-required-on-every-family-fixture) — L216
- [Relations object shape (required buckets)](#relations-object-shape-required-buckets) — L225
- [`contract` object fields (required)](#contract-object-fields-required) — L237
  - [Allowed relation kinds (`required_relation_kinds` and relation rows)](#allowed-relation-kinds-required_relation_kinds-and-relation-rows) — L242
  - [Allowed directions (`required_directions`)](#allowed-directions-required_directions) — L245
- [Relation row contract fields](#relation-row-contract-fields) — L248
- [Backend reconciliation coupling](#backend-reconciliation-coupling) — L256
- [Inconsistencies and gaps](#inconsistencies-and-gaps) — L265
- [Quality](#quality) — L313
- [Schema shape summary (item 2.1)](#schema-shape-summary-item-21) — L341
  - [Entity families (11)](#entity-families-11) — L345
  - [Common fields (all families)](#common-fields-all-families) — L360
  - [Family-specific relation shape](#family-specific-relation-shape) — L373
  - [Contract fields (fixture expectations consumed by tests)](#contract-fields-fixture-expectations-consumed-by-tests) — L393
- [Test expectation mapping](#test-expectation-mapping) — L405
- [Enumerated schema-shape contract for current corpus](#enumerated-schema-shape-contract-for-current-corpus) — L421
- [Entity families and corpus distribution](#entity-families-and-corpus-distribution) — L435
- [Common fixture fields and test expectations](#common-fixture-fields-and-test-expectations) — L453
- [Family-specific relation contracts](#family-specific-relation-contracts) — L491
- [Current schema shape enumeration](#current-schema-shape-enumeration) — L526
  - [Entity families (manifest-backed)](#entity-families-manifest-backed) — L528
  - [Common fixture fields (cross-family contract)](#common-fixture-fields-cross-family-contract) — L533
  - [Relation buckets (cross-family envelope)](#relation-buckets-cross-family-envelope) — L542
  - [Family-specific relation emphasis](#family-specific-relation-emphasis) — L546
  - [Contract fields (fixture expectations)](#contract-fields-fixture-expectations) — L556
  - [Test-expectation binding](#test-expectation-binding) — L562
- [Current schema shapes from fixtures and tests](#current-schema-shapes-from-fixtures-and-tests) — L568
  - [Entity families (current)](#entity-families-current) — L572
  - [Common required fields (all families)](#common-required-fields-all-families) — L587
  - [Family-specific relation expectations](#family-specific-relation-expectations) — L602
  - [Relation-row contract fields enforced by tests](#relation-row-contract-fields-enforced-by-tests) — L640
  - [Backend reconciliation contract fields](#backend-reconciliation-contract-fields) — L648
- [Mismatch taxonomy and severity levels (item 2.3)](#mismatch-taxonomy-and-severity-levels-item-23) — L654
  - [Severity bands](#severity-bands) — L658
  - [Mismatch classes and rules](#mismatch-classes-and-rules) — L664
  - [Deterministic tie-break rules](#deterministic-tie-break-rules) — L703
  - [Reporting contract shape (for comparator output)](#reporting-contract-shape-for-comparator-output) — L709
- [Frozen schema and contract model (item 2)](#frozen-schema-and-contract-model-item-2) — L720
  - [Freeze scope](#freeze-scope) — L724
  - [Required fields (cross-family) and pass/fail expectations](#required-fields-cross-family-and-passfail-expectations) — L729
  - [Relations envelope contract (all families)](#relations-envelope-contract-all-families) — L743
  - [Entity-family schema contracts (explicit)](#entity-family-schema-contracts-explicit) — L749
  - [Comparison invariants (fixture-vs-backend) with pass/fail semantics](#comparison-invariants-fixture-vs-backend-with-passfail-semantics) — L766
  - [Outcome contract for CI gating](#outcome-contract-for-ci-gating) — L778
  - [Contract ownership and change policy](#contract-ownership-and-change-policy) — L784
- [Frozen fixture schema and contract model (item 2)](#frozen-fixture-schema-and-contract-model-item-2) — L789
- [Scope](#scope) — L791
- [Entity-family schema contracts (11 families)](#entity-family-schema-contracts-11-families) — L794
- [Required fields contract (all families)](#required-fields-contract-all-families) — L802
- [Family-specific relation contract expectations](#family-specific-relation-contract-expectations) — L838
- [Comparison invariants (fixture vs backend)](#comparison-invariants-fixture-vs-backend) — L855
- [Explicit fail policy for CI surfaces](#explicit-fail-policy-for-ci-surfaces) — L888
- [Decision summary](#decision-summary) — L893
- [Scope](#scope) — L899
- [Required fixture fields (all families)](#required-fixture-fields-all-families) — L902
- [Required relation-bucket envelope (all families)](#required-relation-bucket-envelope-all-families) — L916
- [Entity-family contract matrix (frozen)](#entity-family-contract-matrix-frozen) — L932
- [Comparison invariants (fixture vs backend)](#comparison-invariants-fixture-vs-backend) — L971
- [Required `contract` fields and pass/fail expectations](#required-contract-fields-and-passfail-expectations) — L988
- [Explicit run-level gate expectations](#explicit-run-level-gate-expectations) — L999
- [Contract ownership and update policy](#contract-ownership-and-update-policy) — L1014
- [Frozen schema and comparison contract (item 2)](#frozen-schema-and-comparison-contract-item-2) — L1021
  - [1) Entity-family contract (frozen)](#1-entity-family-contract-frozen) — L1025
  - [2) Required cross-family fields (frozen)](#2-required-cross-family-fields-frozen) — L1035
  - [3) Contract object fields (frozen)](#3-contract-object-fields-frozen) — L1047
  - [4) Comparison invariants (fixture vs backend)](#4-comparison-invariants-fixture-vs-backend) — L1060
  - [5) Deterministic pass/fail outcome contract](#5-deterministic-passfail-outcome-contract) — L1074
- [Programmatic validation contract](#programmatic-validation-contract) — L1081

## Purpose

Canonical fixture schema derived from the complete WLAN fixture corpus. This note documents:
- Which fields are required vs optional across all 69 fixtures
- Which relation buckets are supported per entity family
- Family-specific extensions (e.g., `fields` for structs)
- Contract field patterns and expectations
- Schema inconsistencies and remediation targets

Data sources:
- test/fixtures/wlan/index.json — manifest with family counts
- test/fixtures/wlan/{family}/*.json — canonical fixtures (69 total)
- test/unit/intelligence/backend-reconciliation.test.ts — SUPPORTED_FAMILIES and FAMILY_INTENTS
- test/unit/intelligence/wlan-ground-truth.test.ts — ApiGroundTruthEntry interface definition

This note feeds into:
- Schema contract enforcement (item [2.2])
- Mismatch taxonomy (item [2.3])
- Schema validation tests (item [2.4])

## Entity family schemas

**Derived from `test/fixtures/wlan/index.json` + fixture-validation tests (`test/unit/intelligence/entity-contract.test.ts`)**

| Family | Count | Required relation buckets (family contract) | At-least-one non-empty buckets |
|---|---:|---|---|
| api | 61 | calls_in_runtime, calls_in_direct, calls_out, registrations_in, structures, logs | calls_in_runtime \| calls_in_direct \| registrations_in |
| struct | 2 | structures, owns, uses | structures |
| ring | 1 | registrations_out, uses | registrations_out \| uses |
| hw_block | 1 | registrations_out, uses | registrations_out \| uses |
| thread | 1 | calls_in_runtime, calls_out, registrations_out | calls_in_runtime \| calls_out |
| signal | 1 | calls_in_runtime | calls_in_runtime |
| interrupt | 1 | calls_out, registrations_out | calls_out \| registrations_out |
| timer | 1 | calls_out, registrations_out | calls_out \| registrations_out |
| dispatch_table | 1 | calls_out, registrations_in | calls_out |
| message | 1 | calls_in_runtime, calls_out | calls_in_runtime \| calls_out |
| log_point | 1 | logs | logs |
| **TOTAL** | **72 files in family dirs** |  |  |

Canonical corpus used by reconciliation is **69 unique entity fixtures** (61 api + 2 struct + 1 each remaining family). The delta is extra non-entity/report artifacts under `test/fixtures/wlan/` that are not family-member fixtures.

This section is the schema-shape contract for item 2.1: entity families and family-specific relation expectations are enumerated from both fixture corpus and tests.

## Canonical fields

All fixtures contain these required fields:

```json
{
  "kind": "api",                           // Required: string, one of 11 family types
  "kind_verbose": "application_programming_interface",  // Required: human-readable kind label
  "canonical_name": "wlan_thread_irq_route_wmac_tx",    // Required: stable identifier
  "aliases": ["_wlan_thread_irq_route_wmac_tx", "..."],  // Required: array of alternate names
  "source": {
    "file": "wlan/syssw_platform/src/thread/tac_thread.c",  // Required: relative path
    "line": 121                            // Required: declaration line
  },
  "description": "semantic description",  // Required: human description
  "relations": { ... }                    // Required: relation buckets (see next section)
  "contract": { ... }                     // Optional: verification expectations
}
```

Schema validation rules (required for all fixtures):
- `kind` must be one of: api, struct, ring, hw_block, thread, signal, interrupt, timer, dispatch_table, message, log_point
- `canonical_name` must be non-empty string
- `source.file` must be non-empty string
- `source.line` must be positive integer
- `aliases` must be array (may be empty)
- `relations` must be object with buckets
- `description` must be non-empty string (recommend 50-200 chars)

## Relation bucket support

All fixtures have a `relations` object with these possible buckets:

**Standard buckets (present on most families):**
- `calls_in_direct` (array) — static direct calls to this entity
- `calls_in_runtime` (array) — runtime invocations (dispatch chains, hw triggers)
- `calls_out` (array) — direct or indirect calls made by this entity
- `registrations_in` (array) — registrations where this entity is the registered callback
- `registrations_out` (array) — registrations this entity registers (handler or consumer registrations)
- `structures` (array) — struct field access (reads/writes)
- `logs` (array) — log emission sites
- `owns` (array) — data ownership relationships
- `uses` (array) — dependency/operational relationships

**Bucket population by family:**

| Family | calls_in_direct | calls_in_runtime | calls_out | registrations_in | registrations_out | structures | logs | owns | uses |
|--------|---|---|---|---|---|---|---|---|---|
| api | often | often | often | often | often | often | sometimes | sometimes | sometimes |
| struct | empty | empty | empty | empty | empty | often | empty | sometimes | sometimes |
| ring | empty | empty | empty | often | often | empty | empty | empty | sometimes |
| hw_block | empty | empty | empty | sometimes | sometimes | empty | empty | empty | often |
| thread | empty | often | often | sometimes | often | empty | empty | empty | empty |
| signal | empty | often | empty | empty | empty | empty | empty | empty | empty |
| interrupt | empty | empty | often | empty | often | empty | empty | empty | empty |
| timer | empty | empty | often | empty | often | empty | empty | empty | empty |
| dispatch_table | empty | empty | often | often | empty | empty | empty | empty | empty |
| message | empty | often | often | empty | empty | empty | empty | empty | empty |
| log_point | empty | empty | empty | empty | empty | empty | often | empty | empty |

All buckets are always present as keys; empty families have empty arrays.

## Family-specific quirks

Family-specific schema shape is defined by two expectations in `test/unit/intelligence/entity-contract.test.ts`:
1. **Required buckets present** (`FAMILY_REQUIRED_BUCKETS`)
2. **At least one informative bucket non-empty** (`FAMILY_MIN_NONEMPTY`)

Observed family contracts:
- `api`: richest shape; must carry incoming (`calls_in_runtime/calls_in_direct`) and behavioral buckets (`calls_out`, `registrations_in`, `structures`, `logs`).
- `struct`: primarily structural semantics (`structures`) plus ownership/dependency context (`owns`, `uses`).
- `ring` and `hw_block`: modeled as operational infrastructure nodes; require `registrations_out` + `uses`.
- `thread`: runtime entrypoint + outbound behavior (`calls_in_runtime`, `calls_out`, `registrations_out`).
- `signal`: runtime trigger entity; must expose `calls_in_runtime`.
- `interrupt` and `timer`: trigger-style entities that must emit outbound activation (`calls_out`, `registrations_out`).
- `dispatch_table`: dispatch metadata entity requiring both dispatch output (`calls_out`) and registration ingress (`registrations_in`).
- `message`: message-mediated runtime flow (`calls_in_runtime`, `calls_out`).
- `log_point`: observability-only entity requiring `logs` bucket.

Reconciliation nuance from `test/unit/intelligence/backend-reconciliation.test.ts`:
- Not all buckets are asserted for every intent; `INTENT_EXPECTED_BUCKETS` selects which buckets must be non-empty for a specific query intent.
- Outgoing-intent handling differs (`what_api_calls`, `show_dispatch_sites`, `find_api_timer_triggers`) because primary response identity may be callee/timer-facing instead of the fixture entity.

## Contract field patterns

Contract expectations are defined by fixture data and enforced by tests.

## Common base fields (required on every family fixture)
- `kind`
- `kind_verbose`
- `canonical_name`
- `aliases`
- `source` (`file`, `line` required)
- `relations`
- `contract`

## Relations object shape (required buckets)
All fixtures must expose these bucket keys (arrays, possibly empty):
- `calls_in_direct`
- `calls_in_runtime`
- `calls_out`
- `registrations_in`
- `registrations_out`
- `structures`
- `logs`
- `owns`
- `uses`

## `contract` object fields (required)
- `required_relation_kinds: string[]` (non-empty)
- `required_directions: string[]`
- `minimum_counts: Record<string, number>`

### Allowed relation kinds (`required_relation_kinds` and relation rows)
`call_direct`, `call_runtime`, `register`, `dispatch`, `read`, `write`, `init`, `mutate`, `owner`, `use`, `inherit`, `implement`, `emit_log`

### Allowed directions (`required_directions`)
`incoming`, `outgoing`, `bidirectional`

## Relation row contract fields
Common row-level contract validated by tests:
- `edge_kind`
- `edge_kind_verbose`
- optional `evidence.kind`, optional `evidence.loc.file`, optional `evidence.loc.line`

Allowed evidence kinds currently validated: `call_expr`, `fn_ptr_assign`, `dispatch_table_entry`, `register_call`, `log_site`, `field_access`, `unknown`.

## Backend reconciliation coupling
`test/unit/intelligence/backend-reconciliation.test.ts` consumes this contract through:
- `FAMILY_INTENTS` (which query intents must be exercised per family)
- `INTENT_EXPECTED_BUCKETS` (which relation buckets each intent must surface)
- `minimum_counts` enforcement for intent-relevant buckets only
- `PROTOCOL_TO_DB_EDGE_KIND` translation (`edge_kind` protocol vocabulary ↔ DB vocabulary)

This makes fixture contract fields executable expectations, not documentation-only metadata.

## Inconsistencies and gaps

**Schema inconsistencies discovered in corpus:**

1. **Optional vs required contract:**
   - Most fixtures have contract field; a few may omit it
   - Recommendation: make contract REQUIRED on all families

2. **Empty relation buckets:**
   - All buckets present as keys, even if empty arrays
   - No family has missing bucket keys
   - Status: CONSISTENT

3. **Struct fixtures anomaly:**
   - Only family with `fields` extension
   - Struct relations focus on structures bucket; other buckets typically empty
   - Status: intentional, properly typed

4. **Log_point fixture minimal schema:**
   - Only populate logs bucket; others are empty arrays
   - May lack complex contracts
   - Status: acceptable (log_point is a leaf entity)

5. **Pre-enrich vs post-enrich:**
   - Some API fixtures have .pre-enrich variants
   - Post-enrich versions are authoritative; pre-enrich are snapshots
   - Status: tracked; not a schema issue

6. **Derivation confidence mix:**
   - Different derivation methods (clangd, runtime, c_parser) have different confidence ceilings
   - No normalization of confidence across derivation types
   - Recommendation: add confidence calibration mapping

7. **Edge kind vocabulary variance:**
   - Protocol uses semantic terms (call_direct, call_runtime, register)
   - Not all combinations appear in corpus (e.g., no "inherit" or "implement" seen)
   - Status: PROTOCOL_TO_DB_EDGE_KIND handles translation

8. **Required path patterns validation:**
   - required_path_patterns present but not validated in backend reconciliation tests
   - Recommendation: add path validation in comparator (item [7])

**Recommended schema tightening (for item [2.2]):**
- Make contract REQUIRED on all fixtures
- Normalize confidence calibration by derivation method
- Add validation for path patterns
- Ensure all buckets are present (currently true but not enforced)

## Quality

**Inventory completeness:**
- All 11 entity families documented with concrete fixture examples
- 69 unique fixtures inventoried (61 api, 2 struct, 7 single-entity families)
- Canonical fields fully specified with validation rules
- Relation bucket support matrix complete per family
- Family-specific extensions documented (struct.fields)
- Contract patterns enumerated per family
- Edge kind translation map (PROTOCOL_TO_DB_EDGE_KIND) validated

**Schema enforcement readiness:**
- Canonical fields can be validated programmatically (non-empty strings, positive integers, enum checks)
- Relation buckets can be validated (required keys, array types)
- Contract can be validated (required_relation_kinds in protocol vocabulary, required_directions valid values)
- Family-specific extensions can be validated (struct must have fields, others must not)

**Remaining gaps (out of scope for [2.1]):**
- Path pattern validation not implemented yet (item [2.2])
- Confidence calibration not normalized (item [2.2])
- Mismatch taxonomy not defined (item [2.3])
- Schema validation tests not yet written (item [2.4])

**Current state:**
- Schema is consistent across 69 fixtures
- Inconsistencies are minor (optional contract, pre-enrich tracking)
- Schema is sufficiently well-defined for contract enforcement

## Schema shape summary (item 2.1)

Derived schema shape contract for `todo 2.1` (fixture corpus + backend/query test expectations):

### Entity families (11)
- `api` (61)
- `struct` (2)
- `ring` (1)
- `hw_block` (1)
- `thread` (1)
- `signal` (1)
- `interrupt` (1)
- `timer` (1)
- `dispatch_table` (1)
- `message` (1)
- `log_point` (1)

Canonical expectation: 69 unique fixtures total; tests treat these families as the supported reconciliation domain.

### Common fields (all families)
Required fields:
- `kind`, `kind_verbose`, `canonical_name`, `aliases`, `source.file`, `source.line`, `description`, `relations`
Optional-but-supported:
- `contract`

Cross-family invariants:
- `kind` is one of the 11 family names.
- `canonical_name` is stable and non-empty.
- `source.file`/`source.line` provide canonical provenance anchors.
- `aliases` supports backend-name reconciliation.
- `relations` is always an object with standard bucket keys present (empty arrays allowed).

### Family-specific relation shape
Standard relation buckets across corpus:
- `calls_in_direct`, `calls_in_runtime`, `calls_out`, `registrations_in`, `registrations_out`, `structures`, `logs`, `owns`, `uses`

Family-centric usage expectations:
- `api`: broad coverage across calls, registrations, structures, optional logs/owns/uses.
- `struct`: `structures`-centric (plus optional owns/uses), no call/registration expectation.
- `ring`: registration + uses oriented.
- `hw_block`: uses-oriented with optional registration context.
- `thread`: runtime-in + calls_out + registrations_out.
- `signal`: runtime-in focused.
- `interrupt`: calls_out + registrations_out.
- `timer`: calls_out + registrations_out.
- `dispatch_table`: calls_out + registrations_in.
- `message`: runtime-in + calls_out.
- `log_point`: logs-only semantic surface.

Relation entry contract fields (shared):
- `edge_kind`, `edge_kind_verbose`, `derivation`, `confidence`, `evidence`

### Contract fields (fixture expectations consumed by tests)
When `contract` is present, expected fields are:
- `required_relation_kinds`
- `required_directions`
- `minimum_counts`
- `required_path_patterns`

Contract-to-test interpretation:
- Reconciliation tests map fixture/protocol edge kinds to DB edge kinds (`PROTOCOL_TO_DB_EDGE_KIND`) before asserting parity.
- Intent tests rely on family intent matrix + expected bucket mapping (`FAMILY_INTENTS`, `INTENT_EXPECTED_BUCKETS`) so each query intent validates the family-relevant relation bucket.
- Comparator pass/fail boundary is fixture-first: missing/extra/field mismatch is evaluated against fixture contract expectations, not backend self-reporting.

## Test expectation mapping

Backend reconciliation expectations are derived from fixture schema through three explicit mappings:

1. **Family → intents** (`FAMILY_INTENTS` in `test/unit/intelligence/backend-reconciliation.test.ts`)
   - Defines which `intelligence_query` intents are valid per entity family.
   - Prevents unsupported intent/family combinations from being treated as mismatches.

2. **Intent → relation bucket** (`INTENT_EXPECTED_BUCKETS`)
   - Maps each query intent to exactly one fixture relation bucket (for example, `who_calls_api` → `calls_in_direct`, `what_api_calls` → `calls_out`).
   - Makes fixture comparisons deterministic: each query response is checked against one authoritative bucket.

3. **Fixture edge kind → backend edge kind** (`PROTOCOL_TO_DB_EDGE_KIND`)
   - Translates protocol edge-kind labels stored in fixture entries (`call_direct`, `register`, `emit_log`, etc.) to backend storage vocabulary used in query rows.
   - Ensures semantic equivalence checks are vocabulary-normalized rather than raw-string compared.

## Enumerated schema-shape contract for current corpus

- **Entity families**: `api`, `struct`, `ring`, `hw_block`, `thread`, `signal`, `interrupt`, `timer`, `dispatch_table`, `message`, `log_point`.
- **Common required fields**: `kind`, `kind_verbose`, `canonical_name`, `aliases`, `source.file`, `source.line`, `description`, `relations`.
- **Contract fields (optional but expected on most fixtures)**: `required_relation_kinds`, `required_directions`, `minimum_counts`, `required_path_patterns`.
- **Family-specific relation emphasis**:
  - `api`: broad coverage across incoming/outgoing calls, registrations, structures, logs, owns/uses.
  - `struct`: `fields` extension plus `structures`-centric relations.
  - `ring`/`thread`/`interrupt`/`timer`/`dispatch_table`/`message`: runtime-flow and registration/call linkage buckets.
  - `signal`: runtime incoming trigger path (`calls_in_runtime`) focus.
  - `log_point`: `logs` bucket focus with minimal contract surface.

This mapping defines the current test expectation shape: fixture schema is authoritative, and reconciliation tests evaluate backend/query behavior only through these mapped contracts.

## Entity families and corpus distribution

Fixture manifest `test/fixtures/wlan/index.json` currently declares 11 entity families and 69 total entities:

- `api`: 61
- `struct`: 2
- `ring`: 1
- `hw_block`: 1
- `thread`: 1
- `signal`: 1
- `interrupt`: 1
- `timer`: 1
- `dispatch_table`: 1
- `message`: 1
- `log_point`: 1

Family set is mirrored by `SUPPORTED_FAMILIES` in `test/unit/intelligence/entity-contract.test.ts` and `test/unit/intelligence/backend-reconciliation.test.ts`, so fixture manifest coverage and test coverage are aligned on the same 11-family taxonomy.

## Common fixture fields and test expectations

Current common shape is enforced across all fixture files by Layer 1 schema tests in `test/unit/intelligence/entity-contract.test.ts`.

Required top-level fields (test-enforced):
- `kind`
- `kind_verbose`
- `canonical_name`
- `aliases`
- `source` (`source.file`, `source.line`)
- `relations`
- `contract`

Required `relations` buckets (all families, array-typed):
- `calls_in_direct`
- `calls_in_runtime`
- `calls_out`
- `registrations_in`
- `registrations_out`
- `structures`
- `logs`
- `owns`
- `uses`

Required `contract` subfields (all families):
- `required_relation_kinds` (non-empty array)
- `required_directions` (array)
- `minimum_counts` (object)

Semantic constraints under test:
- `kind` must match family folder.
- `kind_verbose` must match canonical per-family label.
- `canonical_name` must be non-empty string.
- `aliases` must be array.
- `source.file` string + `source.line` positive number.

Note: this is the currently enforced test contract; broader schema documentation may include additional recommended fields such as `description`.

## Family-specific relation contracts

Layer 2 entity-contract tests (`test/unit/intelligence/entity-contract.test.ts`) enforce family-specific required relation buckets and a minimum non-empty rule.

Per-family required buckets:
- `api`: calls_in_runtime, calls_in_direct, calls_out, registrations_in, structures, logs
- `struct`: structures, owns, uses
- `ring`: registrations_out, uses
- `hw_block`: registrations_out, uses
- `thread`: calls_in_runtime, calls_out, registrations_out
- `signal`: calls_in_runtime
- `interrupt`: calls_out, registrations_out
- `timer`: calls_out, registrations_out
- `dispatch_table`: calls_out, registrations_in
- `message`: calls_in_runtime, calls_out
- `log_point`: logs

Per-family minimum non-empty buckets (at least one must have entries):
- `api`: calls_in_runtime | calls_in_direct | registrations_in
- `struct`: structures
- `ring`: registrations_out | uses
- `hw_block`: registrations_out | uses
- `thread`: calls_in_runtime | calls_out
- `signal`: calls_in_runtime
- `interrupt`: calls_out | registrations_out
- `timer`: calls_out | registrations_out
- `dispatch_table`: calls_out
- `message`: calls_in_runtime | calls_out
- `log_point`: logs

Backend reconciliation expectations (`test/unit/intelligence/backend-reconciliation.test.ts`) add intent coupling:
- `FAMILY_INTENTS[family]` defines which intelligence intents each family must satisfy.
- `INTENT_EXPECTED_BUCKETS[intent]` defines which relation buckets must surface for each exercised intent.
This creates a family→intent→bucket contract chain for fixture-vs-backend parity.

## Current schema shape enumeration

### Entity families (manifest-backed)
- Families: `api`, `struct`, `ring`, `hw_block`, `thread`, `signal`, `interrupt`, `timer`, `dispatch_table`, `message`, `log_point`.
- Current canonical corpus size from `test/fixtures/wlan/index.json`: 69 entities total.
- Count by family: api=61, struct=2, each remaining family=1.

### Common fixture fields (cross-family contract)
All families share this shape baseline:
- Identity/meta: `kind`, `kind_verbose`, `canonical_name`, `aliases`, `description`
- Source anchor: `source.file`, `source.line`
- Relation container: `relations` object
- Verification contract: `contract` object

Test expectations (schema-contract and reconciliation suites) treat these as required for valid fixtures; malformed/missing fields are expected to fail validation.

### Relation buckets (cross-family envelope)
- Canonical relation buckets: `calls_in_direct`, `calls_in_runtime`, `calls_out`, `registrations_in`, `registrations_out`, `structures`, `logs`, `owns`, `uses`.
- Current corpus pattern: buckets are represented as arrays; empty buckets remain explicitly present to keep shape stable.

### Family-specific relation emphasis
- `api`: broadest surface; populates call, registration, structures, and logs buckets.
- `struct`: primarily `structures` and ownership/usage context; call/registration buckets usually empty.
- `ring` / `hw_block`: runtime/registration and usage-oriented relationships.
- `thread` / `signal` / `interrupt` / `timer`: runtime-trigger and flow-routing dominant.
- `dispatch_table`: dispatch/callback routing edges.
- `message`: runtime dispatch + outbound routing.
- `log_point`: `logs`-centric leaf family.
- `struct` uniquely extends schema with `fields[]` entries (`name`, `type`, `description`).

### Contract fields (fixture expectations)
- `required_relation_kinds: string[]` — protocol edge kinds expected for the entity.
- `required_directions: string[]` — expected direction set (incoming/outgoing/bidirectional semantics by tests/mappers).
- `minimum_counts: Record<string, number>` — per-bucket lower bounds.
- `required_path_patterns: Array<{ name, nodes[], description }>` — topology/path invariants.

### Test-expectation binding
- `test/unit/intelligence/entity-contract.test.ts` validates contract keys and allowed values (`required_relation_kinds`, `required_directions`, `minimum_counts`).
- `test/unit/intelligence/backend-reconciliation.test.ts` validates intent/bucket expectations and enforces `contract.minimum_counts` on intent-relevant buckets.
- `FAMILY_INTENTS` + `INTENT_EXPECTED_BUCKETS` define which query intents and relation buckets are mandatory per family during backend reconciliation.
- Reconciliation identity checks assert `kind`, `kind_verbose`, and `source` location consistency against fixture truth.

## Current schema shapes from fixtures and tests

Derived from fixture manifest and contract/reconciliation tests (`test/fixtures/wlan/index.json`, `test/unit/intelligence/entity-contract.test.ts`, `test/unit/intelligence/backend-reconciliation.test.ts`, `src/fixtures/intent-mapper.ts`).

### Entity families (current)
- `api`: 61
- `struct`: 2
- `ring`: 1
- `hw_block`: 1
- `thread`: 1
- `signal`: 1
- `interrupt`: 1
- `timer`: 1
- `dispatch_table`: 1
- `message`: 1
- `log_point`: 1

Canonical fixture set represented in manifest families: **72 entries**. Existing architecture notes still treat the canonical comparison set as 69 core entities; design/implementation work should preserve the 11-family contract and explicitly state whether 69-core vs 72-manifest is used by each pipeline stage.

### Common required fields (all families)
All fixtures are expected to include:
- `kind` (must match family folder)
- `kind_verbose` (must match canonical family label)
- `canonical_name` (non-empty string)
- `aliases` (array)
- `source.file`, `source.line` (non-empty path, positive line)
- `relations` object with **all 9 buckets present as arrays**:
  - `calls_in_direct`, `calls_in_runtime`, `calls_out`, `registrations_in`, `registrations_out`, `structures`, `logs`, `owns`, `uses`
- `contract` object with required fields:
  - `required_relation_kinds` (non-empty array)
  - `required_directions` (array of `incoming|outgoing|bidirectional`)
  - `minimum_counts` (object)
  - `required_path_patterns` is part of the typed contract shape (often empty)

### Family-specific relation expectations
Expected relation families (from `FAMILY_REQUIRED_BUCKETS`) and minimum non-empty requirements (from `FAMILY_MIN_NONEMPTY`):

- `api`
  - Required buckets: `calls_in_runtime`, `calls_in_direct`, `calls_out`, `registrations_in`, `structures`, `logs`
  - At least one non-empty: `calls_in_runtime` or `calls_in_direct` or `registrations_in`
- `struct`
  - Required buckets: `structures`, `owns`, `uses`
  - At least one non-empty: `structures`
  - Extension field: `fields[]` (member schema)
- `ring`
  - Required buckets: `registrations_out`, `uses`
  - At least one non-empty: `registrations_out` or `uses`
- `hw_block`
  - Required buckets: `registrations_out`, `uses`
  - At least one non-empty: `registrations_out` or `uses`
- `thread`
  - Required buckets: `calls_in_runtime`, `calls_out`, `registrations_out`
  - At least one non-empty: `calls_in_runtime` or `calls_out`
- `signal`
  - Required buckets: `calls_in_runtime`
  - At least one non-empty: `calls_in_runtime`
- `interrupt`
  - Required buckets: `calls_out`, `registrations_out`
  - At least one non-empty: `calls_out` or `registrations_out`
- `timer`
  - Required buckets: `calls_out`, `registrations_out`
  - At least one non-empty: `calls_out` or `registrations_out`
- `dispatch_table`
  - Required buckets: `calls_out`, `registrations_in`
  - At least one non-empty: `calls_out`
- `message`
  - Required buckets: `calls_in_runtime`, `calls_out`
  - At least one non-empty: `calls_in_runtime` or `calls_out`
- `log_point`
  - Required buckets: `logs`
  - At least one non-empty: `logs`

### Relation-row contract fields enforced by tests
Across populated relation rows:
- required semantic fields vary by bucket (`caller/callee`, `registrar/callback`, `api/struct`, `api_name/level/template/subsystem`)
- required common verification fields:
  - `edge_kind` in allowed protocol vocabulary (`call_direct`, `call_runtime`, `register`, `dispatch`, `read`, `write`, `init`, `mutate`, `owner`, `use`, `inherit`, `implement`, `emit_log`)
  - `edge_kind_verbose` in allowed verbose vocabulary
  - `evidence.kind` in allowed evidence kinds; `evidence.loc.file/line` when loc exists

### Backend reconciliation contract fields
`backend-reconciliation.test.ts` exercises family-specific intent sets (`FAMILY_INTENTS`) and expected fixture buckets (`INTENT_EXPECTED_BUCKETS`) and translates fixture protocol edge kinds to DB storage edge kinds via `PROTOCOL_TO_DB_EDGE_KIND` before comparing results. This means fixture schema contract fields that are comparison-critical are:
- identity/source: `kind`, `canonical_name`, `source`
- relation semantics: per-row endpoint fields + `edge_kind`, `derivation`, `confidence`, `evidence`
- contract expectation controls: `required_relation_kinds`, `required_directions`, `minimum_counts`, `required_path_patterns`

## Mismatch taxonomy and severity levels (item 2.3)

This taxonomy standardizes fixture-vs-backend comparison outcomes so all mismatch classes map to reproducible CI behavior.

### Severity bands
- **S0 / blocker** — breaks fixture authority or makes result non-actionable. CI **fail**.
- **S1 / major** — high-confidence contract violation with valid evidence. CI **fail** unless explicitly waived.
- **S2 / moderate** — actionable quality defect that does not invalidate all conclusions. CI **warn**.
- **S3 / minor** — low-risk signal; track for cleanup/trend only. CI **info/warn** depending on volume.

### Mismatch classes and rules

1. **Missing mismatch** (`fixture_has_relation`, `backend_missing_relation`)
   - **Default severity: S1**.
   - **Escalate to S0** when any of these hold:
     - missing relation violates `contract.minimum_counts` for a required intent bucket,
     - missing relation kind appears in `contract.required_relation_kinds`,
     - missing direction appears in `contract.required_directions`.
   - **Downgrade to S2** only when relation is outside required contract fields and bucket is optional for the family.

2. **Extra mismatch** (`backend_has_relation`, `fixture_missing_relation`)
   - **Default severity: S2**.
   - **Escalate to S1** when extra relation conflicts with fixture canonical constraints (wrong canonical target but same intent bucket) or repeatedly appears across entities (systematic drift).
   - **Downgrade to S3** for one-off, low-impact extras in optional buckets with no contract violation.

3. **Source mismatch** (`relation_present`, `source_anchor_conflict`)
   - Definition: relation exists but `source.file`/`source.line` or evidence location does not match fixture truth.
   - **Default severity: S1** because provenance is part of the fixture contract.
   - **Escalate to S0** when source mismatch prevents traceability/auditability for required relations.
   - **Downgrade to S2** when only non-authoritative metadata differs and canonical relation identity still matches.

4. **Unresolved alias mismatch** (`name_resolution_failed`)
   - Definition: backend value cannot be mapped to fixture `canonical_name` via aliases/normalization.
   - **Default severity: S1**.
   - **Escalate to S0** when unresolved alias blocks intent-level comparison entirely for a required contract bucket.
   - **Downgrade to S2** when alias miss affects optional buckets and relation still maps indirectly with confidence penalty.

5. **Evidence-weak mismatch** (`relation_match_low_confidence`)
   - Definition: relation appears matched, but evidence quality is below confidence floor (missing/weak evidence loc, ambiguous extraction, low corroboration).
   - **Default severity: S2**.
   - **Escalate to S1** when weak evidence is attached to required contract relations used for release gating.
   - **Downgrade to S3** for optional relations where confidence model already caps impact.

6. **Consistency mismatch** (`cross-surface_contract_conflict`)
   - Definition: contradictions across fixture contract surfaces (family-intent mapping, intent-bucket expectation, edge-kind translation, or per-test expected bucket).
   - **Default severity: S1** because inconsistent contracts make comparator outcomes non-deterministic.
   - **Escalate to S0** when conflict changes pass/fail result depending on test path (e.g., mocked vs live comparator branch).
   - **Downgrade to S2** when inconsistency is documentation-only and executable mappings remain aligned.

### Deterministic tie-break rules
- If multiple mismatch classes apply, choose the **highest severity**.
- If class-level and contract-level severities differ, contract-level escalation wins.
- Repeated occurrences (same class across >=3 entities in one run) promote severity by one band, capped at S0.
- Any S0/S1 mismatch in required contract buckets (`INTENT_EXPECTED_BUCKETS` + `minimum_counts`) must be reflected as CI fail in reporting surfaces.

### Reporting contract shape (for comparator output)
Each mismatch record should include:
- `class`: one of `missing | extra | source_mismatch | unresolved_alias | evidence_weak | consistency`
- `severity`: `S0 | S1 | S2 | S3`
- `entity_family`, `entity`, `intent`, `bucket`
- `fixture_expected`, `backend_observed`
- `contract_basis`: which rule triggered severity (`minimum_counts`, `required_relation_kinds`, `required_directions`, mapping conflict)
- `remediation_hint`: canonical next action (enrich fixture, normalize alias, fix mapper/edge-kind translation, improve evidence extraction)

This section is the authoritative mismatch taxonomy used by design items 2.3, comparator tests (7.1), report contract definition (7.2/4.4), and ops documentation (10.2).

## Frozen schema and contract model (item 2)

This section freezes the fixture schema + comparison contract for WLAN ground-truth infrastructure. It is the authoritative design target for implementation items that validate fixtures and compare backend/query output.

### Freeze scope
- Freeze applies to all 11 entity families: `api`, `struct`, `ring`, `hw_block`, `thread`, `signal`, `interrupt`, `timer`, `dispatch_table`, `message`, `log_point`.
- Fixture truth is authoritative for comparison; backend/query behavior is evaluated against fixture contracts, not vice versa.
- Contract applies to both mocked reconciliation and live-backend verification paths; both must produce equivalent comparator semantics.

### Required fields (cross-family) and pass/fail expectations
A fixture **passes schema contract** only if all checks below pass.

| Check ID | Requirement | Pass expectation | Fail expectation |
|---|---|---|---|
| F-001 | `kind` present and in allowed 11-family enum | value matches family enum and folder context | schema failure (entity invalid)
| F-002 | `kind_verbose` present | non-empty normalized label | schema failure
| F-003 | `canonical_name` present | non-empty stable identifier | schema failure
| F-004 | `aliases` present | array (empty allowed) | schema failure
| F-005 | `source.file` and `source.line` present | non-empty path + positive line | schema failure
| F-006 | `description` present | non-empty semantic description | schema failure
| F-007 | `relations` object present | all 9 buckets exist and are arrays | schema failure
| F-008 | `contract` object present | has `required_relation_kinds`, `required_directions`, `minimum_counts` (and typed `required_path_patterns`) | schema-contract failure (comparison cannot be trusted)

### Relations envelope contract (all families)
Required buckets: `calls_in_direct`, `calls_in_runtime`, `calls_out`, `registrations_in`, `registrations_out`, `structures`, `logs`, `owns`, `uses`.

Pass: all buckets exist as arrays (empty permitted unless family non-empty rule says otherwise).
Fail: missing bucket key or non-array bucket value.

### Entity-family schema contracts (explicit)
Family-level contract = required bucket presence + minimum non-empty semantics.

| Family | Required buckets | Non-empty expectation (pass/fail) |
|---|---|---|
| `api` | `calls_in_runtime`, `calls_in_direct`, `calls_out`, `registrations_in`, `structures`, `logs` | pass if at least one of `calls_in_runtime` \| `calls_in_direct` \| `registrations_in` non-empty; fail otherwise |
| `struct` | `structures`, `owns`, `uses` | pass if `structures` non-empty; fail otherwise |
| `ring` | `registrations_out`, `uses` | pass if `registrations_out` or `uses` non-empty; fail otherwise |
| `hw_block` | `registrations_out`, `uses` | pass if `registrations_out` or `uses` non-empty; fail otherwise |
| `thread` | `calls_in_runtime`, `calls_out`, `registrations_out` | pass if `calls_in_runtime` or `calls_out` non-empty; fail otherwise |
| `signal` | `calls_in_runtime` | pass if `calls_in_runtime` non-empty; fail otherwise |
| `interrupt` | `calls_out`, `registrations_out` | pass if `calls_out` or `registrations_out` non-empty; fail otherwise |
| `timer` | `calls_out`, `registrations_out` | pass if `calls_out` or `registrations_out` non-empty; fail otherwise |
| `dispatch_table` | `calls_out`, `registrations_in` | pass if `calls_out` non-empty; fail otherwise |
| `message` | `calls_in_runtime`, `calls_out` | pass if `calls_in_runtime` or `calls_out` non-empty; fail otherwise |
| `log_point` | `logs` | pass if `logs` non-empty; fail otherwise |

### Comparison invariants (fixture-vs-backend) with pass/fail semantics
A comparator run is contract-valid only when invariants below hold:

| Invariant ID | Invariant | Pass expectation | Fail expectation |
|---|---|---|---|
| C-001 | Fixture authority | comparator uses fixture row as expected truth per `(entity,intent,bucket)` | any logic that treats backend as source-of-truth is contract failure |
| C-002 | Intent-to-bucket determinism | each exercised intent maps to deterministic expected bucket(s) via `INTENT_EXPECTED_BUCKETS` | ambiguous/missing mapping => consistency failure |
| C-003 | Edge-kind translation determinism | fixture `edge_kind` is normalized through `PROTOCOL_TO_DB_EDGE_KIND` before backend comparison | missing/wrong translation => consistency/source failure |
| C-004 | Contract-required relation enforcement | `minimum_counts`, `required_relation_kinds`, and `required_directions` are checked for required buckets | violation => fail-level mismatch (`S0/S1`) |
| C-005 | Canonical identity resolution | backend names resolve to fixture `canonical_name` via aliases/normalization | unresolved mapping on required path => fail-level mismatch |
| C-006 | Source anchor traceability | required relation/source evidence anchors remain traceable to fixture source expectations | source/evidence anchor drift on required path => fail-level mismatch |

### Outcome contract for CI gating
- **Schema pass prerequisite:** no F-00x failures in any fixture participating in run.
- **Comparator pass prerequisite:** no fail-level (`S0`/`S1`) mismatches in required contract paths.
- **Warn-only runs:** allowed only when remaining mismatches are non-required `S2`/`S3` signals.
- **Hard fail:** any schema failure, missing required contract field, or required-path invariant breach.

### Contract ownership and change policy
- Owner note for schema contract: `[[doc/derived/module-wlan-fixture-schema#Frozen schema and contract model (item 2)]]`.
- Any change to required fields, family non-empty rules, intent/bucket mapping, or edge-kind translation is a **contract change** and must update this section before implementation changes ship.
- Reporting and CI surfaces must consume this contract via mismatch taxonomy + severity mapping (see [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity levels]] and [[doc/derived/module-wlan-reporting-ci-surfaces#Mismatch severity contract]]).

## Frozen fixture schema and contract model (item 2)

## Scope
Freeze the fixture contract used by schema validation, reconciliation comparison, and CI gating so pass/fail outcomes are deterministic across runs.

## Entity-family schema contracts (11 families)
Families covered by the frozen contract:
- `api`, `struct`, `ring`, `hw_block`, `thread`, `signal`, `interrupt`, `timer`, `dispatch_table`, `message`, `log_point`

Family-level pass/fail rule:
- **Pass**: fixture file declares one of the 11 allowed `kind` values and satisfies that family's required bucket and non-empty bucket constraints.
- **Fail**: unknown `kind`, missing family-required buckets, or violating family minimum non-empty bucket rule.

## Required fields contract (all families)
A fixture is schema-valid only if all required fields pass:

1. `kind`
   - Pass: string in allowed family set.
   - Fail: missing, empty, or not one of the 11 families.
2. `kind_verbose`
   - Pass: non-empty string aligned with canonical family label.
   - Fail: missing/empty.
3. `canonical_name`
   - Pass: non-empty stable identifier string.
   - Fail: missing/empty.
4. `aliases`
   - Pass: array (empty allowed).
   - Fail: non-array.
5. `source.file`
   - Pass: non-empty relative path string.
   - Fail: missing/empty/non-string.
6. `source.line`
   - Pass: positive integer.
   - Fail: missing, non-integer, or <= 0.
7. `description`
   - Pass: non-empty string.
   - Fail: missing/empty.
8. `relations`
   - Pass: object with all 9 buckets present as arrays:
     `calls_in_direct`, `calls_in_runtime`, `calls_out`, `registrations_in`, `registrations_out`, `structures`, `logs`, `owns`, `uses`.
   - Fail: missing relations object, missing any bucket, or bucket not array.
9. `contract`
   - Pass: object containing comparison-control fields:
     - `required_relation_kinds` (non-empty array)
     - `required_directions` (array of `incoming|outgoing|bidirectional`)
     - `minimum_counts` (object)
     - `required_path_patterns` (typed field; may be empty)
   - Fail: missing required contract controls or invalid enum/value type.

## Family-specific relation contract expectations
- `api`: required buckets `calls_in_runtime`, `calls_in_direct`, `calls_out`, `registrations_in`, `structures`, `logs`; at least one non-empty in `{calls_in_runtime, calls_in_direct, registrations_in}`.
- `struct`: required `structures`, `owns`, `uses`; at least one non-empty `structures`.
- `ring`: required `registrations_out`, `uses`; at least one non-empty in `{registrations_out, uses}`.
- `hw_block`: required `registrations_out`, `uses`; at least one non-empty in `{registrations_out, uses}`.
- `thread`: required `calls_in_runtime`, `calls_out`, `registrations_out`; at least one non-empty in `{calls_in_runtime, calls_out}`.
- `signal`: required `calls_in_runtime`; non-empty `calls_in_runtime`.
- `interrupt`: required `calls_out`, `registrations_out`; at least one non-empty in `{calls_out, registrations_out}`.
- `timer`: required `calls_out`, `registrations_out`; at least one non-empty in `{calls_out, registrations_out}`.
- `dispatch_table`: required `calls_out`, `registrations_in`; non-empty `calls_out`.
- `message`: required `calls_in_runtime`, `calls_out`; at least one non-empty in `{calls_in_runtime, calls_out}`.
- `log_point`: required `logs`; non-empty `logs`.

Family rule pass/fail:
- **Pass**: all family-required buckets exist and minimum non-empty condition is satisfied.
- **Fail**: any family-required bucket missing/typed incorrectly or all required non-empty candidates are empty.

## Comparison invariants (fixture vs backend)
These invariants freeze comparator behavior and pass/fail interpretation:

1. Fixture authority invariant
- Rule: fixture corpus is source of truth; backend output must reconcile to fixture expectations.
- Pass: backend relations for exercised intents match fixture canonical relation identity and contract controls.
- Fail: backend truth diverges from fixture-required contract fields.

2. Intent-to-bucket invariant
- Rule: each `QueryIntent` maps deterministically to one expected relation bucket (via `INTENT_EXPECTED_BUCKETS`).
- Pass: query result compared only against mapped bucket for that intent.
- Fail: intent resolves to wrong/multiple bucket semantics for the same comparison path.

3. Edge-kind translation invariant
- Rule: fixture protocol `edge_kind` is translated to DB storage vocabulary via `PROTOCOL_TO_DB_EDGE_KIND` before comparison.
- Pass: translated edge kinds align across fixture-derived rows and backend-observed rows.
- Fail: translation mismatch causing semantic drift in relation classification.

4. Contract-driven minimum-count invariant
- Rule: `contract.minimum_counts` for required intent buckets is mandatory.
- Pass: backend-observed counts meet/exceed minimum.
- Fail: below minimum -> contract violation.

5. Required-kind invariant
- Rule: `contract.required_relation_kinds` must be present for required comparisons.
- Pass: all required kinds are observed in expected direction.
- Fail: missing required kind.

6. Required-direction invariant
- Rule: `contract.required_directions` must hold (`incoming|outgoing|bidirectional`).
- Pass: observed relations satisfy declared directional contract.
- Fail: direction absent or contradicting fixture contract.

## Explicit fail policy for CI surfaces
- Any violation of required contract controls (`minimum_counts`, `required_relation_kinds`, `required_directions`) is fail-class (S0/S1 depending on severity policy).
- Optional-bucket or non-authoritative metadata drift may degrade to warn/info only when required controls are intact.
- Comparator outputs must carry enough fields to explain deterministic outcome (`class`, `severity`, `contract_basis`, `intent`, `bucket`, `entity_family`, `entity`).

## Decision summary
The schema/contract model is frozen as a two-layer contract:
1) uniform cross-family required structure and contract-control fields, and
2) family-specific bucket + minimum-non-empty expectations,
with comparison outcomes enforced through intent/bucket and edge-kind invariants to keep fixture-first CI results reproducible.

## Scope
This section freezes the fixture schema and comparator contract used by WLAN ground-truth tests. It is the canonical pass/fail reference for entity-family fixture validation and fixture-vs-backend reconciliation.

## Required fixture fields (all families)
A fixture is **schema-pass** only if all required fields exist with valid types:
- `kind`: enum in `{api, struct, ring, hw_block, thread, signal, interrupt, timer, dispatch_table, message, log_point}`
- `kind_verbose`: non-empty string
- `canonical_name`: non-empty string
- `aliases`: array (empty allowed)
- `source.file`: non-empty string
- `source.line`: positive integer
- `description`: non-empty string
- `relations`: object with all canonical buckets present
- `contract`: object with required comparator expectations

**Fail expectation**: missing/invalid required field => schema validation fail.

## Required relation-bucket envelope (all families)
`relations` must include all nine buckets:
- `calls_in_runtime`
- `calls_in_direct`
- `calls_out`
- `registrations_in`
- `registrations_out`
- `structures`
- `logs`
- `owns`
- `uses`

Each bucket value must be an array (empty allowed unless family non-empty rule applies).

**Fail expectation**: missing bucket or non-array bucket => schema validation fail.

## Entity-family contract matrix (frozen)
Each family must satisfy both: (a) required buckets present, and (b) at least one non-empty bucket from its family minimum set.

- `api`
  - required buckets: `calls_in_runtime`, `calls_in_direct`, `calls_out`, `registrations_in`, `structures`, `logs`
  - minimum non-empty: one of `calls_in_runtime | calls_in_direct | registrations_in`
- `struct`
  - required buckets: `structures`, `owns`, `uses`
  - minimum non-empty: `structures`
- `ring`
  - required buckets: `registrations_out`, `uses`
  - minimum non-empty: one of `registrations_out | uses`
- `hw_block`
  - required buckets: `registrations_out`, `uses`
  - minimum non-empty: one of `registrations_out | uses`
- `thread`
  - required buckets: `calls_in_runtime`, `calls_out`, `registrations_out`
  - minimum non-empty: one of `calls_in_runtime | calls_out`
- `signal`
  - required buckets: `calls_in_runtime`
  - minimum non-empty: `calls_in_runtime`
- `interrupt`
  - required buckets: `calls_out`, `registrations_out`
  - minimum non-empty: one of `calls_out | registrations_out`
- `timer`
  - required buckets: `calls_out`, `registrations_out`
  - minimum non-empty: one of `calls_out | registrations_out`
- `dispatch_table`
  - required buckets: `calls_out`, `registrations_in`
  - minimum non-empty: `calls_out`
- `message`
  - required buckets: `calls_in_runtime`, `calls_out`
  - minimum non-empty: one of `calls_in_runtime | calls_out`
- `log_point`
  - required buckets: `logs`
  - minimum non-empty: `logs`

**Fail expectation**: required family bucket missing OR family minimum non-empty rule not satisfied => schema validation fail.

## Comparison invariants (fixture vs backend)
1. **Fixture authority invariant**
   - Fixture corpus is source of truth; backend output must conform to fixture contract.
   - Fail when backend lacks required fixture relation/count/direction.
2. **Family→intent→bucket invariant**
   - `FAMILY_INTENTS[family]` and `INTENT_EXPECTED_BUCKETS[intent]` must jointly map every exercised comparison to exactly one expected bucket set.
   - Fail on missing required intent bucket for a family.
3. **Edge-kind translation invariant**
   - Fixture protocol `edge_kind` must be translated via `PROTOCOL_TO_DB_EDGE_KIND` before backend comparison.
   - Fail when translation mismatch causes required relation mismatch.
4. **Contract criticality invariant**
   - `contract.minimum_counts`, `contract.required_relation_kinds`, and `contract.required_directions` govern required-vs-optional severity.
   - Any violation of required contract dimensions is fail-level (S0/S1).
5. **Determinism invariant**
   - Same fixture + same mappings must yield same mismatch class/severity outputs.
   - Fail when contract surfaces conflict and pass/fail outcome depends on path.

## Required `contract` fields and pass/fail expectations
- `required_relation_kinds: string[]`
- `required_directions: string[]`
- `minimum_counts: Record<string, number>` keyed by expected bucket or relation grouping

Pass/fail behavior:
- Missing contract field for required comparison path => fail.
- Backend result below `minimum_counts` for required bucket => fail.
- Relation kind/direction outside required contract for required path => fail.
- Optional-path evidence weakness/extra relation => warn/info per mismatch taxonomy, not hard fail unless escalated by contract rules.

## Explicit run-level gate expectations
A comparator run is **PASS** only when:
- no schema validation failures, and
- no S0/S1 mismatches in required contract buckets.

A comparator run is **WARN** when:
- schema passes, required buckets pass, but S2 mismatches remain.

A comparator run is **INFO/ADVISORY** when:
- only S3 findings exist.

A comparator run is **FAIL** when:
- any schema contract violation occurs, or
- any required contract mismatch escalates to S0/S1.

## Contract ownership and update policy
- This frozen model is owned by fixture-schema + reconciliation boundaries.
- Any future family or bucket change must update:
  1. fixture schema contract tests,
  2. reconciliation intent/bucket mapping,
  3. this frozen section before release gating is changed.

## Frozen schema and comparison contract (item 2)

This section freezes the fixture schema + comparison contract used by WLAN ground-truth verification. It is the explicit pass/fail reference for schema validation (item 5), comparator design (item 7), and CI gating (item 9).

### 1) Entity-family contract (frozen)
- Supported families are exactly: `api`, `struct`, `ring`, `hw_block`, `thread`, `signal`, `interrupt`, `timer`, `dispatch_table`, `message`, `log_point`.
- Canonical corpus authority is `test/fixtures/wlan/index.json` (current 69 entities) plus family fixture JSON files.

**Pass condition**
- Every fixture has `kind` in the approved family set and family-level relation expectations align with `entity-contract.test.ts` family rules.

**Fail condition**
- Unknown family kind, missing family membership, or family fixture shape violating required family buckets/non-empty expectations.

### 2) Required cross-family fields (frozen)
Required on every entity fixture:
- `kind`, `kind_verbose`, `canonical_name`, `aliases`, `source.file`, `source.line`, `description`, `relations`, `contract`.
- `relations` must expose the 9 canonical buckets:
  `calls_in_direct`, `calls_in_runtime`, `calls_out`, `registrations_in`, `registrations_out`, `structures`, `logs`, `owns`, `uses`.

**Pass condition**
- All required fields exist with valid types/constraints (`canonical_name` non-empty, `source.line` positive integer, buckets present as arrays).

**Fail condition**
- Any missing required field, invalid type/constraint, or missing canonical relation bucket.

### 3) Contract object fields (frozen)
`contract` fields consumed by reconciliation are:
- `required_relation_kinds: string[]`
- `required_directions: string[]`
- `minimum_counts: Record<string, number>`
- `required_path_patterns: Array<{name,nodes[],description}>`

**Pass condition**
- Contract keys are present and valid, relation kinds/directions use allowed vocabularies, and bucket counts are numeric and non-negative.

**Fail condition**
- Missing/ill-typed contract keys, out-of-vocabulary relation kinds/directions, or malformed `minimum_counts` values.

### 4) Comparison invariants (fixture vs backend)
These invariants must hold for each `(entity, intent, bucket)` comparison:
1. **Intent→bucket invariant**: intent must resolve to exactly one expected bucket via `INTENT_EXPECTED_BUCKETS`.
2. **Family→intent invariant**: each family is validated only against its declared `FAMILY_INTENTS` surface.
3. **Protocol→DB edge invariant**: fixture protocol edge kinds normalize through `PROTOCOL_TO_DB_EDGE_KIND` before backend match.
4. **Minimum-count invariant**: backend-observed relations must satisfy fixture `contract.minimum_counts` for required buckets.
5. **Identity/source invariant**: matched relations preserve canonical identity + source anchors unless fixture marks optional evidence.

**Pass condition**
- All five invariants hold and no required contract relation violates counts/kinds/directions.

**Fail condition**
- Any invariant break (`missing`, `source_mismatch`, `unresolved_alias`, `consistency`, etc.) at S0/S1 in required contract scope.

### 5) Deterministic pass/fail outcome contract
- **Schema gate**: any cross-family required-field violation is hard fail.
- **Comparator gate**: required-contract mismatches (`minimum_counts`, `required_relation_kinds`, `required_directions`, mapping consistency) are fail-severity outcomes.
- **CI gate**: S0/S1 on required contract paths => fail; S2 => warn; S3 => advisory/info.

This freeze binds schema shape, contract interpretation, and comparison behavior to one deterministic contract so fixture data remains authoritative across mocked and live verification paths.

## Programmatic validation contract

The fixture schema is enforced programmatically via `src/fixtures/schema-validator.ts` before any comparison runs. The validator implements a two-layer contract:

**Layer 1: Cross-family required fields**
Every fixture must have these top-level fields:
- `kind` (string): one of 11 family types (api, struct, ring, hw_block, thread, signal, interrupt, timer, dispatch_table, message, log_point)
- `kind_verbose` (string): human-readable kind label
- `canonical_name` (string): non-empty stable identifier
- `aliases` (array): may be empty, but must be an array
- `source.file` (string): non-empty relative path
- `source.line` (integer): positive integer ≥ 1
- `description` (string): non-empty; recommend 50-200 chars
- `relations` (object): required relation buckets (see Layer 2)
- `contract` (optional): object with optional `required_relation_kinds`, `required_directions`, `minimum_counts` fields

**Layer 2: Relations envelope (all families)**
Every `relations` object must contain these 9 required buckets, each as an array:
- `calls_in_direct`, `calls_in_runtime`, `calls_out`
- `registrations_in`, `registrations_out`
- `structures`, `logs`, `owns`, `uses`

**Layer 3: Family-specific non-empty bucket rules**
At least one of these family-specific buckets must be non-empty:
- `api`: one of [calls_in_runtime, calls_in_direct, registrations_in]
- `struct`: [structures]
- `ring`: one of [registrations_out, uses]
- `hw_block`: one of [registrations_out, uses]
- `thread`: one of [calls_in_runtime, calls_out]
- `signal`: [calls_in_runtime]
- `interrupt`: one of [calls_out, registrations_out]
- `timer`: one of [calls_out, registrations_out]
- `dispatch_table`: [calls_out]
- `message`: one of [calls_in_runtime, calls_out]
- `log_point`: [logs]

**Layer 4: Optional contract field validation**
If `contract` field is present, it must be an object with only these optional keys:
- `required_relation_kinds` (array): relation edge-kind strings
- `required_directions` (array): direction labels
- `minimum_counts` (object): intent-to-count map

**Validator API**

`validateFixture(fixture: unknown): ValidationResult`
- Accepts raw JSON.parse output (unknown type)
- Returns `{ valid: boolean; errors: ValidationError[]; warnings: ValidationError[] }`
- Each error/warning has `{ field: string; message: string; severity: "error" | "warning" }`
- Fails on any error; warnings do not block validity
- All validation is deterministic and runs synchronously

`validateFixtureFile(filePath: string): Promise<ValidationResult>`
- Loads fixture JSON from disk, parses, validates
- Returns error if file does not exist or JSON is invalid
- Delegates schema validation to `validateFixture`

`validateCorpus(fixtureDir: string): Promise<{ results: Map<string, ValidationResult>; summary: { total, valid, invalid } }>`
- Validates all *.json files in a directory (non-recursive, top-level only)
- Returns per-file results and summary counts
- Used by test/unit/fixtures/schema-validator.test.ts to validate all real fixtures in test/fixtures/wlan/{family}

**Implementation source**
- Source: src/fixtures/schema-validator.ts (287 lines)
- Tests: test/unit/fixtures/schema-validator.test.ts (467 lines, 53 tests, 53 pass)
- Coverage: valid api fixture, kind validation (missing/invalid/empty), canonical_name validation, source.file validation, source.line validation, all 9 relation buckets (missing/type/non-empty), all 11 family non-empty rules, description validation, optional contract fields, non-object inputs, real fixture files, corpus validation

**Mirror synchronization**
The validator constants are mirrors of test-layer rules:
- `VALID_KINDS` mirrors entity family inventory from corpus manifest
- `RELATIONS_REQUIRED_BUCKETS` = [calls_in_direct, calls_in_runtime, calls_out, registrations_in, registrations_out, structures, logs, owns, uses]
- `FAMILY_MIN_NONEMPTY` mirrors `FAMILY_MIN_NONEMPTY` in test/unit/intelligence/entity-contract.test.ts

When any schema contract changes, both the validator and the test layer must be updated to keep validation and test assertions in sync.
