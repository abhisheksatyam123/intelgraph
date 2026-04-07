---
tags:
  - status/wip
description: A comprehensive JSON-structured corpus of WLAN entity fixtures organized by entity family.
---

# module-wlan-ground-truth-fixture-corpus

## Index

- [Index](#index) — L9
- [Meaning](#meaning) — L15
- [Data flow](#data-flow) — L21
- [Canonical corpus membership and count](#canonical-corpus-membership-and-count) — L32

## Meaning

A comprehensive JSON-structured corpus of WLAN entity fixtures organized by entity family. Each fixture encodes the canonical entity identity, source location, semantic relations across 9 relation buckets (calls_in_direct, calls_in_runtime, calls_out, registrations_in/out, structures, logs, owns, uses), and a contract of expected relation kinds and minimum counts per entity.

The corpus treats fixture data as source of truth: when comparing backend responses against fixtures, fixture data is authoritative.

## Data flow

Reads fixture JSON files from disk (test/fixtures/wlan/{api,struct,ring,hw_block,thread,signal,interrupt,timer,dispatch_table,message,log_point}/*.json) and validates:
- All required fields present per entity family
- Relation buckets contain properly typed edge objects
- Confidence values are in [0, 1]
- Evidence references are structurally valid
- Source location coordinates resolve (file + line exist in WLAN workspace if available)

Produces a summary JSON report listing per-family validation status, missing required fields, malformed edges, and confidence outliers. Used by wlan-ground-truth.test.ts and backend-reconciliation.test.ts to fail early on corrupted fixtures.

## Canonical corpus membership and count

Authoritative fixture-corpus membership for WLAN ground-truth validation is **69 canonical entity fixtures** across 11 families.

Count contract:
- Canonical entity fixtures: 69 (61 `api`, 2 `struct`, and 1 each for `ring`, `hw_block`, `thread`, `signal`, `interrupt`, `timer`, `dispatch_table`, `message`, `log_point`).
- Raw family-directory file count may appear as 72 when non-canonical artifacts are present.
- Exclusions from canonical corpus: pre-enrich snapshots and report/support JSON artifacts that are not canonical entity fixtures.

Pass/fail expectation:
- PASS: schema/reconciliation scope is derived from canonical entity fixtures only.
- FAIL: non-canonical artifacts are treated as contract-bearing entity fixtures.

Linked authority: [[doc/derived/module-wlan-fixture-schema#Frozen schema and contract model (item 2)]]
