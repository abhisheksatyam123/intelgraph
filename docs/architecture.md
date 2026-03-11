# clangd-mcp Architecture

## Overview

clangd-mcp is a Model Context Protocol (MCP) server that bridges clangd's Language Server Protocol (LSP) capabilities to AI agents. It provides persistent daemon architecture for fast startup and multi-session support.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         OpenCode / AI Agent                      │
└────────────────────────────┬────────────────────────────────────┘
                             │ MCP Protocol
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                      MCP Server (index.ts)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │   Stdio      │  │     HTTP     │  │  HTTP Proxy  │         │
│  │  Transport   │  │  Transport   │  │  Transport   │         │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         │
│         │                  │                  │                  │
│         └──────────────────┴──────────────────┘                  │
│                             │                                     │
│                    ┌────────▼────────┐                           │
│                    │  Tool Registry  │                           │
│                    │  (22 MCP Tools) │                           │
│                    └────────┬────────┘                           │
└─────────────────────────────┼──────────────────────────────────┘
                              │
┌─────────────────────────────▼──────────────────────────────────┐
│                      LSP Client Layer                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              JSON-RPC Connection                          │  │
│  │         (vscode-jsonrpc over TCP/stdio)                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Navigation  │  │   Symbols    │  │    Hover     │         │
│  │  Operations  │  │  Operations  │  │  Operations  │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Hierarchy   │  │  Formatting  │  │ Diagnostics  │         │
│  │  Operations  │  │  Operations  │  │  Operations  │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────┬────────────────────────────────────┘
                              │ TCP Connection
┌─────────────────────────────▼────────────────────────────────────┐
│                      Bridge Daemon (bridge.ts)                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              TCP Server (OS-assigned port)                │   │
│  │         Multiplexes multiple MCP sessions                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                             │ stdio                               │
└─────────────────────────────┼─────────────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────────────┐
│                      clangd Process                                │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              Background Index (persistent)                │    │
│  │         Compilation Database (compile_commands.json)      │    │
│  └──────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

## Component Hierarchy

```
clangd-mcp/
├── Core Layer
│   ├── Entry Point (index.ts)
│   ├── Server Factory
│   └── Client Factory
│
├── Configuration Layer
│   ├── Workspace Config (.clangd-mcp.json)
│   ├── CLI Parser
│   └── Config Resolver
│
├── Daemon Management Layer
│   ├── State Manager (.clangd-mcp-state.json)
│   ├── Process Manager (spawn/kill)
│   ├── Health Checker (liveness)
│   └── Port Allocator (OS-assigned ports)
│
├── Bridge Layer
│   ├── TCP Server
│   ├── Connection Pool
│   └── stdio ↔ TCP Proxy
│
├── LSP Client Layer
│   ├── JSON-RPC Connection
│   ├── File Manager (textDocument/did*)
│   └── Operation Modules
│       ├── Navigation (definition, references, implementation)
│       ├── Symbols (documentSymbol, workspaceSymbol)
│       ├── Hover (hover, signatureHelp)
│       ├── Hierarchy (callHierarchy, typeHierarchy)
│       ├── Formatting (format, inlayHints)
│       └── Diagnostics (publishDiagnostics)
│
├── MCP Tools Layer
│   ├── Tool Registry
│   ├── Schema Definitions (Zod)
│   ├── Tool Handlers
│   └── Output Formatters
│
├── Transport Layer
│   ├── Stdio Transport
│   ├── HTTP Transport (StreamableHTTP)
│   └── Proxy Transport (stdio → HTTP)
│
├── Tracking Layer
│   ├── Index Tracker ($/progress)
│   └── File Tracker (clangd/fileStatus)
│
├── Logging Layer
│   ├── Logger Interface
│   ├── File Appender (with rotation)
│   ├── Console Appender
│   └── Log Formatter
│
└── Error Handling Layer
    ├── Error Types (typed exceptions)
    └── Error Handler (global handler)
```

## Data Flow

### 1. Startup Flow

```
User launches OpenCode
    │
    ▼
OpenCode spawns clangd-mcp (stdio mode)
    │
    ▼
clangd-mcp reads .clangd-mcp.json
    │
    ▼
Check for existing daemon (.clangd-mcp-state.json)
    │
    ├─── Daemon exists & alive ──────┐
    │                                 │
    ├─── Daemon stale/missing ───────┤
    │                                 │
    ▼                                 ▼
Spawn new daemon              Reconnect to existing
(bridge + clangd)             daemon (fast path)
    │                                 │
    ▼                                 ▼
Write state file              Mark index as ready
    │                                 │
    └─────────────┬───────────────────┘
                  │
                  ▼
        MCP server ready
        (tools available)
```

### 2. Tool Call Flow

