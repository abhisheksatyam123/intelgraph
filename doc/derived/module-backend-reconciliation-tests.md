---
tags:
  - status/wip
  - derived/module-backend-reconciliation-tests
description: Backend reconciliation tests—verify intelligence backend against fixture source-of-truth with injected mocks
owner: wlan
---


# module-backend-reconciliation-tests

## Index

- [Index](#index) — L12
- [Purpose](#purpose) — L19
- [Test structure and coverage](#test-structure-and-coverage) — L23
- [Reconciliation workflow and logic](#reconciliation-workflow-and-logic) — L42

## Purpose

Backend reconciliation tests load every fixture in the corpus, inject its relations as mock DB rows, and verify that the intelligence backend returns expected query results. Fixtures are the source of truth.

## Test structure and coverage

**Source**: `test/unit/intelligence/backend-reconciliation.test.ts`

**Test organization**:
- Per-entity family test suite
- Per-entity test case within family

**Supported families**:
api, struct, ring, hw_block, thread, signal, interrupt, timer, dispatch_table, message, log_point

**Family intents** (per-family query coverage map):
- **api**: who_calls_api, who_calls_api_at_runtime, what_api_calls, show_registration_chain, find_api_logs, find_api_struct_reads, find_api_struct_writes
- **struct**: where_struct_modified, where_struct_initialized, find_struct_readers, find_struct_writers, find_struct_owners
- **ring**: who_calls_api_at_runtime, find_callback_registrars
- **hw_block**: who_calls_api_at_runtime, find_callback_registrars
- **thread**: who_calls_api_at_runtime, what_api_calls, find_callback_registrars
- (and so on for other families)

## Reconciliation workflow and logic

**Per-entity reconciliation workflow**:
1. Load fixture from disk (test/fixtures/wlan/<family>/<canonical_name>.json)
2. Extract relations from fixture (calls_in, calls_out, registrations, etc.)
3. Build mock DB rows from fixture relations
4. Inject mock rows into intelligence backend via `setIntelligenceDeps(mockRows)`
5. For each applicable intent:
   - Call intelligence_query tool with entity name and intent
   - Extract backend response (nodes, edges)
   - Compare response to fixture expectations
   - Classify any mismatches (missing, extra, source mismatch, weak evidence, consistency)
6. Report per-entity, per-relation-bucket, per-field mismatches

**Reconciliation logic**:
- Fixtures define expected relations in buckets (calls_in_direct, calls_out, structures, etc.)
- For each intent, expected relation bucket is looked up via intent-to-bucket mapping
- Backend response is compared against expected relations in that bucket
- Mismatches are classified and reported
