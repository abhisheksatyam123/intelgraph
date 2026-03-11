# Log Analysis Guide

## Log Format

All logs are in JSON format for easy parsing and analysis. Each log entry contains:

```json
{
  "timestamp": "2026-03-11T10:30:45.123Z",
  "level": "DEBUG|INFO|WARN|ERROR",
  "component": "component.subcomponent",
  "message": "Human-readable message",
  "context": { /* Optional structured data */ },
  "error": { /* Optional error details */ }
}
```

## Log Components

### Component Naming Convention

- `core.*` - Core application logic
- `lsp.*` - LSP client operations
- `mcp.*` - MCP server operations
- `bridge.*` - TCP bridge operations
- `daemon.*` - Daemon management
- `config.*` - Configuration handling
- `transport.*` - Transport layer

## Common Analysis Tasks

### 1. Debugging LSP Communication

**View all LSP requests:**
```bash
jq 'select(.context.direction == "request")' clangd-mcp.log
```

**View all LSP responses:**
```bash
jq 'select(.context.direction == "response")' clangd-mcp.log
```

**Find slow LSP operations (>1 second):**
```bash
# First, extract request/response pairs with timestamps
jq -s 'group_by(.context.method) | map({
  method: .[0].context.method,
  count: length,
  avg_time: (map(.timestamp) | length)
})' clangd-mcp.log
```

**View specific LSP method:**
```bash
jq 'select(.context.method == "textDocument/definition")' clangd-mcp.log
```

**View LSP errors:**
```bash
jq 'select(.component | startswith("lsp")) | select(.level == "ERROR")' clangd-mcp.log
```

### 2. Debugging MCP Tool Calls

**View all MCP tool calls:**
```bash
jq 'select(.context.phase == "call")' clangd-mcp.log
```

**View tool results:**
```bash
jq 'select(.context.phase == "result")' clangd-mcp.log
```

**View tool errors:**
```bash
jq 'select(.context.phase == "error")' clangd-mcp.log
```

**Find most-used tools:**
```bash
jq -s 'map(select(.context.tool != null)) | group_by(.context.tool) | map({
  tool: .[0].context.tool,
  count: length
}) | sort_by(.count) | reverse' clangd-mcp.log
```

**View specific tool execution:**
```bash
jq 'select(.context.tool == "clangd_lsp_definition")' clangd-mcp.log
```

### 3. Debugging Bridge Communication

**View connection events:**
```bash
jq 'select(.component == "bridge") | select(.context.event | contains("connection"))' clangd-mcp.log
```

**View message forwarding:**
```bash
jq 'select(.context.event == "message_forwarded")' clangd-mcp.log
```

**Count active connections:**
```bash
jq -s 'map(select(.context.event == "connection_accepted")) | length' clangd-mcp.log
```

### 4. Error Analysis

**View all errors:**
```bash
jq 'select(.level == "ERROR")' clangd-mcp.log
```

**Group errors by component:**
```bash
jq -s 'map(select(.level == "ERROR")) | group_by(.component) | map({
  component: .[0].component,
  count: length,
  errors: map(.message)
})' clangd-mcp.log
```

**View errors with stack traces:**
```bash
jq 'select(.error != null)' clangd-mcp.log
```

**Find most common error messages:**
```bash
jq -s 'map(select(.level == "ERROR")) | group_by(.message) | map({
  message: .[0].message,
  count: length
}) | sort_by(.count) | reverse' clangd-mcp.log
```

### 5. Performance Analysis

**View all operations with timing:**
```bash
jq 'select(.context.duration_ms != null)' clangd-mcp.log
```

**Find slowest operations:**
```bash
jq -s 'map(select(.context.duration_ms != null)) | sort_by(.context.duration_ms) | reverse | .[0:10]' clangd-mcp.log
```

**Average operation time by component:**
```bash
jq -s 'map(select(.context.duration_ms != null)) | group_by(.component) | map({
  component: .[0].component,
  avg_ms: (map(.context.duration_ms) | add / length),
  count: length
})' clangd-mcp.log
```

### 6. Session Analysis

**View session lifecycle:**
```bash
jq 'select(.message | contains("session"))' clangd-mcp.log
```

**Count sessions:**
```bash
jq -s 'map(select(.message | contains("session initialized"))) | length' clangd-mcp.log
```

**View session duration:**
```bash
jq -s 'map(select(.message | contains("session"))) | group_by(.context.sessionId) | map({
  sessionId: .[0].context.sessionId,
  start: .[0].timestamp,
  end: .[-1].timestamp
})' clangd-mcp.log
```

## Real-Time Monitoring

