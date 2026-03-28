import { describe, expect, it } from "vitest"
import os from "os"
import path from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { parseCliArgs } from "../../src/config/cli-parser.js"
import { resolveConfig, getDefaultClangdArgs } from "../../src/config/config-resolver.js"
import { readWorkspaceConfig, isConfigEnabled } from "../../src/config/workspace-config.js"
import { parseLogLevel, logLevelToString, LogLevel, shouldLog } from "../../src/logging/log-levels.js"
import { formatLogEntry, formatConsoleEntry } from "../../src/logging/log-formatter.js"
import { ClangdMcpError, ConfigurationError, DaemonError, LspError, ToolError, TransportError, ValidationError } from "../../src/errors/error-types.js"
import { wrapError } from "../../src/errors/error-handler.js"

describe("config modules are codebase-derived", () => {
  it("parses CLI args including transport and clangd overrides", () => {
    const got = parseCliArgs([
      "node",
      "clangd-mcp",
      "--root",
      "/ws",
      "--port",
      "8080",
      "--http-daemon",
      "--http-port=9999",
      "--clangd=/bin/clangd",
      "--clangd-args=a,b,c",
    ])
    expect(got.root).toBe("/ws")
    expect(got.port).toBe(8080)
    expect(got.httpDaemon).toBe(true)
    expect(got.httpPort).toBe(9999)
    expect(got.clangdPath).toBe("/bin/clangd")
    expect(got.clangdArgs).toEqual(["a", "b", "c"])
  })

  it("resolves config with CLI precedence", () => {
    const got = resolveConfig(
      { root: "/cli", stdio: false, port: 7777, httpDaemonMode: false, httpDaemon: false, httpPort: undefined, clangdPath: "c1", clangdArgs: ["x"], help: false },
      { root: "/ws", clangd: "c2", args: ["y"] },
      "/cwd",
    )
    expect(got.root).toBe("/cli")
    expect(got.clangdPath).toBe("c1")
    expect(got.clangdArgs).toEqual(["x"])
    expect(got.transport).toBe("http")
  })

  it("reads workspace config and validates schema", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-cfg-"))
    try {
      writeFileSync(path.join(dir, ".clangd-mcp.json"), JSON.stringify({ root: "/r", clangd: "clangd", args: ["--x"], enabled: true }))
      const got = readWorkspaceConfig(dir)
      expect(got.root).toBe("/r")
      expect(isConfigEnabled(got)).toBe(true)
      expect(getDefaultClangdArgs().length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throws typed config error on invalid workspace config", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-cfg-bad-"))
    try {
      writeFileSync(path.join(dir, ".clangd-mcp.json"), JSON.stringify({ enabled: "bad" }))
      expect(() => readWorkspaceConfig(dir)).toThrow(ConfigurationError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("logging modules are codebase-derived", () => {
  it("parses and prints log levels consistently", () => {
    expect(parseLogLevel("debug")).toBe(LogLevel.DEBUG)
    expect(logLevelToString(LogLevel.WARN)).toBe("WARN")
    expect(shouldLog(LogLevel.ERROR, LogLevel.INFO)).toBe(true)
    expect(shouldLog(LogLevel.DEBUG, LogLevel.WARN)).toBe(false)
  })

  it("formats structured and console log entries", () => {
    const e = {
      timestamp: new Date("2020-01-01T00:00:00.000Z"),
      level: LogLevel.INFO,
      component: "test",
      message: "hello",
      context: { a: 1 },
      error: new Error("boom"),
    }
    const j = JSON.parse(formatLogEntry(e))
    expect(j.level).toBe("INFO")
    expect(j.component).toBe("test")
    expect(j.context.a).toBe(1)
    expect(j.error.message).toBe("boom")
    const c = JSON.parse(formatConsoleEntry(e))
    expect(c.error).toBe("boom")
  })
})

describe("error modules are codebase-derived", () => {
  it("constructs typed clangd-mcp errors", () => {
    const list = [
      new ConfigurationError("c"),
      new DaemonError("d"),
      new LspError("l"),
      new ToolError("t"),
      new TransportError("tr"),
      new ValidationError("v"),
    ]
    for (const e of list) {
      expect(e).toBeInstanceOf(ClangdMcpError)
      expect(e.code.endsWith("_ERROR")).toBe(true)
    }
  })

  it("wrapError preserves message context", () => {
    const e = wrapError(new Error("inner"), "outer")
    expect(e.message).toContain("outer: inner")
  })
})
