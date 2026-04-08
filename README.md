# intelgraph

`intelgraph` is a plugin-based code intelligence graph: it extracts structural
facts about your codebase (symbols, calls, imports, type references, inheritance,
JSX components, …) into an embedded SQLite graph and exposes them through 38+
query intents over MCP and a built-in CLI.

Two extractor plugins ship today:

- **`clangd-core`** for C/C++, backed by a persistent clangd LSP daemon. Started
  life as the only thing this project did — hence the legacy `clangd-mcp` config
  file names you'll see referenced below.
- **`ts-core`** for TypeScript / JavaScript / JSX / TSX, using `tree-sitter`
  with no LSP required. Produces a richly annotated graph with cross-file call
  resolution, type references from signatures and bodies, JSX component edges,
  inheritance, and 17+ resolution kinds per call edge.

Visualization tools (such as `tui-relation-window`) consume the query layer
over MCP. The same query intents are also exposed by `npm run snapshot:stats`
which prints a workspace dashboard for any TS or C/C++ project.

## What it does

- starts or reuses a workspace-scoped clangd service for C/C++ extraction
- runs the ts-core tree-sitter extractor for TypeScript/JS workspaces
- writes facts into an embedded SQLite graph (`.clangd-mcp/intelligence.db`
  by default; the directory name is legacy and stays for backwards compat)
- exposes 38+ structural query intents as MCP tools (`intelligence_query`)
- supports direct stdio mode, standalone HTTP mode, and the default stdio proxy
  to a detached HTTP daemon
- ships a `snapshot:stats` CLI that prints a per-workspace dashboard in text,
  JSON, or markdown

## Runtime modes

### Default: stdio proxy to detached HTTP daemon

With no transport flags, `intelgraph` starts as a short-lived stdio MCP server
that first ensures a detached HTTP daemon is already running for the workspace,
then forwards all tool calls to it.

This is the recommended mode for OpenCode because:

- the warm clangd index survives OpenCode restarts
- multiple OpenCode sessions can share one workspace daemon
- you usually do not need to manage ports manually

### Direct stdio mode

Use `--stdio` when you want a single-process, single-session debug setup.

### Standalone HTTP mode

Use `--port <n>` when you want a long-lived HTTP MCP endpoint and prefer to
manage the process yourself.

## Quick start

### 1. Build

```bash
bun install
bun run build
```

This produces `dist/index.js` and `dist/bridge.js`.

### 2. Configure OpenCode

Minimal recommended setup:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "lsp": "allow"
  },
  "mcp": {
    "clangd": {
      "type": "local",
      "command": [
        "bun",
        "/path/to/intelgraph/dist/index.js",
        "--root",
        "/path/to/your/workspace",
        "--clangd",
        "/usr/local/bin/clangd-20",
        "--clangd-args",
        "--background-index,--enable-config,--log=error,--clang-tidy=false"
      ],
      "enabled": true
    }
  }
}
```

Notes:

- omitting transport flags uses the default stdio-proxy mode
- `--root` should point at the workspace that contains `compile_commands.json`
- `--clangd` is optional if `clangd` is already on `PATH`

### 3. Start OpenCode

OpenCode will launch `intelgraph` automatically when the MCP entry is enabled.

## Tool surface

The authoritative tool registry lives in `src/tools/index.ts`. The current source
defines 23 MCP tools with `lsp_` names:

- `lsp_hover`
- `lsp_definition`
- `lsp_declaration`
- `lsp_type_definition`
- `lsp_references`
- `lsp_implementation`
- `lsp_document_highlight`
- `lsp_document_symbol`
- `lsp_workspace_symbol`
- `lsp_folding_range`
- `lsp_signature_help`
- `lsp_incoming_calls`
- `lsp_indirect_callers`
- `lsp_outgoing_calls`
- `lsp_supertypes`
- `lsp_subtypes`
- `lsp_rename`
- `lsp_format`
- `lsp_inlay_hints`
- `lsp_diagnostics`
- `lsp_code_action`
- `lsp_file_status`
- `lsp_index_status`

These tools return readable plain text rather than raw JSON. Many of them also
append readiness hints while background indexing is still in progress.

## Configuration

### CLI options

```text
--root <path>         Workspace root. Defaults to .clangd-mcp.json, then cwd.
--stdio               Direct stdio MCP mode.
--port <number>       Standalone HTTP MCP mode on this port.
--http-daemon         Detached HTTP daemon mode (normally spawned internally).
--http-port <number>  Port for detached HTTP daemon mode.
--clangd <path>       Path to clangd binary. Defaults to "clangd".
--clangd-args <args>  Extra clangd args, comma-separated.
```

### Workspace config file

You can commit a `.clangd-mcp.json` file at the workspace root:

```json
{
  "clangd": "/usr/local/bin/clangd-20",
  "args": [
    "--background-index",
    "--enable-config",
    "--log=error"
  ],
  "enabled": true
}
```

Precedence is:

1. CLI flags
2. `.clangd-mcp.json`
3. built-in defaults

### Example `.clangd` file

You can still use clangd's own `.clangd` configuration in the target workspace:

```yaml
CompileFlags:
  Add:
    - -ferror-limit=0
  Remove:
    - -m*
    - -f*san

