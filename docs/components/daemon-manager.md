# Daemon Manager Component Specification

## Overview

The Daemon Manager is responsible for the lifecycle management of the persistent clangd daemon and its TCP bridge. It handles spawning, health checking, state persistence, and cleanup.

## Class Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      DaemonManager                           │
├─────────────────────────────────────────────────────────────┤
│ - stateManager: StateManager                                 │
│ - processManager: ProcessManager                             │
│ - healthChecker: HealthChecker                               │
│ - portAllocator: PortAllocator                               │
│ - logger: Logger                                             │
├─────────────────────────────────────────────────────────────┤
│ + ensureDaemon(config: DaemonConfig): Promise<DaemonInfo>   │
│ + stopDaemon(root: string): Promise<void>                   │
│ + getDaemonStatus(root: string): Promise<DaemonStatus>      │
│ + reconnectToDaemon(state: DaemonState): Promise<Connection>│
└─────────────────────────────────────────────────────────────┘
                            │
                            │ uses
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│StateManager  │   │ProcessManager│   │HealthChecker │
├──────────────┤   ├──────────────┤   ├──────────────┤
│+ readState() │   │+ spawn()     │   │+ checkAlive()│
│+ writeState()│   │+ kill()      │   │+ checkPort() │
│+ clearState()│   │+ isAlive()   │   │+ waitReady() │
└──────────────┘   └──────────────┘   └──────────────┘
```

## Component Responsibilities

### StateManager

**Purpose**: Manage persistent state file (`.clangd-mcp-state.json`)

**Responsibilities**:
- Read state file from disk
- Write state file atomically
- Validate state file schema
- Clear stale state files

**Interface**:
```typescript
class StateManager {
  readState(root: string): DaemonState | null
  writeState(root: string, state: DaemonState): void
  clearState(root: string): void
  stateFilePath(root: string): string
}
```

### ProcessManager

**Purpose**: Spawn and manage daemon processes

**Responsibilities**:
- Spawn bridge daemon as detached process
- Spawn HTTP daemon (if needed)
- Check if process is alive
- Kill processes gracefully
- Handle process exit events

**Interface**:
```typescript
class ProcessManager {
  spawnBridge(config: BridgeConfig): Promise<ChildProcess>
  spawnHttpDaemon(config: HttpDaemonConfig): Promise<ChildProcess>
  isProcessAlive(pid: number): boolean
  killProcess(pid: number, signal?: string): void
  waitForExit(pid: number, timeout: number): Promise<void>
}
```

### HealthChecker

**Purpose**: Verify daemon liveness and readiness

**Responsibilities**:
- Check if bridge process is alive
- Check if TCP port is responding
- Verify clangd is ready
- Wait for daemon to become ready

**Interface**:
```typescript
class HealthChecker {
  checkDaemonAlive(state: DaemonState): Promise<boolean>
  checkTcpPortOpen(port: number, timeout?: number): Promise<boolean>
  waitForDaemonReady(port: number, maxWait: number): Promise<void>
  verifyClangdResponsive(connection: Connection): Promise<boolean>
}
```

### PortAllocator

**Purpose**: Allocate free TCP ports for daemons

**Responsibilities**:
- Find free port using OS assignment
- Validate port availability
- Handle port conflicts

**Interface**:
```typescript
class PortAllocator {
  findFreePort(): Promise<number>
  isPortAvailable(port: number): Promise<boolean>
}
```

## State Machine

```
┌─────────────┐
│   Initial   │
└──────┬──────┘
       │
       │ ensureDaemon()
       ▼
┌─────────────┐
│  Checking   │──────────┐
│   State     │          │
└──────┬──────┘          │
       │                 │ state exists
       │ no state        │
       ▼                 ▼
