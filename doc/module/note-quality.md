---
tags:
  - module/note-quality
  - status/stable
  - pattern/note-quality
description: Authoritative quality contract for task, module, architecture, concept, skill, and flow notes.
owner: notes-tool
---

# note-quality

## Index

- [Index](#index) — L12
- [Purpose](#purpose) — L16
- [Responsibilities](#responsibilities) — L20
- [Public API](#public-api) — L26
- [Key files](#key-files) — L32
- [Data model](#data-model) — L39
- [Data flow](#data-flow) — L45
- [Control layers](#control-layers) — L53
- [State transitions](#state-transitions) — L60
- [Use cases](#use-cases) — L67
- [Patterns](#patterns) — L73
- [Quality](#quality) — L80
- [Notes](#notes) — L85
  - [Task note quality](#task-note-quality) — L87
  - [Module note quality](#module-note-quality) — L91
  - [Architecture note quality](#architecture-note-quality) — L95
  - [Concept note quality](#concept-note-quality) — L99
  - [Skill note quality](#skill-note-quality) — L103
  - [Flow note quality](#flow-note-quality) — L107
  - [Note type selection](#note-type-selection) — L111
  - [Audit signals](#audit-signals) — L115

## Purpose

- Defines what makes a note retrieval-efficient, non-redundant, well-linked, and durable under change.

## Responsibilities

- Explain quality dimensions for every note kind.
- Map audit signals to concrete fixes.
- Provide narrow link targets for quality guidance.

## Public API

- `notesread audit` for structural and link-quality checks.
- `notesread search` for locating quality guidance by concept.
- `notesread refs` for finding who depends on a quality section.

## Key files

- `packages/opencode/src/tool/notes.ts` - audit rules, storage, graph operations.
- `packages/opencode/src/tool/notesread.txt` - retrieval contract.
- `packages/opencode/src/tool/noteswrite.txt` - write contract.
- `packages/opencode/src/session/prompt/agent.txt` - philosophy and workflow policy.

## Data model

- Quality dimensions: retrieval efficiency, signal density, graph integrity, evolvability.
- Note kinds: task, module, architecture, concept, skill, and flow-tagged durable sections.
- Audit issues: missing sections, missing links, low-signal data sections, verbose progress, broken targets.

## Data flow

1. Create or update note structure.
2. Link claims to durable source sections.
3. Run `notesread audit`.
4. Fix reported issues at the authoritative note.
5. Re-run audit until the note is stable.

## Control layers

- Philosophy layer: information theory and entropy reduction.
- Schema layer: required sections by note kind.
- Audit layer: machine-checked issue codes.
- Editorial layer: concise wording, stable names, narrow links.

## State transitions

- `draft` -> `structured` once required sections exist.
- `structured` -> `linked` once claims point to durable sources.
- `linked` -> `audited` once audit passes.
- `audited` -> `stable` once reused without correction.

## Use cases

- Judge whether a new note is good enough to trust.
- Fix audit failures without re-reading large source areas.
- Explain note quality expectations to subagents and future sessions.

## Patterns

- One concept per section; link instead of duplicate.
- Task note is control plane, not research transcript.
- Prefer the narrowest useful heading or block reference target.
- Quality is measured by future retrieval cost, not prose length.

## Quality

- Keep ownership, data, control, and state sections authoritative and concise.
- Govern this note with [[doc/module/note-quality#Module note quality]] and [[doc/module/note-quality#Flow note quality]] when flow-tagged.

## Notes

### Task note quality
- Keep only goal, state, concise progress, learnings, links, and open questions.
- Every learning should point to a durable note section.

### Module note quality
- Explain ownership, data model, data flow, control layers, and state transitions.
- Use module names as stable concept contracts, not transient file names.

### Architecture note quality
- Capture cross-module structure, boundaries, topology, and linked runtime flows without duplicating module internals.
- Use architecture notes as the first stop for system questions, then link down into module and concept notes.

### Concept note quality
- Capture shared meaning, invariants, representations, and related modules for concepts that span multiple modules.
- Keep concept notes distinct from architecture topology and module implementation detail.

### Skill note quality
- Capture repeatable procedure, required inputs, outputs, checks, and recovery paths.
- Keep workflow steps operational and verifiable.

### Flow note quality
- Make runtime traversal explicit: producer, orchestrator, worker, sink, transitions.
- Keep structure in architecture/module notes and sequence in flow sections or flow-tagged notes.

### Note type selection
- Add a new note type only when it has a distinct owner, retrieval pattern, lifecycle, and audit contract.
- Use tags such as `#feature/*` and `#bug/*` as workflow lenses instead of creating first-class note folders by topic.

### Audit signals
- `missing-section`: note shape is incomplete.
- `missing-data-detail`: data or control abstractions are too shallow.
- `missing-link-target` or `missing-data-link-source`: graph integrity is broken.
- `verbose-progress-entry`: task control plane has leaked transcript detail.
- `conflicting-status-tags`: task note carries both #status/active and #status/done (governance violation).
- `missing-owner`: module/architecture/concept note has no `owner` declared in frontmatter (governance violation).
- `low-abstraction-density`: note is structurally valid but stores descriptive text without reusable abstraction or reduction guidance.
- `missing-reduction-class`: task note does not capture reducible/irreducible framing or abstraction-as-reduction guidance.
- `repeated-recomputation`: repeated expensive reasoning is recorded without a mitigation proposal.
