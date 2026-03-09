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
 *     "clangd":  "/usr/bin/clangd-17", // clangd binary  (default: "clangd" from PATH)
 *     "args":    ["--query-driver=…"],  // extra clangd args (default: built-in set)
 *     "enabled": true                  // set false to disable this server (default: true)
 *   }
 *
 * CLI flags (override .clangd-mcp.json):
 *   --root <path>         Workspace root (where compile_commands.json lives).
 *   --stdio               Use stdio transport (default if --port not given).
 *   --port <number>       Use HTTP/StreamableHTTP transport on this port.
 *   --clangd <path>       Path to clangd binary.
 *   --clangd-args <args>  Extra args for clangd, comma-separated.
 *
 * Persistent daemon mode (default):
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
 *     "clangd": "/usr/local/bin/clangd-17",
 *     "args": ["--background-index", "--query-driver=/usr/bin/arm-none-eabi-gcc", "--log=error"]
 *   }
 */

import { readFileSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { LspClient } from "./lsp-client.js"
import { startStdio, startHttp } from "./server.js"
import { initLogger, log, logError, getLogFile } from "./logger.js"
import { IndexTracker } from "./index-tracker.js"
import {
  readState,
  writeState,
  clearState,
  checkDaemonAlive,
  spawnDaemon,
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
    return JSON.parse(text) as WorkspaceConfig
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
  clangdPath: string | undefined
  clangdArgs: string[] | undefined
} {
  const args = argv.slice(2) // strip "node" and script path

  let root = ""
  let stdio = false
  let port: number | undefined
  let clangdPath: string | undefined
  let clangdArgs: string[] | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--stdio") {
      stdio = true
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

  return { root, stdio, port, clangdPath, clangdArgs }
}

function printHelp(): void {
  process.stderr.write(`
clangd-mcp — MCP bridge server for clangd

Configuration is read from .clangd-mcp.json at the working directory.
All CLI flags are optional and override the config file.

Usage:
  clangd-mcp [--stdio | --port <number>] [options]

Options:
  --root <path>         Workspace root (default: value in .clangd-mcp.json, then process.cwd()).
  --stdio               Use stdio transport (default if --port not given).
  --port <number>       Use HTTP/StreamableHTTP transport on this port.
  --clangd <path>       Path to clangd binary (default: "clangd" from PATH).
  --clangd-args <args>  Extra args for clangd, comma-separated.

Persistent daemon:
  On first start, clangd is spawned as a detached background daemon.
  State is saved to <root>/.clangd-mcp-state.json.
  On subsequent starts, the MCP server reconnects to the existing daemon
  without re-indexing — giving instant startup on large codebases.

.clangd-mcp.json (place at project root, all fields optional):
  {
    "root":    "/path/to/project",
    "clangd":  "/usr/local/bin/clangd-17",
    "args":    ["--background-index", "--query-driver=/usr/bin/arm-none-eabi-gcc", "--log=error"],
    "enabled": true
  }

Examples:
  # Zero-config: reads .clangd-mcp.json, falls back to cwd + system clangd
  clangd-mcp

  # Explicit root override
  clangd-mcp --root /workspace/myproject --stdio

  # Multi-session HTTP transport
  clangd-mcp --port 7777
`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cwd = process.cwd()
  const cli = parseArgs(process.argv)
  const ws = {} as any

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
  const stdio = cli.stdio

  // ── Initialize logger FIRST so all subsequent messages go to the log file ──
  initLogger(root)
  log("INFO", `Log file location: ${getLogFile()}`)
  log("INFO", `Transport: ${port !== undefined ? `HTTP port ${port}` : "stdio"}`)
  log("INFO", `clangd binary: ${clangdPath}`)
  if (clangdArgs.length) log("INFO", `clangd extra args: ${clangdArgs.join(" ")}`)

  // ── Global uncaught error handlers ─────────────────────────────────────────
  process.on("uncaughtException", (err) => {
    logError("UNCAUGHT EXCEPTION — server will exit", err)
    process.exit(1)
  })
  process.on("unhandledRejection", (reason) => {
    logError("UNHANDLED PROMISE REJECTION", reason instanceof Error ? reason : new Error(String(reason)))
    // Don't exit — log and continue
  })

  // ── Shared state ────────────────────────────────────────────────────────────
  const tracker = new IndexTracker()
  let currentClient: LspClient | null = null
  let reconnectPromise: Promise<LspClient> | null = null

  const getClient = (): Promise<LspClient> => {
    if (reconnectPromise) return reconnectPromise
    if (currentClient) return Promise.resolve(currentClient)
    return Promise.reject(new Error("clangd client is not initialized"))
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
      log("INFO", `Found existing daemon state: port=${state.port}, bridgePid=${state.bridgePid}`)
      const alive = await checkDaemonAlive(state, root)
      if (alive) {
        log("INFO", `Reusing existing clangd daemon on port ${state.port}`)
        return { port: state.port, isNew: false }
      }
      log("WARN", "Daemon is stale — clearing state and respawning")
      clearState(root)
    } else {
      log("INFO", "No existing daemon state — spawning fresh clangd daemon")
    }

    const bridgeScript = resolveBridgeScript()
    log("INFO", `Bridge script: ${bridgeScript}`)

    const newState: DaemonState = await spawnDaemon({
      root,
      clangdBin: clangdPath,
      clangdArgs,
      bridgeScript,
    })

    log("INFO", `New daemon started on port ${newState.port} (bridge PID ${newState.bridgePid})`)
    return { port: newState.port, isNew: true }
  }

  /**
   * Connect (or reconnect) to the clangd daemon and set currentClient.
   * Handles the case where the TCP connection drops (e.g. bridge restarted).
   */
  async function connectToClangd(): Promise<LspClient> {
    const { port: daemonPort, isNew } = await getOrStartDaemon()

    log("INFO", `Connecting to clangd daemon on port ${daemonPort} (isNew=${isNew})`)
    // skipInit=true when reconnecting to an already-initialized clangd instance
    const client = await LspClient.createFromSocket(daemonPort, root, tracker, !isNew)
    if (!isNew) {
      tracker.markReady()
      log("INFO", "Marked index as ready (reconnected to warm daemon)")
    }
    log("INFO", "Connected to clangd daemon successfully")

    // Watch for connection drops — reconnect automatically
    ;(client as any)._conn.onClose(() => {
      if (currentClient === client) {
        log("WARN", "Connection to clangd daemon dropped — will reconnect on next tool call")
        currentClient = null
        reconnectPromise = new Promise((resolve) => setTimeout(resolve, 2000))
          .then(() => connectToClangd())
          .then((c) => {
            currentClient = c
            reconnectPromise = null
            return c
          })
          .catch((err) => {
            logError("Failed to reconnect to clangd daemon", err)
            reconnectPromise = null
            process.exit(1)
          })
      }
    })

    return client
  }

  // ── Initial connection ──────────────────────────────────────────────────────
  currentClient = await connectToClangd()

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  // NOTE: We do NOT kill clangd or the bridge on shutdown. They are detached
  // daemons that should keep running so the next MCP server start can reuse
  // the warm index. Only the JSON-RPC connection is closed.
  const shutdown = async () => {
    log("INFO", "Received shutdown signal — disconnecting from clangd daemon (daemon stays alive)")
    if (currentClient) {
      try {
        // Send LSP shutdown but don't kill the process
        ;(currentClient as any)._conn.end()
        ;(currentClient as any)._conn.dispose()
      } catch {
        // ignore
      }
    }
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  // ── Start MCP transport ─────────────────────────────────────────────────────
  if (port !== undefined) {
    await startHttp(getClient, tracker, port)
    log("INFO", `HTTP MCP server ready on http://localhost:${port}/mcp`)
  } else {
    // Default: stdio
    await startStdio(getClient, tracker)
    log("INFO", "Stdio MCP server ready")
  }
}

main().catch((err) => {
  logError("Fatal error in main()", err)
  process.exit(1)
})
