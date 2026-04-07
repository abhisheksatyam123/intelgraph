---
tags:
  - status/wip
description: Provides deterministic mismatch classification for fixture-vs-backend diff rows.
---

# module-comparator-classifier

## Index

- [Index](#index) — L9
- [Purpose](#purpose) — L15
- [Data flow](#data-flow) — L19
- [Boundaries](#boundaries) — L40

## Purpose

Provides deterministic mismatch classification for fixture-vs-backend diff rows. Exports canonical taxonomy rules, types, and the `classifyDiffRow` function so downstream comparator, reporting, and CI modules share a single source of truth for `mismatch_type`/`severity`/`rule_id` assignment.

## Data flow

1. Caller provides `{ field: string; mismatch_type: string }` to `classifyDiffRow`.
2. Function builds lookup key `${mismatch_type}|${field}` and checks `TAXONOMY_RULES`.
3. On hit: returns `{ mismatch_type, severity, rule_id }` from the table (deterministic).
4. On miss: returns fallback with `severity: "S3"` and generated `rule_id: UNKNOWN_<TYPE>_<FIELD>`.
5. `ciOutcome(severity)` maps S0/S1 → "fail", S2 → "warn", S3 → "pass" for CI gate decisions.

Exports:
- `MismatchType` — union of six canonical classes
- `Severity` — "S0" | "S1" | "S2" | "S3"
- `CiOutcome` — "fail" | "warn" | "pass"
- `ClassifierRule` — `{ mismatch_type, severity, rule_id }`
- `DiffRow` — `{ field, expected, actual, mismatch_type, severity, rule_id }`
- `TAXONOMY_RULES` — extensible lookup table (7 entries covering all six classes)
- `classifyDiffRow(row)` — classifier function
- `ciOutcome(severity)` — CI gate helper

Source: `src/fixtures/comparator-classifier.ts`
Consumed by: `test/unit/intelligence/backend-reconciliation.test.ts` (imports classifyDiffRow, TAXONOMY_RULES, DiffRow)

## Boundaries

- `TAXONOMY_RULES` is the single source of truth for all mismatch classification; never duplicate entries in test files.
- `classifyDiffRow` is pure and deterministic: same input always produces same output.
- Fallback rule_id format is `UNKNOWN_<MISMATCH_TYPE>_<FIELD>` (dots replaced with underscores, uppercased).
- `DiffRow` includes `expected` and `actual` fields; intersection types that extend it must include these.
- Six canonical mismatch classes in precedence order: consistency > missing > source_mismatch > unresolved_alias > extra > evidence_weak.
- CI severity mapping: S0/S1 → fail; S2 → warn; S3 → pass.
