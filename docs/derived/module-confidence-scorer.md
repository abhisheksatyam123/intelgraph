---
tags:
  - status/wip
description: Multi-dimensional confidence scorer for WLAN fixture-vs-backend comparison.
---

# module-confidence-scorer

## Index

- [Index](#index) — L9
- [Purpose](#purpose) — L15
- [Data flow](#data-flow) — L19
- [Boundaries](#boundaries) — L27

## Purpose

Multi-dimensional confidence scorer for WLAN fixture-vs-backend comparison. Aggregates four dimension scores into a single release-confidence score per entity, derives CI outcome (PASS/WARN/FAIL), and emits actionable remediation hints. Also aggregates per-entity results into per-family summaries.

## Data flow

1. Caller supplies `ConfidenceInput` with four dimension scores (0–1 each) and `has_s0_s1_mismatch` flag.
2. `scoreConfidence()` computes weighted aggregate: `coverage×0.25 + backend_match×0.35 + evidence_quality×0.20 + consistency×0.20`.
3. CI outcome derived: aggregate ≥ 0.85 → PASS; ≥ 0.70 → WARN; < 0.70 → FAIL; `has_s0_s1_mismatch=true` overrides to FAIL.
4. Remediation hints emitted for each dimension below its threshold (coverage < 0.5, backend_match < 0.7, evidence_quality < 0.7, consistency < 1.0, aggregate < 0.70).
5. `aggregateFamilyConfidence()` groups per-entity results by family, computes avg_confidence, derives family-level CI outcome, and lists `low_confidence_entities` (aggregate < 0.70).

## Boundaries

- **Source file:** `src/fixtures/confidence-scorer.ts`
- **Tests:** `test/unit/fixtures/confidence-scorer.test.ts` (17 tests: threshold edges, remediation hints, aggregation, determinism)
- **Exports:** `scoreConfidence`, `aggregateFamilyConfidence`, `CONFIDENCE_WEIGHTS`, `CONFIDENCE_THRESHOLDS`, `ConfidenceInput`, `ConfidenceResult`, `FamilyConfidenceSummary`
- **Weights:** coverage=0.25, backend_match=0.35, evidence_quality=0.20, consistency=0.20 (sum=1.0)
- **Thresholds:** PASS≥0.85, WARN≥0.70, FAIL<0.70; S0/S1 override → always FAIL
- **Remediation hint triggers:** coverage<0.5, backend_match<0.7, evidence_quality<0.7, consistency<1.0, aggregate<0.70
- **Dimension inputs:** `coverage_score` from completeness audit; `backend_match_score` from reconciliation test; `evidence_quality_score` from comparator; `consistency_score` from mock/live consistency check
- **Does NOT own:** completeness audit scoring (see `module-completeness-audit`), mismatch classification (see `module-backend-reconciliation-test`)
