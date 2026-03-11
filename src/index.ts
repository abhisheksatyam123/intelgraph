#!/usr/bin/env node
/**
 * index.ts — Entry point for clangd-mcp.
 *
 * Configuration is read from a workspace-level `.clangd-mcp.json` file located
 * at the working directory (i.e. the project root when launched by OpenCode).
 * CLI flags override the file config; all fields are optional.
 *
 * .clangd-mcp.json schema:
 *   {
 *     "root":    "/path/to/project",   // workspace root (default: process.cwd())
 *     "clangd":  "/usr/bin/clangd-20", // clangd binary  (default: "clangd" from PATH)
 *     "args":    ["--query-driver=…"],  // extra clangd args (default: built-in set)
 *     "enabled": true                  // set false to disable this server (default: true)
 *   }
 *
 * CLI flags (override .clangd-mcp.json):
 *   --root <path>         Workspace root (where compile_commands.json lives).
 *   --stdio               Use stdio transport (single-client debug mode).
 *   --port <number>       Use HTTP/StreamableHTTP transport on this port.
 *   --clangd <path>       Path to clangd binary.
 *   --clangd-args <args>  Extra args for clangd, comma-separated.
 *
 * Default mode (multi-client):
 *   When no transport flag is given, the server defaults to --http-daemon-mode:
 *   a short-lived stdio proxy that ensures a persistent HTTP daemon is running
 *   for this workspace root, then forwards all MCP calls to it. Multiple
 *   OpenCode sessions in the same workspace share one warm clangd instance.
 *
 * Persistent daemon mode:
 *   On first start, clangd is spawned as a detached background daemon via a
 *   TCP bridge process. The bridge PID and port are saved to
 *   <root>/.clangd-mcp-state.json. On subsequent starts the MCP server checks
 *   if the daemon is still alive and reconnects directly — preserving the
 *   clangd background index across OpenCode restarts.
 *
 * Typical opencode.json setup (no CLI flags needed for standard projects):
 *
 *   {
 *     "mcp": {
 *       "clangd": {
 *         "type": "local",
 *         "command": ["node", "/path/to/clangd-mcp/dist/index.js"]
 *       }
 *     }
 *   }
 *
 * OpenCode launches the subprocess with cwd = project root, so the server
 * automatically finds .clangd-mcp.json and uses process.cwd() as the root.
 *
 * For cross-compile / embedded projects, place a .clangd-mcp.json at the
 * project root (commit it to the repo):
 *
 *   {
 *     "clangd": "/usr/local/bin/clangd-20",
 *     "args": ["--background-index", "--query-driver=/usr/bin/arm-none-eabi-gcc", "--log=error"]
 *   }
 */

import { readFileSync } from "fs"
import path from "path"
import { LspClient } from "./lsp-client.js"
import { startStdio, startHttp, startStdioProxy } from "./server.js"
import { initLogger, log, logError, getLogFile } from "./logger.js"
import { IndexTracker } from "./index-tracker.js"
import {
  readState,
  writeState,
  clearState,
  checkDaemonAlive,
  spawnDaemon,
  spawnHttpDaemon,
  isTcpPortOpen,
  resolveBridgeScript,
  type DaemonState,
} from "./daemon.js"

// ── Workspace config (.clangd-mcp.json) ──────────────────────────────────────

interface WorkspaceConfig {
  root?: string
  clangd?: string
  args?: string[]
  enabled?: boolean
}

function readWorkspaceConfig(dir: string): WorkspaceConfig {
  const configPath = path.join(dir, ".clangd-mcp.json")
  try {
    const text = readFileSync(configPath, "utf8")
    const cfg = JSON.parse(text) as WorkspaceConfig
    return cfg
  } catch {
    // File missing or malformed — all fields default
    return {}
  }
}

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  root: string
  stdio: boolean
  port: number | undefined
  httpDaemonMode: boolean
  httpDaemon: boolean
  httpPort: number | undefined
  clangdPath: string | undefined
  clangdArgs: string[] | undefined
} {
  const args = argv.slice(2) // strip "node" and script path

  let root = ""
  let stdio = false
  let port: number | undefined
  let httpDaemonMode = false
  let httpDaemon = false
  let httpPort: number | undefined
  let clangdPath: string | undefined
  let clangdArgs: string[] | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--stdio") {
      stdio = true
    } else if (arg === "--http-daemon-mode") {
      httpDaemonMode = true
    } else if (arg === "--http-daemon") {
      httpDaemon = true
    } else if (arg === "--http-port") {
      httpPort = parseInt(args[++i] ?? "0", 10)
    } else if (arg.startsWith("--http-port=")) {
      httpPort = parseInt(arg.slice("--http-port=".length), 10)
    } else if (arg === "--root" || arg === "-r") {
      root = args[++i] ?? ""
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length)
    } else if (arg === "--port" || arg === "-p") {
      port = parseInt(args[++i] ?? "7777", 10)
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.slice("--port=".length), 10)
    } else if (arg === "--clangd") {
      clangdPath = args[++i]
    } else if (arg.startsWith("--clangd=")) {
      clangdPath = arg.slice("--clangd=".length)
    } else if (arg === "--clangd-args") {
      clangdArgs = (args[++i] ?? "").split(",").filter(Boolean)
    } else if (arg.startsWith("--clangd-args=")) {
      clangdArgs = arg.slice("--clangd-args=".length).split(",").filter(Boolean)
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    }
  }

  return { root, stdio, port, httpDaemonMode, httpDaemon, httpPort, clangdPath, clangdArgs }
}

