/**
 * logger.ts — Persistent file logger for clangd-mcp.
 *
 * Writes timestamped log lines to a file so that connection drops and
 * clangd crashes can be diagnosed even when stderr is swallowed by the
 * parent process (e.g. OpenCode).
 *
 * Log file location (in priority order):
 *   1. CLANGD_MCP_LOG env var
 *   2. <workspace-root>/clangd-mcp.log
 *   3. /tmp/clangd-mcp.log  (fallback)
 */

import { appendFileSync, mkdirSync } from "fs"
import path from "path"

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

let _logFile: string = "/tmp/clangd-mcp.log"
let _initialized = false

export function initLogger(workspaceRoot: string): void {
  if (process.env["CLANGD_MCP_LOG"]) {
    _logFile = process.env["CLANGD_MCP_LOG"]
  } else {
    _logFile = path.join(workspaceRoot, "clangd-mcp.log")
  }

  // Ensure the directory exists
  try {
    mkdirSync(path.dirname(_logFile), { recursive: true })
  } catch {
    _logFile = "/tmp/clangd-mcp.log"
  }

  _initialized = true
  log("INFO", "=".repeat(72))
  log("INFO", `clangd-mcp starting — PID ${process.pid}`)
  log("INFO", `Log file: ${_logFile}`)
  log("INFO", `Workspace root: ${workspaceRoot}`)
  log("INFO", `Node version: ${process.version}`)
  log("INFO", `Platform: ${process.platform}`)
}

export function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString()
  const extraStr = extra ? " " + JSON.stringify(extra) : ""
  const line = `${ts} [${level.padEnd(5)}] ${message}${extraStr}\n`

  // Try to write to stderr (captured by parent process if it wants)
  // Wrap in try-catch to handle EPIPE when process is detached
  try {
    process.stderr.write(`[clangd-mcp] ${message}${extraStr}\n`)
  } catch {
    // Ignore EPIPE errors when stderr is closed (detached process)
  }

  // Write to log file if initialized
  if (_initialized) {
    try {
      appendFileSync(_logFile, line)
    } catch {
      // If we can't write to the log file, fall back silently
    }
  }
}

export function logError(message: string, err?: unknown): void {
  const errMsg = err instanceof Error
    ? `${err.message}\n  Stack: ${err.stack ?? "(no stack)"}`
    : String(err ?? "")
  log("ERROR", errMsg ? `${message}: ${errMsg}` : message)
}

export function getLogFile(): string {
  return _logFile
}