┌─────────────┐   ┌─────────────┐
│  Spawning   │   │  Verifying  │
│   Daemon    │   │  Liveness   │
└──────┬──────┘   └──────┬──────┘
       │                 │
       │ success         │ alive
       │                 │
       │                 │ stale
       │                 ▼
       │          ┌─────────────┐
       │          │  Cleaning   │
       │          │    Stale    │
       │          └──────┬──────┘
       │                 │
       │                 ▼
       │          ┌─────────────┐
       │          │  Spawning   │
       │          │   Daemon    │
       │          └──────┬──────┘
       │                 │
       └─────────────────┘
                 │
                 ▼
          ┌─────────────┐
          │   Writing   │
          │    State    │
          └──────┬──────┘
                 │
                 ▼
          ┌─────────────┐
          │   Running   │
          └─────────────┘
```

## Sequence Diagrams

### Cold Start (No Existing Daemon)

```
Client          DaemonManager    StateManager    ProcessManager    HealthChecker
  │                  │                │                │                │
  │ ensureDaemon()   │                │                │                │
  ├─────────────────>│                │                │                │
  │                  │ readState()    │                │                │
  │                  ├───────────────>│                │                │
  │                  │ null           │                │                │
  │                  │<───────────────┤                │                │
  │                  │                │                │                │
  │                  │ findFreePort() │                │                │
  │                  ├────────────────┼────────────────┼───────────────>│
  │                  │ port: 36199    │                │                │
  │                  │<───────────────┼────────────────┼────────────────┤
  │                  │                │                │                │
  │                  │ spawnBridge()  │                │                │
  │                  ├────────────────┼───────────────>│                │
  │                  │ bridgePid      │                │                │
  │                  │<───────────────┼────────────────┤                │
  │                  │                │                │                │
  │                  │ checkTcpPortOpen()              │                │
  │                  ├────────────────┼────────────────┼───────────────>│
  │                  │ true           │                │                │
  │                  │<───────────────┼────────────────┼────────────────┤
  │                  │                │                │                │
  │                  │ writeState()   │                │                │
  │                  ├───────────────>│                │                │
  │                  │ ok             │                │                │
  │                  │<───────────────┤                │                │
  │                  │                │                │                │
  │ DaemonInfo       │                │                │                │
  │<─────────────────┤                │                │                │
```

### Warm Start (Existing Daemon Alive)

```
Client          DaemonManager    StateManager    HealthChecker
  │                  │                │                │
  │ ensureDaemon()   │                │                │
  ├─────────────────>│                │                │
  │                  │ readState()    │                │
  │                  ├───────────────>│                │
  │                  │ DaemonState    │                │
  │                  │<───────────────┤                │
  │                  │                │                │
  │                  │ checkDaemonAlive()              │
  │                  ├────────────────┼───────────────>│
  │                  │ true           │                │
  │                  │<───────────────┼────────────────┤
  │                  │                │                │
  │ DaemonInfo       │                │                │
  │<─────────────────┤                │                │
```

### Stale Daemon Recovery

```
Client          DaemonManager    StateManager    ProcessManager    HealthChecker
  │                  │                │                │                │
  │ ensureDaemon()   │                │                │                │
  ├─────────────────>│                │                │                │
  │                  │ readState()    │                │                │
  │                  ├───────────────>│                │                │
  │                  │ DaemonState    │                │                │
  │                  │<───────────────┤                │                │
  │                  │                │                │                │
  │                  │ checkDaemonAlive()              │                │
  │                  ├────────────────┼────────────────┼───────────────>│
  │                  │ false (stale)  │                │                │
  │                  │<───────────────┼────────────────┼────────────────┤
  │                  │                │                │                │
  │                  │ clearState()   │                │                │
  │                  ├───────────────>│                │                │
  │                  │ ok             │                │                │
  │                  │<───────────────┤                │                │
  │                  │                │                │                │
  │                  │ [spawn new daemon - see Cold Start]              │
  │                  │                │                │                │
  │ DaemonInfo       │                │                │                │
  │<─────────────────┤                │                │                │