Index:
  Background: Build

Diagnostics:
  ClangTidy:
    Add: []
    Remove: ['*']

InlayHints:
  Enabled: Yes
  ParameterNames: Yes
  DeducedTypes: Yes
```

## Architecture at a glance

```text
OpenCode / MCP client
        |
        | stdio MCP or HTTP MCP
        v
intelgraph frontend
        |
        | shared LSP client
        v
bridge socket or direct stdio
        |
        v
clangd
        |
        v
workspace source tree + background index
```

Important detail: the HTTP daemon layer supports multiple MCP sessions, but the
raw bridge layer itself keeps one active TCP socket at a time and relies on
higher-level reconnect logic.

## Persistence model

Per-workspace runtime state is stored under the workspace root:

- `.clangd-mcp-state.json` — saved bridge/HTTP daemon metadata
- `.clangd-mcp-spawn.lock` — coordination file to avoid duplicate daemon spawn

Log files are written to `~/.local/share/clangd-mcp/logs/`:

- `clangd-mcp.log` — main server log (override with `CLANGD_MCP_LOG_DIR`)
- `clangd-mcp-bridge.log` — detached bridge log (written to workspace root)

## Manual operation examples

### Direct stdio debug mode

```bash
bun dist/index.js --stdio --root /path/to/workspace
```

### Standalone HTTP mode

```bash
bun dist/index.js \
  --port 7777 \
  --root /path/to/workspace \
  --clangd /usr/local/bin/clangd-20
```

Then configure OpenCode as a remote MCP server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "clangd": {
      "type": "remote",
      "url": "http://localhost:7777/mcp",
      "enabled": true
    }
  }
}
```

### Keep a server alive with tmux

For large codebases you may still prefer to keep a manually launched server in
`tmux`:

```bash
tmux new-session -d -s intelgraph \
  "bun /path/to/intelgraph/dist/index.js --port 7777 --root /path/to/workspace"
```

## Development

Useful commands:

```bash
bun run build
bun run test
bun run test:unit
bun run test:integration
bun run test:e2e
bun run typecheck
```

The test suite documentation lives in `test/README.md`.

## Troubleshooting

### `compile_commands.json` is missing

Make sure the workspace root contains a compilation database clangd can use.

### `clangd` cannot be found

Pass `--clangd /full/path/to/clangd-20` or add clangd to `PATH`.

### Initial indexing is slow

That is expected on large C/C++ repositories. The point of the detached daemon
mode is to pay that cost once, then reuse the warm index.

### Existing daemon seems stale

Delete the workspace-local `.clangd-mcp-state.json` and restart.

### Need logs

Check:

- `~/.local/share/clangd-mcp/logs/clangd-mcp.log` — main server log
- `<workspace>/clangd-mcp-bridge.log` — detached bridge log
- Set `CLANGD_MCP_LOG_DIR` to override the log directory

## More docs

- `doc/project/data/schema/sqlite-graph-schema.md` — **embedded SQLite intelligence schema** (tables, indexes, edge kinds, the join shape every query uses)
- `doc/project/architecture/extraction-pipeline.md` — **extraction pipeline**: how IExtractor plugins, the FactBus, and the SQLite store fit together
- `doc/atomic/domain/graph-db/philosophy-graph-instrumentation.md` — **core philosophy**: persistent LSP, graph model, intent-driven queries
- `doc/architecture.md` — repo-facing architecture summary
- `doc/WLAN_ANALYSIS_ARCHITECTURE.md` — **WLAN code analysis pipeline + PostgreSQL schema design**
- `doc/diagrams/clangd-mcp-architecture.puml` — PlantUML component diagram (basic runtime)
- `doc/diagrams/clangd-mcp-complete-architecture.puml` — **PlantUML complete architecture (multi-client + PostgreSQL)**
- `doc/components/daemon-manager.md` — daemon lifecycle reference
- `doc/LOG_ANALYSIS.md` — logging subsystem reference

### Render the PlantUML diagrams

If you have PlantUML installed locally:

```bash
# Basic runtime architecture
plantuml doc/diagrams/clangd-mcp-architecture.puml

# Complete architecture with PostgreSQL intelligence store
plantuml doc/diagrams/clangd-mcp-complete-architecture.puml
```

This generates diagram images next to the `.puml` source files.

## License

MIT
