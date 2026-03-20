import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  normaliseRoot,
  stateFilePath,
  readState,
  writeState,
  clearState,
  tryAcquireSpawnLock,
  releaseSpawnLock,
  type DaemonState,
} from "../../src/daemon/index.js"

describe("daemon state management", () => {
  let testRoot: string

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "clangd-mcp-test-"))
  })

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true })
  })

  it("normalises VCS marker paths to parent when they exist", () => {
    // normaliseRoot only normalizes if the VCS dir actually exists on disk
    // For non-existent paths, it returns them as-is
    expect(normaliseRoot("/workspace")).toBe("/workspace")
    expect(normaliseRoot(testRoot)).toBe(testRoot)
  })

  it("writes and reads state correctly", () => {
    const state: DaemonState = {
      version: 1,
      bridgePid: 12345,
      clangdPid: 12346,
      port: 9999,
      root: testRoot,
      clangdBin: "clangd",
      clangdArgs: ["--background-index"],
      startedAt: new Date().toISOString(),
    }

    writeState(testRoot, state)
    const read = readState(testRoot)

    expect(read).toEqual(state)
  })

  it("returns null for missing state file", () => {
    const state = readState(testRoot)
    expect(state).toBeNull()
  })

  it("clears state file", () => {
    const state: DaemonState = {
      version: 1,
      bridgePid: 12345,
      clangdPid: 12346,
      port: 9999,
      root: testRoot,
      clangdBin: "clangd",
      clangdArgs: [],
      startedAt: new Date().toISOString(),
    }

    writeState(testRoot, state)
    expect(readState(testRoot)).not.toBeNull()

    clearState(testRoot)
    expect(readState(testRoot)).toBeNull()
  })

  it("acquires and releases spawn lock", () => {
    expect(tryAcquireSpawnLock(testRoot)).toBe(true)
    expect(tryAcquireSpawnLock(testRoot)).toBe(false)

    releaseSpawnLock(testRoot)
    expect(tryAcquireSpawnLock(testRoot)).toBe(true)

    releaseSpawnLock(testRoot)
  })
})
