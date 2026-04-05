# Worktree Focus: WLAN Ground-Truth Test Infrastructure

Branch: `feat/wlan-groundtruth-test-infra`

## Mission
Build a robust verification infrastructure that:
1. Aligns generated test cases with ground-truth extracted from actual WLAN workspace code.
2. Measures confidence that ground-truth captures all relevant entity/relationship information.
3. Evaluates how accurately testing infrastructure compares backend/programmatic relations against ground-truth.

## Scope
- Ground-truth quality scoring and coverage metrics
- Fixture-vs-backend comparison infrastructure
- Test generation pipeline for WLAN entities and relation families
- Gap reporting (missing/extra/mismatched relations)
- Confidence dashboards/artifacts for readiness decisions

## Non-Goals
- Rewriting relation extraction core algorithms (handled in relation-gen branch)
- One-off hardcoded per-API assertions where generic checks are possible

## Deliverables
- Deterministic test generation command(s)
- Ground-truth confidence report artifact
- Backend-vs-ground-truth comparison report artifact
- CI-friendly test suite validating relation completeness and correctness

## Key Paths
- `test/fixtures/wlan/`
- `test/unit/intelligence/`
- `test/integration/`
- `scripts/wlan-*audit*.mjs`

## Definition of Done
- Automated pipeline can regenerate verification artifacts from WLAN workspace
- Confidence metrics and mismatch classes are reproducible
- Testing infra can detect regressions without manual per-API edits
EOF
