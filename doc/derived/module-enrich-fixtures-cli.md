---
tags:
  - status/wip
description: CLI entrypoint for fixture enrichment.
---

# module-enrich-fixtures-cli

## Index

- [Index](#index) — L9
- [Meaning](#meaning) — L15
- [Data flow](#data-flow) — L21

## Meaning

CLI entrypoint for fixture enrichment. Parses --api, --snapshot-id, --dry-run flags and orchestrates the enrichment workflow across one or all APIs.

Delegates to exhaustive-relation-scanner for the actual enrichment logic.

## Data flow

**Entrypoint command**: `npm run enrich:fixtures`

**Invocation path**: `src/bin/enrich-fixtures.ts` → CLI arg parser → `enrichApiFixture()` or `enrichAllApis()`

**Command-line flags**:
- `--api=<name>`: enrich single API by canonical_name (e.g., `arp_offload_proc_frame`)
- `--snapshot-id=<id>`: backend snapshot ID to query (default: 1; production context not yet integrated)
- `--dry-run`: simulate without writing to disk

**Input**:
- Existing fixture files from `test/fixtures/wlan/api/*.json`
- Fixture corpus metadata from `test/fixtures/wlan/index.json` (families: 11; APIs: 60; other entities: 9)

**Processing**:
1. Parse CLI arguments
2. If `--api` flag: enrich single API
   - Load existing fixture from disk
   - Count relations before enrichment
   - Call `enrichApiFixture(apiName, snapshotId)` 
   - Count relations after enrichment
   - Report intent hit rate and relation delta
   - Backup original to `.pre-enrich` (if not --dry-run)
   - Write enriched fixture to disk (or report write path on --dry-run)
3. If no `--api` flag: batch enrich all 60 APIs
   - Discover all `.json` files in `test/fixtures/wlan/api/`
   - Filter out `.pre-enrich` backups
   - Process each API sequentially
   - Track success/failure per API
   - Emit progress line per API: `[i/n] <api_name> [intents: x/y hit, +z new relations]`
   - On error, log error message and continue (not fatal)
   - After batch completion, print summary: total APIs, success count, failure count, success rate %, total relations added, mode (dry-run or not), and list of failed APIs with error summaries

**Output** (unless --dry-run):
- Enriched fixture files written to `test/fixtures/wlan/api/<api_name>.json`
- Backup files written to `test/fixtures/wlan/api/<api_name>.json.pre-enrich` (only once per API, skips if backup already exists)
- Console progress reporting with hit rate, relation counts, and summary statistics

**Error handling**:
- Per-API enrichment failure does not halt the batch (continue on failure)
- Error details logged to console; batch completion always printed
- Exit code 1 on fatal (e.g., directory not found); exit code 0 on successful batch even if some APIs failed
