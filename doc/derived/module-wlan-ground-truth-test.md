---
tags:
  - status/wip
description: Layer 2: Verification of ground-truth expectations.
---

# module-wlan-ground-truth-test

## Index

- [Index](#index) — L9
- [Meaning](#meaning) — L14
- [Data flow](#data-flow) — L20

## Meaning

Layer 2: Verification of ground-truth expectations. Defines node kind specifications (what each entity family should look like), probe cases (test queries that should return specific node kinds), and verification query cases (comprehensive intent coverage per entity family).

Tests that the intelligence backend correctly recognizes and categorizes WLAN entities and can return them for all required intents with correct metadata (canonical_name, kind, location, source anchors).

## Data flow

Reads: test/fixtures/wlan-ground-truth.json and live/mocked WLAN workspace via tool.client

Calls: intelligence_query tool with entity names and intents

Validates:
- Backend recognizes each entity family (api, struct, thread, ring, hw_block, etc.)
- Returns node kind, canonical_name, source location (file, line)
- Source anchors resolve in the WLAN workspace
- Each entity family can be queried via their required intents

Defines VerificationQueryCase, NodeKindProbe, and GraphContract types for structured test organization.

Skips if WLAN_WORKSPACE_ROOT not available; runs with full intent coverage when workspace is present.
