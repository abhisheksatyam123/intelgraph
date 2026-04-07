---
tags:
  - skill/notes-workflow
  - status/stable
description: Standard procedure for notes-first exploration and durable write-back.
---

# notes-workflow

## Index

- [Index](#index) — L10
- [Purpose](#purpose) — L14
- [Entry points](#entry-points) — L18
- [Inputs](#inputs) — L26
- [Workflow](#workflow) — L32
- [Outputs](#outputs) — L43
- [Checks](#checks) — L49
- [Failure modes](#failure-modes) — L55
- [Quality](#quality) — L62
- [References](#references) — L67

## Purpose

- Run every task with notes-first retrieval and durable write-back before completion.

## Entry points

- `doc/task/todo-<goal>` for active problem state.
- `doc/architecture/system-overview` for global orientation.
- `doc/architecture/data-flow-map` and `doc/architecture/control-layer-map` for cross-module traversal.
- `doc/concept/workspace-memory-model` and concept notes for shared-domain meaning.
- `doc/module/note-quality` for note quality expectations and audit interpretation.

## Inputs

- Task goal and scope.
- Existing architecture, concept, module, and skill note links.
- Missing-note signals from task open questions.

## Workflow

1. `notesread list` to inventory durable knowledge.
2. Read task Goal/Data dependencies/Plan/Progress.
3. For system-level questions, read architecture notes first; for shared-domain questions, read concept notes first.
4. Read module `Data flow` and `Control layers` sections for implementation ownership.
5. Expand graph with `notesread refs` before source scans.
6. Allow parallel note reads and exploration, but assign one writer per durable note/section.
7. Persist durable findings with `noteswrite` after ownership is clear; in plan mode, return proposed note targets instead of writing.
8. Run `notesread audit` on touched notes.

## Outputs

- Updated task note with concise execution trace.
- Durable architecture/concept/module/skill updates with reusable abstractions.
- Linked note graph that reduces future token usage.

## Checks

- Task Data dependencies use wiki links to source notes.
- Progress entries include storage link + captured abstraction.
- Audit passes with zero issues.

## Failure modes

- Task note becomes verbose transcript instead of control plane.
- Cross-module facts are buried only in module notes instead of architecture notes.
- Shared meaning is buried only in modules instead of concept notes.
- Broken wiki links in task dependencies or references.

## Quality

- Keep the workflow repeatable, verifiable, and linked to authoritative module/task sections.
- Govern this note with [[doc/module/note-quality#Skill note quality]].

## References

- [[doc/architecture/system-overview]]
- [[doc/architecture/data-flow-map]]
- [[doc/architecture/control-layer-map]]
- [[doc/concept/workspace-memory-model]]
- [[doc/module/note-quality#Flow note quality]]
- [[doc/skill/task-note-maintenance]]
- [[doc/task/todo-bootstrap-notes-vault]]
