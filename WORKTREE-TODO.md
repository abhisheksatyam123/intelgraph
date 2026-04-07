# TODO — WLAN Ground-Truth Test Infrastructure

## Phase 1: Baseline & contracts
- [ ] Freeze and validate fixture schema contracts for all entity families
- [ ] Define confidence dimensions (coverage, evidence quality, consistency, backend match)
- [ ] Define pass/fail thresholds and severity levels for mismatch classes

## Phase 2: Test generation alignment
- [ ] Build/extend generator to produce test cases from ground-truth fixtures
- [ ] Ensure generator covers all relation directions: incoming/outgoing/runtime/data/log
- [ ] Add deterministic seeds/snapshots for reproducibility

## Phase 3: Comparison infrastructure
- [ ] Build fixture-vs-backend comparator with per-relation diffs
- [ ] Emit machine-readable reports (JSON) + human summary (MD)
- [ ] Classify gaps: missing, extra, source mismatch, unresolved alias, evidence weak

## Phase 4: Confidence scoring
- [ ] Implement aggregate confidence score per API and per entity family
- [ ] Add confidence trend tracking across runs
- [ ] Mark low-confidence entities with actionable remediation hints

## Phase 5: CI hardening
- [ ] Add CI job to run generation + comparison pipeline
- [ ] Fail on threshold breach, warn on degradation bands
- [ ] Document local runbook + troubleshooting guide

## Exit Criteria
- [ ] End-to-end command regenerates tests + reports from WLAN workspace
- [ ] Comparator catches intentional injected mismatches
- [ ] Confidence report is stable and actionable for release decisions

## Related — Neo4j intelligence graph

- Tracked in **`doc/project/task/todo-neo4j-schema-hardening.md`** (indexes, constraints, ingest batching, projection).
