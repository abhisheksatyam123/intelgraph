---
tags:
  - status/wip
  - derived/module-ground-truth-tests
description: Ground-truth tests—verify backend behavior against fixture contract expectations with mocked DB
owner: wlan
---


# module-ground-truth-tests

## Index

- [Index](#index) — L12
- [Purpose](#purpose) — L19
- [Architecture and execution model](#architecture-and-execution-model) — L23
- [Verification logic and coverage](#verification-logic-and-coverage) — L43

## Purpose

Ground-truth verification tests load the WLAN fixture corpus and verify backend behavior against fixture contract expectations. Tests run with mocked backend data, treating fixtures as the source of truth.

## Architecture and execution model

**Source**: `test/unit/intelligence/wlan-ground-truth.test.ts`

**Scope**: Tests all entity families (api, struct, ring, hw_block, thread, signal, interrupt, timer, dispatch_table, message, log_point)

**Fixture loading**: 
- Ground truth manifest: `test/fixtures/wlan-ground-truth.json`
- Per-family fixtures: `test/fixtures/wlan/<family>/<canonical_name>.json`
- Manifest structure: `index.json` lists all canonical names per family

**Test structure**:
- Per-entity family: separate test suite
- Per-entity: separate test case that:
  1. Loads fixture from disk
  2. Sets up mock DB rows from fixture relations
  3. Executes targeted intents via intelligence_query tool
  4. Compares backend response to fixture expectations
  5. Reports mismatches at (entity, relation_bucket, field) granularity

## Verification logic and coverage

**Data structures**:
- `VerificationQueryCase`: A single query test with intent, mockRows, and expected response
- `ApiGroundTruthEntry`: Complete entry with api_name, node_kind, source, relations (buckets of FixtureRow), verification_contract
- `GraphContract`: Defines required relation kinds, directions (incoming/outgoing/bidirectional), query cases, and path patterns per entity family

**Verification logic**:
- Load fixture relations into mock DB rows
- For each required intent: call intelligence_query tool with entity name and intent
- Extract backend response nodes/edges
- Compare response shape to fixture contract expectations
- Classify mismatches: missing, extra, source mismatch, weak evidence, consistency issues

**Coverage**:
- Per-family intent map specifies which intents must be exercised
- E.g. for API: who_calls_api, who_calls_api_at_runtime, what_api_calls, show_registration_chain, find_api_logs, find_api_struct_reads, find_api_struct_writes
