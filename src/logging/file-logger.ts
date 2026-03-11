/**
 * file-logger.ts — File appender with log rotation
 */

import { appendFileSync, statSync, renameSync, unlinkSync, existsSync, mkdirSync } from "fs"
import path from "path"
import { LogEntry, formatLogEntry } from "./log-formatter.js"

export interface FileLoggerOptions {
  filePath: string
  maxSizeBytes?: number // Default: 10MB
  maxBackups?: number // Default: 5
}

export class FileLogger {
  private filePath: string
  private maxSizeBytes: number
  private maxBackups: number

  constructor(options: FileLoggerOptions) {
    this.filePath = options.filePath
    this.maxSizeBytes = options.maxSizeBytes ?? 10 * 1024 * 1024 // 10MB
    this.maxBackups = options.maxBackups ?? 5

    // Ensure directory exists
    const dir = path.dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  write(entry: LogEntry): void {
    try {
      // Check if rotation is needed
      this.rotateIfNeeded()

      // Format and append
      const line = formatLogEntry(entry) + "\n"
      appendFileSync(this.filePath, line, "utf8")
    } catch (err) {
      // Silently fail - don't crash the app if logging fails
      console.error(`[FileLogger] Failed to write log: ${err}`)
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.filePath)) {
        return
      }

      const stats = statSync(this.filePath)
      if (stats.size < this.maxSizeBytes) {
        return
      }

      // Rotate existing backups
      for (let i = this.maxBackups - 1; i >= 1; i--) {
        const oldPath = `${this.filePath}.${i}`
        const newPath = `${this.filePath}.${i + 1}`
        
        if (existsSync(oldPath)) {
          if (i === this.maxBackups - 1) {
            // Delete oldest backup
            unlinkSync(oldPath)
          } else {
            renameSync(oldPath, newPath)
          }
        }
      }

      // Rotate current log to .1
      renameSync(this.filePath, `${this.filePath}.1`)
    } catch (err) {
      console.error(`[FileLogger] Failed to rotate log: ${err}`)
    }
  }

  getFilePath(): string {
    return this.filePath
  }
}
