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
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, constants, statSync } from "fs"
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import { log, logError } from "../logger.js"

// ── Root normalisation ────────────────────────────────────────────────────────

/**
 * Normalise a workspace root path.
 *
 * Guards against callers passing a VCS marker directory (e.g. `.git`) instead
 * of the actual project root.  When the path ends with a known marker directory
 * name AND that path is a directory on disk, return its parent.
 *
 * This is the single source of truth for root normalisation inside clangd-mcp.
 * All state file, lock file, and daemon spawn paths go through this function.
 */
export function normaliseRoot(rawRoot: string): string {
  const resolved = path.resolve(rawRoot)
  const name = path.basename(resolved)
  const markerDirs = new Set([".git", ".hg", ".svn"])
  if (markerDirs.has(name)) {
    try {
      const st = statSync(resolved)
      if (st.isDirectory()) {
        log("WARN", "Root points inside a VCS marker dir — using parent", { rawRoot, resolved })
        return path.dirname(resolved)
      }
    } catch {
      // stat failed — leave as-is
    }
  }
  return resolved
}

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
  /** HTTP MCP daemon port (absent = not running) */
  httpPort?: number
  /** PID of the HTTP MCP daemon process (absent = not running) */
  httpPid?: number
}

const STATE_FILE = ".clangd-mcp-state.json"
const STATE_VERSION = 1

export function stateFilePath(root: string): string {
  return path.join(normaliseRoot(root), STATE_FILE)
}

export function readState(root: string): DaemonState | null {
  const fp = stateFilePath(root)
  try {
    const text = readFileSync(fp, "utf8")
    const state = JSON.parse(text) as DaemonState
    if (state.version !== STATE_VERSION) {
      log("WARN", "State file version mismatch — ignoring", {
        got: state.version,
        expected: STATE_VERSION,
        path: fp,
      })
      return null
    }
    log("DEBUG", "State file read", { path: fp, port: state.port, bridgePid: state.bridgePid })
    return state
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log("WARN", "Failed to read state file", { path: fp, error: err?.message })
    }
    return null
  }
}

export function writeState(root: string, state: DaemonState): void {
  const fp = stateFilePath(root)
  writeFileSync(fp, JSON.stringify(state, null, 2), "utf8")
  log("INFO", "State file written", {
    path: fp,
    port: state.port,
    bridgePid: state.bridgePid,
    clangdPid: state.clangdPid,
    httpPort: state.httpPort,
    httpPid: state.httpPid,
  })
}

export function clearState(root: string): void {
  const fp = stateFilePath(root)
  try {
    unlinkSync(fp)
    log("INFO", "Stale state file removed", { path: fp })
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log("WARN", "Failed to remove state file", { path: fp, error: err?.message })
    }
  }
}

// ── Spawn lock file (atomic spawn coordination) ──────────────────────────────

const SPAWN_LOCK_FILE = ".clangd-mcp-spawn.lock"

function spawnLockPath(root: string): string {
  return path.join(normaliseRoot(root), SPAWN_LOCK_FILE)
}

/**
 * Acquire spawn lock using atomic O_CREAT | O_EXCL.
 * Returns true if lock acquired, false if another process holds it.
 */
export function tryAcquireSpawnLock(root: string): boolean {
  const lp = spawnLockPath(root)
  try {
    const fd = openSync(lp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8")
    closeSync(fd)
    log("INFO", "Spawn lock acquired", { path: lp, pid: process.pid })
    return true
  } catch (err: any) {
    if (err.code === "EEXIST") {
      log("INFO", "Spawn lock already held by another process", { path: lp })
      return false
    }
    logError("Failed to acquire spawn lock", err)
    return false
  }
}

/**
 * Release spawn lock.
 */
export function releaseSpawnLock(root: string): void {
  const lp = spawnLockPath(root)
  try {
    unlinkSync(lp)
    log("INFO", "Spawn lock released", { path: lp, pid: process.pid })
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log("WARN", "Failed to release spawn lock", { path: lp, error: err?.message })
    }
  }
}

/**
 * Wait for spawn lock to be released (poll with backoff).
 * Returns true if lock was released within timeout, false otherwise.
 */
export async function waitForSpawnLockRelease(root: string, timeoutMs = 30_000): Promise<boolean> {
  const lp = spawnLockPath(root)
  const deadline = Date.now() + timeoutMs
  let delay = 100
  let polls = 0

  while (Date.now() < deadline) {
    polls++
    try {
      readFileSync(lp, "utf8")
      // Lock file still exists — wait
      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * 1.5, 2000)
    } catch {
      // Lock file gone
      log("INFO", "Spawn lock released by holder", { path: lp, polls, elapsedMs: timeoutMs - (deadline - Date.now()) })
      return true
    }
  }

  log("WARN", "Spawn lock wait timed out", { path: lp, timeoutMs, polls })
  return false
}

