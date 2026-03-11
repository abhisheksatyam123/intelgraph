/**
 * console-logger.ts — Console appender for stderr output
 */

import { LogEntry, formatConsoleEntry } from "./log-formatter.js"

export class ConsoleLogger {
  write(entry: LogEntry): void {
    try {
      const line = formatConsoleEntry(entry)
      process.stderr.write(`[clangd-mcp] ${line}\n`)
    } catch (err) {
      // Ignore EPIPE errors when stderr is closed (detached process)
    }
  }
}
