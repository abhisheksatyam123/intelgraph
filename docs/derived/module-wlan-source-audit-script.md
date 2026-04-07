---
tags:
  - status/wip
description: Script that validates the ground-truth fixture against a real WLAN workspace.
---

# module-wlan-source-audit-script

## Index

- [Index](#index) — L9
- [Meaning](#meaning) — L14
- [Data flow](#data-flow) — L23

## Meaning

Script that validates the ground-truth fixture against a real WLAN workspace. Checks:
1. Fixture sections exist and contain DB-comparable fields (source location, relation buckets)
2. Verification targets retain expected runtime metadata (dispatch chain, trigger reason, confidence)
3. All declared source anchors resolve in the audited workspace (file exists, line number is reasonable)

Produces console output with pass/fail summary per check category.

## Data flow

Entry point: test/manual/wlan-source-audit.mjs

Reads: test/fixtures/wlan-ground-truth.json, WLAN workspace at WLAN_WORKSPACE_ROOT (env var)

Validates:
- All fixture sections contain required fields (source, relations, contract)
- All relation types map to known relation bucket kinds
- Source anchor references (file, line) exist in the workspace
- Confidence values are in [0, 1]
- Minimum evidence is present per relation

Output: console report with pass/fail counts and specific failures.
