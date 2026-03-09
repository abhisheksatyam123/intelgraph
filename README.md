# clangd-mcp

A standalone MCP (Model Context Protocol) server that bridges `clangd` to OpenCode agents.

Unlike the built-in LSP tool, this server **owns the clangd process** and keeps it alive across
OpenCode restarts — preserving the background index that can take minutes to build on large C/C++
codebases. Multiple OpenCode sessions can share the same warm clangd instance via the HTTP transport.

---

## Tools exposed

| Tool | Description |
|------|-------------|
| `lsp_hover` | Type info, docs, and signature for a symbol |
| `lsp_definition` | Jump to definition |
| `lsp_references` | Find all references |
| `lsp_implementation` | Find virtual/interface implementations |
| `lsp_document_symbol` | List all symbols in a file |
| `lsp_workspace_symbol` | Search symbols across the whole workspace |
| `lsp_incoming_calls` | Who calls this function? |
| `lsp_outgoing_calls` | What does this function call? |
| `lsp_diagnostics` | Compiler errors and warnings |
| `lsp_code_action` | Quick fixes and refactors at a position |
| `lsp_index_status` | Current clangd background index status |

All tools append an index-status suffix when the background index is still building, so the agent
knows whether cross-file results (references, callers, etc.) are complete.

---

## Building

```bash
cd packages/clangd-mcp
bun install
bun run build   # produces dist/index.js
```

---

## Running

### Single-session stdio (one OpenCode window)

```bash
node /path/to/clangd-mcp/dist/index.js \
  --root /path/to/your/project \
  --stdio
```

### Multi-session HTTP (shared across OpenCode windows)

```bash
node /path/to/clangd-mcp/dist/index.js \
  --root /path/to/your/project \
  --port 7777
```

The server listens at `http://localhost:7777/mcp` using the MCP StreamableHTTP transport.
Each OpenCode session gets its own MCP session but shares the same clangd process and index.

### Cross-compile / embedded projects (e.g. WLAN firmware)

```bash
node /path/to/clangd-mcp/dist/index.js \
  --root /local/mnt/workspace/code/WLAN.HL.3.4.3-00886-QCAHLSWMTPL-2 \
  --port 7777 \
  --clangd /usr/local/bin/clangd \
  --clangd-args="--background-index,--query-driver=/pkg/qct/software/hexagon/releases/tools/8.5.06/Tools/bin/hexagon-clang,--log=error"
```

### All CLI options

```
--root <path>         Workspace root (where compile_commands.json lives). Required.
--stdio               Use stdio transport (default if --port not given).
--port <number>       Use HTTP/StreamableHTTP transport on this port.
--clangd <path>       Path to clangd binary (default: "clangd" from PATH).
--clangd-args <args>  Extra args for clangd, comma-separated.
```

---

## Configuring OpenCode to use clangd-mcp

### 1. Register the MCP server in `opencode.json`

**Option A — stdio (single session, clangd starts/stops with OpenCode):**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "clangd": {
      "type": "local",
      "command": [
        "node",
        "/local/mnt/workspace/opencode/opencode/packages/clangd-mcp/dist/index.js",
        "--root", "/local/mnt/workspace/code/WLAN.HL.3.4.3-00886-QCAHLSWMTPL-2",
        "--stdio",
        "--clangd-args=--background-index,--query-driver=/pkg/qct/software/hexagon/releases/tools/8.5.06/Tools/bin/hexagon-clang,--log=error"
      ]
    }
  }
}
```

**Option B — HTTP (persistent clangd, survives OpenCode restarts):**

Start the server once in a terminal (or as a systemd/tmux service):

```bash
node /local/mnt/workspace/opencode/opencode/packages/clangd-mcp/dist/index.js \
  --root /local/mnt/workspace/code/WLAN.HL.3.4.3-00886-QCAHLSWMTPL-2 \
  --port 7777 \
  --clangd-args="--background-index,--query-driver=/pkg/qct/software/hexagon/releases/tools/8.5.06/Tools/bin/hexagon-clang,--log=error"
```

Then in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "clangd": {
      "type": "remote",
      "url": "http://localhost:7777/mcp"
    }
  }
}
```

### 2. Disable the built-in LSP tool (optional but recommended)

To avoid duplicate results from both the built-in LSP and clangd-mcp:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": false,
  "mcp": {
    "clangd": { ... }
  }
}
```

### 3. Add agent instructions to prefer clangd-mcp over file tools

Create an `AGENTS.md` at the project root (OpenCode reads this automatically):

```markdown
## Code Navigation

This project uses the `clangd` MCP server for all C/C++ code intelligence.

**Prefer these MCP tools over read/grep/glob for C/C++ source files:**

- Use `clangd_lsp_definition` instead of reading files to find where a symbol is defined.
- Use `clangd_lsp_references` instead of grep to find all usages of a function or variable.
- Use `clangd_lsp_hover` to get the type and documentation of any symbol.
- Use `clangd_lsp_incoming_calls` / `clangd_lsp_outgoing_calls` to trace call graphs.
- Use `clangd_lsp_document_symbol` to get a structural outline of a file before reading it.
- Use `clangd_lsp_workspace_symbol` to locate a symbol by name across the entire codebase.
- Use `clangd_lsp_diagnostics` to check for compile errors before and after edits.
- Use `clangd_lsp_index_status` to check if the background index is ready.

**When the index is still building** (shown in tool output as `[Index: building N%]`),
cross-file results like references and callers may be incomplete. Use `lsp_hover` and
`lsp_definition` freely — they work on the current file without needing the full index.

**Only fall back to grep/glob/read** when:
- The file is not a C/C++ source file (e.g. Makefiles, scripts, JSON configs).
- You need to read raw file content for editing purposes.
```

Or add it via `opencode.json` `instructions` field pointing to a separate file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["AGENTS.md"]
}
```

---

## Keeping clangd alive with tmux (recommended for large repos)

For large repos like WLAN firmware where the index takes 5–15 minutes to build, run clangd-mcp
in a persistent tmux session so it survives terminal disconnects:

```bash
tmux new-session -d -s clangd-mcp \
  "node /local/mnt/workspace/opencode/opencode/packages/clangd-mcp/dist/index.js \
    --root /local/mnt/workspace/code/WLAN.HL.3.4.3-00886-QCAHLSWMTPL-2 \
    --port 7777 \
    --clangd-args='--background-index,--query-driver=/pkg/qct/software/hexagon/releases/tools/8.5.06/Tools/bin/hexagon-clang,--log=error'"
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
