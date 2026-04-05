/**
 * bootstrap.ts — Config parsing, CLI args, reconnect constants, and retry logic.
 * Pure config module — no side effects.
 */

import { readFileSync } from "fs"
import path from "path"
import { log } from "../logging/logger.js"

// ── Workspace config (.clangd-mcp.json) ──────────────────────────────────────

export interface WorkspaceConfig {
  root?: string
  clangd?: string
  args?: string[]
  enabled?: boolean
  compileCommandsCleaning?: {
    preflightPolicy?: "reject" | "fix" | "remap"
  }
  intelligenceLocal?: {
    enabled?: boolean
    composeFile?: string
    startScript?: string
    services?: Record<string, unknown>
    env?: {
      INTELLIGENCE_NEO4J_URL?: string
      INTELLIGENCE_NEO4J_USER?: string
      INTELLIGENCE_NEO4J_PASSWORD?: string
      [key: string]: string | undefined
    }
    storage?: Record<string, string>
  }
}

export function readWorkspaceConfig(dir: string): WorkspaceConfig {
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

export function parseArgs(argv: string[]): {
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

export function printHelp(): void {
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

export const RECONNECT_BASE_DELAY_MS = 2_000
export const RECONNECT_MAX_DELAY_MS = 30_000
export const RECONNECT_MAX_ATTEMPTS = 0 // 0 = retry forever
// Minimum delay before scheduling a reconnect after a connection drop.
// This prevents a reconnect storm: when the bridge destroys the old socket
// upon receiving a new connection, the onClose fires on the old client and
// would immediately trigger another connectToClangd — which in turn causes
// the bridge to destroy the current socket, and so on infinitely.
export const RECONNECT_DEBOUNCE_MS = 1_000

export async function retryWithBackoff<T>(
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
