# clangd-mcp

A standalone MCP (Model Context Protocol) server that bridges `clangd` to OpenCode agents.

Unlike the built-in LSP tool, this server **owns the clangd process** and keeps it alive across
OpenCode restarts — preserving the background index that can take minutes to build on large C/C++
codebases. Multiple OpenCode sessions can share the same warm clangd instance via the HTTP transport.

---

## Quick Start

### 1. Build the server

```bash
bun install
bun run build   # produces dist/index.js
```

### 2. Configure OpenCode

Add to your `opencode.json`:

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
        "/path/to/clangd-mcp/dist/index.js",
        "--stdio",
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

Replace:
- `/path/to/clangd-mcp/dist/index.js` with the actual path to this built server
- `/path/to/your/workspace` with your project root (where `compile_commands.json` lives)
- `/usr/local/bin/clangd-20` with your clangd binary path (or just `clangd` if it's in PATH)

### 3. Start OpenCode

The clangd-mcp server will start automatically when OpenCode launches.

---

## Tools exposed

| Tool | Description |
|------|-------------|
| `clangd_lsp_hover` | Type info, docs, and signature for a symbol |
| `clangd_lsp_definition` | Jump to definition |
| `clangd_lsp_declaration` | Jump to declaration (header file) |
| `clangd_lsp_type_definition` | Jump to type definition |
| `clangd_lsp_references` | Find all references |
| `clangd_lsp_implementation` | Find virtual/interface implementations |
| `clangd_lsp_document_symbol` | List all symbols in a file |
| `clangd_lsp_workspace_symbol` | Search symbols across the whole workspace |
| `clangd_lsp_incoming_calls` | Who calls this function? |
| `clangd_lsp_outgoing_calls` | What does this function call? |
| `clangd_lsp_supertypes` | Find base types/parent classes |
| `clangd_lsp_subtypes` | Find derived types/child classes |
| `clangd_lsp_diagnostics` | Compiler errors and warnings |
| `clangd_lsp_code_action` | Quick fixes and refactors at a position |
| `clangd_lsp_format` | Format code with clang-format |
| `clangd_lsp_rename` | Preview rename refactoring |
| `clangd_lsp_inlay_hints` | Show inferred types and parameter names |
| `clangd_lsp_index_status` | Current clangd background index status |

All tools append an index-status suffix when the background index is still building, so the agent
knows whether cross-file results (references, callers, etc.) are complete.

---

## Configuration Examples

### Minimal stdio setup (single OpenCode session)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "clangd": {
      "type": "local",
      "command": [
        "bun",
        "/local/mnt/workspace/qprojects/clangd-mcp/dist/index.js",
        "--stdio",
        "--root",
        "/path/to/your/workspace"
      ],
      "enabled": true
    }
  }
}
```

### Full configuration with custom clangd args

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "lsp": "allow"
  },
  "lsp": {
    "clangd": {
      "command": [
        "/usr/local/bin/clangd-20",
        "--background-index",
        "--enable-config",
        "--compile-commands-dir=/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
        "--log=error",
        "--clang-tidy=false"
      ]
    }
  },
  "mcp": {
    "clangd": {
      "type": "local",
      "command": [
        "bun",
        "/local/mnt/workspace/qprojects/clangd-mcp/dist/index.js",
        "--stdio",
        "--root",
        "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
        "--clangd",
        "/usr/local/bin/clangd-20",
        "--clangd-args",
        "--background-index,--enable-config,--compile-commands-dir=/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1,--log=error,--clang-tidy=false,--completion-style=detailed,--header-insertion=never"
      ],
      "enabled": true
    }
  }
}
```

**Key configuration options:**
- `--background-index` — Build index in background for cross-file navigation
- `--enable-config` — Read `.clangd` configuration files
- `--compile-commands-dir` — Path to directory containing `compile_commands.json`
- `--log=error` — Reduce log verbosity
- `--clang-tidy=false` — Disable clang-tidy for faster indexing
- `--completion-style=detailed` — More detailed completions for agents
- `--header-insertion=never` — Don't auto-insert headers

### HTTP mode (persistent clangd, survives OpenCode restarts)

Start the server once in a terminal (or as a systemd/tmux service):

```bash
bun /local/mnt/workspace/qprojects/clangd-mcp/dist/index.js \
  --root /local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1 \
  --port 7777 \
  --clangd /usr/local/bin/clangd-20 \
  --clangd-args="--background-index,--enable-config,--log=error,--clang-tidy=false"
```

Then in `opencode.json`:

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

---

## CLI Options

```
--root <path>         Workspace root (where compile_commands.json lives). Required.
--stdio               Use stdio transport (default if --port not given).
--port <number>       Use HTTP/StreamableHTTP transport on this port.
--clangd <path>       Path to clangd binary (default: "clangd" from PATH).
--clangd-args <args>  Extra args for clangd, comma-separated.
```

---

## Project-specific clangd configuration

Create a `.clangd` file in your workspace root to customize clangd behavior:

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
  UnusedIncludes: None
  
InlayHints:
  Enabled: Yes
  ParameterNames: Yes
  DeducedTypes: Yes
```

---

## Keeping clangd alive with tmux (recommended for large repos)

For large repos where the index takes 5–15 minutes to build, run clangd-mcp
in a persistent tmux session so it survives terminal disconnects:

```bash
tmux new-session -d -s clangd-mcp \
  "bun /local/mnt/workspace/qprojects/clangd-mcp/dist/index.js \
    --root /local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1 \
    --port 7777 \
    --clangd /usr/local/bin/clangd-20 \
    --clangd-args='--background-index,--enable-config,--log=error,--clang-tidy=false'"
```

Check status:
```bash
tmux attach -t clangd-mcp
```

---

## Architecture

```
OpenCode agent
     │  MCP tool calls (JSON-RPC over stdio or HTTP)
     ▼
clangd-mcp (this server)
     │  LSP JSON-RPC over stdio
     ▼
clangd process
     │  reads compile_commands.json, builds background index
     ▼
Source files + index cache (~/.cache/clangd/)
```

---

## Troubleshooting

### Index not building

Check that `compile_commands.json` exists in your workspace root:
```bash
ls -la /path/to/workspace/compile_commands.json
```

### clangd not found

Specify the full path to clangd:
```bash
which clangd-20  # or: which clangd
```

Then use that path in `--clangd` argument.

### Slow indexing

For large codebases, the initial index build can take 5-15 minutes. Use HTTP mode with tmux
to keep the index warm across OpenCode restarts.

### Check clangd logs

Logs are written to:
- `clangd-mcp.log` — MCP server logs
- `clangd-mcp-bridge.log` — clangd process logs

---

## License

MIT
EOFREADME
cat /tmp/readme_new.md
