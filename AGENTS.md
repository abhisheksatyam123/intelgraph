# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the runtime code. `src/core/`, `src/lsp/`, `src/daemon/`, and `src/config/` handle startup, transport, and lifecycle. `src/tools/` exposes MCP tools, `src/intelligence/` contains graph-backed ingestion and query logic, and `src/backend/` wires both sides together. Tests live under `test/unit`, `test/integration`, `test/e2e`, and `test/manual`, with shared fixtures in `test/fixtures` and helpers in `test/helpers.ts`. `scripts/` plus `docker-compose.intelligence.local.yml` manage the local intelligence stack. `dist/` and `.intelligence-data/` are generated artifacts.

## Build, Test, and Development Commands
Use `bun install` to install dependencies. `npm run build` bundles `src/index.ts` and `src/bridge/index.ts` into `dist/`. `npm run dev` runs the server from source. `npm test` runs the automated Vitest suites; use `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, or `npm run test:coverage` for narrower checks. `npm run lint` enforces ESLint rules, including module boundaries, and `npm run typecheck` runs strict TypeScript validation. For local graph work, use `scripts/start-intelligence-local.sh <workspace>` and `scripts/stop-intelligence-local.sh <workspace>`.

## Coding Style & Naming Conventions
Write strict ESM TypeScript with 2-space indentation, double quotes, trailing commas, and no semicolons. Follow the existing kebab-case file naming pattern, for example `get-callers.ts` and `proposal-validator.ts`. Keep tool entrypoints in `src/tools/index.ts` and intelligence exports in `src/intelligence/index.ts`. Respect the enforced import boundaries: `src/tools/` must not import intelligence internals directly, `src/intelligence/` must not import from `src/tools/` except through `src/intelligence/init.ts`, and `src/core/server.ts` should depend on `BackendDeps`, not `unified-backend` directly.

## Testing Guidelines
Name automated tests `*.test.ts`. Put fast isolated coverage in `test/unit`, cross-module behavior in `test/integration`, and real-workspace flows in `test/e2e`. Reuse `test/fixtures` and `test/helpers.ts` instead of hardcoding workspace paths. If a test needs a real WLAN tree, set `WLAN_WORKSPACE_ROOT` or `CLANGD_MCP_WORKSPACE_ROOT`. Keep core-module coverage above 90%, and run `npm test`, `npm run lint`, and `npm run typecheck` before opening a PR.

## Commit & Pull Request Guidelines
Follow the existing conventional style: `feat:`, `fix:`, `refactor:`, and `test:` with an imperative summary. Keep commits focused on one behavior change. Pull requests should describe the problem, note affected runtime modes or MCP tools, link related issues, and list the validation commands you ran. If tool responses or daemon behavior changed, include a short request/response sample or log excerpt instead of screenshots.

## Documentation & Notes Vault
This repo's `doc/` is two symlinks into a personal Obsidian vault at `~/notes/`. The symlinks are gitignored — recreate them on a fresh clone with `scripts/setup-notes-vault.sh`.

- **`doc/atomic/`** — universal durable knowledge shared across every project. Read `doc/atomic/skill/notes-workflow.md` for the workflow contract and `doc/atomic/skill/weekly-review.md` for the maintenance ritual. Domain-bound atoms live under `doc/atomic/domain/<subfield>/` (e.g. `doc/atomic/domain/graph-db/`).
- **`doc/project/`** — intelgraph-specific notes only (the vault directory is still under `software/clangd-mcp/` for backwards compat). Subfolders answer five questions: `architecture/` (how it's built), `module/` (code parts), `data/` (schemas, fixtures, contracts under `data/schema/`, `data/fixture/`, etc.), `decision/` (ADRs), `skill/` (project runbooks). Plus `derived/` (machine-generated module notes), `diagram/` (.puml), and `task/` (active work).
- **Quick capture**: `scripts/note new <type> <slug>` creates a note from the matching template under the vault and prints its path.
- **Frontmatter is required** on every note — schema in `~/notes/_templates/_frontmatter-standard.md`. Lifecycle is `seedling → growing → evergreen → superseded → archived`; bump `status:` and `updated:` whenever you touch a note.
- **When you learn something**: a universal pattern → new note in `doc/atomic/concept|skill|pattern/`. A domain insight → new note in `doc/atomic/domain/<subfield>/`. A project fact → update or create a note under `doc/project/<area>/`. Never duplicate; link with `[[wikilinks]]`.
- **Source code referencing notes**: use `doc/atomic/...` or `doc/project/...` paths so symlink resolution works. Don't reference the vault path directly.

## WLAN Graph Fixture Design
When extending `test/fixtures/wlan-ground-truth.json`, treat each `verificationTarget` as a graph contract for one primary API node. For each target, include a `graphContract` section and keep it synchronized with `queryCases`.

Primary storage format for backend verification is `apiGroundTruth`:
- One entry per API (`api_name`).
- Keep all relation evidence in that single entry under `relations.*` arrays.
- Keep `verification_contract.required_sections` and `minimum_counts` so tests can assert completeness.

Use this relation matrix for coverage:
- Incoming relations: who calls the API (`who_calls_api`, `who_calls_api_at_runtime`, callback registrars).
- Outgoing relations: what the API calls (`what_api_calls`, dispatch to APIs/HW blocks).
- Data-flow relations: struct/field reads and writes.
- Observability relations: logs and log-level filtering.
- Runtime context relations: interrupt/signal/thread/timer/ring/hw_block links.

Required `graphContract` fields:
- `primaryNode`: canonical API name represented by the target.
- `requiredRelationKinds`: expected normalized edge kinds (`call_runtime`, `call_direct`, `register`, `dispatch`, `read`, `write`, `emit_log`).
- `requiredDirections`: one or more of `incoming`, `outgoing`, `bidirectional`.
- `requiredQueryCases`: query case names that must exist for this target.
- `requiredPathPatterns`: short path signatures (2-4 nodes), for example `interrupt -> signal -> thread -> api`.
- `minimumEvidencePerRelation`: minimum evidence rows per relation kind (usually `1`).

Practical rules:
- Every mock row must be DB-comparable (`kind`, `canonical_name`, `file_path`, `line_number`, plus relation-specific fields).
- Every required relation should have at least one source anchor in real WLAN code.
- Missing relation extraction must be captured through `feedbackIfMissing` and `parserGapFeedback`; treat it as backend parser debt.
- Keep `verificationTargets[*].queryCases` and `apiGroundTruth[*].relations` aligned; both are validated by unit tests and the manual source-audit script.
