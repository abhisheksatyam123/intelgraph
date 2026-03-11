/**
 * test/unit/log-formatter.test.ts
 * Unit tests for log formatting utilities
 */

import { describe, test, expect } from "vitest"
import { LogLevel } from "../../src/logging/log-levels"
import { formatLogEntry, formatConsoleEntry, type LogEntry } from "../../src/logging/log-formatter"

describe("formatLogEntry", () => {
  test("returns valid JSON string", () => {
    const entry: LogEntry = {
      timestamp: new Date("2026-03-11T10:30:45.123Z"),
      level: LogLevel.INFO,
      component: "test.component",
      message: "Test message",
    }
    const result = formatLogEntry(entry)
    expect(() => JSON.parse(result)).not.toThrow()
  })

  test("includes all required fields", () => {
    const entry: LogEntry = {
      timestamp: new Date("2026-03-11T10:30:45.123Z"),
      level: LogLevel.INFO,
      component: "test.component",
      message: "Test message",
    }
    const result = JSON.parse(formatLogEntry(entry))
    expect(result.timestamp).toBe("2026-03-11T10:30:45.123Z")
    expect(result.level).toBe("INFO")
    expect(result.component).toBe("test.component")
    expect(result.message).toBe("Test message")
  })

  test("includes context when present", () => {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.DEBUG,
      component: "test",
      message: "msg",
      context: { key: "value", num: 42 },
    }
    const result = JSON.parse(formatLogEntry(entry))
    expect(result.context).toEqual({ key: "value", num: 42 })
  })

  test("excludes context key when context is empty object", () => {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.INFO,
      component: "test",
      message: "msg",
      context: {},
    }
    const result = JSON.parse(formatLogEntry(entry))
    expect(result.context).toBeUndefined()
  })

  test("includes error details when error present", () => {
    const error = new Error("Test error")
    error.stack = "Error: Test error\n  at line 1\n  at line 2"
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.ERROR,
      component: "test",
      message: "Error occurred",
      error,
    }
    const result = JSON.parse(formatLogEntry(entry))
    expect(result.error.message).toBe("Test error")
    expect(result.error.name).toBe("Error")
    expect(Array.isArray(result.error.stack)).toBe(true)
    expect(result.error.stack.length).toBeGreaterThan(0)
  })

  test("excludes error key when no error", () => {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.INFO,
      component: "test",
      message: "msg",
    }
    const result = JSON.parse(formatLogEntry(entry))
    expect(result.error).toBeUndefined()
  })

  test("formats all log levels correctly", () => {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]
    const expected = ["DEBUG", "INFO", "WARN", "ERROR"]
    
    levels.forEach((level, i) => {
      const entry: LogEntry = {
        timestamp: new Date(),
        level,
        component: "test",
        message: "msg",
      }
      const result = JSON.parse(formatLogEntry(entry))
      expect(result.level).toBe(expected[i])
    })
  })
})

describe("formatConsoleEntry", () => {
  test("returns valid JSON string", () => {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.INFO,
      component: "test",
      message: "msg",
    }
    const result = formatConsoleEntry(entry)
    expect(() => JSON.parse(result)).not.toThrow()
  })

  test("includes level, component, message", () => {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.WARN,
      component: "test.sub",
      message: "Warning message",
    }
    const result = JSON.parse(formatConsoleEntry(entry))
    expect(result.level).toBe("WARN")
    expect(result.component).toBe("test.sub")
    expect(result.message).toBe("Warning message")
  })

  test("does not include timestamp (simplified for console)", () => {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.INFO,
      component: "test",
      message: "msg",
    }
    const result = JSON.parse(formatConsoleEntry(entry))
    expect(result.timestamp).toBeUndefined()
  })

  test("includes context when present", () => {
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.INFO,
      component: "test",
      message: "msg",
      context: { foo: "bar" },
    }
    const result = JSON.parse(formatConsoleEntry(entry))
    expect(result.context).toEqual({ foo: "bar" })
  })

  test("includes error message only (not full stack)", () => {
    const error = new Error("Test error")
    error.stack = "Error: Test error\n  at line 1"
    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel.ERROR,
      component: "test",
      message: "Error occurred",
      error,
    }
    const result = JSON.parse(formatConsoleEntry(entry))
    expect(result.error).toBe("Test error")
    expect(typeof result.error).toBe("string")
  })
})
