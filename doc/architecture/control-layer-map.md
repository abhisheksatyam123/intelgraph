---
tags:
  - architecture/control-layer-map
  - status/stable
  - flow/control-map
description: Canonical map of orchestration boundaries and control-plane ownership.
owner: architecture
---

# control-layer-map

## Index

- [Index](#index) — L12
- [Purpose](#purpose) — L16
- [Responsibilities](#responsibilities) — L20
- [Participating modules](#participating-modules) — L26
- [Interfaces](#interfaces) — L31
- [Data flow](#data-flow) — L36
- [Control layers](#control-layers) — L43
- [State transitions](#state-transitions) — L49
- [Topology](#topology) — L55
- [Use cases](#use-cases) — L60
- [Patterns](#patterns) — L65
- [Quality](#quality) — L70
- [Notes](#notes) — L75

## Purpose

- Tracks who orchestrates work vs who executes work, so control bugs are isolated quickly.

## Responsibilities

- Define controllers/orchestrators/workers.
- Capture delegation paths and policy checks.
- Link control decisions to owning modules.

## Participating modules

- Link controllers, orchestrators, policy modules, and workers.
- Keep links narrow to control-layer sections.

## Interfaces

- Control-entry boundaries, delegation points, and effect surfaces.
- Link concrete commands or APIs from owning module notes.

## Data flow

1. Controller receives intent.
2. Policy validates preconditions.
3. Orchestrator coordinates workers.
4. Worker outputs are committed and reported.

## Control layers

- Control plane: scheduling, ordering, retries, policy.
- Data plane: deterministic transforms on validated inputs.
- Observability plane: logs/audits for correctness checks.

## State transitions

- `queued` -> `running` -> `completed`.
- `running` -> `blocked` when policy or dependency fails.
- `blocked` -> `running` after remediation.

## Topology

- Control flows from controllers to orchestrators to workers with policy gates between them.
- Observability runs alongside control transitions for verification.

## Use cases

- Find where retry or ordering logic should live.
- Separate orchestration bugs from data-transform bugs.

## Patterns

- Keep orchestration and transformation concerns separated.
- Record control transitions explicitly, not implicitly.

## Quality

- Keep this note at the cross-module structure layer; link down to modules instead of duplicating internals.
- Govern this note with [[doc/module/note-quality#Architecture note quality]] and [[doc/module/note-quality#Flow note quality]] when flow-tagged.

## Notes

- See [[doc/architecture/system-overview#Control layers]].
- See [[doc/architecture/data-flow-map#Data flow]].
