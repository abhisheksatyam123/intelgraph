/**
 * test/unit/log-levels.test.ts
 * Unit tests for log level utilities
 */

import { describe, test, expect } from "vitest"
import {
  LogLevel,
  parseLogLevel,
  logLevelToString,
  shouldLog,
} from "../../src/logging/log-levels"

describe("parseLogLevel", () => {
  test("parses DEBUG (case-insensitive)", () => {
    expect(parseLogLevel("debug")).toBe(LogLevel.DEBUG)
    expect(parseLogLevel("DEBUG")).toBe(LogLevel.DEBUG)
    expect(parseLogLevel("Debug")).toBe(LogLevel.DEBUG)
  })

  test("parses INFO", () => {
    expect(parseLogLevel("info")).toBe(LogLevel.INFO)
    expect(parseLogLevel("INFO")).toBe(LogLevel.INFO)
  })

  test("parses WARN", () => {
    expect(parseLogLevel("warn")).toBe(LogLevel.WARN)
    expect(parseLogLevel("WARN")).toBe(LogLevel.WARN)
  })

  test("parses ERROR", () => {
    expect(parseLogLevel("error")).toBe(LogLevel.ERROR)
    expect(parseLogLevel("ERROR")).toBe(LogLevel.ERROR)
  })

  test("defaults to INFO for unknown levels", () => {
    expect(parseLogLevel("unknown")).toBe(LogLevel.INFO)
    expect(parseLogLevel("")).toBe(LogLevel.INFO)
    expect(parseLogLevel("trace")).toBe(LogLevel.INFO)
  })
})

describe("logLevelToString", () => {
  test("converts DEBUG to string", () => {
    expect(logLevelToString(LogLevel.DEBUG)).toBe("DEBUG")
  })

  test("converts INFO to string", () => {
    expect(logLevelToString(LogLevel.INFO)).toBe("INFO")
  })

  test("converts WARN to string", () => {
    expect(logLevelToString(LogLevel.WARN)).toBe("WARN")
  })

  test("converts ERROR to string", () => {
    expect(logLevelToString(LogLevel.ERROR)).toBe("ERROR")
  })

  test("defaults to INFO for unknown numeric values", () => {
    expect(logLevelToString(999 as LogLevel)).toBe("INFO")
  })
})

describe("shouldLog", () => {
  test("DEBUG message at INFO level → false (below threshold)", () => {
    expect(shouldLog(LogLevel.DEBUG, LogLevel.INFO)).toBe(false)
  })

  test("INFO message at INFO level → true (equal passes)", () => {
    expect(shouldLog(LogLevel.INFO, LogLevel.INFO)).toBe(true)
  })

  test("WARN message at INFO level → true (above threshold)", () => {
    expect(shouldLog(LogLevel.WARN, LogLevel.INFO)).toBe(true)
  })

  test("ERROR message at INFO level → true (above threshold)", () => {
    expect(shouldLog(LogLevel.ERROR, LogLevel.INFO)).toBe(true)
  })

  test("ERROR message at DEBUG level → true (always passes at DEBUG)", () => {
    expect(shouldLog(LogLevel.ERROR, LogLevel.DEBUG)).toBe(true)
  })

  test("DEBUG message at DEBUG level → true (equal passes)", () => {
    expect(shouldLog(LogLevel.DEBUG, LogLevel.DEBUG)).toBe(true)
  })

  test("INFO message at WARN level → false (below threshold)", () => {
    expect(shouldLog(LogLevel.INFO, LogLevel.WARN)).toBe(false)
  })

  test("WARN message at ERROR level → false (below threshold)", () => {
    expect(shouldLog(LogLevel.WARN, LogLevel.ERROR)).toBe(false)
  })

  test("ERROR message at ERROR level → true (equal passes)", () => {
    expect(shouldLog(LogLevel.ERROR, LogLevel.ERROR)).toBe(true)
  })
})
