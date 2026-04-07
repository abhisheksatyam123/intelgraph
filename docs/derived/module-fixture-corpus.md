---
tags:
  - status/wip
  - derived/module-fixture-corpus
  - status/stable
description: WLAN fixture corpus—source-of-truth entity definitions organized by family with relation buckets
owner: wlan
---


# module-fixture-corpus

## Index

- [Index](#index) — L13
- [Purpose](#purpose) — L20
- [Data flow](#data-flow) — L30
- [Boundaries](#boundaries) — L41

## Purpose

The WLAN fixture corpus is the source of truth for all backend reconciliation and ground-truth testing. It consists of JSON fixture files organized by entity family, where each fixture contains:
- Entity metadata (canonical_name, kind, kind_verbose, source location, description)
- Relation buckets (calls_in_direct, calls_in_runtime, calls_out, registrations_in, registrations_out, structures, logs, owns, uses)
- Optional contract with verification expectations
- Optional enrichment metadata from generation runs

Total: ~120 API fixtures + struct/ring/thread/hw_block/signal/interrupt/timer/dispatch_table/message/log_point fixtures organized in `/test/fixtures/wlan/api` and family subdirectories.

## Data flow

1. **Fixture discovery**: `test/fixtures/wlan/index.json` manifests all entity families and names
2. **Loading**: Tests/enrichment CLI loads fixtures by family and canonical name from disk
3. **Storage**: Each fixture is a standalone JSON file with complete entity definition and all known relations
4. **Backup**: Pre-enrichment backups created as `<name>.json.pre-enrich` when enrichment writes occur
5. **Consumption**: 
   - Ground-truth tests consume fixtures directly for contract verification
   - Backend reconciliation tests build mock DB rows from fixture relations
   - Enrichment CLI loads and augments existing fixtures with new relation data

## Boundaries

- **What is in scope**: fixture data structure, relation buckets, entity families, file organization
- **What is out of scope**: backend schema, clangd intelligence implementation, workspace source code
- **Ownership**: fixtures are manually curated and programmatically enriched; each fixture may have a corresponding `.pre-enrich` backup
- **Determinism**: fixtures are static except during enrichment runs; enrichment is controlled via `--snapshot-id` and `--dry-run` flags
