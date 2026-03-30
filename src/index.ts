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

import { LspClient } from "./lsp/index.js"
import { startHttp, startStdio } from "./core/server.js"
import { initLogger, log, logError, getLogFile } from "./logging/logger.js"
import { initIntelligenceBackend } from "./intelligence/init.js"
import { IndexTracker } from "./tracking/index.js"
import {
  normaliseRoot,
  computeWorkspaceId,
} from "./daemon/index.js"
import {
  parseArgs,
  readWorkspaceConfig,
  retryWithBackoff,
} from "./config/bootstrap.js"
import {
  connectToClangd,
  makeGetClient,
  startAsHttpDaemon,
  startAsStdioProxy,
  type LifecycleConfig,
} from "./core/lifecycle.js"
import { createUnifiedBackend } from "./backend/unified-backend.js"
import type { BackendDeps } from "./core/types.js"

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
  // normaliseRoot strips VCS marker dirs (.git etc.) so state files always land
  // in the real project root, not inside .git/.
  const root = normaliseRoot(cli.root || ws.root || cwd)
  const workspaceId = computeWorkspaceId(root)
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
  initLogger({ component: "clangd-mcp" })

  // ── Intelligence backend auto-init (no-op when env vars not set) ────────────
  initIntelligenceBackend().catch((err) =>
    log("WARN", "intelligence backend init failed — continuing without it", { err: String(err) }),
  )

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
    workspaceId,
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
  const lifecycleConfig: LifecycleConfig = {
    root,
    workspaceId,
    clangdPath,
    clangdArgs,
    wsCompileCommandsPolicy: ws.compileCommandsCleaning?.preflightPolicy,
  }

  let currentClient: LspClient | null = null
  let reconnectPromise: Promise<LspClient> | null = null

  const getClient = makeGetClient(
    () => ({ currentClient, reconnectPromise }),
    () => connectToClangd(
      lifecycleConfig,
      tracker,
      (newClient) => {
        currentClient = newClient
        reconnectPromise = null
      },
      retryWithBackoff,
    ),
    (patch) => {
      if ("currentClient" in patch) currentClient = patch.currentClient ?? null
      if ("reconnectPromise" in patch) reconnectPromise = patch.reconnectPromise ?? null
    },
  )

  // ── Initial connection ──────────────────────────────────────────────────────
  // Skip in proxy mode — the HTTP daemon owns the clangd connection.
  // In httpDaemonMode the stdio process is just a thin proxy; it must not
  // spawn or connect to clangd itself (that would create a second clangd instance).
  if (!httpDaemonMode && !cli.httpDaemon) {
    log("INFO", "Establishing initial clangd connection (non-proxy mode)", { mode: resolvedMode })
    currentClient = await connectToClangd(
      lifecycleConfig,
      tracker,
      (newClient) => {
        currentClient = newClient
        reconnectPromise = null
      },
      retryWithBackoff,
    )
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
    await startAsHttpDaemon(
      getClient, tracker, cli.httpPort ?? 7777,
      root, workspaceId, clangdPath, clangdArgs,
    )

  } else if (httpDaemonMode) {
    // ── Stdio proxy mode (default) ────────────────────────────────────────────
    // Short-lived stdio process. Ensures the HTTP daemon is running for this
    // workspace, then proxies all MCP tool calls from stdio → HTTP daemon.
    await startAsStdioProxy(root, workspaceId, clangdPath, clangdArgs)

  } else if (port !== undefined) {
    // ── Legacy explicit HTTP mode (--port N) ──────────────────────────────────
    log("INFO", "Starting legacy HTTP MCP server", { port, root })
    const backend = createUnifiedBackend(getClient, tracker)
    const deps: BackendDeps = { getClient, tracker, backend }
    await startHttp(deps, port)
    log("INFO", "HTTP MCP server ready", { url: `http://localhost:${port}/mcp`, port })

  } else {
    // ── Direct stdio mode (--stdio) ───────────────────────────────────────────
    log("INFO", "Starting direct stdio MCP server (single-client debug mode)", { root })
    const backend = createUnifiedBackend(getClient, tracker)
    const deps: BackendDeps = { getClient, tracker, backend }
    await startStdio(deps)
    log("INFO", "Stdio MCP server ready", { pid: process.pid })
  }
}

main().catch((err) => {
  logError("Fatal error in main()", err)
  process.exit(1)
})
