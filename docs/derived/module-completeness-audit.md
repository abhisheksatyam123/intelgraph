---
tags:
  - status/wip
  - derived/module-completeness-audit
description: Completeness audit—scores fixture enrichment coverage per API and identifies gaps
owner: wlan
---


# module-completeness-audit

## Index

- [Index](#index) — L12
- [Meaning](#meaning) — L48
- [Data flow](#data-flow) — L54
- [Purpose](#purpose) — L66
- [Entry points and options](#entry-points-and-options) — L70
- [Scoring model](#scoring-model) — L88
- [Completeness-to-confidence gap analysis (item 3.1)](#completeness-to-confidence-gap-analysis-item-31) — L109
- [Context](#context) — L111
- [Reconciliation summary](#reconciliation-summary) — L114
- [Documented gaps between current completeness scoring and desired confidence model](#documented-gaps-between-current-completeness-scoring-and-desired-confidence-model) — L119
- [Design bridge to confidence model](#design-bridge-to-confidence-model) — L155
- [Consequences for downstream design items](#consequences-for-downstream-design-items) — L163
- [Completeness-to-confidence reconciliation (item 3.1)](#completeness-to-confidence-reconciliation-item-31) — L167
  - [Context](#context) — L169
  - [Reconciliation decision](#reconciliation-decision) — L172
  - [Gap matrix: current completeness scoring vs desired confidence](#gap-matrix-current-completeness-scoring-vs-desired-confidence) — L175
  - [Architecture consequence](#architecture-consequence) — L186
  - [Interface contract impact](#interface-contract-impact) — L191
  - [Links](#links) — L204
- [Context](#context) — L209
- [Reconciliation decision](#reconciliation-decision) — L212
- [Gap map: current completeness scoring vs desired confidence](#gap-map-current-completeness-scoring-vs-desired-confidence) — L219
- [Architecture consequence](#architecture-consequence) — L230
- [Interface contract impact](#interface-contract-impact) — L235
- [Links](#links) — L241
- [Completeness-vs-release-confidence reconciliation (item 3.1)](#completeness-vs-release-confidence-reconciliation-item-31) — L245
- [Context](#context) — L247
- [Current completeness scoring (what it measures)](#current-completeness-scoring-what-it-measures) — L250
- [Desired release-confidence scoring (what it must measure)](#desired-release-confidence-scoring-what-it-must-measure) — L256
- [Gap matrix (completeness score vs release confidence)](#gap-matrix-completeness-score-vs-release-confidence) — L262
- [Reconciliation decision](#reconciliation-decision) — L273
- [Interface contract implications](#interface-contract-implications) — L279
- [Links](#links) — L284
- [Confidence-model reconciliation gaps (item 3.1)](#confidence-model-reconciliation-gaps-item-31) — L289
- [What current completeness scoring actually measures](#what-current-completeness-scoring-actually-measures) — L293
- [Desired release-confidence model surfaces](#desired-release-confidence-model-surfaces) — L301
- [Reconciliation gaps](#reconciliation-gaps) — L309
- [Practical bridge (how to reuse current audit safely)](#practical-bridge-how-to-reuse-current-audit-safely) — L335
- [Integration boundary summary](#integration-boundary-summary) — L342

## Meaning

Scores the completeness of fixture coverage per entity. Classifies entities into Tier 1 (direct calls only), Tier 1+2 (adds runtime calls), Tier 1+2+3 (adds structures, registrations, logs). Produces a per-entity completeness score (0-1) based on which relation buckets are populated and their densities.

Central metric for understanding where fixture enrichment effort is most needed.

## Data flow

Reads: test/fixtures/wlan/*/\*.json (all entity families)
  
Writes: test/fixtures/wlan/wlan-gap-audit-report.{json,md}

- Aggregates completeness scores across all entities
- Groups entities by tier (Tier 1 only, Tier 1+2, Tier 1+2+3)
- Lists which entities need follow-up enrichment
- Tracks total relation counts and distribution across buckets
- Generates both machine-readable JSON and human-readable Markdown reports

## Purpose

The completeness audit CLI generates reports on fixture enrichment coverage across all APIs. It scores each API by relation completeness and identifies APIs needing follow-up enrichment.

## Entry points and options

**CLI**: `npm run audit:fixtures [--format=json|markdown|table] [--min-score=N] [--output=PATH]`

**Source**: 
- CLI: `src/bin/audit-fixtures.ts`
- Core logic: `src/fixtures/completeness-audit.ts`

**Output formats**:
- `table`: Human-readable text table (default)
- `json`: Machine-readable JSON report (always written to `test/fixtures/completeness-audit.json`)
- `markdown`: Markdown table for documentation

**Options**:
- `--format=<fmt>`: Choose output format (default: table)
- `--min-score=<N>`: Filter APIs with completeness >= N% (default: all)
- `--output=<PATH>`: Write to custom file (default: stdout + completeness-audit.json for JSON)

## Scoring model

**Per-API scoring** (RelationSet interface):
- Tier 1: calls_in_direct, calls_out, structures
- Tier 2: calls_in_runtime, registrations_in, registrations_out, logs
- Tier 3: owns, uses

Completeness score: percentage of populated relation buckets / total buckets (9)

Example: If API has calls_in_direct, calls_out, structures, logs → 4/9 = 44%

**Report structure**:
- timestamp: when audit was generated
- total_apis: count of all APIs scanned
- average_completeness_score: mean completeness across all APIs
- tier_distribution: counts and percentages of APIs at each completeness tier
- total_relations: sum of all relations across all APIs
- relation_distribution: per-bucket totals (calls_in_direct, calls_out, etc.)
- apis_needing_followup: list of APIs below configurable threshold with missing relations
- per_api_scores: detailed score for each API with relation_counts and missing_relations list

## Completeness-to-confidence gap analysis (item 3.1)

## Context
Current completeness audit scoring is a fixture-enrichment coverage metric (bucket-population oriented), while release confidence is a multi-signal correctness metric that must also account for mismatch severity, consistency, and evidence quality.

## Reconciliation summary
- **What completeness score measures today:** percent of populated relation buckets per API (9 buckets, tier-weighted emphasis on incoming/context/optional buckets).
- **What release confidence must measure:** whether fixture truth and backend/query behavior are trustworthy enough for release decisions.
- **Result:** completeness is a necessary input to confidence, but not a sufficient proxy for release confidence.

## Documented gaps between current completeness scoring and desired confidence model
1. **Dimension gap (single-axis vs multi-axis)**
   - Current: one axis (`bucket population / 9`) plus tier distribution.
   - Desired: aggregate across at least coverage, backend match, consistency, and evidence quality.
   - Impact: high completeness can coexist with severe reconciliation failures (S0/S1), so release risk is understated.

2. **Contract-criticality gap**
   - Current: treats missing optional and contract-required relations similarly inside a bucket-population percentage.
   - Desired: fixture `contract` critical fields (`minimum_counts`, `required_relation_kinds`, `required_directions`) must dominate confidence degradation.
   - Impact: score can look healthy while violating fixture-required invariants.

3. **Severity integration gap**
   - Current: does not consume mismatch severity taxonomy (S0/S1/S2/S3).
   - Desired: severity-aware penalties where S0/S1 sharply reduce confidence and enforce fail posture.
   - Impact: no deterministic bridge from completeness metric to CI release decision quality.

4. **Consistency gap (cross-surface agreement)**
   - Current: no explicit penalty for mock-vs-live or cross-intent inconsistency.
   - Desired: consistency mismatch must be confidence-critical (especially S0/S1 consistency class).
   - Impact: instability across verification paths is invisible to completeness score.

5. **Evidence/provenance quality gap**
   - Current: relation presence is counted even when source/path evidence quality is weak.
   - Desired: evidence-weak and source-mismatch findings should degrade confidence even when relation exists.
   - Impact: score can overstate trust in weakly evidenced relations.

6. **Aggregation-scope gap (API-first only)**
   - Current: primarily per-API completeness summaries.
   - Desired: confidence outputs required at both per-API and per-entity-family scopes, with policy-ready aggregates.
   - Impact: release owners lack family-level risk concentration view.

7. **Trend/degradation policy gap**
   - Current: snapshot completeness report without explicit degradation band policy.
   - Desired: trend-aware confidence deltas with warn/fail degradation thresholds.
   - Impact: regressions across runs are not policy-enforceable.

## Design bridge to confidence model
- Treat completeness as the **coverage dimension input** only.
- Compute release confidence as a weighted aggregate where:
  - coverage derives from completeness audit output,
  - backend-match and consistency derive from reconciliation mismatch severity outputs,
  - evidence quality derives from source/evidence mismatch classes.
- CI gates remain severity-first for hard failures (S0/S1), with confidence thresholds/trends as secondary release controls.

## Consequences for downstream design items
- Item **3.3** must define threshold bands and trend degradation policy using this separation (severity hard-gates + confidence thresholds).
- Item **8.x** implementation must merge completeness metrics and mismatch-severity aggregates into one deterministic confidence report contract.

## Completeness-to-confidence reconciliation (item 3.1)

### Context
Current completeness audit measures fixture relation-bucket population (coverage density) per API. Desired release confidence model (item 3.2) is multi-dimensional: coverage + evidence quality + backend consistency + fixture-vs-backend match severity.

### Reconciliation decision
Treat completeness audit as the **coverage sub-score input** to release confidence, not as the release-confidence score itself.

### Gap matrix: current completeness scoring vs desired confidence
| Dimension | Current completeness audit (`module-completeness-audit`) | Desired release-confidence model | Gap | Required delta |
|---|---|---|---|---|
| Coverage shape | Bucket-population % across 9 relation buckets; tier weighting from relation presence | Coverage is only one dimension inside aggregate confidence | Audit conflates "more filled buckets" with "more release confidence" | Keep completeness as normalized coverage feature `coverage_score` only |
| Evidence quality | Not modeled beyond bucket presence/count | Confidence must penalize weak/missing evidence anchors | High coverage can still hide weak evidence quality | Add `evidence_quality_score` from source/path anchor quality and contract-required evidence checks |
| Backend correctness | Not modeled (fixture-side only) | Confidence must include backend match outcomes | Completeness can be high even when backend mismatches fixture truth | Join comparator mismatch aggregates into confidence: severity-weighted penalty |
| Cross-path consistency | Not modeled | Confidence must degrade when mock/live paths disagree | Tier score cannot detect consistency drift | Add `consistency_score` driven by `consistency` mismatches (S0/S1/S2) |
| Contract criticality | No direct tie to `minimum_counts` / required kinds/directions | Confidence must degrade sharply on required-contract violations | Missing required relations may be masked by non-required bucket density | Apply contract-aware hard penalties for S0/S1 classes tied to required contract fields |
| CI gate semantics | Produces enrichment-priority report, not release gate outcome | CI needs deterministic pass/warn/fail for release confidence | Completeness threshold alone cannot enforce release readiness | CI must gate on normalized severity + aggregate confidence bands (see reporting CI contract) |
| Trend/degradation policy | Snapshot score report; no explicit run-to-run degradation contract | Confidence policy requires trend-aware degradation handling | No deterministic "regressed vs improved" decision surface | Persist per-run confidence components + mismatch aggregates for run-to-run deltas |

### Architecture consequence
- `module-completeness-audit` remains the producer of coverage telemetry.
- Comparator/reconciliation output remains authority for correctness + severity (`mismatch_type`, `severity`, `rule_id`).
- Confidence aggregator composes both surfaces into release decision inputs.

### Interface contract impact
Confidence report schema should include at least:
- `coverage_score` (from completeness audit)
- `evidence_quality_score`
- `backend_match_score` (penalized by mismatch severity distribution)
- `consistency_score`
- `aggregate_confidence`
- `ci_outcome` (`pass|warn|fail`) and `degradation_state`

CI consequence link:
- Severity gate semantics remain governed by [[doc/derived/module-wlan-reporting-ci-surfaces#Mismatch severity contract]].
- Aggregate confidence bands and trend policy must be layered on top (item 3.3), not substituted by completeness percentage.

### Links
- [[doc/derived/module-wlan-reporting-ci-surfaces#Mismatch severity contract]]
- [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity]]
- [[doc/task/todo-wlan-ground-truth-test-infrastructure#Interfaces / interactions]]

## Context
Current completeness audit scoring measures fixture relation-bucket population per API (`populated buckets / 9`, tier-distribution rollups). The desired release-confidence model (item 3) is broader: confidence must represent not only coverage but also whether backend/query behavior matches fixture truth with deterministic CI outcomes.

## Reconciliation decision
Treat completeness as one input dimension (coverage signal), not as the release-confidence score itself. Release-confidence must be an aggregate over four dimensions:
1. **Coverage** (from completeness audit)
2. **Evidence quality** (source/evidence robustness and weak-evidence penalties)
3. **Consistency** (cross-surface agreement, especially mock/live and contract consistency)
4. **Backend match** (fixture-vs-query mismatch severity profile)

## Gap map: current completeness scoring vs desired confidence
| Area | Current completeness audit behavior | Gap vs release-confidence need | Required bridge signal |
|---|---|---|---|
| Scoring scope | API-centric bucket population only | Does not cover all entity-family confidence uniformly | Family-level aggregation contract (API + non-API families) |
| Semantic meaning | Presence/absence of relations | Does not check whether returned relations are correct | Comparator mismatch events (`mismatch_type`, `severity`) |
| Criticality weighting | Buckets are effectively uniform for score math | Does not weight contract-critical failures (`minimum_counts`, required kinds/directions) | Severity/rule-id escalation from mismatch taxonomy |
| Evidence robustness | Counts populated buckets regardless of evidence strength | Cannot penalize weak provenance/noisy evidence | Evidence-quality dimension using `evidence_weak` and source quality checks |
| Cross-surface consistency | Focuses fixture completeness only | Does not detect disagreements across verification surfaces | Consistency dimension fed by `consistency` mismatches |
| Release gating | Produces follow-up list by threshold | Not directly mapped to pass/warn/fail release policy | CI policy bridge (`S0/S1 fail`, `S2 warn`, `S3 info/pass`) |
| Trend/degradation | Point-in-time report | No deterministic degradation policy over runs | Run-to-run trend bands and degradation gates |

## Architecture consequence
- Keep completeness audit output as the **coverage substrate**.
- Compose release-confidence from completeness + reconciliation severity outputs + evidence/consistency signals.
- Require comparator/report artifacts to emit stable `(mismatch_type, severity)` aggregates so confidence and CI gating remain reproducible.

## Interface contract impact
- `module-completeness-audit` remains owner of coverage metrics.
- `module-backend-reconciliation-test` remains owner of mismatch class/severity semantics.
- `module-wlan-reporting-ci-surfaces` owns pass/warn/fail mapping and report schema constraints.
- Confidence aggregation must consume all three surfaces without redefining their local contracts.

## Links
- Taxonomy authority: [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity]]
- CI/report policy: [[doc/derived/module-wlan-reporting-ci-surfaces#Mismatch severity contract]]

## Completeness-vs-release-confidence reconciliation (item 3.1)

## Context
Current completeness audit scoring is fixture-internal coverage telemetry. The desired confidence model (item 3.2) is a release decision signal that combines coverage, backend match, consistency, and evidence quality.

## Current completeness scoring (what it measures)
- Unit: relation-bucket population and bucket counts per entity.
- Scope: fixture corpus only (pre-comparator).
- Output: per-entity completeness %, tier bucketing, aggregate relation distributions.
- Strength: fast enrichment-priority signal for missing fixture coverage.

## Desired release-confidence scoring (what it must measure)
- Unit: release risk from contract-critical behavior.
- Scope: fixture coverage + reconciliation mismatch outcomes + cross-surface consistency + evidence quality.
- Output: deterministic pass/warn/fail support for CI and trend analysis.
- Strength: answers "can this run be trusted for release decisions?"

## Gap matrix (completeness score vs release confidence)
| Gap ID | Completeness audit today | Release-confidence need | Consequence if unaddressed |
|---|---|---|---|
| G1 Scope gap | Scores fixture buckets only | Must include backend/query comparison outcomes | High completeness can coexist with failing backend behavior |
| G2 Contract-criticality gap | Treats bucket presence uniformly | Must weight required contracts (`minimum_counts`, `required_relation_kinds`, `required_directions`) higher | Non-critical coverage can mask critical contract breaches |
| G3 Severity gap | No S0/S1/S2/S3 semantics | Must consume mismatch severity taxonomy for gating | Score cannot map deterministically to CI fail/warn/pass |
| G4 Evidence-quality gap | Counts relations regardless of source-evidence strength | Must include evidence quality / source-anchor trust | Inflated confidence from weakly supported relations |
| G5 Consistency gap | No cross-surface conflict signal | Must penalize mapping/translation inconsistency (intent↔bucket, edge-kind, alias identity) | Non-deterministic outcomes across comparator paths |
| G6 Aggregation gap | Uses average completeness across entities | Must support family-aware and contract-aware aggregation | API-heavy corpus can dominate and hide sparse-family risk |
| G7 Trend gap | Snapshot score only | Must detect degradation/improvement bands across runs | Release risk drift is invisible until hard failure |

## Reconciliation decision
Treat completeness audit as the **coverage dimension input**, not the final release-confidence score:
- Keep completeness outputs for enrichment prioritization.
- Feed completeness into confidence aggregation as one bounded dimension.
- Require complementary dimensions from reconciliation and reporting modules before CI gating.

## Interface contract implications
- Upstream from this module: no change to fixture scanning inputs.
- Downstream to confidence/CI: expose completeness as `coverage_score` + missing bucket diagnostics; never expose it as standalone release readiness.
- CI gate authority remains with mismatch-severity + threshold policy in reporting/CI surfaces.

## Links
- Severity taxonomy authority: [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity levels]]
- CI/report contract surface: [[doc/derived/module-wlan-reporting-ci-surfaces#Mismatch severity contract]]
- Schema contract criticality basis: [[doc/derived/module-wlan-fixture-schema#Mismatch taxonomy and severity levels (item 2.3)]]

## Confidence-model reconciliation gaps (item 3.1)

Current completeness audit behavior (from `src/fixtures/completeness-audit.ts`) and the desired release-confidence model (coverage + evidence quality + consistency + backend match) are not equivalent. The audit remains useful as a **coverage input**, but cannot be used as a release-confidence gate without additional dimensions.

## What current completeness scoring actually measures

- Scope: API fixtures only (`test/fixtures/wlan/api`), not all 11 entity families.
- Signal: fixture-internal relation-bucket population (`calls_in_*`, `calls_out`, `registrations_*`, `structures`, `logs`, `owns`, `uses`).
- Rule shape: three boolean tiers (`tier1_complete`, `tier2_complete`, `tier3_complete`) with static weighting `5/4/1` => percent score.
- Follow-up trigger: `<70%` completeness used for enrichment follow-up list.
- Output contract: aggregate relation distributions + per-API missing buckets; no mismatch class/severity, no rule IDs.

## Desired release-confidence model surfaces

From existing confidence/mismatch direction in task plan + reporting contracts, release confidence is expected to combine:
1. **Coverage** (fixture relation presence/shape)
2. **Evidence quality** (source-anchor strength and weak-evidence penalties)
3. **Consistency** (mock-vs-live and cross-path agreement)
4. **Backend match** (fixture-vs-query reconciliation outcomes)

## Reconciliation gaps

1. **Dimension gap (single-axis vs multi-axis)**
   - Current audit contributes only coverage.
   - Missing evidence-quality, consistency, and backend-match dimensions.

2. **Authority gap (fixture-only vs fixture-vs-backend)**
   - Current score never compares against backend/query outputs.
   - Release confidence requires mismatch-aware comparison authority from [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity levels]].

3. **Severity/gating gap (bucket emptiness vs contract criticality)**
   - Current `<70%` rule is scalar and non-contract-aware.
   - Release gating needs deterministic severity mapping (S0/S1 fail, S2 warn, S3 advisory) and contract-driven escalation.

4. **Granularity gap (API-only vs API + entity-family aggregates)**
   - Current audit emits per-API and aggregate API metrics.
   - Desired model requires per-API and per-family confidence aggregation.

5. **Output-contract gap (coverage report vs CI confidence artifact)**
   - Current report lacks `mismatch_type`, `severity`, `rule_id`, and dimension subscores.
   - CI/trend policies require stable, comparable confidence artifacts across runs.

6. **Threshold semantics gap (enrichment follow-up vs release decisioning)**
   - `<70%` currently means “enrichment needed,” not “release blocked.”
   - Release confidence thresholds must encode pass/warn/fail policy aligned to severity + trend degradation.

## Practical bridge (how to reuse current audit safely)

Treat completeness audit as the **coverage subscore input** only:
- Keep current tiered completeness as one dimension.
- Join with mismatch/severity aggregates from comparator and evidence-quality/consistency measures before deriving release confidence.
- Do not map completeness percent directly to release pass/fail.

## Integration boundary summary

- Completeness audit remains enrichment guidance + coverage telemetry.
- Release-confidence scoring must be computed in the comparator/reporting layer that has access to mismatch severity and cross-run policy contracts ([[doc/derived/module-wlan-reporting-ci-surfaces#Mismatch severity contract]]).