// ── Liveness checks ───────────────────────────────────────────────────────────

/** Returns true if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    log("DEBUG", "Process liveness check: alive", { pid })
    return true
  } catch {
    log("DEBUG", "Process liveness check: dead", { pid })
    return false
  }
}

/** Returns true if a TCP server is accepting connections on the given port. */
export function isTcpPortOpen(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
    const timer = setTimeout(() => {
      socket.destroy()
      log("DEBUG", "TCP port check: timeout", { port, timeoutMs })
      resolve(false)
    }, timeoutMs)
    socket.on("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      log("DEBUG", "TCP port check: open", { port })
      resolve(true)
    })
    socket.on("error", (err) => {
      clearTimeout(timer)
      log("DEBUG", "TCP port check: closed", { port, error: (err as any)?.message })
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
    log("WARN", "Daemon root mismatch — respawning", { stateRoot: state.root, expectedRoot })
    return false
  }
  // If bridgePid is 0, the bridge hasn't been spawned yet (HTTP daemon wrote state first).
  // This is OK — we'll spawn the bridge and it will update the state.
  if (state.bridgePid === 0) {
    log("INFO", "Bridge not yet spawned (bridgePid=0) — will spawn now", { httpPort: state.httpPort, httpPid: state.httpPid })
    return false
  }
  if (!isProcessAlive(state.bridgePid)) {
    log("WARN", "Bridge process is not alive", { bridgePid: state.bridgePid })
    return false
  }
  const tcpOpen = await isTcpPortOpen(state.port)
  if (!tcpOpen) {
    log("WARN", "TCP port is not responding", { port: state.port, bridgePid: state.bridgePid })
    return false
  }
  log("INFO", "Daemon liveness check passed", { bridgePid: state.bridgePid, port: state.port })
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
  // Normalise root first — guards against .git being passed as root
  const root = normaliseRoot(opts.root)
  if (root !== opts.root) {
    log("WARN", "spawnDaemon: root normalised", { original: opts.root, normalised: root })
  }

  const port = await findFreePort()

  log("INFO", "Spawning clangd bridge daemon", {
    port,
    bridgeScript: opts.bridgeScript,
    clangdBin: opts.clangdBin,
    clangdArgs: opts.clangdArgs,
    root,
  })

  // Bridge log file alongside the state file
  const bridgeLog = path.join(root, "clangd-mcp-bridge.log")

  const bridgeArgs = [
    opts.bridgeScript,
    "--port", String(port),
    "--root", root,
    "--clangd", opts.clangdBin,
    "--clangd-args", opts.clangdArgs.join(","),
    "--log", bridgeLog,
  ]

  // Spawn bridge as a detached process with stdio ignored so it becomes a
  // true daemon — it will outlive the MCP server process.
  const bridge = spawn(process.execPath, bridgeArgs, {
    detached: true,
    stdio: "ignore",
    cwd: root,
  })

  if (!bridge.pid) {
    throw new Error("Failed to spawn bridge process (no PID assigned)")
  }

  // Detach from the bridge so our process exit doesn't kill it
  bridge.unref()

  log("INFO", "Bridge process spawned (detached)", {
    bridgePid: bridge.pid,
    port,
    bridgeLog,
  })

  // Wait for the bridge to start listening (poll TCP port)
  log("INFO", "Waiting for bridge to start listening…", { port, timeoutMs: 10_000 })
  const ready = await waitForPort(port, 10_000)
  if (!ready) {
    throw new Error(`Bridge did not start listening on port ${port} within 10 seconds`)
  }

  log("INFO", "Bridge is ready and accepting connections", { port, bridgePid: bridge.pid })

  // We don't know clangd's PID from here (it's a grandchild), so we store 0.
  // The bridge writes its own PID to the state file once clangd is up.
  // We read it back after the bridge is ready.
  // IMPORTANT: Also preserve httpPort/httpPid if they exist (HTTP daemon may have written them first).
  const stateAfter = readState(root)
  const clangdPid = stateAfter?.clangdPid ?? 0
  
  log("DEBUG", "spawnDaemon: read existing state before writing", {
    stateAfter,
    httpPortFromState: stateAfter?.httpPort,
    httpPidFromState: stateAfter?.httpPid,
  })

  const state: DaemonState = {
    version: STATE_VERSION,
    bridgePid: bridge.pid,
    clangdPid,
    port,
    root,
    clangdBin: opts.clangdBin,
    clangdArgs: opts.clangdArgs,
    startedAt: new Date().toISOString(),
    // Preserve httpPort and httpPid if they were written by the HTTP daemon
    httpPort: stateAfter?.httpPort,
    httpPid: stateAfter?.httpPid,
  }

  writeState(root, state)
  log("INFO", "Daemon state written", { port, bridgePid: bridge.pid, clangdPid, httpPort: state.httpPort, httpPid: state.httpPid })
  return state
}

