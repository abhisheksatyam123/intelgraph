---
tags:
  - skill/task-note-maintenance
  - status/stable
description: How to keep task notes concise, current, and linked to durable architecture notes.
---

# task-note-maintenance

## Index

- [Index](#index) — L10
- [Purpose](#purpose) — L14
- [Entry points](#entry-points) — L18
- [Inputs](#inputs) — L23
- [Workflow](#workflow) — L29
- [Outputs](#outputs) — L38
- [Checks](#checks) — L43
- [Failure modes](#failure-modes) — L49
- [Quality](#quality) — L55
- [References](#references) — L60

## Purpose

- Maintain task notes as compressed scratchpads while preserving durable depth in architecture/concept/module/skill notes.

## Entry points

- Active task note in `doc/task/`.
- Links and Data dependencies in the task note.

## Inputs

- Current problem statement.
- Existing task progress and plan state.
- Durable note links for data and control abstractions.

## Workflow

1. Create/fill all required task sections before exploration.
2. Keep Data inputs/outputs/dependencies updated as understanding changes.
3. Record concise progress entries (attempt -> outcome -> storage -> abstraction).
4. Move detailed facts into architecture/concept/module/skill notes immediately.
5. Resolve open questions inline with durable links.
6. Finalize plan/progress/learnings and run audit.

## Outputs

- Short task control note with accurate current state.
- Durable linked notes for all reusable technical facts.

## Checks

- Task note has all required sections.
- Data dependencies links resolve to durable notes.
- No verbose progress dump entries.

## Failure modes

- Detailed architecture copied into task note.
- Missing wiki links in Data dependencies.
- Plan not reflecting real done/in-progress state.

## Quality

- Keep the workflow repeatable, verifiable, and linked to authoritative module/task sections.
- Govern this note with [[doc/module/note-quality#Skill note quality]].

## References

- [[doc/skill/notes-workflow]]
- [[doc/architecture/system-overview]]
- [[doc/module/note-quality#Task note quality]]
- [[doc/task/todo-bootstrap-notes-vault]]
