---
tags:
  - status/wip
description: [Index](#index) — audit and enrichment identity
---

# module-wlan-audit-enrichment

## Index

- [Index](#index) — L9
- [Purpose](#purpose) — L18
- [Completeness audit](#completeness-audit) — L36
- [Enrichment pipeline](#enrichment-pipeline) — L63
- [Intent mapper](#intent-mapper) — L90
- [Data flow](#data-flow) — L113
- [Quality](#quality) — L136

## Purpose

Complementary tools to fixture generation and testing. Audit and enrichment pipeline:
- Runs completeness assessment on all fixture APIs
- Scores APIs by relation tier (tier 1: incoming relations, tier 2: contextual, tier 3: optional)
- Computes completeness percentage and identifies follow-up gaps
- Generates reports on per-API and per-relation distribution
- Feeds into confidence scoring for release gates

Entry points:
- `src/fixtures/completeness-audit.ts` — generateCompletenessAudit()
- `src/bin/enrich-fixtures.ts` — CLI to regenerate fixtures from source
- `src/fixtures/exhaustive-relation-scanner.ts` — deep relation discovery
- `src/fixtures/intent-mapper.ts` — family-to-query-intent mapping

Related test suite:
- `test/unit/intelligence/wlan-ground-truth.test.ts` — ground-truth verification layer (Layer 2)

## Completeness audit

File: `src/fixtures/completeness-audit.ts`

Scoring model:
- **Tier 1** (50% weight) — at least one incoming relation:
  - calls_in_direct > 0 OR calls_in_runtime > 0 OR registrations_in > 0
- **Tier 2** (40% weight) — contextual relations (at least one):
  - calls_out > 0 OR structures > 0 OR logs > 0 OR owns > 0
- **Tier 3** (10% weight) — optional relations:
  - uses > 0 OR registrations_out > 0

Completeness percentage:
- If tier1Complete: +50%
- If tier2Complete: +40%
- If tier3Complete: +10%
- Score = (sum / 100) * 100

Audit report output:
- `total_apis` — count of API fixtures analyzed
- `average_completeness_score` — mean of per-API scores
- `tier_distribution` — counts and percentages by completion level
- `total_relations` — sum of all relation counts across all buckets
- `relation_distribution` — per-bucket totals
- `apis_needing_followup` — APIs below target score with missing relations
- `per_api_scores` — detailed scores with missing_relations and relation_counts

## Enrichment pipeline

Files:
- `src/bin/enrich-fixtures.ts` — CLI entry point
- `src/fixtures/exhaustive-relation-scanner.ts` — relation discovery engine
- `src/fixtures/intent-mapper.ts` — intent-to-family mapping

Pipeline stages:
1. **Source parsing**: read WLAN workspace source files
2. **Relation discovery**: extract calls, registrations, struct accesses, logs via:
   - Static analysis (clangd call expressions)
   - Runtime dispatch chain analysis (register callbacks, interrupt handlers)
   - C parser (field access detection)
3. **Fixture generation**: create canonical JSON per entity with relations
4. **Normalization**: canonicalize names, aliases, and confidence scores
5. **Storage**: write to `test/fixtures/wlan/{family}/{name}.json`
6. **Audit**: run completeness-audit and generate report

Pre-enrich vs post-enrich:
- Pre-enrich: fixtures before enrichment run (tracked as `.pre-enrich` snapshots)
- Post-enrich: authoritative versions after full enrichment pass
- Difference shows which relations were added during enrichment

Intent mapper:
- Maps entity families to intelligence_query intents (e.g., api → who_calls_api, what_api_calls)
- Provides FAMILY_INTENTS lookup for test suite

## Intent mapper

File: `src/fixtures/intent-mapper.ts`

FAMILY_INTENTS mapping — which intelligence_query intents are supported for each entity family:

**api**: [who_calls_api, who_calls_api_at_runtime, what_api_calls, show_registration_chain, find_api_logs, find_api_struct_reads, find_api_struct_writes]
**struct**: [where_struct_modified, where_struct_initialized, find_struct_readers, find_struct_writers, find_struct_owners]
**ring**: [who_calls_api_at_runtime, find_callback_registrars]
**hw_block**: [who_calls_api_at_runtime, find_callback_registrars]
**thread**: [who_calls_api_at_runtime, what_api_calls, find_callback_registrars]
**signal**: [who_calls_api_at_runtime]
**interrupt**: [what_api_calls, find_callback_registrars]
**timer**: [find_api_timer_triggers, find_callback_registrars]
**dispatch_table**: [show_dispatch_sites, find_callback_registrars]
**message**: [who_calls_api_at_runtime, show_dispatch_sites]
**log_point**: [find_api_logs, find_api_logs_by_level]

This mapping is used by:
- Backend reconciliation tests to select which intents to exercise per family
- Fixture verification suite to validate contract expectations
- Report generation to assess coverage by query intent

## Data flow

Audit data flow:

1. Enrich-fixtures CLI reads WLAN workspace source
2. Exhaustive-relation-scanner extracts all relations per entity
3. Fixtures written to `test/fixtures/wlan/{family}/{name}.json`
4. Completeness-audit runs on all fixtures:
   - Loads all API fixtures
   - Scores each by relation completeness (tier 1/2/3)
   - Aggregates distribution statistics
   - Identifies APIs needing follow-up
5. Audit report written to `test/fixtures/wlan/wlan-gap-audit-report.json` and `.md`
6. Report feeds into confidence-scoring model:
   - Tier 1 only → low confidence (critical relations missing)
   - Tier 1+2 → medium confidence (contextual relations missing)
   - Tier 1+2+3 → high confidence (complete)

Confidence signal feeds into:
- [[doc/derived/module-wlan-fixture-corpus#Contract model]] — contract expectations
- [[doc/derived/module-wlan-reconciliation-tests#Data flow]] — test coverage assessment
- Release gate policy: warn if avg completeness < X%; fail if avg completeness < Y%

## Quality

**Audit coverage:**
- All 69 fixtures scorable by completeness model
- API family (61 fixtures) most complete; other families typically have simpler contracts
- Audit reports include top follow-up targets and per-relation distribution

**Gaps and limitations:**
- Enrichment relies on WLAN workspace source — if source is unavailable or changed, re-enrichment may fail
- Pre-enrich snapshots tracked but comparison logic not yet implemented
- Relation discovery depends on derivation method (clangd, runtime, c_parser) — each has confidence ceiling
- Intent mapper is static; new intents require code update

**Integration points:**
- Fixture corpus: [[doc/derived/module-wlan-fixture-corpus]]
- Backend tests: [[doc/derived/module-wlan-reconciliation-tests]]
- Ground-truth tests: Layer 2 verification (wlan-ground-truth.test.ts)
