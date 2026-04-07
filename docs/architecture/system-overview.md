---
tags:
  - architecture/system-overview
  - status/stable
description: Baseline system map for data paths, control layers, and state transitions.
owner: architecture
---

# system-overview

## Index

- [Index](#index) — L11
- [Purpose](#purpose) — L15
- [Responsibilities](#responsibilities) — L19
- [Participating modules](#participating-modules) — L25
- [Interfaces](#interfaces) — L30
- [Data flow](#data-flow) — L36
- [Control layers](#control-layers) — L43
- [State transitions](#state-transitions) — L52
- [Topology](#topology) — L59
- [Use cases](#use-cases) — L65
- [Patterns](#patterns) — L70
- [Quality](#quality) — L75
- [Notes](#notes) — L80

## Purpose

- Captures the minimal shared architecture map so sessions start from abstractions, not raw code.

## Responsibilities

- Define high-level subsystem ownership.
- Link durable data and control maps.
- Provide first-stop orientation for new tasks.

## Participating modules

- Link core module notes that define major subsystem boundaries.
- Add architecture-adjacent modules as they are discovered.

## Interfaces

- Task notes link into architecture, module, concept, and skill notes.
- Module notes expose owned implementation contracts.
- Concept notes define shared meaning across modules.

## Data flow

1. `notesread list` discovers known notes.
2. `notesread index` + targeted `read` recover module abstractions.
3. Source files are read only for missing or stale facts.
4. Durable findings are written back before task completion.

## Control layers

- Task note controls execution state and decisions.
- Architecture notes control cross-module structure and flow maps.
- Module notes control durable implementation facts.
- Concept notes control shared meaning and invariants.
- Skill notes control repeatable procedures.
- Audit controls quality before completion.

## State transitions

- `empty` -> `oriented` after notes discovery.
- `oriented` -> `exploring` when gaps remain.
- `exploring` -> `persisted` after durable writes.
- `persisted` -> `audited` when integrity checks pass.

## Topology

- `system-overview` is the first-stop map for cross-module navigation.
- `data-flow-map` and `control-layer-map` provide architecture-scoped runtime lenses.
- Module and concept notes hang below this layer as owned detail.

## Use cases

- Start a new task with low token cost.
- Handoff between sessions without losing architectural context.

## Patterns

- Information-theory lens: reduce entropy with linked durable abstractions.
- Keep task notes concise; move depth into module/skill notes.

## Quality

- Keep this note at the cross-module structure layer; link down to modules instead of duplicating internals.
- Govern this note with [[doc/module/note-quality#Architecture note quality]] and [[doc/module/note-quality#Flow note quality]] when flow-tagged.

## Notes

- See [[doc/architecture/data-flow-map#Data flow]].
- See [[doc/architecture/control-layer-map#Control layers]].
- See [[doc/skill/notes-workflow#Workflow]].
