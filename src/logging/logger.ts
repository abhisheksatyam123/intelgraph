/**
 * logger.ts — Main logger interface with multiple appenders
 */

import { existsSync } from "fs"
import { homedir } from "os"
import path from "path"
import { LogLevel, LogLevelName, parseLogLevel, shouldLog } from "./log-levels.js"
import { LogEntry } from "./log-formatter.js"
import { FileLogger } from "./file-logger.js"
import { ConsoleLogger } from "./console-logger.js"

export { LogLevel } from "./log-levels.js"
export type { LogLevelName } from "./log-levels.js"

export interface LoggerOptions {
  component: string
  logDir?: string
  logLevel?: LogLevel
  enableConsole?: boolean
  enableFile?: boolean
}

export class Logger {
  private component: string
  private logLevel: LogLevel
  private fileLogger: FileLogger | null = null
  private consoleLogger: ConsoleLogger | null = null

  constructor(options: LoggerOptions) {
    this.component = options.component
    this.logLevel = options.logLevel ?? LogLevel.INFO

    // Setup file logger
    if (options.enableFile !== false) {
      const logDir = this.resolveLogDir(options.logDir)
      const logFile = path.join(logDir, "clangd-mcp.log")
      this.fileLogger = new FileLogger({ filePath: logFile })
    }

    // Setup console logger
    if (options.enableConsole !== false) {
      this.consoleLogger = new ConsoleLogger()
    }
  }

  private resolveLogDir(customDir?: string): string {
    // Priority: custom > INTELGRAPH_LOG_DIR > legacy CLANGD_MCP_LOG_DIR
    //   > ~/.local/share/intelgraph/logs (or legacy clangd-mcp dir if it
    //     already exists) > /tmp/intelgraph
    if (customDir) {
      return customDir
    }

    // New env var name takes priority
    if (process.env["INTELGRAPH_LOG_DIR"]) {
      return process.env["INTELGRAPH_LOG_DIR"]
    }
    // Legacy env var still works
    if (process.env["CLANGD_MCP_LOG_DIR"]) {
      return process.env["CLANGD_MCP_LOG_DIR"]
    }

    try {
      const home = homedir()
      // Prefer the new ~/.local/share/intelgraph/logs path. Fall back to
      // the legacy clangd-mcp directory if it already exists on disk so
      // upgraded users keep writing to their existing log location.
      const newDir = path.join(home, ".local", "share", "intelgraph", "logs")
      const legacyDir = path.join(home, ".local", "share", "clangd-mcp", "logs")
      if (existsSync(legacyDir) && !existsSync(newDir)) {
        return legacyDir
      }
      return newDir
    } catch {
      return "/tmp/intelgraph"
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context)
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context)
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context)
  }

  error(message: string, errorOrContext?: Error | Record<string, unknown>): void {
    if (errorOrContext instanceof Error) {
      this.log(LogLevel.ERROR, message, undefined, errorOrContext)
    } else {
      this.log(LogLevel.ERROR, message, errorOrContext)
    }
  }

  /**
   * Log LSP request/response (always includes full payload for debugging)
   */
  lsp(direction: "request" | "response", method: string, payload: unknown): void {
    this.log(LogLevel.DEBUG, `LSP ${direction}: ${method}`, {
      direction,
      method,
      payload,
    })
  }

  /**
   * Log MCP tool call (always includes full args and result for debugging)
   */
  mcp(phase: "call" | "result" | "error", toolName: string, data: unknown): void {
    this.log(LogLevel.DEBUG, `MCP ${phase}: ${toolName}`, {
      phase,
      tool: toolName,
      data,
    })
  }

  /**
   * Log Bridge communication (connection events, forwarding)
   */
  bridge(event: string, details: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, `Bridge: ${event}`, {
      event,
      ...details,
    })
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error,
  ): void {
    if (!shouldLog(level, this.logLevel)) {
      return
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      component: this.component,
      message,
      context,
      error,
    }

    if (this.fileLogger) {
      this.fileLogger.write(entry)
    }

    if (this.consoleLogger) {
      this.consoleLogger.write(entry)
    }
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level
  }

  getLogFile(): string | null {
    return this.fileLogger?.getFilePath() ?? null
  }

  child(subComponent: string): Logger {
    return new Logger({
      component: `${this.component}.${subComponent}`,
      logLevel: this.logLevel,
      enableConsole: this.consoleLogger !== null,
      enableFile: this.fileLogger !== null,
    })
  }
}

// Global logger instance
let _globalLogger: Logger | null = null

export function initLogger(options: LoggerOptions): Logger {
  _globalLogger = new Logger(options)
  _globalLogger.info("=".repeat(72))
  _globalLogger.info(`clangd-mcp starting — PID ${process.pid}`)
  _globalLogger.info(`Log file: ${_globalLogger.getLogFile() ?? "disabled"}`)
  _globalLogger.info(`Node version: ${process.version}`)
  _globalLogger.info(`Platform: ${process.platform}`)
  return _globalLogger
}

export function getLogger(): Logger {
  if (!_globalLogger) {
    // Fallback logger if not initialized
    _globalLogger = new Logger({ component: "clangd-mcp" })
  }
  return _globalLogger
}

// Convenience functions for backward compatibility
export function log(level: LogLevelName, message: string, context?: Record<string, unknown>): void {
  const logger = getLogger()
  const logLevel = parseLogLevel(level)
  
  switch (logLevel) {
    case LogLevel.DEBUG:
      logger.debug(message, context)
      break
    case LogLevel.INFO:
      logger.info(message, context)
      break
    case LogLevel.WARN:
      logger.warn(message, context)
      break
    case LogLevel.ERROR:
      logger.error(message, context)
      break
  }
}

export function logError(message: string, err?: unknown): void {
  const logger = getLogger()
  if (err instanceof Error) {
    logger.error(message, err)
  } else {
    logger.error(`${message}: ${String(err ?? "")}`)
  }
}

export function getLogFile(): string {
  return getLogger().getLogFile() ?? "/tmp/clangd-mcp.log"
}