### Watch for errors:
```bash
tail -f clangd-mcp.log | jq 'select(.level == "ERROR")'
```

### Watch LSP traffic:
```bash
tail -f clangd-mcp.log | jq 'select(.component | startswith("lsp"))'
```

### Watch MCP tool calls:
```bash
tail -f clangd-mcp.log | jq 'select(.context.tool != null)'
```

### Watch specific component:
```bash
tail -f clangd-mcp.log | jq 'select(.component == "daemon.manager")'
```

## Log Rotation

Logs are automatically rotated when they reach 10MB. Backup files are named:
- `clangd-mcp.log` - Current log
- `clangd-mcp.log.1` - Most recent backup
- `clangd-mcp.log.2` - Second most recent
- ... up to `clangd-mcp.log.5`

### Analyze all logs (including backups):
```bash
cat clangd-mcp.log* | jq 'select(.level == "ERROR")'
```

### Merge and sort all logs by timestamp:
```bash
cat clangd-mcp.log* | jq -s 'sort_by(.timestamp)' > merged.json
```

## Debugging Workflows

### Workflow 1: Tool Call Not Working

1. **Find the tool call:**
   ```bash
   jq 'select(.context.tool == "clangd_lsp_definition")' clangd-mcp.log
   ```

2. **Check for errors:**
   ```bash
   jq 'select(.context.tool == "clangd_lsp_definition") | select(.level == "ERROR")' clangd-mcp.log
   ```

3. **View LSP request/response:**
   ```bash
   jq 'select(.context.method == "textDocument/definition")' clangd-mcp.log
   ```

4. **Check clangd errors:**
   ```bash
   jq 'select(.component == "lsp.client") | select(.level == "ERROR")' clangd-mcp.log
   ```

### Workflow 2: Daemon Not Starting

1. **Check daemon spawn:**
   ```bash
   jq 'select(.component == "daemon.manager") | select(.message | contains("spawn"))' clangd-mcp.log
   ```

2. **Check for errors:**
   ```bash
   jq 'select(.component == "daemon.manager") | select(.level == "ERROR")' clangd-mcp.log
   ```

3. **Check state file operations:**
   ```bash
   jq 'select(.message | contains("state"))' clangd-mcp.log
   ```

### Workflow 3: Slow Performance

1. **Find slow operations:**
   ```bash
   jq 'select(.context.duration_ms > 1000)' clangd-mcp.log
   ```

2. **Group by operation type:**
   ```bash
   jq -s 'map(select(.context.duration_ms != null)) | group_by(.context.method // .context.tool) | map({
     operation: .[0].context.method // .[0].context.tool,
     avg_ms: (map(.context.duration_ms) | add / length),
     max_ms: (map(.context.duration_ms) | max),
     count: length
   }) | sort_by(.avg_ms) | reverse' clangd-mcp.log
   ```

3. **Check index status:**
   ```bash
   jq 'select(.message | contains("index"))' clangd-mcp.log
   ```

## Log Cleanup

### Remove old logs:
```bash
rm ~/.local/share/clangd-mcp/logs/clangd-mcp.log.[3-5]
```

### Archive logs:
```bash
tar -czf logs-$(date +%Y%m%d).tar.gz ~/.local/share/clangd-mcp/logs/
```

### Clear all logs:
```bash
rm ~/.local/share/clangd-mcp/logs/clangd-mcp.log*
```

## Tips

1. **Use jq for all analysis** - It's designed for JSON and much faster than grep
2. **Pretty-print for readability** - Add `| jq '.'` to any command
3. **Save complex queries** - Create shell aliases for common queries
4. **Monitor in real-time** - Use `tail -f` with jq filters
5. **Aggregate data** - Use `jq -s` to load entire file and aggregate
6. **Export to CSV** - Use `jq -r '@csv'` for spreadsheet analysis

## Example Aliases

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
# View clangd-mcp logs
alias cmlogs='tail -f ~/.local/share/clangd-mcp/logs/clangd-mcp.log | jq "."'

# View errors only
alias cmerrors='tail -f ~/.local/share/clangd-mcp/logs/clangd-mcp.log | jq "select(.level == \"ERROR\")"'

# View LSP traffic
alias cmlsp='tail -f ~/.local/share/clangd-mcp/logs/clangd-mcp.log | jq "select(.component | startswith(\"lsp\"))"'

# View MCP tools
alias cmmcp='tail -f ~/.local/share/clangd-mcp/logs/clangd-mcp.log | jq "select(.context.tool != null)"'

# Pretty-print log file
alias cmcat='jq "." ~/.local/share/clangd-mcp/logs/clangd-mcp.log'
```
