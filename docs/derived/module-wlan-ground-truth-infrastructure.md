---
tags:
  - status/wip
  - derived/module-wlan-ground-truth-infrastructure
  - status/stable
description: The WLAN ground-truth test infrastructure treats fixture data (`test/fixtures/wlan/**`) as authoritative source of truth for entity relationships, then compares backend query results against these fixtures to catch mismatches, score confidence, and enforce quality thresholds via CI.
owner: wlan-infrastructure
---


# module-wlan-ground-truth-infrastructure

## Index

- [Index](#index) — L13
- [Purpose](#purpose) — L27
- [Data flow](#data-flow) — L36
  - [Source Workspace → Fixture Corpus](#source-workspace-fixture-corpus) — L38
  - [Fixture Corpus → Enrichment Pipeline](#fixture-corpus-enrichment-pipeline) — L43
  - [Fixture Corpus → Mocked Backend Comparator Path](#fixture-corpus-mocked-backend-comparator-path) — L49
  - [Fixture Corpus → Live Backend Comparator Path](#fixture-corpus-live-backend-comparator-path) — L56
  - [Comparator/Verification → Report Surfaces](#comparatorverification-report-surfaces) — L62
  - [Translation Boundaries](#translation-boundaries) — L71
- [Boundaries](#boundaries) — L76
- [Components](#components) — L108

## Purpose

The WLAN ground-truth test infrastructure treats fixture data (`test/fixtures/wlan/**`) as authoritative source of truth for entity relationships, then compares backend query results against these fixtures to catch mismatches, score confidence, and enforce quality thresholds via CI.

The system is built as three stacked verification layers:
1. **Fixture → Contract** (Layer 1): Fixture completeness audit (`completeness-audit.ts`) scans all entity families and reports per-API tier coverage (Tier 1=basic, Tier 1+2=advanced, Tier 1+2+3=exhaustive) and relation counts.
2. **Backend Reconciliation** (Layer 2): Mock DB rows derived from fixture relations are injected into the intelligence_query tool (`backend-reconciliation.test.ts`), and query responses are compared against fixture expectations to find mismatches at entity-relation-field granularity.
3. **Graph Verification** (Layer 3): Ground-truth fixture (`test/fixtures/wlan-ground-truth.json`) captures per-API verification targets with query intents, mock rows, and expected relation contracts (`wlan-ground-truth.test.ts`).

## Data flow

### Source Workspace → Fixture Corpus
- Source evidence starts in WLAN workspace files/lines and is represented in fixtures as `source.file`/`source.line` plus per-edge evidence locations.
- Canonical corpus files: `test/fixtures/wlan/<family>/*.json` with manifest at `test/fixtures/wlan/index.json`.
- Scenario fixture for verification contracts: `test/fixtures/wlan-ground-truth.json`.

### Fixture Corpus → Enrichment Pipeline
- CLI entrypoint: `src/bin/enrich-fixtures.ts`.
- Scanner implementation: `src/fixtures/exhaustive-relation-scanner.ts`.
- Intent bridge: `src/fixtures/intent-mapper.ts` maps query intent to relation bucket.
- Output: enriched fixtures written back under `test/fixtures/wlan/api/<name>.json` (or selected target).

### Fixture Corpus → Mocked Backend Comparator Path
- Harness: `test/unit/intelligence/backend-reconciliation.test.ts`.
- `fixtureRelationsToMockRows()` transforms fixture relations into DB-shaped rows.
- `setIntelligenceDeps(...)` injects mocked `dbLookup.lookup` into `tool("intelligence_query")`.
- Family-intent matrix (`FAMILY_INTENTS`) and `INTENT_EXPECTED_BUCKETS` define which intents and buckets must match fixture truth.
- Comparison checks missing/extra/field-level mismatches against fixture expectations.

### Fixture Corpus → Live Backend Comparator Path
- Harness: `test/integration/neo4j-backend.test.ts`.
- Uses `Neo4jDbLookup.lookup(...)` against a real snapshot (`TEST_SNAPSHOT_ID` or seeded fixture snapshot).
- Confirms live query rows satisfy fixture-defined canonical names/relations per intent.
- Preserves fixture-first authority while validating production-like backend query behavior.

### Comparator/Verification → Report Surfaces
- Completeness report CLI: `src/bin/audit-fixtures.ts` delegates to `src/fixtures/completeness-audit.ts`.
- Emits machine artifact `test/fixtures/completeness-audit.json` and formatted summaries.
- Gap-audit artifacts: `test/fixtures/wlan/wlan-gap-audit-report.json` + `.md`.
- Comparator evidence currently materializes through test suites:
  - `test/unit/intelligence/backend-reconciliation.test.ts` (mock comparator)
  - `test/unit/intelligence/wlan-ground-truth.test.ts` (query-case + source-anchor verification)
  - `test/integration/neo4j-backend.test.ts` (live backend parity)

### Translation Boundaries
- Intent-to-bucket mapping boundary: `src/fixtures/intent-mapper.ts`.
- Protocol-to-DB edge-kind boundary: `PROTOCOL_TO_DB_EDGE_KIND` in `test/unit/intelligence/backend-reconciliation.test.ts`.
- Mock/live branch boundary: same fixture truth and intent contracts, different query dependency path (mock injection vs Neo4j lookup).

## Boundaries

**Fixture Corpus Boundary:**
- Scope: ~200 entity fixtures across 12 families
- Owned by: fixture enrichment pipeline + manual curation
- Contract: all fixtures must match `ApiFixture` type (kind, canonical_name, source: {file, line}, relations object with supported buckets)
- Versioning: `.json.pre-enrich` backup saved before enrichment runs

**Backend Query Layer Boundary:**
- Scope: intelligence_query tool accepting intents from FAMILY_INTENTS map
- Owned by: src/intelligence/ (node-adapter, query resolver)
- Contract: NodeProtocolResponse with status, intent, data.items[], rel[bucket][], edge evidence
- Mock injection: all tests inject deps via setIntelligenceDeps()

**Completeness Audit Boundary:**
- Scope: per-API tier scoring (Tier 1/2/3) and relation distribution
- Owned by: src/fixtures/completeness-audit.ts
- Contract: AuditReport with per_api_scores[], tier_distribution, total_relations, apis_needing_followup[]
- Output format: JSON (primary), table (CLI), markdown (reports)

**Reconciliation Test Boundary:**
- Scope: per-entity, per-relation comparison against fixture
- Owned by: test/unit/intelligence/backend-reconciliation.test.ts
- Contract: for each (family, entity, intent) combination, compare mock rows to query response items
- Mismatches reported as: missing items, extra items, canonical_name/file/line mismatches

**Ground-Truth Verification Boundary:**
- Scope: per-API query cases with explicit relation contract expectations
- Owned by: test/unit/intelligence/wlan-ground-truth.test.ts + test/fixtures/wlan-ground-truth.json
- Contract: GroundTruthFixture with verificationTargets[], apiGroundTruth[], nodeKindProbes[]
- Pass/fail: all items present, relation buckets non-empty, edge_kinds match, source anchors exist

## Components

**Test Fixtures & Config:**
- `test/fixtures/wlan/index.json` — manifest: maps entity family → entity names
- `test/fixtures/wlan/api/*.json` — 60 API fixtures (+ `.pre-enrich` backups)
- `test/fixtures/wlan/{struct,ring,hw_block,thread,signal,interrupt,timer,dispatch_table,message,log_point}/*.json` — entity family fixtures
- `test/fixtures/wlan-ground-truth.json` — verification targets, query cases, and mock rows for Layer 3 tests
- `test/fixtures/completeness-audit.json` — output of audit CLI (timestamped report)

**Test Suites (Verification Layers):**
- `test/unit/fixtures/completeness-audit.test.ts` (Layer 1) — tests audit report generation, formatting, tier scoring, relation distribution
- `test/unit/intelligence/backend-reconciliation.test.ts` (Layer 2) — tests fixture-to-mock-rows conversion, query execution, item comparison for all families/intents
- `test/unit/intelligence/wlan-ground-truth.test.ts` (Layer 3) — tests verification targets with explicit query contracts and graph path validation

**Implementation Modules:**
- `src/fixtures/completeness-audit.ts` — `generateCompletenessAudit()`, `formatAuditReportJson()`, `formatAuditReportMarkdown()`
- `src/fixtures/exhaustive-relation-scanner.ts` — `enrichApiFixture()`, `enrichAllApis()`, discovers relations from workspace + backend
- `src/fixtures/intent-mapper.ts` — maps entity families to query intents and relation buckets
- `src/bin/audit-fixtures.ts` — CLI for audit report generation (entry: `npm run audit:fixtures`)
- `src/bin/enrich-fixtures.ts` — CLI for fixture enrichment (entry: `npm run enrich:fixtures`)
- `src/intelligence/query-node-adapter.ts` — converts DB rows to `NodeProtocolResponse` (used by backend tests)

**Missing Components (To Be Built):**
- Comparator engine: unified fixture-vs-backend comparison with mismatch classification
- Confidence scorer: per-API/entity-family confidence with threshold policy
- Report formatter: JSON + Markdown unified output from comparator
- Trend tracker: historical comparison tracking for degradation detection
- CI integration: threshold enforcement and result reporting
