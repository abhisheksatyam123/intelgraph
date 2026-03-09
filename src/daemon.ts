/**
 * daemon.ts — Persistent clangd daemon management.
 *
 * Clangd is kept alive as a detached background process across MCP server
 * restarts. A lightweight TCP bridge (bridge.ts) proxies clangd's stdio to a
 * TCP port so the MCP server can reconnect without re-spawning clangd.
 *
 * State file: <root>/.clangd-mcp-state.json
 *   Stores the bridge PID, clangd PID, and TCP port so the next MCP server
 *   start can verify the daemon is still alive and reconnect directly.
 *
 * Lifecycle:
 *   First start  → no state file → spawn bridge+clangd → write state → connect
 *   Later starts → read state → PID alive? TCP open? → connect (fast path)
 *                             → stale?               → respawn
 */

import { createServer, createConnection } from "net"
import { readFileSync, writeFileSync, unlinkSync } from "fs"
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import { log, logError } from "./logger.js"

// ── State file schema ─────────────────────────────────────────────────────────

export interface DaemonState {
  version: number
  /** PID of the bridge process (the one that owns the TCP server) */
  bridgePid: number
  /** PID of the clangd process (child of the bridge) */
  clangdPid: number
  /** TCP port the bridge is listening on */
  port: number
  /** Absolute path to the workspace root */
  root: string
  /** clangd binary path used */
  clangdBin: string
  /** clangd args used */
  clangdArgs: string[]
  /** ISO timestamp of when the daemon was started */
  startedAt: string
}

const STATE_FILE = ".clangd-mcp-state.json"
const STATE_VERSION = 1

export function stateFilePath(root: string): string {
  return path.join(root, STATE_FILE)
}

export function readState(root: string): DaemonState | null {
  try {
    const text = readFileSync(stateFilePath(root), "utf8")
    const state = JSON.parse(text) as DaemonState
    if (state.version !== STATE_VERSION) {
      log("WARN", `State file version mismatch (got ${state.version}, expected ${STATE_VERSION}) — ignoring`)
      return null
    }
    return state
  } catch {
    return null
  }
}

export function writeState(root: string, state: DaemonState): void {
  writeFileSync(stateFilePath(root), JSON.stringify(state, null, 2), "utf8")
  log("INFO", `State file written: ${stateFilePath(root)}`)
}

export function clearState(root: string): void {
  try {
    unlinkSync(stateFilePath(root))
    log("INFO", "Stale state file removed")
  } catch {
    // already gone
  }
}

// ── Liveness checks ───────────────────────────────────────────────────────────

/** Returns true if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Returns true if a TCP server is accepting connections on the given port. */
export function isTcpPortOpen(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.on("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * Full liveness check: root matches, bridge PID alive, AND TCP port responding.
 * Returns true only if all three checks pass.
 */
export async function checkDaemonAlive(state: DaemonState, expectedRoot?: string): Promise<boolean> {
  if (expectedRoot && state.root !== expectedRoot) {
    log("WARN", `Daemon root mismatch (state=${state.root}, expected=${expectedRoot}) — respawning`)
    return false
  }
  if (!isProcessAlive(state.bridgePid)) {
    log("WARN", `Bridge process PID ${state.bridgePid} is not alive`)
    return false
  }
  const tcpOpen = await isTcpPortOpen(state.port)
  if (!tcpOpen) {
    log("WARN", `TCP port ${state.port} is not responding`)
    return false
  }
  log("INFO", `Daemon alive: bridge PID ${state.bridgePid}, port ${state.port}`)
  return true
}

// ── Free port allocation ──────────────────────────────────────────────────────

/** Binds to port 0 to get an OS-assigned free port, then releases it. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close()
        return reject(new Error("Could not determine free port"))
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })
}

// ── Daemon spawn ──────────────────────────────────────────────────────────────

export interface SpawnDaemonOptions {
  root: string
  clangdBin: string
  clangdArgs: string[]
  /** Path to the compiled bridge script (dist/bridge.js) */
  bridgeScript: string
}

/**
 * Spawns the clangd TCP bridge as a detached process and writes the state file.
 * Returns the TCP port the bridge is listening on.
 *
 * The bridge process is detached and unref'd so it outlives the MCP server.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonState> {
  const port = await findFreePort()

  log("INFO", `Spawning clangd daemon on port ${port}`)
  log("INFO", `Bridge script: ${opts.bridgeScript}`)
  log("INFO", `clangd: ${opts.clangdBin} ${opts.clangdArgs.join(" ")}`)

  // Bridge log file alongside the state file
  const bridgeLog = path.join(opts.root, "clangd-mcp-bridge.log")

  const bridgeArgs = [
    opts.bridgeScript,
    "--port", String(port),
    "--root", opts.root,
    "--clangd", opts.clangdBin,
    "--clangd-args", opts.clangdArgs.join(","),
    "--log", bridgeLog,
  ]

  // Spawn bridge as a detached process with stdio ignored so it becomes a
  // true daemon — it will outlive the MCP server process.
  const bridge = spawn(process.execPath, bridgeArgs, {
    detached: true,
    stdio: "ignore",
    cwd: opts.root,
  })

  if (!bridge.pid) {
    throw new Error("Failed to spawn bridge process (no PID assigned)")
  }

  // Detach from the bridge so our process exit doesn't kill it
  bridge.unref()

  log("INFO", `Bridge spawned with PID ${bridge.pid}`)

  // Wait for the bridge to start listening (poll TCP port)
  const ready = await waitForPort(port, 10_000)
  if (!ready) {
    throw new Error(`Bridge did not start listening on port ${port} within 10 seconds`)
  }

  log("INFO", `Bridge is ready on port ${port}`)

  // We don't know clangd's PID from here (it's a grandchild), so we store 0.
  // The bridge writes its own PID to the state file once clangd is up.
  // We read it back after the bridge is ready.
  const stateAfter = readState(opts.root)
  const clangdPid = stateAfter?.clangdPid ?? 0

  const state: DaemonState = {
    version: STATE_VERSION,
    bridgePid: bridge.pid,
    clangdPid,
    port,
    root: opts.root,
    clangdBin: opts.clangdBin,
    clangdArgs: opts.clangdArgs,
    startedAt: new Date().toISOString(),
  }

  writeState(opts.root, state)
  return state
}

/** Polls a TCP port until it accepts connections or the timeout expires. */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const open = await isTcpPortOpen(port, 500)
    if (open) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** Resolve the path to the bridge script relative to this file's location. */
export function resolveBridgeScript(): string {
  // In production (dist/): bridge.js is next to index.js
  // In development (src/): bridge.ts is next to index.ts — Bun runs it directly
  const thisFile = fileURLToPath(import.meta.url)
  const thisDir = path.dirname(thisFile)

  // Try dist/bridge.js first (production build)
  const distBridge = path.join(thisDir, "bridge.js")
  try {
    readFileSync(distBridge)
    return distBridge
  } catch {
    // Fall back to src/bridge.ts (dev mode with Bun)
    return path.join(thisDir, "bridge.ts")
  }
}
