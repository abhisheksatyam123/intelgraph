---
tags:
  - status/wip
  - derived/module-wlan-reporting-ci-surfaces
description: Reporting and CI contract surfaces for WLAN ground-truth artifacts, thresholds, and trend outcomes.
owner: wlan
---


# module-wlan-reporting-ci-surfaces

## Index

- [Index](#index) — L12
- [Purpose](#purpose) — L25
- [Boundaries](#boundaries) — L31
- [Atomic sources](#atomic-sources) — L37
- [Data flow](#data-flow) — L43
- [Control layers](#control-layers) — L51
- [Quality](#quality) — L58
- [Mismatch taxonomy and severity](#mismatch-taxonomy-and-severity) — L64
- [Mismatch severity contract](#mismatch-severity-contract) — L115
- [Confidence input boundary: completeness vs release confidence (item 3.1)](#confidence-input-boundary-completeness-vs-release-confidence-item-31) — L134
- [Completeness-to-confidence boundary (item 3.1)](#completeness-to-confidence-boundary-item-31) — L146

## Purpose

Define the reporting and CI enforcement surfaces for WLAN ground-truth verification so comparator/audit outputs are reproducible, inspectable, and gateable in CI.

This module is the durable target for artifact contracts (JSON + Markdown), threshold outcomes (pass/warn/fail), and trend-oriented result comparisons across runs.

## Boundaries

- Includes: artifact surface definitions (JSON + Markdown), CI threshold policy framing (warn/fail), and trend-comparison output expectations
- Excludes: comparator mismatch taxonomy design, confidence-weight formula definition, and implementation-specific CI pipeline wiring
- Authority boundary: this note defines where reporting/CI contracts live; implementation details stay in owning impl/test modules

## Atomic sources

- [[doc/derived/module-completeness-audit#Scoring model]] — existing completeness scoring and report formatting surfaces
- [[doc/derived/module-wlan-fixture-gap-audit-script#Data flow]] — current JSON/Markdown audit artifact generation path
- [[doc/derived/module-wlan-ground-truth-infrastructure#Comparator/Verification → Report Surfaces]] — cross-module report and verification branch boundary

## Data flow

1. Comparator/audit stages emit machine-readable and human-readable artifacts.
2. Reporting surface normalizes artifact shape expectations so one run yields reproducible outputs.
3. CI surface evaluates configured threshold bands against report data.
4. Run-to-run comparison reads prior artifacts to classify improvement/degradation trends.
5. CI exposes pass/warn/fail outcome and links to artifact evidence for remediation.

## Control layers

- Contract layer: report schema and artifact locations must be stable for downstream readers.
- Policy layer: threshold bands and degradation rules map report values to CI outcomes.
- Orchestration layer: one command path must produce comparable artifacts and deterministic exit behavior.
- Evidence layer: each CI decision must reference persisted report artifacts, not transient console output.

## Quality

Keeps the reusable reporting/CI contract surface for WLAN ground-truth infrastructure and intentionally omits low-level implementation details that will evolve during impl tasks.

Quality target: downstream design/impl/test leaves can retrieve artifact/threshold/trend surface requirements without re-deriving cross-module boundaries from source files.

## Mismatch taxonomy and severity

Severity scale (normalized for comparator + CI):
- **S0 Critical (fail)**: breaks fixture-as-source-of-truth contract; run must fail.
- **S1 High (fail)**: strong correctness risk; fail unless explicitly allowlisted.
- **S2 Medium (warn)**: plausible drift/normalization issue; warn and require remediation owner.
- **S3 Low (warn/info)**: weak-evidence or hygiene gap; does not fail alone.

Mismatch classes and explicit severity rules:
1. **Missing mismatch** (fixture expects relation, backend/query does not return it)
   - **S0** when missing relation violates fixture `contract.minimum_counts` or drops an entire required intent bucket (`INTENT_EXPECTED_BUCKETS`).
   - **S1** when relation kind/direction is required by fixture contract but aggregate minimum still passes.
   - **S2** when relation is optional context (outside required contract fields) and does not affect required counts.

2. **Extra mismatch** (backend/query returns relation not present in fixture truth)
   - **S1** when extra relation conflicts with fixture-declared kind/direction for the same canonical target or would change intent interpretation.
   - **S2** when extra relation is non-conflicting but unaccounted by fixture contract (candidate fixture drift).
   - **S3** when extra row is duplicate/noise after normalization and does not change unique relation set.

3. **Source mismatch** (relation target matches but evidence/source anchor disagrees)
   - **S1** when `source.file` disagrees for a relation that fixture marks as required evidence.
   - **S2** when file matches but line/path-pattern anchor diverges or is missing on one side.
   - **S3** when both sides match target semantics but backend omits non-required evidence metadata.

4. **Unresolved alias mismatch** (backend name cannot be resolved to fixture `canonical_name` or `aliases`)
   - **S1** when unresolved alias blocks canonical entity matching for required intents.
   - **S2** when unresolved alias still permits relation-level fallback match but leaves identity ambiguous.
   - **S3** when alias resolution fails only for non-required/display aliases.

5. **Evidence weak mismatch** (relation exists but confidence evidence is incomplete)
   - **S2** when fixture contract requires source/path evidence and backend row lacks it.
   - **S3** when evidence is recommended (not required) and semantic relation match remains intact.

6. **Consistency mismatch** (cross-run, cross-path, or cross-layer inconsistency)
   - **S0** when mocked comparator and live backend path disagree on required relation presence/kind for same fixture + intent.
   - **S1** when same run yields contradictory results across intents that map to same bucket/edge-kind boundary.
   - **S2** when only counts/order differ but required presence contract still holds.

CI enforcement mapping:
- Any **S0/S1** mismatch class => **fail**.
- No S0/S1, but any **S2** => **warn** (non-blocking only if policy allows warn pass).
- Only **S3** => **pass with advisory**.

Normalization precedence (for reproducibility):
1. canonicalize entity identity (`canonical_name` + alias map),
2. translate protocol edge kinds to DB edge kinds,
3. de-duplicate relation rows,
4. then classify mismatch + severity.

This ordering prevents false S1/S2 inflation from alias/edge-kind representation noise.

## Mismatch severity contract

Reporting/CI consumes comparator mismatch events as normalized records with required keys:
- `mismatch_type`: one of `missing|extra|source_mismatch|unresolved_alias|evidence_weak|consistency`
- `severity`: one of `S0|S1|S2|S3`
- `entity`, `intent`, `bucket`, `expected`, `actual`, optional `rule_id`/`escalation_reason`

CI policy mapping is deterministic:
- any `S0` or `S1` record => fail
- no `S0/S1` and at least one `S2` => warn
- only `S3` (or none) => pass

Report obligations:
1. Emit aggregate counts grouped by `(mismatch_type, severity)` for trend analysis.
2. Include per-record evidence payloads so remediation can be traced to fixture-vs-response deltas.
3. Preserve stable ordering and schema across runs to keep run-to-run diffing reproducible.

Source taxonomy authority: [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity]].

## Confidence input boundary: completeness vs release confidence (item 3.1)

Release-confidence policy must treat completeness audit as a single input dimension rather than a gate by itself.

Boundary rule:
- `coverage_score` (from [[doc/derived/module-completeness-audit#Completeness-vs-release-confidence reconciliation (item 3.1)]]) informs enrichment debt.
- CI gate status is determined by mismatch severity/threshold policy, not by completeness alone.
- Any S0/S1 mismatch overrides high completeness and forces fail semantics.

Rationale:
A high fixture coverage percentage does not guarantee backend correctness, identity consistency, or evidence trustworthiness. Gate decisions must compose coverage with comparator severity and consistency dimensions.

## Completeness-to-confidence boundary (item 3.1)

Current completeness audit scoring and release-confidence scoring serve different control intents and must stay separated at the contract layer.

- Completeness audit ([[doc/derived/module-completeness-audit#What current completeness scoring actually measures]]) is a **coverage telemetry** surface: API-scoped relation-bucket population with tiered weighting.
- Release-confidence scoring is a **release decision** surface that must combine four dimensions: coverage + evidence quality + consistency + backend match.

Documented contract gaps that block direct reuse of completeness score as release confidence:
1. Single-axis coverage metric vs multi-axis confidence model.
2. Fixture-only scoring vs fixture-vs-backend mismatch-aware scoring.
3. `<70%` enrichment heuristic vs severity-driven CI gate semantics (`S0/S1 fail`, `S2 warn`, `S3 advisory`).
4. API-only aggregation vs required per-API + per-family confidence rollups.
5. Coverage-report output shape vs CI confidence artifact requirements (`mismatch_type`, `severity`, `rule_id`, and dimension subscores).

Integration rule:
- Use completeness score only as the **coverage subscore input**.
- Compute release-confidence and pass/warn/fail outcomes in reporting/comparator surfaces that ingest mismatch severity and trend data.
- Do not map completeness percentage directly to release gate outcome.

Links:
- Gap authority: [[doc/derived/module-completeness-audit#Confidence-model reconciliation gaps (item 3.1)]]
- Severity authority: [[doc/derived/module-backend-reconciliation-test#Mismatch taxonomy and severity levels]]
- CI contract surface: [[doc/derived/module-wlan-reporting-ci-surfaces#Mismatch severity contract]]
