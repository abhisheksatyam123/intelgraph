# AGENT.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

```bash
bun install
bun run build
bun run lint
bun run typecheck
bun run test
bun run test:unit
bun run test:integration
bun run test:e2e
bun run test:watch
bun run test:coverage
bun run test:legacy
```

Single-test examples:

```bash
bun run test:unit -- test/unit/pattern-resolver.test.ts
bun run test:integration -- test/integration/chain-resolver-ground-truth.test.ts
bun run test -t "normalises VCS marker paths"
```

Useful validation presets (all target the 01880 workspace only):

```bash
bun run validate:unit
bun run validate:01880
bun run validate:matrix:conditional-go
```

**On-demand graph correctness check** (build → typecheck → all unit tests):

```bash
bun run validate:graph
```

This is the single command to run after any change to the caller-resolution waterfall,
alias handling, or role classification logic.

## High-level architecture

`src/index.ts` is the entrypoint. It reads process args and `.clangd-mcp.json`, initializes logging, optionally boots the intelligence backend, then chooses one of three transports: default stdio proxy to a detached HTTP daemon, explicit `--port` HTTP mode, or direct `--stdio` mode.

The runtime is centered on a shared `LspClient` connected to clangd. Lifecycle and reconnect behavior live under `src/core/` and `src/daemon/`; the index tracker in `src/tracking/` feeds readiness and file-status suffixes back into tool outputs.

MCP tools are declared in `src/tools/index.ts`. They wrap LSP operations, formatting, and diagnostics into plain-text responses, and also include higher-level reasoning/caller flows plus the intelligence query surface. Tool formatting logic is split into formatter modules, while dispatch and dependency wiring live separately.

The intelligence subsystem is initialized from `src/intelligence/init.ts`. When `INTELLIGENCE_NEO4J_URL` is set, it creates the Neo4j-backed backend, runs migrations, and wires the shared dependencies used by ingest/query tools. The tool layer combines clangd-derived data with the intelligence backend for runtime caller and query workflows.

Per-workspace daemon/runtime state is stored in the workspace root, while server logs are written under the local data log directory described in `README.md`.

## API graph and caller resolution

The spec goal is a complete runtime-invocation graph of the WLAN codebase. The center of that system is `src/tools/get-callers.ts`, which runs a 5-step waterfall:

1. `lsp_runtime_flow` — LLM/cache-based (highest quality, needs `llmReasoning` config)
2. `intelligence_query_runtime` — Neo4j runtime caller graph (needs `INTELLIGENCE_NEO4J_URL`)
3. `intelligence_query_static` — Neo4j static call graph
4. `lsp_indirect_callers` — LSP + C parser dispatch chain reconstruction
5. `lsp_incoming_calls` — direct clangd callers (always available, lowest coverage)

Two critical correctness properties the tests enforce:
- **Alias resolution**: `canonicalizeSymbol` and `symbolAliasVariants` in `get-callers.ts` normalize `_fn___RAM` variants so DB queries find the right node regardless of ROM/RAM suffix decoration.
- **Role separation**: `callerRole` distinguishes `runtime_caller`/`direct_caller` (shown in the caller tree) from `registrar` (context only — it wired the fn-ptr but does NOT call the target at runtime). Mixing these up silently produces wrong graphs.

The ground-truth fixture suite lives in `test/fixtures/wlan-ground-truth.json` and `test/integration/wlan-targets.ts`, covering 8 WLAN APIs across 7 dispatch/registration pattern families. Unit tests for the waterfall helpers are in `test/unit/get-callers.test.ts`.
