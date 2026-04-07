---
tags:
  - status/wip
description: Script that normalizes and reconciles relation aliases in fixtures.
---

# module-wlan-fixture-normalize-relations-script

## Index

- [Index](#index) — L9
- [Meaning](#meaning) — L14
- [Data flow](#data-flow) — L20

## Meaning

Script that normalizes and reconciles relation aliases in fixtures. Maps discovered aliases (e.g. "_api_name" vs "api_name") to canonical forms and applies batch normalization rules to fixture relation fields.

Used to maintain consistency across the fixture corpus when entities have multiple naming conventions.

## Data flow

Entry point: scripts/wlan-fixture-normalize-relations.mjs

Reads: test/fixtures/wlan/*/\*.json (existing fixtures), relation normalization map files

Writes: test/fixtures/wlan/*/\*.json (updated fixtures with normalized relation fields)

Applies batch alias transformations to relation caller/callee/api/struct fields, ensuring consistent canonical naming across the corpus.