```
AI Agent calls MCP tool
    │
    ▼
MCP Server receives request
    │
    ▼
Validate input (Zod schema)
    │
    ▼
Route to tool handler
    │
    ▼
Tool handler calls LSP operation
    │
    ▼
LSP Client sends JSON-RPC request
    │
    ▼
TCP connection to bridge
    │
    ▼
Bridge forwards to clangd (stdio)
    │
    ▼
clangd processes request
    │
    ▼
clangd sends JSON-RPC response
    │
    ▼
Bridge forwards response
    │
    ▼
LSP Client receives response
    │
    ▼
Tool handler formats output
    │
    ▼
MCP Server returns formatted text
    │
    ▼
AI Agent receives result
```

### 3. Multi-Session Flow

```
Session 1 (OpenCode)          Session 2 (OpenCode)
    │                              │
    ▼                              ▼
stdio MCP proxy              stdio MCP proxy
    │                              │
    └──────────┬───────────────────┘
               │
               ▼
    HTTP MCP Daemon (persistent)
               │
               ▼
    Shared LSP Client
               │
               ▼
    TCP Bridge (multiplexer)
               │
               ▼
    Single clangd instance
    (shared warm index)
```

## Key Design Patterns

### 1. Persistent Daemon Pattern

**Problem**: clangd takes 30-60 seconds to build background index on large codebases.

**Solution**: Keep clangd alive as a detached daemon across MCP server restarts.

**Implementation**:
- Bridge process spawns clangd and listens on TCP
- State file stores bridge PID, clangd PID, and TCP port
- MCP server checks state file on startup
- If daemon alive, reconnect directly (instant startup)
- If daemon stale, respawn and rebuild index

### 2. TCP Multiplexing Pattern

**Problem**: Multiple OpenCode sessions need to share one clangd instance.

**Solution**: TCP bridge multiplexes connections to single clangd stdio.

**Implementation**:
- Bridge accepts multiple TCP connections
- Each connection gets its own JSON-RPC stream
- Bridge forwards requests to clangd sequentially
- Responses routed back to correct connection

### 3. Layered Architecture Pattern

**Problem**: Monolithic code is hard to maintain and test.

**Solution**: Separate concerns into distinct layers with clear interfaces.

**Implementation**:
- Each layer has single responsibility
- Layers communicate through well-defined interfaces
- Dependencies flow downward (no circular deps)
- Easy to mock and test individual layers

### 4. Factory Pattern

**Problem**: Complex object creation with many dependencies.

**Solution**: Factory functions encapsulate creation logic.

**Implementation**:
- `createMcpServer()` - Creates configured MCP server
- `createLspClient()` - Creates LSP client with connection
- `createDaemon()` - Spawns and configures daemon

### 5. Strategy Pattern

**Problem**: Multiple transport mechanisms (stdio, HTTP, proxy).

**Solution**: Abstract transport behind common interface.

**Implementation**:
- Transport interface: `connect()`, `send()`, `receive()`
- Concrete implementations: StdioTransport, HttpTransport, ProxyTransport
- Server uses transport interface, doesn't know concrete type

## State Management

### State File Schema (.clangd-mcp-state.json)

```typescript
interface DaemonState {
  version: number              // State file format version
  bridgePid: number           // Bridge process PID
  clangdPid: number           // clangd process PID
  port: number                // TCP port bridge listens on
  root: string                // Workspace root path
  clangdBin: string           // clangd binary path
  clangdArgs: string[]        // clangd arguments
  startedAt: string           // ISO timestamp
  httpPort?: number           // HTTP daemon port (if running)
  httpPid?: number            // HTTP daemon PID (if running)
}
```

### State Transitions

```
[No State File]
    │
    ▼
[Spawning] ──error──> [Failed]
    │
    │ success
    ▼
[Running] ──health check──> [Alive]
    │                           │
    │ process exit              │ reconnect
    ▼                           ▼
[Stale] ──cleanup──> [No State File]
```

## Configuration Precedence

```
CLI Arguments (highest priority)
    │
    ▼
.clangd-mcp.json (workspace config)
    │
    ▼
Environment Variables
    │
    ▼
Built-in Defaults (lowest priority)
```

### Example Configuration Merge

```
CLI:        --root /workspace --clangd clangd-20
Config:     { "args": ["--background-index"], "clangd": "clangd-16" }
Defaults:   { "root": process.cwd(), "clangd": "clangd" }

Result:     {
              "root": "/workspace",           // from CLI
              "clangd": "clangd-20",          // from CLI
              "args": ["--background-index"]  // from config
            }
```

## Logging Architecture

### Log Location Hierarchy

1. Custom directory (if specified in config)
2. `CLANGD_MCP_LOG_DIR` environment variable
3. `~/.local/share/clangd-mcp/logs/` (default)
4. `/tmp/clangd-mcp/` (fallback)

### Log Files

- `clangd-mcp.log` - Main server log (with rotation)
- `clangd-mcp-bridge.log` - Bridge daemon log
- `clangd-stderr.log` - clangd's stderr output

### Log Format