```

## Data Structures

### DaemonState

```typescript
interface DaemonState {
  version: number              // State file format version (currently 1)
  bridgePid: number           // Bridge process PID
  clangdPid: number           // clangd process PID
  port: number                // TCP port bridge listens on
  root: string                // Workspace root path
  clangdBin: string           // clangd binary path
  clangdArgs: string[]        // clangd arguments
  startedAt: string           // ISO timestamp
  httpPort?: number           // HTTP daemon port (optional)
  httpPid?: number            // HTTP daemon PID (optional)
}
```

### DaemonConfig

```typescript
interface DaemonConfig {
  root: string                // Workspace root
  clangdPath: string          // Path to clangd binary
  clangdArgs: string[]        // Arguments for clangd
  logDir: string              // Log directory
}
```

### DaemonInfo

```typescript
interface DaemonInfo {
  port: number                // TCP port to connect to
  bridgePid: number           // Bridge process PID
  clangdPid: number           // clangd process PID
  isNew: boolean              // True if daemon was just spawned
}
```

### DaemonStatus

```typescript
interface DaemonStatus {
  running: boolean            // Is daemon running?
  bridgeAlive: boolean        // Is bridge process alive?
  clangdAlive: boolean        // Is clangd process alive?
  portOpen: boolean           // Is TCP port responding?
  state: DaemonState | null   // Current state (if available)
}
```

## Error Handling

### Error Types

- `DaemonSpawnError`: Failed to spawn daemon process
- `DaemonConnectionError`: Failed to connect to daemon
- `DaemonStateError`: State file corrupted or invalid
- `PortAllocationError`: Failed to allocate free port

### Recovery Strategies

1. **Stale daemon**: Clear state and respawn
2. **Port conflict**: Allocate new port and respawn
3. **Process crash**: Log error, clear state, respawn on next request
4. **State corruption**: Delete state file, start fresh

## Performance Considerations

### Startup Time

- **Cold start**: 30-60 seconds (clangd indexing)
- **Warm start**: <1 second (reconnect only)
- **Stale recovery**: 30-60 seconds (respawn + indexing)

### Resource Usage

- **Bridge process**: ~10MB RAM
- **State file**: <1KB
- **Health check**: <100ms

### Optimization Strategies

1. **Lazy spawning**: Only spawn daemon when first tool is called
2. **Connection pooling**: Reuse TCP connections
3. **Async health checks**: Don't block on health checks
4. **State caching**: Cache state in memory, refresh periodically

## Testing Strategy

### Unit Tests

- State file read/write/clear
- Process spawn and kill
- Health check logic
- Port allocation

### Integration Tests

- Full daemon lifecycle (spawn → run → stop)
- Stale daemon recovery
- Multiple daemon instances (different workspaces)
- Concurrent health checks

### Edge Cases

- State file deleted while daemon running
- Bridge crashes but clangd still alive
- Port becomes unavailable after allocation
- Workspace root moved/deleted

## Usage Example

```typescript
import { DaemonManager } from "./daemon/daemon-manager.js"

const manager = new DaemonManager({
  logger: getLogger(),
})

// Ensure daemon is running (spawn if needed, reconnect if alive)
const info = await manager.ensureDaemon({
  root: "/workspace/myproject",
  clangdPath: "clangd-20",
  clangdArgs: ["--background-index"],
  logDir: "~/.local/share/clangd-mcp/logs",
})

console.log(`Daemon running on port ${info.port}`)
console.log(`Bridge PID: ${info.bridgePid}, clangd PID: ${info.clangdPid}`)

// Check daemon status
const status = await manager.getDaemonStatus("/workspace/myproject")
console.log(`Daemon running: ${status.running}`)

// Stop daemon
await manager.stopDaemon("/workspace/myproject")
```

## Future Enhancements

1. **Graceful shutdown**: Send shutdown signal to clangd before killing
2. **Daemon pooling**: Support multiple workspaces per daemon
3. **Auto-restart**: Automatically restart crashed daemons
4. **Metrics**: Collect daemon uptime, restart count, etc.
5. **Remote daemons**: Support connecting to remote clangd instances