function printHelp(): void {
  process.stderr.write(`
clangd-mcp — MCP bridge server for clangd

Configuration is read from .clangd-mcp.json at the working directory.
All CLI flags are optional and override the config file.

Usage:
  clangd-mcp [options]

Options:
  --root <path>         Workspace root (default: value in .clangd-mcp.json, then process.cwd()).
  --stdio               Use direct stdio transport (single-client debug mode).
  --port <number>       Use HTTP/StreamableHTTP transport on this port.
  --clangd <path>       Path to clangd binary (default: "clangd" from PATH).
  --clangd-args <args>  Extra args for clangd, comma-separated.

Default (no flags):
  Runs in multi-client mode: a short-lived stdio proxy that ensures a persistent
  HTTP daemon is running for this workspace, then forwards all MCP calls to it.
  Multiple OpenCode sessions in the same workspace share one warm clangd instance.

Persistent daemon:
  On first start, clangd is spawned as a detached background daemon.
  State is saved to <root>/.clangd-mcp-state.json.
  On subsequent starts, the MCP server reconnects to the existing daemon
  without re-indexing — giving instant startup on large codebases.

.clangd-mcp.json (place at project root, all fields optional):
  {
    "root":    "/path/to/project",
    "clangd":  "/usr/local/bin/clangd-20",
    "args":    ["--background-index", "--query-driver=/usr/bin/arm-none-eabi-gcc", "--log=error"],
    "enabled": true
  }

Examples:
  # Zero-config: reads .clangd-mcp.json, defaults to multi-client daemon mode
  clangd-mcp

  # Single-client debug mode (direct stdio, no daemon)
  clangd-mcp --stdio

  # Explicit root override
  clangd-mcp --root /workspace/myproject --stdio

  # Legacy explicit HTTP transport
  clangd-mcp --port 7777
`)
}

// ── Reconnect with exponential backoff ───────────────────────────────────────

const RECONNECT_BASE_DELAY_MS = 2_000
const RECONNECT_MAX_DELAY_MS = 30_000
const RECONNECT_MAX_ATTEMPTS = 0 // 0 = retry forever
// Minimum delay before scheduling a reconnect after a connection drop.
// This prevents a reconnect storm: when the bridge destroys the old socket
// upon receiving a new connection, the onClose fires on the old client and
// would immediately trigger another connectToClangd — which in turn causes
// the bridge to destroy the current socket, and so on infinitely.
const RECONNECT_DEBOUNCE_MS = 1_000

