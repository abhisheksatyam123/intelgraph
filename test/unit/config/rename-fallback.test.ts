/**
 * test/unit/config/rename-fallback.test.ts
 *
 * Regression test for the project rename's backwards-compat fallback.
 *
 * The rename from clangd-mcp → intelgraph (commits c2dc21a through
 * 0ba19b2) replaced the workspace config file from .clangd-mcp.json
 * to .intelgraph.json. To avoid breaking existing user workspaces,
 * resolveConfigPath() falls back to the legacy file when only it
 * exists. This test exercises that fallback in three configurations:
 *
 *   1. Only .intelgraph.json present → returns the new path
 *   2. Only .clangd-mcp.json present → returns the legacy path
 *   3. Both present → prefers .intelgraph.json
 *
 * If a future refactor breaks the fallback, this test catches it
 * before existing users notice their config silently stops loading.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfigPath, readConfig } from "../../../src/config/config.js"
import { readWorkspaceConfig } from "../../../src/config/bootstrap.js"

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "rename-fallback-"))
  mkdirSync(dir, { recursive: true })
  tmpDirs.push(dir)
  return dir
}

describe("config rename fallback — resolveConfigPath", () => {
  it("returns the new .intelgraph.json path when only it exists", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".intelgraph.json"),
      JSON.stringify({ enabled: true, language: "ts" }),
    )
    expect(resolveConfigPath(ws)).toBe(join(ws, ".intelgraph.json"))
  })

  it("falls back to legacy .clangd-mcp.json when only it exists", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".clangd-mcp.json"),
      JSON.stringify({ enabled: true, language: "c" }),
    )
    expect(resolveConfigPath(ws)).toBe(join(ws, ".clangd-mcp.json"))
  })

  it("prefers .intelgraph.json when both files exist", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".intelgraph.json"),
      JSON.stringify({ enabled: true, language: "ts" }),
    )
    writeFileSync(
      join(ws, ".clangd-mcp.json"),
      JSON.stringify({ enabled: false, language: "c" }),
    )
    expect(resolveConfigPath(ws)).toBe(join(ws, ".intelgraph.json"))
  })

  it("returns the new path even when neither file exists (so writes land there)", () => {
    const ws = makeTempWorkspace()
    expect(resolveConfigPath(ws)).toBe(join(ws, ".intelgraph.json"))
  })
})

describe("config rename fallback — readConfig actually loads from legacy file", () => {
  it("readConfig honors a legacy .clangd-mcp.json file", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".clangd-mcp.json"),
      JSON.stringify({
        enabled: true,
        clangd: "/usr/bin/clangd-19",
      }),
    )
    const config = readConfig(ws)
    expect(config.enabled).toBe(true)
    expect(config.clangd).toBe("/usr/bin/clangd-19")
  })

  it("readConfig honors a new .intelgraph.json file", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".intelgraph.json"),
      JSON.stringify({
        enabled: true,
        clangd: "/opt/llvm/bin/clangd",
      }),
    )
    const config = readConfig(ws)
    expect(config.enabled).toBe(true)
    expect(config.clangd).toBe("/opt/llvm/bin/clangd")
  })

  it("readConfig prefers .intelgraph.json content when both files exist", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".clangd-mcp.json"),
      JSON.stringify({ enabled: false, clangd: "from-legacy" }),
    )
    writeFileSync(
      join(ws, ".intelgraph.json"),
      JSON.stringify({ enabled: true, clangd: "from-new" }),
    )
    const config = readConfig(ws)
    // The new file wins
    expect(config.enabled).toBe(true)
    expect(config.clangd).toBe("from-new")
  })
})

describe("config rename fallback — readWorkspaceConfig parallel API", () => {
  it("readWorkspaceConfig honors a legacy .clangd-mcp.json file", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".clangd-mcp.json"),
      JSON.stringify({ language: "c", root: "/abs/path" }),
    )
    const config = readWorkspaceConfig(ws)
    expect(config.language).toBe("c")
    expect(config.root).toBe("/abs/path")
  })

  it("readWorkspaceConfig honors a new .intelgraph.json file", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".intelgraph.json"),
      JSON.stringify({ language: "ts", root: "/different/path" }),
    )
    const config = readWorkspaceConfig(ws)
    expect(config.language).toBe("ts")
    expect(config.root).toBe("/different/path")
  })

  it("readWorkspaceConfig prefers .intelgraph.json over .clangd-mcp.json", () => {
    const ws = makeTempWorkspace()
    writeFileSync(
      join(ws, ".clangd-mcp.json"),
      JSON.stringify({ language: "c" }),
    )
    writeFileSync(
      join(ws, ".intelgraph.json"),
      JSON.stringify({ language: "ts" }),
    )
    const config = readWorkspaceConfig(ws)
    expect(config.language).toBe("ts")
  })

  it("readWorkspaceConfig returns empty defaults when neither file exists", () => {
    const ws = makeTempWorkspace()
    const config = readWorkspaceConfig(ws)
    expect(config).toEqual({})
  })
})
