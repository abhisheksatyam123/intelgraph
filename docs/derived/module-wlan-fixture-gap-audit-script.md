---
tags:
  - status/wip
description: Script that audits fixture coverage gaps by comparing fixture corpus against the WLAN source.
---

# module-wlan-fixture-gap-audit-script

## Index

- [Index](#index) — L9
- [Meaning](#meaning) — L14
- [Data flow](#data-flow) — L24

## Meaning

Script that audits fixture coverage gaps by comparing fixture corpus against the WLAN source. Generates comprehensive reports (JSON and Markdown) listing:
- Per-entity completeness scores (Tier 1/1+2/1+2+3)
- Relation distribution across all 9 buckets
- Entities needing follow-up enrichment
- Actionable remediation suggestions

The gap audit forms the basis for prioritizing which entities to enrich next.

## Data flow

Entry point: scripts/wlan-fixture-gap-audit.mjs

Reads: test/fixtures/wlan/index.json, test/fixtures/wlan/*/\*.json (all fixtures), WLAN source tree

Writes: test/fixtures/wlan/wlan-gap-audit-report.{json,md}

Algorithm:
1. Load fixture index (manifest of all entities per family)
2. For each entity, load its fixture JSON and compute completeness score
3. Partition entities into tiers (Tier 1/1+2/1+2+3)
4. Aggregate relation counts and distribution across all buckets
5. List entities with lowest scores as needing follow-up
6. Generate both JSON (structured) and Markdown (human-readable) reports

Used to understand overall fixture health and identify enrichment priorities.
