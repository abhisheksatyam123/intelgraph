/**
 * log-levels.ts — Log level definitions and utilities
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export type LogLevelName = "DEBUG" | "INFO" | "WARN" | "ERROR"

export function parseLogLevel(level: string): LogLevel {
  const normalized = level.toUpperCase() as LogLevelName
  switch (normalized) {
    case "DEBUG":
      return LogLevel.DEBUG
    case "INFO":
      return LogLevel.INFO
    case "WARN":
      return LogLevel.WARN
    case "ERROR":
      return LogLevel.ERROR
    default:
      return LogLevel.INFO
  }
}

export function logLevelToString(level: LogLevel): LogLevelName {
  switch (level) {
    case LogLevel.DEBUG:
      return "DEBUG"
    case LogLevel.INFO:
      return "INFO"
    case LogLevel.WARN:
      return "WARN"
    case LogLevel.ERROR:
      return "ERROR"
    default:
      return "INFO"
  }
}

export function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel): boolean {
  return messageLevel >= configuredLevel
}