```json
{
  "timestamp": "2026-03-11T10:30:45.123Z",
  "level": "INFO",
  "component": "core.server",
  "message": "MCP server started"
}

{
  "timestamp": "2026-03-11T10:30:45.234Z",
  "level": "DEBUG",
  "component": "lsp.client",
  "message": "LSP request: textDocument/definition",
  "context": {
    "direction": "request",
    "method": "textDocument/definition",
    "payload": {
      "textDocument": { "uri": "file:///workspace/main.c" },
      "position": { "line": 41, "character": 10 }
    }
  }
}

{
  "timestamp": "2026-03-11T10:30:45.345Z",
  "level": "ERROR",
  "component": "daemon.manager",
  "message": "Failed to spawn daemon",
  "error": {
    "message": "spawn clangd ENOENT",
    "name": "Error",
    "stack": [
      "Error: spawn clangd ENOENT",
      "    at ChildProcess.spawn (node:internal/child_process:413:11)",
      "    at ..."
    ]
  }
}
```

### Log Rotation

- Rotate when file exceeds 10MB
- Keep last 5 backup files
- Automatic cleanup of old backups

## Error Handling

### Error Type Hierarchy

```
Error (built-in)
    │
    ▼
ClangdMcpError (base)
    │
    ├── ConfigurationError
    ├── DaemonError
    ├── LspError
    ├── TransportError
    ├── ToolError
    └── ValidationError
```

### Error Propagation

```
Low-level error (e.g., ENOENT)
    │
    ▼
Wrap in typed error (e.g., DaemonError)
    │
    ▼
Log with context
    │
    ▼
Return user-friendly message
```

## Performance Considerations

### Startup Time

- **Cold start** (no daemon): 30-60 seconds (clangd indexing)
- **Warm start** (daemon alive): <1 second (reconnect only)

### Memory Usage

- **clangd**: 500MB - 2GB (depends on codebase size)
- **MCP server**: 50-100MB
- **Bridge**: 10-20MB

### Concurrency

- **Single clangd instance**: Handles requests sequentially
- **Multiple MCP sessions**: Share same clangd (no duplication)
- **Background indexing**: Runs in parallel with requests

## Security Considerations

### Process Isolation

- Bridge and clangd run as detached processes
- State file permissions: 0600 (user-only)
- TCP server binds to localhost only

### Input Validation

- All tool inputs validated with Zod schemas
- File paths sanitized and validated
- No shell command injection (spawn with array args)

### Log Security

- Logs may contain file paths and code snippets
- Log directory permissions: 0700 (user-only)
- No sensitive credentials logged

## Extension Points

### Adding New MCP Tools

1. Define Zod schema in `tools/schemas.ts`
2. Implement handler in `tools/handlers/`
3. Add formatter in `tools/formatters/`
4. Register in `tools/registry.ts`

### Adding New LSP Operations

1. Add operation method in `lsp/operations/`
2. Update LSP client interface
3. Add corresponding MCP tool (if needed)

### Custom Transports

1. Implement transport interface
2. Add transport factory
3. Update server factory to support new transport

## Testing Strategy

### Unit Tests

- Configuration parsing and merging
- State file read/write
- Log formatting and rotation
- Error type creation

### Integration Tests

- Daemon spawn and reconnect
- LSP client operations
- Tool handler execution
- Transport layer

### End-to-End Tests

- Full startup flow
- Tool call from AI agent
- Multi-session scenarios
- Daemon recovery

## Deployment

### Installation

```bash
npm install -g @opencode-ai/clangd-mcp
```

### Configuration

Place `.clangd-mcp.json` at project root:

```json
{
  "clangd": "/usr/local/bin/clangd-20",
  "args": ["--background-index", "--log=error"]
}
```

### OpenCode Integration

Add to `opencode.json`:

```json
{
  "mcp": {
    "clangd": {
      "type": "local",
      "command": ["clangd-mcp"]
    }
  }
}
```

## Troubleshooting

### Common Issues

1. **Daemon won't start**: Check clangd binary path and permissions
2. **Slow startup**: Wait for initial indexing (one-time cost)
3. **Stale connections**: Delete `.clangd-mcp-state.json` and restart
4. **Port conflicts**: Use OS-assigned ports (default behavior)

### Debug Mode

```bash
CLANGD_MCP_LOG_LEVEL=DEBUG clangd-mcp --stdio
```

### Health Check

```bash
# Check if daemon is running
ps aux | grep clangd

# Check state file
cat .clangd-mcp-state.json

# Check logs
tail -f ~/.local/share/clangd-mcp/logs/clangd-mcp.log
```

## Future Enhancements

1. **Workspace switching**: Support multiple workspaces per daemon
2. **Remote clangd**: Connect to clangd over network
3. **Plugin system**: Allow custom tool extensions
4. **Metrics**: Collect performance metrics
5. **Web UI**: Dashboard for daemon management

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Language Server Protocol Specification](https://microsoft.github.io/language-server-protocol/)
- [clangd Documentation](https://clangd.llvm.org/)
- [vscode-jsonrpc Documentation](https://github.com/microsoft/vscode-languageserver-node)
