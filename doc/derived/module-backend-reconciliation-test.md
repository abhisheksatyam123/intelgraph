---
tags:
  - status/wip
description: Layer 3: Fixture-as-ground-truth reconciliation.
---

# module-backend-reconciliation-test

## Index

- [Index](#index) — L9
- [Meaning](#meaning) — L78
- [Data flow](#data-flow) — L89
- [Mismatch taxonomy and severity](#mismatch-taxonomy-and-severity) — L105
- [Severity scale](#severity-scale) — L133
- [Taxonomy with explicit severity rules](#taxonomy-with-explicit-severity-rules) — L140
- [Concrete examples](#concrete-examples) — L151
- [Report and CI mapping contract](#report-and-ci-mapping-contract) — L160
- [Context](#context) — L170
- [Decision](#decision) — L173
- [Severity policy](#severity-policy) — L195
- [Deterministic classification rules](#deterministic-classification-rules) — L201
- [Consequences](#consequences) — L207
- [Mismatch taxonomy and severity rules](#mismatch-taxonomy-and-severity-rules) — L212
- [Context](#context) — L214
- [Decision](#decision) — L217
  - [Taxonomy (canonical `mismatch_type`)](#taxonomy-canonical-mismatch_type) — L220
  - [Severity levels (canonical `severity`)](#severity-levels-canonical-severity) — L228
  - [Deterministic severity rules](#deterministic-severity-rules) — L234
    - [`missing`](#missing) — L235
    - [`extra`](#extra) — L243
    - [`source_mismatch`](#source_mismatch) — L248
    - [`unresolved_alias`](#unresolved_alias) — L253
    - [`evidence_weak`](#evidence_weak) — L258
    - [`consistency`](#consistency) — L263
- [Rationale](#rationale) — L268
- [Consequences](#consequences) — L271
- [Alternatives considered](#alternatives-considered) — L276
- [Quality](#quality) — L281
- [Mismatch taxonomy and severity levels](#mismatch-taxonomy-and-severity-levels) — L286
- [Taxonomy](#taxonomy) — L319
- [Severity rules](#severity-rules) — L330
- [Cross-cutting escalation invariants](#cross-cutting-escalation-invariants) — L353
- [Comparator output contract requirement](#comparator-output-contract-requirement) — L359
- [Comparator classifier test matrix (item 3.4.1.1)](#comparator-classifier-test-matrix-item-3411) — L369
- [Context](#context) — L371
- [Decision](#decision) — L374
- [Contract / Interface for tests](#contract-interface-for-tests) — L407
- [Consequences](#consequences) — L424
- [Alternatives considered](#alternatives-considered) — L429
- [Comparator mismatch classifier test matrix (item 3.4.1.1)](#comparator-mismatch-classifier-test-matrix-item-3411) — L433
  - [Required fixture-driven test matrix](#required-fixture-driven-test-matrix) — L435
    - [Matrix expectations](#matrix-expectations) — L443
    - [Determinism assertions](#determinism-assertions) — L449
    - [Test linkage](#test-linkage) — L454
- [Context](#context) — L457
- [Decision](#decision) — L460
- [Determinism invariants](#determinism-invariants) — L482
- [Implementation handoff](#implementation-handoff) — L488
- [Links](#links) — L491
- [Contract under test](#contract-under-test) — L495
- [Required fixture-driven test matrix](#required-fixture-driven-test-matrix) — L498
- [Determinism assertions](#determinism-assertions) — L517
- [Suggested test structure](#suggested-test-structure) — L523
- [Links](#links) — L528
- [Classifier test contract (item 3.4.1.1)](#classifier-test-contract-item-3411) — L532
- [Implementation dependency gap (item 3.4.1.1)](#implementation-dependency-gap-item-3411) — L581
- [Classifier implementation gap (item 3.4.1.1)](#classifier-implementation-gap-item-3411) — L592
- [Test implementation handoff (item 3.4.1.1)](#test-implementation-handoff-item-3411) — L607
- [Comparator classifier output interface (unblock contract for 3.4.1.1)](#comparator-classifier-output-interface-unblock-contract-for-3411) — L621
- [Contract](#contract) — L630
- [Invariants](#invariants) — L636
- [Test interface shape](#test-interface-shape) — L642
- [Contract](#contract) — L645
- [Invariants](#invariants) — L651
- [Test interface shape](#test-interface-shape) — L656

## Meaning

Layer 3: Fixture-as-ground-truth reconciliation. For every entity in the fixture corpus, this test harness:
1. Builds mock DB rows from the fixture's relation buckets
2. Injects them into intelligence_query via setIntelligenceDeps
3. Calls the tool for each entity and each required intent
4. Compares backend response against fixture contract expectations
5. Reports mismatches at (entity, relation_bucket, field) granularity

The fixture is authoritative; the backend must match it. All tests use mocked DB rows (no live backend required during test runs).

## Data flow

Reads: test/fixtures/wlan/index.json (manifest), test/fixtures/wlan/*/\*.json (entity fixtures)

Calls: intelligence_query tool with mocked DB (via setIntelligenceDeps)

Iterates over all supported families (api, struct, ring, hw_block, thread, signal, interrupt, timer, dispatch_table, message, log_point) and all entities in each family.

For each entity:
- Build mock DB rows from fixture.relations
- For each FAMILY_INTENTS[family], call intelligence_query
- Compare response against fixture.contract expectations
- Report mismatches: (entity, relation_bucket, field, expected, actual)

Exit code indicates pass/fail for CI integration.

## Mismatch taxonomy and severity

Comparator classification for fixture-vs-backend mismatches uses six classes with explicit severity:
- missing
- extra
- source_mismatch
- unresolved_alias
- evidence_weak
- consistency

Severity policy:
- **S0/S1 (fail)** for required-contract violations (`minimum_counts`, required intent bucket presence, required kind/direction) and for mock-vs-live consistency breaks on required relations.
- **S2 (warn)** for non-required but material drift (non-conflicting extras, partial source-anchor divergence, ambiguous alias fallback).
- **S3 (advisory)** for weak/non-required evidence metadata gaps or duplicate/noise rows after normalization.

Class rules:
1. missing → S0 if required bucket/minimum violated; else S1 for required kind/direction missing; else S2 optional context missing.
2. extra → S1 when conflicting with fixture kind/direction semantics; else S2 unmodeled but plausible drift; S3 duplicates/noise.
3. source_mismatch → S1 required file-anchor conflict; S2 line/path-pattern divergence; S3 non-required metadata omission.
4. unresolved_alias → S1 blocks canonical entity match for required intent; S2 fallback relation match with identity ambiguity; S3 non-required display alias unresolved.
5. evidence_weak → S2 required evidence absent; S3 recommended-only evidence absent.
6. consistency → S0 required-relation disagreement across mock/live paths; S1 contradictory results across intents for same boundary; S2 count/order-only divergence with required presence intact.

Normalization and precedence before classification:
1) canonicalize names via alias map, 2) translate protocol edge kinds to DB edge kinds, 3) de-duplicate rows, 4) classify mismatch and severity. This keeps CI deterministic and prevents representational noise from inflating severity.

CI mapping: any S0/S1 => fail; else any S2 => warn; only S3 => pass with advisory.

## Severity scale

- **S0 (critical / fail-now):** contract-violating mismatch that invalidates fixture-first authority for a required check. CI must fail immediately.
- **S1 (high / fail):** major correctness mismatch that breaks expected backend-vs-fixture parity for required intents or minimum-count guarantees. CI fails.
- **S2 (medium / warn):** mismatch that preserves core parity but weakens confidence or indicates likely drift. CI warns; does not fail.
- **S3 (low / info):** non-blocking discrepancy captured for triage and trend tracking. CI informational only.

## Taxonomy with explicit severity rules

| Mismatch class | Detection rule | Default severity | Escalate to | CI/report impact |
|---|---|---|---|---|
| `missing` | Fixture-required relation/row is absent in query response for the mapped intent+bucket | S1 | S0 if it violates fixture `minimum_counts` for a required bucket or required direction | Counted under `missing`; contributes fail-class totals; blocks release at S1+ |
| `extra` | Query returns relation/row not present in fixture truth for the compared entity+bucket | S2 | S1 if extra row contradicts required direction/edge-kind contract or creates bucket pollution across intents | Counted under `extra`; warn by default; can fail when escalated |
| `source_mismatch` | Canonical relation match exists, but `source.file` and/or `source.line` disagree with fixture anchor | S2 | S1 if file differs (line-only drift stays S2) or mismatch occurs on contract-required evidence paths | Tracked as provenance drift; degrades confidence provenance dimension |
| `unresolved_alias` | Returned node cannot be resolved to fixture `canonical_name` via canonical-name match or alias set | S2 | S1 when unresolved alias blocks required relation matching and causes effective `missing` on required checks | Reported in alias-resolution bucket; warn unless it blocks required parity |
| `evidence_weak` | Relation exists but evidence quality is below contract expectation (e.g., missing edge evidence location/kind metadata required for verification) | S2 | S1 if weak evidence occurs on required contract sections or exceeds configured weak-evidence budget | Counted separately from missing/extra to avoid masking presence with low-quality proof |
| `consistency_mismatch` | Internal contract inconsistency: direction, edge_kind translation, or relation bucket is self-contradictory across fixture/response mapping | S1 | S0 if inconsistency invalidates translation boundary (`intent→bucket` or protocol→DB edge_kind) for multiple entities | Always highlighted as contract-integrity issue; fail at S1+ |

## Concrete examples

- `missing` (S1): fixture expects `calls_out` edge `wlan_thread_irq_route_wmac_tx -> wlan_tx_enqueue`, response omits it.
- `extra` (S2): response includes unexpected `logs` edge not present in fixture for the entity.
- `source_mismatch` (S2): relation found, but fixture anchor `foo.c:120` vs response `foo.c:141`.
- `unresolved_alias` (S2): response node `_wlan_tx_enqueue` fails canonical/alias resolution against fixture alias set.
- `evidence_weak` (S2): response row has relation kind but missing evidence location required for verification output.
- `consistency_mismatch` (S1): fixture relation marked `call_runtime` maps to DB `runtime_calls`, but response tagged as non-runtime `calls` for same compared edge.

## Report and CI mapping contract

- Comparator output must include per-mismatch fields: `class`, `severity`, `entity`, `intent`, `bucket`, `expected`, `actual`, `escalation_reason?`.
- Aggregate counters must be emitted by `(class, severity)` for trendability.
- CI policy bridge:
  - Any S0/S1 mismatch => **fail**
  - No S0/S1 but ≥1 S2 => **warn**
  - Only S3/none => **pass**
- Confidence scoring bridge: S1/S0 decrease backend-match and consistency dimensions sharply; S2 primarily degrades evidence quality/provenance confidence.

## Context
Fixture-first reconciliation compares backend/query output to authoritative fixture contracts at `(entity, intent, relation_bucket, field)` granularity. CI needs deterministic severity semantics so failures are actionable and confidence scoring can degrade consistently.

## Decision
Use a six-class mismatch taxonomy with fixed severity defaults and escalation rules:

1. **missing** — expected fixture relation/item absent in backend/query result.
   - Default severity: **critical**
   - Escalate to **blocker** when missing violates `contract.minimum_counts` or removes all required relations for an intent bucket.
2. **extra** — backend/query emits relation/item not present in fixture contract.
   - Default severity: **major**
   - Escalate to **critical** when extra item collides with canonical identity or causes intent bucket over-reporting that changes downstream decisions.
3. **source_mismatch** — relation identity matches but provenance (`source.file`, `source.line`, evidence location) differs materially from fixture.
   - Default severity: **major**
   - Escalate to **critical** when source anchor is missing/invalid or points to unrelated file lineage.
4. **unresolved_alias** — backend result only matches fixture through alias candidates but cannot resolve to fixture `canonical_name` deterministically.
   - Default severity: **major**
   - Escalate to **critical** when ambiguity produces multiple canonical candidates or no canonical candidate for required intents.
5. **evidence_weak** — relation exists but evidence quality is below contract requirements (missing edge kind, weak/no loc anchor, incomplete required path pattern evidence).
   - Default severity: **warning**
   - Escalate to **major** when repeated for same entity across required buckets or when required contract evidence fields are absent.
6. **consistency** — internal contract inconsistency across views (fixture contract vs response shape vs intent/bucket mapping), including direction/edge-kind translation disagreements.
   - Default severity: **critical**
   - Escalate to **blocker** when mismatch indicates mapping-layer contradiction (e.g., `PROTOCOL_TO_DB_EDGE_KIND`/`INTENT_EXPECTED_BUCKETS` cannot produce a coherent comparison basis).

## Severity policy
- **blocker**: cannot trust comparison outcome; CI must fail immediately.
- **critical**: high-confidence contract violation; CI fail.
- **major**: material divergence requiring remediation; CI fail or hard-warn depending threshold policy.
- **warning**: non-blocking quality degradation; CI warn and track trend.

## Deterministic classification rules
- Class assignment is precedence-ordered: `consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak`.
- If one diff instance matches multiple classes, record all tags but use highest-precedence class as primary severity driver.
- Escalation is monotonic only (never downgrade within same run).
- Severity is computed before aggregate confidence scoring so score degradation can reuse class totals deterministically.

## Consequences
- Comparator output can expose one primary class/severity per diff plus auxiliary tags.
- CI policy can gate on class counts and severity bands without ad-hoc interpretation.
- Confidence model can map mismatch counts to deterministic penalties (item 3.x linkage).

## Mismatch taxonomy and severity rules

## Context
Fixture-first reconciliation currently detects relation-level deltas but lacks a canonical mismatch vocabulary and severity contract, which causes inconsistent triage across comparator, reports, and CI gates.

## Decision
Define a six-class mismatch taxonomy with deterministic severity assignment using fixture contract criticality and relation tier context.

### Taxonomy (canonical `mismatch_type`)
1. `missing` — fixture-required relation or item is absent from backend/query result.
2. `extra` — backend/query returns relation or item not present in fixture authority.
3. `source_mismatch` — matched relation exists, but source anchor (`source.file`, `source.line`, `evidence.loc`) conflicts with fixture contract.
4. `unresolved_alias` — backend/query row cannot be canonicalized to fixture `canonical_name` or `aliases`.
5. `evidence_weak` — relation exists but lacks required evidence quality (missing/low-fidelity source anchors, weak pattern proof, or missing contract-required evidence markers).
6. `consistency` — internally contradictory output (e.g., edge_kind↔direction mismatch, duplicate conflicting rows, intent bucket disagreement for same entity/relation).

### Severity levels (canonical `severity`)
- `blocker` — release-failing mismatch; fixture authority or core contract is violated.
- `major` — high-priority defect; output usable only with explicit risk acceptance.
- `minor` — non-blocking discrepancy; remediation required but does not invalidate run.
- `info` — advisory inconsistency; track and trend, no immediate gate.

### Deterministic severity rules
#### `missing`
- `blocker` when missing item satisfies any of:
  - required by fixture `contract.minimum_counts` (count underflow), or
  - required by `required_relation_kinds` / `required_directions`, or
  - belongs to Tier-1 incoming critical coverage for the entity intent.
- `major` when missing affects Tier-2 contextual/runtime coverage not marked optional.
- `minor` when missing affects Tier-3 optional coverage only.

#### `extra`
- `major` when extra relation conflicts with fixture contract namespace (wrong edge_kind/direction bucket for intent) or produces contradictory semantic path.
- `minor` when extra is plausible but uncontracted and non-conflicting.
- `info` when extra is duplicate-equivalent noise after normalization.

#### `source_mismatch`
- `blocker` when fixture contract requires exact source anchor and backend evidence points to a different file/line family.
- `major` when source path matches subsystem but line/range anchor diverges beyond tolerated normalization.
- `minor` when only formatting/normalization differences exist and semantic anchor remains equivalent.

#### `unresolved_alias`
- `blocker` when unresolved alias prevents mapping of required relation that drives pass/fail intent checks.
- `major` when unresolved alias affects non-required relation sets.
- `minor` when alias ambiguity is recoverable and does not change relation cardinality/outcome.

#### `evidence_weak`
- `major` when evidence weakness applies to required relations (contract-required path patterns or required sections).
- `minor` when evidence weakness applies to optional/contextual relations.
- `info` when weak evidence is expected transitional debt explicitly allowlisted for migration window.

#### `consistency`
- `blocker` when contradictions make comparator result non-deterministic (same entity+intent+relation key yields incompatible facts).
- `major` when contradiction is localized but changes bucket/edge interpretation.
- `minor` when inconsistency is representational and resolver can deterministically normalize.

## Rationale
A fixed taxonomy plus deterministic severity mapping keeps fixture-first authority intact, yields reproducible triage across mocked/live paths, and enables later CI threshold policy to aggregate by severity without reinterpretation.

## Consequences
- Comparator/report contracts must emit `mismatch_type`, `severity`, and `rule_id` per diff.
- Classification logic must consume fixture contract context (`minimum_counts`, required kinds/directions, tier context).
- CI policy can remain decoupled: it consumes normalized severities rather than bespoke comparator strings.

## Alternatives considered
- Binary pass/fail only: rejected because it hides remediation priority and blocks trend analysis.
- Per-test custom mismatch labels: rejected because labels drift across harnesses and break reproducibility.
- Severity based only on mismatch_type (no context): rejected because optional vs required mismatches need different operational weight.

## Quality
- Rule set is deterministic: same diff + same fixture contract context must always produce same severity.
- Rule set is composable with future threshold/trend policy in reporting/CI layer.
- Rule set preserves fixture-first authority: backend output is judged against fixture contract, never vice versa.

## Mismatch taxonomy and severity levels

Comparator mismatch taxonomy is precedence-ordered so each `(entity, intent, bucket, relation_key)` emits one primary class and optional secondary diagnostics.

Primary classes and default severities:
1. **consistency_mismatch** — **critical/fail**
   - Trigger: fixture and backend rows conflict on invariant fields (relation direction, translated edge kind, canonical identity) or violate contract `minimum_counts` after intent→bucket and protocol→DB translation.
   - Rule: always highest precedence because it indicates contradictory truth rather than absence.
2. **missing** — **high/fail**
   - Trigger: fixture-required relation or contract-required minimum count is absent in backend/query response.
   - Rule: escalate to critical when missing count breaches declared `minimum_counts` by more than one relation tier.
3. **source_mismatch** — **high/fail**
   - Trigger: relation exists but `source.file`/`source.line` or evidence anchor does not match fixture-authoritative source anchor.
   - Rule: fail by default for source-of-truth drift; downgrade to warn only when fixture marks evidence optional.
4. **unresolved_alias** — **medium/warn**
   - Trigger: backend returns name variant that cannot be resolved to fixture `canonical_name` via `aliases`.
   - Rule: escalate to high/fail if unresolved alias causes intent bucket miss (becomes functional mismatch).
5. **extra** — **medium/warn**
   - Trigger: backend/query emits relation not present in fixture truth for the evaluated intent/bucket.
   - Rule: escalate to high/fail when extra relation violates family contract expectations or creates contradictory edge kind/direction.
6. **evidence_weak** — **low/warn**
   - Trigger: relation matches semantically but evidence quality is below acceptance policy (weak derivation/source certainty, incomplete anchor metadata).
   - Rule: never outranks functional mismatches; accumulates into confidence degradation and becomes fail only when quality floor threshold is crossed at aggregate score stage.

Precedence rule (single primary label):
`consistency_mismatch > missing > source_mismatch > unresolved_alias > extra > evidence_weak`

Aggregation and CI mapping:
- Any critical or high primary mismatch in required contract paths yields comparator **fail** for the entity.
- Medium-only mismatches yield **warn** and remediation hints.
- Low-only mismatches keep comparator pass but reduce confidence score contribution in evidence-quality dimension.
- Report payload should preserve both `primary_class` and `secondary_classes` to keep remediation specific while maintaining deterministic gating.

## Taxonomy

Comparator classification MUST emit exactly one primary mismatch class per finding:

1. **missing** — fixture-required relation/field is absent in backend response.
2. **extra** — backend returns relation/field not present in fixture truth set for the compared scope.
3. **source_mismatch** — relation exists but source anchor (`source.file`/`source.line` or edge evidence location) disagrees with fixture expectation.
4. **unresolved_alias** — backend row cannot be mapped to fixture canonical identity through canonical name or declared aliases.
5. **evidence_weak** — relation exists but evidence quality is below contract floor (missing evidence location, unsupported edge_kind, or confidence signal below required level).
6. **consistency** — internal contract contradiction across equivalent views (intent-to-bucket mismatch, direction mismatch, minimum-count violation, or protocol↔DB edge-kind translation inconsistency).

## Severity rules

Severity is deterministic by class and escalation condition:

- **missing**
  - `error` when finding violates fixture `contract.required_relation_kinds`, `contract.required_directions`, or `contract.minimum_counts`.
  - `warn` when the missing relation is outside required contract but inside family-intent expected buckets.
- **extra**
  - `warn` by default (possible backend over-reporting).
  - `error` when extra relation also conflicts with fixture identity boundary (different canonical entity namespace) or breaks deterministic comparator output.
- **source_mismatch**
  - `error` when canonical source anchor differs for required relation.
  - `warn` when only secondary evidence metadata differs but canonical file/line anchor still matches.
- **unresolved_alias**
  - `error` when no canonical-or-alias mapping exists after normalization.
  - `warn` when mapping is ambiguous but one candidate remains recoverable with deterministic tie-break rule.
- **evidence_weak**
  - `warn` by default; score degradation only.
  - `error` when weak evidence is attached to a required relation and prevents contract verification.
- **consistency**
  - `error` for intent/bucket/direction/translation contradictions that make result non-reproducible.
  - `warn` for non-contract formatting inconsistencies that do not change relation truth value.

## Cross-cutting escalation invariants

- Any mismatch affecting required contract checks (`required_relation_kinds`, `required_directions`, `minimum_counts`) escalates to at least `error`.
- If a finding is both `evidence_weak` and another class, use the other class as primary and attach `evidence_weak` as a secondary flag.
- CI gating input should consume severities as: `error` => fail candidate, `warn` => degradable but reviewable.

## Comparator output contract requirement

Each finding record should carry:
- `mismatch_class` (one of taxonomy values)
- `severity` (`error`|`warn`)
- `entity_family`, `canonical_name`, `intent`, `relation_bucket`
- `expected`, `actual`
- `rule_id` (deterministic rule that assigned severity)
- `secondary_flags` (optional, e.g. `evidence_weak`)

## Comparator classifier test matrix (item 3.4.1.1)

## Context
The comparator taxonomy/severity contract is defined in `[[#Mismatch taxonomy and severity]]`, but executable test coverage must be deterministic across all six mismatch classes and escalation paths.

## Decision
Use a table-driven test matrix where each row binds one canonical mismatch class to explicit expected outputs:
- `mismatch_type`
- `severity`
- `rule_id`

Required matrix coverage:
1. `missing`
   - required bucket or `minimum_counts` violation -> `S0`/`S1` (fail)
   - optional bucket absence -> `S2`
2. `extra`
   - canonical conflict/systematic drift -> `S1`
   - plausible unmodeled optional -> `S2`
   - duplicate/noise after normalization -> `S3`
3. `source_mismatch`
   - required source-anchor traceability break -> `S1` (or `S0` when auditability is blocked)
   - metadata-only divergence -> `S2`/`S3`
4. `unresolved_alias`
   - required intent match blocked -> `S1` (or `S0` if comparison cannot proceed)
   - optional alias ambiguity with fallback -> `S2`/`S3`
5. `evidence_weak`
   - required evidence absent -> `S2` (escalate `S1` for release-gated required relation)
   - recommended evidence absent -> `S3`
6. `consistency`
   - mock/live required relation contradiction -> `S0`
   - cross-intent contradiction on same required boundary -> `S1`
   - count/order divergence with required presence intact -> `S2`

Tie-break invariants to test explicitly:
- Primary classification precedence remains deterministic (`consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak`) when one diff could match multiple classes.
- Contract-driven escalation (`minimum_counts`, `required_relation_kinds`, `required_directions`) overrides class default severity.
- Recurrence escalation (`>=3` same-class entity hits) promotes one severity band, capped at `S0`.

## Contract / Interface for tests
Each expected diff row in tests should assert this stable shape:
```ts
type ComparatorMismatchRecord = {
  mismatch_type: "missing" | "extra" | "source_mismatch" | "unresolved_alias" | "evidence_weak" | "consistency"
  severity: "S0" | "S1" | "S2" | "S3"
  rule_id: string
  entity: string
  intent: string
  bucket: string
  expected: unknown
  actual: unknown
}
```

`rule_id` should be deterministic and class+trigger specific so CI/reporting can aggregate root causes without parsing message text.

## Consequences
- Comparator and reporting tests can gate deterministic CI outcomes directly from mismatch records.
- Future classifier refactors remain safe because semantic expectations are encoded as contract rows, not ad-hoc assertions.
- Any new mismatch class now requires explicit matrix and CI mapping updates before acceptance.

## Alternatives considered
- Snapshot-only assertions over full mismatch payloads: rejected because payload order/noise can hide class/severity regressions.
- String-message assertions without `rule_id`: rejected because remediation and trend analysis become non-deterministic.

## Comparator mismatch classifier test matrix (item 3.4.1.1)

### Required fixture-driven test matrix

The comparator test matrix must assert deterministic classifier output for the taxonomy cases already enumerated in item 3.4.1.1. Each row should validate the triad emitted from a diff record:

- `mismatch_type`: canonical taxonomy label for the primary mismatch class
- `severity`: deterministic severity assigned from the taxonomy/severity contract
- `rule_id`: stable identifier for the first matching rule, used for CI reproducibility and auditability

#### Matrix expectations
- Each taxonomy case must map to exactly one primary classifier outcome.
- Tie-breaking must be deterministic; repeated runs on the same diff row set must yield identical `rule_id` values.
- The test suite should fail if the comparator omits any of the three fields or if the emitted values drift across repeated execution.
- The matrix should cover the taxonomy classes already defined in the note (`missing`, `extra`, `source_mismatch`, `unresolved_alias`, `evidence_weak`, `consistency`) and verify the precedence order established in the taxonomy note.

#### Determinism assertions
- Same input diff rows → same `mismatch_type`, `severity`, and `rule_id`.
- Rule precedence is stable across row ordering.
- Output is shaped for downstream report/CI consumers without further normalization.

#### Test linkage
This test contract is the executable guard for [[#Comparator classifier output interface (unblock contract for 3.4.1.1)]].

## Context
The test leaf `3.4.1.1` needs executable assertions for classifier outputs, but earlier note versions split requirements across multiple nearby sections. This section is now the single execution-facing matrix for implementation.

## Decision
Use table-driven tests that assert `{mismatch_type, severity, rule_id}` for each canonical mismatch class and escalation path.

Required matrix rows (minimum):
1. `missing.required.minimum_count` -> `mismatch_type=missing`, `severity=S0|S1`
2. `missing.required.kind_or_direction` -> `missing`, `S1`
3. `missing.optional.context` -> `missing`, `S2`
4. `extra.conflicting_semantics` -> `extra`, `S1`
5. `extra.unmodeled_plausible` -> `extra`, `S2`
6. `extra.duplicate_noise` -> `extra`, `S3`
7. `source_mismatch.required_anchor` -> `source_mismatch`, `S1`
8. `source_mismatch.pattern_divergence` -> `source_mismatch`, `S2`
9. `source_mismatch.optional_metadata` -> `source_mismatch`, `S3`
10. `unresolved_alias.required_blocking` -> `unresolved_alias`, `S1`
11. `unresolved_alias.ambiguous_fallback` -> `unresolved_alias`, `S2`
12. `unresolved_alias.display_only` -> `unresolved_alias`, `S3`
13. `evidence_weak.required_evidence_missing` -> `evidence_weak`, `S2`
14. `evidence_weak.recommended_evidence_missing` -> `evidence_weak`, `S3`
15. `consistency.required_cross_surface` -> `consistency`, `S0`
16. `consistency.required_cross_intent` -> `consistency`, `S1`
17. `consistency.count_or_order_only` -> `consistency`, `S2`

## Determinism invariants
- Precedence: `consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak`
- Escalation monotonicity: adding required-contract violations can only raise severity.
- Stable output: identical inputs must emit identical triples `{mismatch_type,severity,rule_id}`.
- CI gate mapping: any row classified `S0|S1` is fail-level; `S2` warn-level; `S3` advisory.

## Implementation handoff
`@tester` should implement vitest table-driven tests in `test/unit/intelligence/backend-reconciliation.test.ts` (or a focused classifier test file) and run the suite until green.

## Links
- [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity levels]]
- [[doc/derived/module-wlan-fixture-schema#Mismatch taxonomy and severity levels (item 2.3)]]

## Contract under test
Comparator diff classification must emit deterministic `{ mismatch_type, severity, rule_id }` for each diff row using taxonomy precedence and escalation rules from [[#Mismatch taxonomy and severity levels]].

## Required fixture-driven test matrix
1. `missing` required-bucket/minimum-count violation → `severity: S0`, `rule_id: missing.required.minimum_count`.
2. `missing` required kind/direction present in contract but not returned → `severity: S1`, `rule_id: missing.required.kind_or_direction`.
3. `missing` optional context bucket absent with required buckets intact → `severity: S2`, `rule_id: missing.optional.context`.
4. `extra` row that conflicts with fixture kind/direction semantics → `severity: S1`, `rule_id: extra.conflicting_semantics`.
5. `extra` unmodeled but plausible row (non-conflicting) → `severity: S2`, `rule_id: extra.unmodeled_plausible`.
6. `extra` duplicate/noise row removed by normalization path → `severity: S3`, `rule_id: extra.duplicate_noise`.
7. `source_mismatch` required source-file anchor conflict → `severity: S1`, `rule_id: source_mismatch.required_anchor`.
8. `source_mismatch` line/path-pattern divergence without required-anchor break → `severity: S2`, `rule_id: source_mismatch.pattern_divergence`.
9. `source_mismatch` non-required metadata omission only → `severity: S3`, `rule_id: source_mismatch.optional_metadata`.
10. `unresolved_alias` blocks canonical match for required intent → `severity: S1`, `rule_id: unresolved_alias.required_blocking`.
11. `unresolved_alias` fallback relation match with identity ambiguity → `severity: S2`, `rule_id: unresolved_alias.ambiguous_fallback`.
12. `unresolved_alias` display-only alias unresolved → `severity: S3`, `rule_id: unresolved_alias.display_only`.
13. `evidence_weak` required evidence absent → `severity: S2`, `rule_id: evidence_weak.required_evidence_missing`.
14. `evidence_weak` recommended-only evidence absent → `severity: S3`, `rule_id: evidence_weak.recommended_evidence_missing`.
15. `consistency` required-relation disagreement across mock/live surfaces → `severity: S0`, `rule_id: consistency.required_cross_surface`.
16. `consistency` contradictory intent outcomes for same required boundary → `severity: S1`, `rule_id: consistency.required_cross_intent`.
17. `consistency` count/order-only divergence with required presence intact → `severity: S2`, `rule_id: consistency.count_or_order_only`.

## Determinism assertions
- Same input diff row always yields same `{mismatch_type,severity,rule_id}`.
- Precedence invariant: when a row could match multiple classes, classifier chooses first in precedence order `consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak`.
- Escalation monotonicity: adding required-contract violation metadata may raise severity, never lower it.
- CI mapping invariant: any S0/S1-classified row causes fail-level outcome in report gate.

## Suggested test structure
- Table-driven unit tests over synthetic diff rows: one row per matrix entry plus precedence tie-break fixtures.
- Golden assertion for emitted classifier object shape: all three fields are non-empty and belong to canonical enums.
- Regression test for normalization pipeline: duplicate raw rows classify as `extra/S3` only after canonicalization + dedupe stage, avoiding severity inflation.

## Links
- [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity levels]]
- [[doc/derived/module-wlan-fixture-schema#Mismatch taxonomy and severity levels (item 2.3)]]

## Classifier test contract (item 3.4.1.1)

Purpose: define deterministic test expectations for comparator mismatch-classification output so implementation tests can be written without re-deriving taxonomy rules from source.

Required output fields per mismatch record:
- `mismatch_type`: one of `missing|extra|source_mismatch|unresolved_alias|evidence_weak|consistency`
- `severity`: one of `S0|S1|S2|S3`
- `rule_id`: stable deterministic classifier rule identifier
- `entity`, `intent`, `bucket`, `expected`, `actual`

Deterministic primary-class precedence (single primary class per diff row):
`consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak`

Test matrix (minimum required cases):
1. missing + required minimum_count violation
   - Input: backend returns fewer rows than fixture `contract.minimum_counts` for intent bucket
   - Expect: `mismatch_type=missing`, `severity=S1` (or `S0` if tier breach configured), `rule_id=missing.minimum_count`
2. missing + required bucket absent
   - Input: fixture has required relation bucket rows, backend has zero rows
   - Expect: `mismatch_type=missing`, `severity=S1`, `rule_id=missing.required_bucket`
3. source_mismatch on provenance anchor
   - Input: canonical relation exists but `source.file`/`source.line` differs materially
   - Expect: `mismatch_type=source_mismatch`, `severity=S1`, `rule_id=source_mismatch.provenance`
4. unresolved_alias non-blocking ambiguity
   - Input: backend name cannot resolve via fixture aliases but does not break required bucket presence
   - Expect: `mismatch_type=unresolved_alias`, `severity=S2`, `rule_id=alias.unresolved`
5. unresolved_alias causing functional miss
   - Input: alias miss causes required intent bucket miss
   - Expect escalation to `severity=S1`, `rule_id=alias.unresolved.functional_miss`
6. extra optional relation
   - Input: backend emits relation absent from fixture truth in non-required context
   - Expect: `mismatch_type=extra`, `severity=S2`, `rule_id=extra.optional`
7. extra contradictory relation
   - Input: extra row conflicts with canonical identity/edge-direction contract
   - Expect escalation: `mismatch_type=extra`, `severity=S1`, `rule_id=extra.contradictory`
8. evidence_weak quality-only
   - Input: semantic match exists but weak derivation/partial anchor metadata
   - Expect: `mismatch_type=evidence_weak`, `severity=S3` or `S2` per policy floor, `rule_id=evidence.weak`
9. consistency mapping contradiction
   - Input: intent→bucket or protocol→DB edge-kind translation cannot produce coherent comparison
   - Expect: `mismatch_type=consistency`, `severity=S0`, `rule_id=consistency.mapping_contradiction`

Precedence test requirement:
- When one diff row satisfies multiple class predicates, emitted primary class must follow precedence ordering above; secondary diagnostics may be emitted separately but must not change primary CI gating.

Stability test requirement:
- For identical input diff rows, classifier must emit stable `(mismatch_type, severity, rule_id)` across runs.
- Tests must assert deterministic ordering when multiple mismatches are reported in one comparator run (sorted by entity, intent, bucket, rule_id).

## Implementation dependency gap (item 3.4.1.1)

The backend reconciliation suite currently records raw field-level mismatches (`field`, `expected`, `actual`) and does not yet expose classifier output fields (`mismatch_type`, `severity`, `rule_id`) in comparator diff records.

Unblock condition for item 3.4.1.1:
1. Item 3.4.1 emits classifier-enriched mismatch rows from the comparator.
2. Emitted rows include deterministic precedence when multiple mismatch candidates apply.
3. Rule IDs are stable strings that map to the taxonomy note and CI severity policy.

Only after this contract is emitted can the 3.4.1.1 table-driven tests assert deterministic classifier behavior without re-implementing classifier logic inside test code.

## Classifier implementation gap (item 3.4.1.1)

Current `test/unit/intelligence/backend-reconciliation.test.ts` asserts raw mismatch count/fields only (`entity/family/intent/field/expected/actual`) and does not yet consume comparator-classifier output fields (`mismatch_type`, `severity`, `rule_id`).

Gap diagnosis:
- Existing mismatch capture is local `Mismatch` struct in test file and not taxonomy-aware.
- Repository search shows no emitted classifier fields/rule IDs in current comparator/test surfaces.
- Therefore classifier-matrix tests must be staged behind the 3.4.1 implementation that emits canonical classifier fields.

Execution contract for next test pass:
1. Keep current reconciliation pass/fail assertions unchanged.
2. Add table-driven assertions for the 9-case matrix from [[#Classifier test contract (item 3.4.1.1)]].
3. Assert deterministic precedence (`consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak`) and stable sorting key `(entity, intent, bucket, rule_id)` for repeated runs.
4. Fail CI on S0/S1 in required contract paths, warn on S2-only, advisory on S3-only per [[#Mismatch taxonomy and severity levels]].

## Test implementation handoff (item 3.4.1.1)

Execution contract for tester/coder implementation:
- Implement Vitest coverage in `test/unit/intelligence/backend-reconciliation.test.ts` (or split helper test file) asserting classifier outputs canonical fields: `mismatch_type`, `severity`, `rule_id`.
- Cover the taxonomy cases already enumerated for item 3.4.1.1, and assert repeated classification of the same diff row is identical.
- Include precedence assertion for any multi-match row (`consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak`).
- Include stability assertions: identical input row => identical classification output; multi-row report ordering deterministic by `(entity, intent, bucket/field, rule_id)`.
- Close signal for execution leaf is a green test run (targeted Vitest or suite) proving matrix pass.

Suggested evidence payload for closure:
- Test file path(s) changed
- Command run and pass count
- Any rule-id normalization decisions linked back to this note section.

## Comparator classifier output interface (unblock contract for 3.4.1.1)

The comparator classifier output interface is a deterministic triad: each classified diff row must expose `mismatch_type`, `severity`, and `rule_id`. For the six taxonomy cases used by item 3.4.1.1, the emitted triad is stable across repeated runs, and tests can assert the exact mapping directly from diff rows without re-deriving taxonomy logic.

- Taxonomy coverage in the test matrix should enumerate the six canonical cases used by 3.4.1.1.
- Determinism requirement: repeated classification of the same row set must yield byte-for-byte identical triads.
- Unknown or unmapped rows may still classify, but the contract under test is the stable triad on known taxonomy cases.
- Test linkage: [[#Comparator mismatch classifier test matrix (item 3.4.1.1)]].

## Contract
Comparator diff rows must expose canonical classifier fields for downstream tests and CI:
- `mismatch_type`: stable taxonomy label for the primary finding class
- `severity`: deterministic gate level derived from the taxonomy rule table
- `rule_id`: stable identifier of the rule that produced the classification

## Invariants
- The same diff row classified twice yields identical `mismatch_type`, `severity`, and `rule_id`.
- When multiple mismatch signals apply, precedence is deterministic and resolves to one primary `mismatch_type`.
- `rule_id` is stable across repeated runs for the same taxonomy case and does not depend on row ordering or incidental fixture iteration order.
- Tests should treat `mismatch_type` + `severity` + `rule_id` as the canonical observable output for classifier behavior.

## Test interface shape
The test matrix for item 3.4.1.1.1.1 should assert the emitted fields directly from comparator diff rows, using the same taxonomy cases already enumerated in 3.4.1.1.

## Contract
Comparator diff records consumed by 3.4.1.1 tests must expose:
- `mismatch_type`: `missing | extra | source_mismatch | unresolved_alias | evidence_weak | consistency`
- `severity`: `S0 | S1 | S2 | S3`
- `rule_id`: stable string key (`<mismatch_type>.<condition>`)

## Invariants
- Deterministic precedence: if multiple candidates apply, classifier must return exactly one canonical `mismatch_type` by documented precedence order.
- Monotonic escalation: required-contract violations cannot downgrade severity once promoted by a stronger rule.
- Stable mapping: identical input rows must produce identical `{mismatch_type,severity,rule_id}` across runs.

## Test interface shape
```ts
type ClassifiedMismatch = {
  mismatch_type: "missing"|"extra"|"source_mismatch"|"unresolved_alias"|"evidence_weak"|"consistency"
  severity: "S0"|"S1"|"S2"|"S3"
  rule_id: string
}
```

3.4.1.1 assertions should bind to this contract and must not re-implement classifier decision logic in test code.