/** Polls a TCP port until it accepts connections or the timeout expires. */
export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
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
    return path.join(thisDir, "../bridge/index.ts")
  }
}

// ── HTTP MCP daemon spawn ─────────────────────────────────────────────────────

export interface SpawnHttpDaemonOptions {
  root: string
  clangdBin: string
  clangdArgs: string[]
  /** Path to the compiled bridge script (dist/bridge.js) — index.js is derived from it */
  bridgeScript: string
}

/**
 * Spawns the clangd-mcp HTTP MCP server as a detached daemon.
 * Picks a free port automatically via the OS, writes it to the state file,
 * and returns when the HTTP port is confirmed open (max 15s).
 *
 * Uses a lock file to prevent race conditions when multiple proxies start simultaneously.
 *
 * The daemon runs: index.js --http-daemon --http-port <N> --root <root> ...
 * It is detached and unref'd so it outlives the stdio proxy process.
 */
export async function spawnHttpDaemon(
  opts: SpawnHttpDaemonOptions,
): Promise<{ httpPort: number; httpPid: number }> {
  // Normalise root first — guards against .git being passed as root
  const root = normaliseRoot(opts.root)
  if (root !== opts.root) {
    log("WARN", "spawnHttpDaemon: root normalised", { original: opts.root, normalised: root })
  }

  log("INFO", "spawnHttpDaemon: attempting to acquire spawn lock", { root })

  // Try to acquire spawn lock
  if (!tryAcquireSpawnLock(root)) {
    log("INFO", "Another process is spawning HTTP daemon — waiting for lock release", { root })
    const released = await waitForSpawnLockRelease(root, 30_000)

    if (!released) {
      // Lock holder may have crashed — force-remove stale lock and try again
      log("WARN", "Spawn lock timed out — removing stale lock and retrying", { root })
      releaseSpawnLock(root)

      if (!tryAcquireSpawnLock(root)) {
        throw new Error("Failed to acquire spawn lock after stale lock removal")
      }
    } else {
      // Lock was released — check if daemon is now running
      const state = readState(root)
      if (state?.httpPort && state.httpPid && await isTcpPortOpen(state.httpPort)) {
        log("INFO", "HTTP daemon was spawned by another process — reusing", {
          httpPort: state.httpPort,
          httpPid: state.httpPid,
        })
        return { httpPort: state.httpPort, httpPid: state.httpPid }
      }

      // Daemon not running — acquire lock and spawn
      if (!tryAcquireSpawnLock(root)) {
        throw new Error("Failed to acquire spawn lock after wait")
      }
    }
  }

  try {
    const httpPort = await findFreePort()
    log("INFO", "Allocated free port for HTTP daemon", { httpPort })

    // index.js lives next to bridge.js in dist/
    const indexScript = opts.bridgeScript.replace(/bridge\.(js|ts)$/, (_, ext) =>
      ext === "ts" ? "index.ts" : "index.js",
    )

    const args = [
      indexScript,
      "--http-daemon",
      "--http-port", String(httpPort),
      "--root", root,
      "--clangd", opts.clangdBin,
    ]
    if (opts.clangdArgs.length) {
      args.push("--clangd-args", opts.clangdArgs.join(","))
    }

    log("INFO", "Spawning HTTP MCP daemon process (detached)", {
      httpPort,
      indexScript,
      clangdBin: opts.clangdBin,
      clangdArgs: opts.clangdArgs,
      root,
    })

    const daemon = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      cwd: root,
    })

    if (!daemon.pid) throw new Error("Failed to spawn HTTP MCP daemon (no PID)")
    daemon.unref()

    log("INFO", "HTTP MCP daemon process spawned", { httpPid: daemon.pid, httpPort })

    log("INFO", "Waiting for HTTP daemon to start accepting connections…", { httpPort, timeoutMs: 15_000 })
    const ready = await waitForPort(httpPort, 15_000)
    if (!ready) throw new Error(`HTTP MCP daemon did not start on port ${httpPort} within 15s`)

    log("INFO", "HTTP MCP daemon is ready", { httpPort, httpPid: daemon.pid })
    return { httpPort, httpPid: daemon.pid }
  } finally {
    // Always release lock when done (success or failure)
    releaseSpawnLock(root)
  }
}
