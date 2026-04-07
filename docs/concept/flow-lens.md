---
tags:
  - concept/flow-lens
  - status/stable
  - flow/flow-lens
description: Shared meaning of flow as the runtime-path lens used inside architecture and module notes.
owner: notes-tool
---

# flow-lens

## Index

- [Index](#index) — L12
- [Purpose](#purpose) — L16
- [Meaning](#meaning) — L20
- [Invariants](#invariants) — L25
- [Representations](#representations) — L31
- [Lifecycle](#lifecycle) — L36
- [Participating modules](#participating-modules) — L41
- [Related concepts](#related-concepts) — L46
- [Use cases](#use-cases) — L50
- [Patterns](#patterns) — L55
- [Quality](#quality) — L60
- [Notes](#notes) — L65

## Purpose

- Defines what a flow is and where it should live so runtime traversal stays easy to retrieve without creating taxonomy sprawl.

## Meaning

- A flow describes ordered runtime movement across producers, orchestrators, workers, and sinks.
- Flow is a lens, not a primary folder, in the default notes model.

## Invariants

- Cross-module flows belong in architecture notes.
- Module-local flows belong in module notes.
- Flows should make transitions and boundaries explicit.

## Representations

- Flow notes are usually sections or notes tagged with `flow/<name>`.
- Flow sections should live under `Data flow` or dedicated flow-tagged headings.

## Lifecycle

- Flows are created when runtime traversal is too costly to re-derive from code.
- Flows are refined when data/control boundaries change.

## Participating modules

- See [[doc/architecture/system-overview#Control layers]] for orchestration context.
- See [[doc/architecture/data-flow-map#Data flow]] for data-path context.

## Related concepts

- [[doc/concept/workspace-memory-model]]

## Use cases

- Answer 'what happens in order at runtime?' quickly.
- Prevent architecture notes from turning into undifferentiated sequence dumps.

## Patterns

- Keep structure in architecture and sequence in flows.
- Use one writer per flow section during parallel exploration.

## Quality

- Keep this note focused on shared meaning and invariants; link to architecture for topology and modules for implementation.
- Govern this note with [[doc/module/note-quality#Concept note quality]].

## Notes

- See [[doc/module/note-quality#Flow note quality]].
