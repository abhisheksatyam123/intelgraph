---
tags:
  - architecture/data-flow-map
  - status/stable
  - flow/data-map
description: Canonical map of data contracts, producers, transforms, and consumers.
owner: architecture
---

# data-flow-map

## Index

- [Index](#index) — L12
- [Purpose](#purpose) — L16
- [Responsibilities](#responsibilities) — L20
- [Participating modules](#participating-modules) — L26
- [Interfaces](#interfaces) — L31
- [Data flow](#data-flow) — L36
- [Control layers](#control-layers) — L43
- [State transitions](#state-transitions) — L49
- [Topology](#topology) — L54
- [Use cases](#use-cases) — L59
- [Patterns](#patterns) — L64
- [Quality](#quality) — L69
- [Notes](#notes) — L74

## Purpose

- Tracks end-to-end data contracts so features and fixes can target the correct owners quickly.

## Responsibilities

- Define data producers and consumers.
- Describe transformation boundaries.
- Link source-of-truth module sections for each contract.

## Participating modules

- Link data-owner modules and architecture-adjacent orchestrators.
- Keep links narrow to the relevant data sections.

## Interfaces

- Input boundaries, transformation contracts, and output sinks.
- Link concrete API details from owning module notes.

## Data flow

1. Input enters at boundary module.
2. Validation and normalization are applied.
3. Domain transforms execute in owning modules.
4. Output is emitted to callers, storage, or integrations.

## Control layers

- Orchestrators route flow across modules.
- Workers perform deterministic transforms.
- Policies enforce constraints at boundaries.

## State transitions

- `raw` -> `validated` -> `normalized` -> `committed`.
- Failed validation transitions to error paths with context.

## Topology

- Data enters from boundary modules and crosses orchestrators before reaching sinks.
- Use linked module notes for owner-local transforms.

## Use cases

- Locate where a data contract should change.
- Diagnose unexpected output by tracing upstream transforms.

## Patterns

- Keep contracts explicit and linked.
- Prefer narrow section links in task data dependencies.

## Quality

- Keep this note at the cross-module structure layer; link down to modules instead of duplicating internals.
- Govern this note with [[doc/module/note-quality#Architecture note quality]] and [[doc/module/note-quality#Flow note quality]] when flow-tagged.

## Notes

- See [[doc/architecture/system-overview#Data flow]].
- See [[doc/architecture/control-layer-map#Control layers]].
