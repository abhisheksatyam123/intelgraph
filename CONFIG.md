# intelgraph Configuration Guide

## Overview

All intelgraph configuration is stored in a single file: **`.intelgraph.json`** at your workspace root. (The legacy filename **`.clangd-mcp.json`** is still read as a fallback so existing workspaces keep working without migration — but new repos should use the new name.)

This file serves as **persistent memory** across sessions, storing:
- Core clangd settings
- Compile commands cleaning configuration
- Daemon state (auto-managed)
- Background index status (auto-managed)
- Session memory (recent files, dismissed warnings, preferences)

## Quick Start

### 1. Create Configuration File

Copy the example to your workspace root:

```bash
cp .intelgraph.example.json /path/to/workspace/.intelgraph.json
```

### 2. Basic Configuration

Minimal `.intelgraph.json`:

```json
{
  "version": "1.0.0",
  "enabled": true,
  "clangd": "/usr/local/bin/clangd-20",
  "compileCommandsCleaning": {
    "enabled": true,
    "cleanFlags": true
  }
}
```

### 3. Full Configuration

See `.intelgraph.example.json` for all available options.

## Configuration Sections

### Core Settings

```json
{
  "enabled": true,
  "clangd": "/usr/local/bin/clangd-20",
  "args": [
    "--background-index",
    "--enable-config",
    "--log=error"
  ]
}
```

- **`enabled`**: Enable/disable intelgraph (default: `true`)
- **`clangd`**: Path to clangd binary (default: `"clangd"` from PATH)
- **`args`**: Extra arguments passed to clangd

### Compile Commands Cleaning

```json
{
  "compileCommandsCleaning": {
    "enabled": true,
    "removeTests": false,
    "cleanFlags": true
  }
}
```

- **`enabled`**: Auto-clean compile_commands.json on startup (default: `true`)
- **`removeTests`**: Remove test/mock/stub files (default: `false`)
- **`cleanFlags`**: Remove problematic flags like `-mduplex` (default: `true`)

**Auto-managed fields** (don't edit manually):
- `lastCleanedHash`: Hash of last cleaned compile_commands.json
- `lastCleanedAt`: Timestamp of last cleaning
- `lastStats`: Statistics from last cleaning

### Daemon State (Auto-managed)

```json
{
  "daemon": {
    "port": 46155,
    "bridgePid": 12345,
    "clangdPid": 12346,
    "httpPort": 40141,
    "httpPid": 12347,
    "startedAt": "2026-03-21T16:16:21.049Z"
  }
}
```

**Do not edit manually** - managed automatically by intelgraph.

### Index State (Auto-managed)

```json
{
  "index": {
    "ready": true,
    "progress": 100,
    "lastCheckedAt": "2026-03-21T16:16:21.049Z"
  }
}
```

**Do not edit manually** - tracks background index status.

### Session Memory

```json
{
  "memory": {
    "recentFiles": [
      "/path/to/file1.c",
      "/path/to/file2.c"
    ],
    "dismissedWarnings": [
      "incomplete-compile-commands",
      "missing-clangd-config"
    ],
    "preferences": {
      "logLevel": "info",
      "autoRestart": true,
      "maxReconnectAttempts": 5
    }
  }
}
```

- **`recentFiles`**: Last 50 accessed files (auto-managed)
- **`dismissedWarnings`**: Warnings that won't show again
- **`preferences`**: User preferences
  - `logLevel`: `"error"` | `"warn"` | `"info"` | `"debug"`
  - `autoRestart`: Auto-restart daemon on crash
  - `maxReconnectAttempts`: Max reconnection attempts

## Use Cases

### 1. ROM/RAM Patching Codebases

For codebases with ROM/RAM patching (like WLAN firmware):

```json
{
  "compileCommandsCleaning": {
    "enabled": true,
    "removeTests": false,
    "cleanFlags": true
  }
}
```

This automatically:
- Maps patch files to ROM source files
- Adds 300+ ROM entries to compile_commands.json
- Removes duplicate entries
- Cleans problematic compiler flags

### 2. Large Codebases with Tests

To reduce noise from test files:

```json
{
  "compileCommandsCleaning": {
    "enabled": true,
    "removeTests": true,
    "cleanFlags": true
  }
}
```

### 3. Custom clangd Binary

For cross-compilation or custom clangd builds:

```json
{
  "clangd": "/usr/local/bin/clangd-20",
  "args": [
    "--background-index",
    "--query-driver=/usr/bin/arm-none-eabi-gcc",
    "--enable-config",
    "--log=error"
  ]
}
```

### 4. Debugging

For verbose logging:

```json
{
  "memory": {
    "preferences": {
      "logLevel": "debug"
    }
  }
}
```

## API Usage

### TypeScript/JavaScript

```typescript
import { readConfig, updateConfig, addRecentFile } from './config/config.js'

// Read config
const config = readConfig('/path/to/workspace')

// Update config
updateConfig('/path/to/workspace', {
  compileCommandsCleaning: {
    enabled: true,
    cleanFlags: true,
  }
})

// Add recent file
addRecentFile('/path/to/workspace', '/path/to/file.c')
```

## Migration from Old Config

If you have legacy files (`.clangd-mcp.json`, `.clangd-mcp-state.json`), they
are read transparently — the daemon prefers the new `.intelgraph.json` /
`.intelgraph-state.json` names but falls back to the legacy ones when present.
You can keep using the old filenames indefinitely; renaming them on disk is
optional.

## Best Practices

1. **Commit to repo**: Add `.intelgraph.json` to your repository so all team members use the same settings
2. **Exclude auto-managed sections**: Add to `.gitignore` if you don't want to commit daemon state:
   ```gitignore
   # Exclude auto-managed sections
   .intelgraph.json
   ```
   Then provide a `.intelgraph.example.json` for team members to copy.

3. **Use notes field**: Document workspace-specific quirks:
   ```json
   {
     "notes": "This workspace requires clangd-20 due to C++23 features"
   }
   ```

4. **Review cleaning stats**: Check `lastStats` to see what was cleaned:
   ```json
   {
     "compileCommandsCleaning": {
       "lastStats": {
         "originalEntries": 4700,
         "romFilesAdded": 359,
         "duplicatesRemoved": 1821,
         "finalEntries": 3238
       }
     }
   }
   ```

## Troubleshooting

### Config not loading

Check logs:
```bash
tail -f ~/.local/share/intelgraph/logs/intelgraph.log | grep "config"
```

### Cleaning not working

Verify config:
```bash
cat /path/to/workspace/.intelgraph.json | jq '.compileCommandsCleaning'
```

Force re-clean by removing hash:
```bash
jq 'del(.compileCommandsCleaning.lastCleanedHash)' .intelgraph.json > tmp.json && mv tmp.json .intelgraph.json
```

### Daemon state stale

Clear daemon state:
```bash
jq 'del(.daemon)' .intelgraph.json > tmp.json && mv tmp.json .intelgraph.json
pkill -f "clangd.*workspace-name"
```

## Schema

JSON Schema available at: `schema.json` (coming soon)

## See Also

- [Compile Commands Cleaning Guide](../scripts/README.md)
- [clangd Configuration](https://clangd.llvm.org/config)
- [MCP Protocol](https://modelcontextprotocol.io/)