async function retryWithBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = RECONNECT_MAX_ATTEMPTS,
): Promise<T> {
  let attempt = 0
  let delay = RECONNECT_BASE_DELAY_MS
  while (true) {
    attempt++
    try {
      log("INFO", `[reconnect] Attempt ${attempt} for "${label}"`)
      const result = await fn()
      log("INFO", `[reconnect] "${label}" succeeded on attempt ${attempt}`)
      return result
    } catch (err: any) {
      const willRetry = maxAttempts === 0 || attempt < maxAttempts
      log("WARN", `[reconnect] Attempt ${attempt} failed for "${label}": ${err?.message ?? err}`, {
        attempt,
        delay,
        willRetry,
        maxAttempts,
      })
      if (!willRetry) throw err
      log("INFO", `[reconnect] Waiting ${delay}ms before retry…`)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cwd = process.cwd()
  const cli = parseArgs(process.argv)
  const ws = readWorkspaceConfig(cwd)

  // Respect the enabled flag in the workspace config
  if (ws.enabled === false) {
    process.stderr.write("[clangd-mcp] Disabled by workspace config (.clangd-mcp.json)\n")
    process.exit(0)
  }

  // Merge precedence: CLI flag > .clangd-mcp.json > default (cwd / system clangd)
  const root = cli.root || ws.root || cwd
  const clangdPath = cli.clangdPath || ws.clangd || "clangd"
  const clangdArgs = cli.clangdArgs || ws.args || []
  const port = cli.port

  // ── Multi-client sharing by default ──────────────────────────────────────────
  // If no explicit transport mode is given (--stdio / --port / --http-daemon),
  // default to http-daemon-mode: a short-lived stdio proxy that ensures a
  // persistent HTTP daemon is running for this workspace root, then forwards
  // all MCP calls to it. This lets multiple OpenCode sessions share one warm
  // clangd instance without any configuration.
  const httpDaemonMode: boolean =
    !cli.stdio && port === undefined && !cli.httpDaemon
      ? true
      : cli.httpDaemonMode

  // ── Initialize logger FIRST so all subsequent messages go to the log file ──
  initLogger(root)

  const resolvedMode = cli.httpDaemon
    ? `http-daemon (port ${cli.httpPort ?? "auto"})`
    : httpDaemonMode
      ? "stdio-proxy → http-daemon (default multi-client)"
      : port !== undefined
        ? `http (port ${port})`
        : "stdio (single-client debug)"

  log("INFO", "clangd-mcp starting", {
    pid: process.pid,
    cwd,
    root,
    mode: resolvedMode,
    clangdBin: clangdPath,
    clangdArgs,
    logFile: getLogFile(),
    wsConfigFound: Object.keys(ws).length > 0,
    cliFlags: {
      stdio: cli.stdio,
      port: cli.port,
      httpDaemon: cli.httpDaemon,
      httpDaemonMode: cli.httpDaemonMode,
      httpPort: cli.httpPort,
    },
  })

  // ── Global uncaught error handlers ─────────────────────────────────────────
  process.on("uncaughtException", (err) => {
    logError("UNCAUGHT EXCEPTION — server will exit", err)
    process.exit(1)
  })
  process.on("unhandledRejection", (reason) => {
    logError(
      "UNHANDLED PROMISE REJECTION — continuing",
      reason instanceof Error ? reason : new Error(String(reason)),
    )
    // Don't exit — log and continue
  })

  // ── Shared state ────────────────────────────────────────────────────────────
  const tracker = new IndexTracker()
  let currentClient: LspClient | null = null
  let reconnectPromise: Promise<LspClient> | null = null

  const getClient = (): Promise<LspClient> => {
    if (reconnectPromise) {
      log("DEBUG", "getClient: reconnect in progress — waiting for it")
      return reconnectPromise
    }
    if (currentClient) return Promise.resolve(currentClient)
    
    // Lazy initialization: if client is null (HTTP daemon mode), connect now
    log("INFO", "Lazy-initializing clangd client (first tool call in HTTP daemon mode)")
    reconnectPromise = connectToClangd()
      .then((c) => {
        currentClient = c
        reconnectPromise = null
        return c
      })
      .catch((err) => {
        reconnectPromise = null
        throw err
      })
    return reconnectPromise
  }

  // ── Daemon management ───────────────────────────────────────────────────────

  /**
   * Ensure the clangd daemon is running and return the TCP port.
   * - If a valid state file exists and the daemon is alive → reuse it.
   * - Otherwise → spawn a new daemon and write a fresh state file.
   *
   * Returns { port, isNew } where isNew=true means we just spawned clangd
   * (needs initialize handshake) and isNew=false means we're reconnecting
   * to an already-initialized clangd (skip initialize).
   */
  async function getOrStartDaemon(): Promise<{ port: number; isNew: boolean }> {
    const state = readState(root)

    if (state) {
      log("INFO", "Found existing daemon state — checking liveness", {
        port: state.port,
        bridgePid: state.bridgePid,
        clangdPid: state.clangdPid,
        startedAt: state.startedAt,
      })
      const alive = await checkDaemonAlive(state, root)
      if (alive) {
        log("INFO", "Reusing existing clangd daemon", { port: state.port, bridgePid: state.bridgePid })
        return { port: state.port, isNew: false }
      }
      log("WARN", "Daemon is stale — clearing state and respawning", {
        staleBridgePid: state.bridgePid,
        stalePort: state.port,
      })
      clearState(root)
    } else {
      log("INFO", "No existing daemon state — spawning fresh clangd daemon", { root })
    }

    const bridgeScript = resolveBridgeScript()
    log("INFO", "Resolved bridge script", { bridgeScript })

    const newState: DaemonState = await spawnDaemon({
      root,
      clangdBin: clangdPath,
      clangdArgs,
      bridgeScript,
    })

    log("INFO", "New daemon started", {
      port: newState.port,
      bridgePid: newState.bridgePid,
      clangdPid: newState.clangdPid,
      startedAt: newState.startedAt,
    })
    return { port: newState.port, isNew: true }
  }

  /**
   * Connect (or reconnect) to the clangd daemon and set currentClient.
   * Handles the case where the TCP connection drops (e.g. bridge restarted).
   */
  async function connectToClangd(): Promise<LspClient> {
    const { port: daemonPort, isNew } = await getOrStartDaemon()

    log("INFO", "Connecting to clangd daemon via TCP", { daemonPort, isNew, root })
    // skipInit=true when reconnecting to an already-initialized clangd instance
    const client = await LspClient.createFromSocket(daemonPort, root, tracker, !isNew)
    if (!isNew) {
      tracker.markReady()
      log("INFO", "Marked index as ready (reconnected to warm daemon)", { daemonPort })
    } else {
      log("INFO", "LSP initialize handshake sent to fresh daemon", { daemonPort })
    }
    log("INFO", "Connected to clangd daemon successfully", { daemonPort, isNew })

    // Watch for connection drops — reconnect automatically with backoff.
    // IMPORTANT: debounce the reconnect by RECONNECT_DEBOUNCE_MS.
    // Without this, a reconnect storm occurs: the bridge destroys the old
    // socket when a new connection arrives, which fires onClose on the old
    // client, which immediately triggers another connectToClangd, which
    // causes the bridge to destroy the current socket, and so on infinitely.
    ;(client as any)._conn.onClose(() => {
      if (currentClient !== client) return // already superseded by a newer client
      if (reconnectPromise) return         // reconnect already in flight — don't stack
      log("WARN", "Connection to clangd daemon dropped — scheduling reconnect", { daemonPort })
      currentClient = null

      // Debounce: wait before reconnecting so the bridge has time to settle
      reconnectPromise = new Promise<void>((r) => setTimeout(r, RECONNECT_DEBOUNCE_MS))
        .then(() => retryWithBackoff("connectToClangd", connectToClangd))
        .then((c) => {
          log("INFO", "Reconnected to clangd daemon successfully after drop")
          currentClient = c
          reconnectPromise = null
          return c
        })
        .catch((err) => {
          // retryWithBackoff with maxAttempts=0 never rejects, but guard anyway
          logError("Reconnect loop exited unexpectedly — this should not happen", err)
          reconnectPromise = null
          throw err
        })
    })

    return client
  }

  // ── Initial connection ──────────────────────────────────────────────────────
  // Skip in proxy mode — the HTTP daemon owns the clangd connection.
  // In httpDaemonMode the stdio process is just a thin proxy; it must not
  // spawn or connect to clangd itself (that would create a second clangd instance).
  if (!httpDaemonMode && !cli.httpDaemon) {
    log("INFO", "Establishing initial clangd connection (non-proxy mode)", { mode: resolvedMode })
    currentClient = await connectToClangd()
  } else {
    log("INFO", "Skipping direct clangd connection (proxy/daemon mode)", { mode: resolvedMode })
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  // NOTE: We do NOT kill clangd or the bridge on shutdown. They are detached
  // daemons that should keep running so the next MCP server start can reuse
  // the warm index. Only the JSON-RPC connection is closed.
  const shutdown = async (signal: string) => {
    log("INFO", "Shutdown signal received — disconnecting (daemon stays alive)", {
      signal,
      pid: process.pid,
      mode: resolvedMode,
    })
    if (currentClient) {
      try {
        ;(currentClient as any)._conn.end()
        ;(currentClient as any)._conn.dispose()
      } catch {
        // ignore
      }
    }
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  // ── Start MCP transport ─────────────────────────────────────────────────────

  if (cli.httpDaemon) {
    // ── HTTP daemon mode ──────────────────────────────────────────────────────
    // This process was spawned detached by the httpDaemonMode proxy path.
    // Serve MCP over HTTP and stay alive indefinitely (HTTP server holds event loop).
    const httpPort = cli.httpPort ?? 7777
    log("INFO", "Starting HTTP MCP daemon", { httpPort, root, pid: process.pid })
    await startHttp(getClient, tracker, httpPort)
    log("INFO", "HTTP MCP daemon ready", { url: `http://127.0.0.1:${httpPort}/mcp`, httpPort })

  } else if (httpDaemonMode) {
    // ── Stdio proxy mode (default) ────────────────────────────────────────────
    // Short-lived stdio process. Ensures the HTTP daemon is running for this
    // workspace, then proxies all MCP tool calls from stdio → HTTP daemon.
    // The HTTP daemon holds the warm clangd index across OpenCode restarts.
    log("INFO", "Starting stdio proxy mode", { root, pid: process.pid })

    // Check if HTTP daemon is already alive via the state file
    const state = readState(root)
    let httpPort: number | undefined
    let daemonAlive = false

    if (state?.httpPort && state.httpPid) {
      log("INFO", "Checking existing HTTP daemon liveness", {
        httpPort: state.httpPort,
        httpPid: state.httpPid,
      })
      const portOpen = await isTcpPortOpen(state.httpPort)
      if (portOpen) {
        httpPort = state.httpPort
        daemonAlive = true
        log("INFO", "HTTP daemon is alive — reusing", { httpPort, httpPid: state.httpPid })
      } else {
        log("WARN", "HTTP daemon port not responding — will respawn", {
          httpPort: state.httpPort,
          httpPid: state.httpPid,
        })
      }
    } else {
      log("INFO", "No HTTP daemon in state file — will spawn one", { stateExists: !!state })
    }

    if (!daemonAlive) {
      log("INFO", "Spawning HTTP MCP daemon for this workspace", { root })
      const bridgeScript = resolveBridgeScript()
      let spawnResult: { httpPort: number; httpPid: number }
      try {
        spawnResult = await spawnHttpDaemon({
          root,
          clangdBin: clangdPath,
          clangdArgs,
          bridgeScript,
        })
        log("INFO", "HTTP daemon spawned successfully", {
          httpPort: spawnResult.httpPort,
          httpPid: spawnResult.httpPid,
        })
      } catch (err) {
        // Race: another proxy may have spawned the daemon between our check and spawn.
        // Re-read state and try to use whatever port is now open.
        log("WARN", "spawnHttpDaemon threw — checking for race-spawned daemon", {
          error: (err as any)?.message,
        })
        const retryState = readState(root)
        if (retryState?.httpPort && (await isTcpPortOpen(retryState.httpPort))) {
          log("INFO", "Race resolved — another proxy spawned the daemon", {
            httpPort: retryState.httpPort,
            httpPid: retryState.httpPid,
          })
          spawnResult = { httpPort: retryState.httpPort, httpPid: retryState.httpPid ?? 0 }
        } else {
          logError("Failed to spawn or find HTTP daemon", err as Error)
          throw err
        }
      }
      httpPort = spawnResult.httpPort

      // Persist httpPort + httpPid into the state file alongside the bridge state
      const freshState = readState(root)
      if (freshState) {
        writeState(root, { ...freshState, httpPort: spawnResult.httpPort, httpPid: spawnResult.httpPid })
        log("INFO", "Persisted HTTP daemon info to state file", {
          httpPort: spawnResult.httpPort,
          httpPid: spawnResult.httpPid,
        })
      }
    }

    // Brief pause to let the HTTP server finish registering routes after port opens
    await new Promise((r) => setTimeout(r, 200))

    // Proxy stdio MCP → HTTP daemon
    const httpUrl = `http://127.0.0.1:${httpPort}/mcp`
    log("INFO", "Connecting stdio proxy to HTTP daemon", { httpUrl })
    await startStdioProxy(httpUrl)
    log("INFO", "Stdio MCP proxy ready", { httpUrl, pid: process.pid })

  } else if (port !== undefined) {
    // ── Legacy explicit HTTP mode (--port N) ──────────────────────────────────
    log("INFO", "Starting legacy HTTP MCP server", { port, root })
    await startHttp(getClient, tracker, port)
    log("INFO", "HTTP MCP server ready", { url: `http://localhost:${port}/mcp`, port })

  } else {
    // ── Direct stdio mode (--stdio) ───────────────────────────────────────────
    log("INFO", "Starting direct stdio MCP server (single-client debug mode)", { root })
    await startStdio(getClient, tracker)
    log("INFO", "Stdio MCP server ready", { pid: process.pid })
  }
}

main().catch((err) => {
  logError("Fatal error in main()", err)
  process.exit(1)
})
