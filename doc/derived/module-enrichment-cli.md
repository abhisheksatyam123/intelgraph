---
tags:
  - status/wip
  - derived/module-enrichment-cli
description: Enrichment CLI—generates and extends WLAN fixtures with backend-sourced relation data
owner: wlan
---


# module-enrichment-cli

## Index

- [Index](#index) — L12
- [Purpose](#purpose) — L21
- [Entry points](#entry-points) — L25
- [Data flow](#data-flow) — L37
- [Outputs](#outputs) — L59
- [Determinism and reproducibility](#determinism-and-reproducibility) — L73

## Purpose

The enrichment CLI is the generation entrypoint that extends WLAN fixtures with exhaustive relation data by querying the intelligence backend. It supports single-API and batch enrichment modes, dry-run simulation, and snapshot versioning.

## Entry points

**CLI**: `npm run enrich:fixtures [--api=<name>] [--snapshot-id=<id>] [--dry-run]`

**Source**: `src/bin/enrich-fixtures.ts`

**Options**:
- `--api=<api_name>`: Enrich single API by name (e.g. `arp_offload_proc_frame`). If omitted, batch-enrich all APIs.
- `--snapshot-id=<id>`: Backend snapshot ID to query (default: 1). Controls which version of backend data is used.
- `--dry-run`: Simulate enrichment without writing to disk. Useful for testing and validation.
- `--help` or `-h`: Show usage information.

## Data flow

**Single API workflow**:
1. Parse CLI arguments
2. Load existing fixture from `test/fixtures/wlan/api/<api_name>.json`
3. Count pre-enrichment relations
4. Call `enrichApiFixture(apiName, snapshotId)` from exhaustive-relation-scanner
5. Backup original to `<name>.json.pre-enrich` (unless --dry-run)
6. Write enriched fixture back to disk with new relations
7. Report progress: intents hit/queried, new relation count

**Batch workflow**:
1. Parse CLI arguments
2. Scan `test/fixtures/wlan/api/` for all `.json` files (excluding `.pre-enrich`)
3. For each API (sorted, with progress bar):
   - Load fixture
   - Enrich via exhaustive-relation-scanner
   - Create `.pre-enrich` backup (skip if already exists; don't overwrite)
   - Write enriched fixture to disk
   - Track success/failure, relation counts
4. Print summary: total APIs, success/failure counts, success rate, total relations added, failed APIs list

## Outputs

**On success**:
- Enriched fixture written to `test/fixtures/wlan/api/<api_name>.json`
- Pre-enrichment backup written to `test/fixtures/wlan/api/<api_name>.json.pre-enrich` (single or batch)
- Console output: progress bar (batch), success rate, relation delta, hit intents list
- Exit code: 0

**On failure** (per API):
- Original fixture untouched (if --dry-run or error before write)
- Error message printed to console with API name and error snippet
- Batch mode continues processing remaining APIs
- Exit code: 0 (batch mode) or 1 (single mode)

## Determinism and reproducibility

**Determinism factors**:
- `--snapshot-id` controls which backend snapshot is queried; same snapshot should yield same results on repeated runs
- Intent selection is deterministic based on API role heuristics from exhaustive-relation-scanner
- Relation deduplication is stable (sorted by confidence descending)
- Backup creation is idempotent (skips if `.pre-enrich` already exists)

**Known non-determinism**:
- If backend snapshot data changes between runs, fixture relations will change
- If intelligence backend behavior changes, results may differ
