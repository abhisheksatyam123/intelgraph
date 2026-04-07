---
tags:
  - concept/workspace-memory-model
  - status/stable
description: Shared meaning of the note graph as durable project memory across tasks and modules.
owner: notes-tool
---

# workspace-memory-model

## Index

- [Index](#index) — L11
- [Purpose](#purpose) — L15
- [Meaning](#meaning) — L19
- [Invariants](#invariants) — L27
- [Representations](#representations) — L33
- [Lifecycle](#lifecycle) — L39
- [Participating modules](#participating-modules) — L44
- [Related concepts](#related-concepts) — L49
- [Use cases](#use-cases) — L54
- [Patterns](#patterns) — L59
- [Quality](#quality) — L64
- [Notes](#notes) — L69

## Purpose

- Defines what the workspace note graph represents so tasks can store facts at the correct abstraction layer.

## Meaning

- Task notes are compressed control memory for one active problem.
- Module notes are implementation-owner memory.
- Architecture notes are cross-module structure memory.
- Concept notes are shared-domain meaning memory.
- Skill notes are repeatable workflow memory.

## Invariants

- Durable truths live outside task notes.
- Every stable fact should have one canonical home.
- Retrieval should prefer `list -> index -> read(section)` before source files.

## Representations

- Logical paths use `doc/<type>/<name>`.
- Physical storage resolves to the unified notes vault.
- Cross-note relationships use wiki links and narrow headings.

## Lifecycle

- Facts start as task progress, then promote into durable notes.
- Durable notes are corrected at the source section when code changes.

## Participating modules

- See [[doc/architecture/system-overview#Data flow]] for the notes-first data path.
- See [[doc/architecture/control-layer-map#Control layers]] for the control-plane model.

## Related concepts

- [[doc/concept/flow-lens]]
- [[doc/architecture/system-overview]]

## Use cases

- Decide where a newly discovered fact belongs.
- Explain why notes reduce source re-reads and token use.

## Patterns

- Stable knowledge classes beat topic buckets such as feature or bug folders.
- One canonical home per durable fact keeps the graph low-entropy.

## Quality

- Keep this note focused on shared meaning and invariants; link to architecture for topology and modules for implementation.
- Govern this note with [[doc/module/note-quality#Concept note quality]].

## Notes

- See [[doc/module/note-quality#Note type selection]].
