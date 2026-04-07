---
tags:
  - status/wip
  - derived/module-exhaustive-relation-scanner
description: Exhaustive relation scanner—multi-intent backend query orchestrator for fixture enrichment
owner: wlan
---


# module-exhaustive-relation-scanner

## Index

- [Index](#index) — L12
- [Meaning](#meaning) — L28
- [Data flow](#data-flow) — L34
- [Purpose](#purpose) — L54
- [API surface](#api-surface) — L58
- [Enrichment algorithm](#enrichment-algorithm) — L80
- [Generator and enrichment entrypoints (item 4.1)](#generator-and-enrichment-entrypoints-item-41) — L112
  - [NPM Script Entry Points](#npm-script-entry-points) — L114
  - [Core Enrichment Algorithm (enrichApiFixture function)](#core-enrichment-algorithm-enrichapifixture-function) — L149
  - [Intent-to-Array Mapping](#intent-to-array-mapping) — L175
  - [Completeness Audit Workflow](#completeness-audit-workflow) — L208
  - [Fixture I/O Paths](#fixture-io-paths) — L224
  - [Environment and Assumptions](#environment-and-assumptions) — L238

## Meaning

Enriches existing API fixtures by querying the intelligence backend exhaustively for all applicable intents. For each intent, normalizes the backend response (extract nodes, edges, map to fixture buckets), deduplicates, sorts by confidence, and merges into the fixture.

On completion, regenerates the dynamic contract for the fixture based on what relations were populated.

## Data flow

Reads: test/fixtures/wlan/api/\*.json (existing fixtures for a given API)

Calls: intelligence_query tool (mocked in tests via setIntelligenceDeps, real in production)

Writes: test/fixtures/wlan/api/\*.json (updated fixtures with enriched relations)

Algorithm:
1. Load existing fixture from disk
2. Select applicable intents for that API (via intent-mapper.selectIntentsForApi)
3. Query backend for each intent (continue on per-intent failure)
4. Normalize backend response edges into fixture-compatible Relation objects
5. Deduplicate relations by (caller, callee, edge_kind) triple
6. Sort each bucket by confidence descending
7. Regenerate contract from now-populated arrays
8. Persist enriched fixture to disk with enrichment_metadata timestamp

Supports --api, --snapshot-id, --dry-run CLI flags for selective enrichment and testing.

## Purpose

The exhaustive relation scanner queries the intelligence backend for all applicable intents per API and normalizes results into fixture relation arrays. It orchestrates multi-intent queries, deduplication, and contract generation.

## API surface

**Main exports** from `src/fixtures/exhaustive-relation-scanner.ts`:

1. `enrichApiFixture(apiName: string, snapshotId: number) → Promise<ApiFixture>`
   - Enrich a single API fixture by querying backend for all applicable intents
   - Input: API canonical_name (e.g., "arp_offload_proc_frame"), snapshot ID (typically 1 or higher in production)
   - Output: enriched ApiFixture with relations populated, sorted, deduplicated, and contract regenerated
   - Side effect: none (does not persist to disk; called by CLI which handles persistence)

2. `enrichAllApis(snapshotIds: Record<string, number>) → Promise<FixtureEnrichmentReport>`
   - Batch enrich all 60+ APIs in `test/fixtures/wlan/api/`
   - Input: Record mapping API names to snapshot IDs, with "default" key for fallback (optional)
   - Output: FixtureEnrichmentReport with timestamp, total_apis, successful_apis, failed_apis, total_relations_added, and per-API intent query/hit maps
   - Side effect: persists enriched fixtures to disk via `saveFixture()`; does not back up originals (CLI responsibility)

**Helper functions** (internal):

- `loadFixture(apiName: string) → Promise<ApiFixture>`: Load fixture from `test/fixtures/wlan/api/<name>.json`
- `saveFixture(apiName: string, fixture: ApiFixture) → void`: Write enriched fixture to disk (overwrites)
- `queryBackend(request: QueryRequest) → Promise<NormalizedQueryResponse>`: Mock facade (real production code calls intelligence tool; mocked in tests via setIntelligenceDeps)

## Enrichment algorithm

**Phase 1: Load existing fixture**
- Load from `test/fixtures/wlan/api/<api_name>.json`

**Phase 2: Determine applicable intents**
- Call `selectIntentsForApi(apiName, existingFixture)` from intent-mapper
- Returns array of QueryIntent values applicable to this API based on role heuristics

**Phase 3: Query backend for all applicable intents**
- For each intent:
  - Build QueryRequest with intent, snapshotId, apiName, apiNameAliases
  - Call `queryBackend(request)` (currently placeholder)
  - On error: log and continue to next intent (fail-soft per-intent)
  - Store result in `intentResults: Map<QueryIntent, NormalizedQueryResponse>`

**Phase 4: Normalize and merge results with deduplication**
- For each QueryIntent result:
  - Extract nodes/edges from backend response
  - Normalize edge fields via `normalizeEdge()`
  - Deduplicate across intents via `deduplicateRelations()`
  - Map intent to relation array via `mapIntentToArray(intent)`
  - Merge into target relation bucket

**Phase 5: Sort within each bucket by confidence descending**

**Phase 6: Generate dynamic contract**
- Call `generateContractFromRelations()` to create verification expectations

**Phase 7: Return enriched fixture with metadata**
- Attach enrichment_metadata (intents_queried, intents_hit, timestamp)

## Generator and enrichment entrypoints (item 4.1)

### NPM Script Entry Points

**1. Enrichment CLI: `npm run enrich:fixtures`**
- Location: `src/bin/enrich-fixtures.ts`
- Modes: Single API or batch enrichment
- Arguments:
  - `--api=<name>` — enrich single API (e.g. `--api=arp_offload_proc_frame`)
  - `--snapshot-id=<id>` — backend snapshot to query (default: 1)
  - `--dry-run` — simulate without writing to disk
  - `--help` — show usage
- Behavior:
  - Single API: `enrichApiFixture(apiName, snapshotId)` → fixture + metadata → save
  - Batch: discovers all `test/fixtures/wlan/api/*.json`, calls enricher for each, reports summary
  - Creates `.pre-enrich` backup files on first run per API
  - Reports: progress per API, intent hit count, relations added, success/failure rate
- Outputs:
  - Modified fixtures written to `test/fixtures/wlan/api/<api-name>.json`
  - Backup: `test/fixtures/wlan/api/<api-name>.json.pre-enrich` (created once)

**2. Completeness Audit CLI: `npm run audit:fixtures`**
- Location: `src/bin/audit-fixtures.ts`
- Modes: table (default), JSON, markdown formats
- Arguments:
  - `--format=<table|json|markdown>` — output format (default: table)
  - `--min-score=<threshold>` — filter results >= threshold
  - `--output=<path>` — write report to file (optional)
- Behavior:
  - Reads all fixtures from `test/fixtures/wlan/api/`
  - Calculates per-API completeness scores (tier 1/2/3)
  - Always writes JSON to `test/fixtures/completeness-audit.json`
  - Console output in requested format
- Outputs:
  - JSON report: `test/fixtures/completeness-audit.json` (always written)
  - Optional markdown/table console output or custom file

### Core Enrichment Algorithm (enrichApiFixture function)

**Entry point:** `src/fixtures/exhaustive-relation-scanner.ts::enrichApiFixture(apiName, snapshotId)`

**Nine-phase enrichment:**

1. **Load existing fixture** from `test/fixtures/wlan/api/<apiName>.json`
2. **Select applicable intents** for API using `selectIntentsForApi(apiName, fixture)`
   - Default: 10 core intents (who_calls_api, who_calls_api_at_runtime, what_api_calls, show_registration_chain, find_callback_registrars, find_api_logs, find_api_logs_by_level, find_api_struct_writes, find_api_struct_reads, find_struct_owners)
   - Intent selection can be customized per API role (currently all intents queried)
3. **Query backend** for all intents via `queryBackend(QueryRequest)`
   - Builds request with: intent, snapshotId, apiName, apiNameAliases (4 variants)
   - Continues on per-intent failure (resilient to partial backend unavailability)
   - Returns `NormalizedQueryResponse` with nodes/edges
4. **Normalize edges** from backend via `normalizeEdge(edge, bucket, intent)`
   - Maps edge_kind, adds source_intent tracking, assigns bucket
   - Ensures all fields present (edge_kind_verbose, derivation, confidence)
5. **Deduplicate relations** via `deduplicateRelations(allNormalizedEdges)`
   - Dedup key: `caller|callee|edge_kind` (or `api|struct|edge_kind`)
   - Preference: higher confidence wins, then clangd over c_parser
6. **Assign deduplicated relations to buckets** in relation arrays
7. **Sort within each bucket** by confidence descending
8. **Generate dynamic contract** via `generateContractFromRelations(enrichedRelations)`
   - Creates minimum_counts, required_relation_kinds, required_directions based on what's populated
9. **Return enriched fixture** with enrichment_metadata (timestamp, intents_queried, intents_hit, total_relations count)

### Intent-to-Array Mapping

**Function:** `src/fixtures/intent-mapper.ts::mapIntentToArray(intent: QueryIntent)`

Maps each intelligence query intent to its fixture relation bucket:

```
who_calls_api                      → calls_in_direct
who_calls_api_at_runtime           → calls_in_runtime
why_api_invoked                    → calls_in_runtime
what_api_calls                     → calls_out
show_registration_chain            → registrations_in
find_callback_registrars           → registrations_in
show_dispatch_sites                → calls_out
find_struct_writers                → structures
find_struct_readers                → structures
where_struct_initialized           → structures
where_struct_modified              → structures
find_struct_owners                 → owns
find_field_access_path             → structures
find_api_struct_writes             → structures
find_api_struct_reads              → structures
find_api_logs                       → logs
find_api_logs_by_level             → logs
find_api_timer_triggers            → owns
show_runtime_flow_for_trace        → calls_in_runtime
show_api_runtime_observations      → calls_in_runtime
show_hot_call_paths                → calls_in_runtime
show_cross_module_path             → calls_out
find_api_by_log_pattern            → logs
(default)                          → uses
```

### Completeness Audit Workflow

**Entry point:** `src/fixtures/completeness-audit.ts::generateCompletenessAudit(fixturesDir)`

**Scoring tiers:**
- **Tier 1 (50%):** at least one incoming relation (calls_in_direct OR calls_in_runtime OR registrations_in)
- **Tier 2 (40%):** contextual relations (calls_out, structures, logs, owns)
- **Tier 3 (10%):** optional relations (uses, registrations_out)

**Completeness score:** `(tier1_points + tier2_points + tier3_points) / 10 * 100`

**Report output:**
- Per-API scores: name, tier completeness flags, score, missing relations, per-bucket counts
- Aggregate: total APIs, average score, tier distribution, total relations, distribution
- API follow-up list: APIs scoring < 100% with missing relations

### Fixture I/O Paths

**Input:**
- Fixture corpus: `test/fixtures/wlan/api/` directory (discovery via `fs.readdir`)
- Snapshot ID: CLI argument or default 1

**Intermediate:**
- Pre-enrichment backups: `test/fixtures/wlan/api/<api-name>.json.pre-enrich` (created once per CLI run)

**Outputs:**
- Enriched fixtures: `test/fixtures/wlan/api/<api-name>.json` (overwritten)
- Completeness audit JSON: `test/fixtures/completeness-audit.json` (always)
- CLI-requested formats: console or custom file path

### Environment and Assumptions

**Working directory:** must be project root (uses `process.cwd()`)

**Fixture discovery:** `fs.readdir('test/fixtures/wlan/api')` must return at least one `.json` file

**Snapshot ID selection:**
- CLI default: 1
- Can be overridden per API via `--snapshot-id=<id>` (single) or per-API in batch map
- Passed to `queryBackend(QueryRequest)` for versioned backend queries

**Backend query:** `queryBackend(QueryRequest)` is currently a stub that returns `status: "not_found"` (production would call clangd_intelligence_query tool)
