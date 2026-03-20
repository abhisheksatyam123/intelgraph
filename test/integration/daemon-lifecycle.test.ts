import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  spawnDaemon,
  readState,
  checkDaemonAlive,
  resolveBridgeScript,
  type SpawnDaemonOptions,
} from "../../src/daemon/index.js"
import { waitForPort } from "../helpers.js"

describe("daemon lifecycle integration", () => {
  let testRoot: string

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "clangd-mcp-daemon-test-"))
  })

  afterEach(() => {
    // Clean up any spawned processes
    const state = readState(testRoot)
    if (state?.bridgePid) {
      try {
        process.kill(state.bridgePid, "SIGTERM")
      } catch {
        // ignore if already dead
      }
    }
    rmSync(testRoot, { recursive: true, force: true })
  })

  it("spawns daemon and writes state", async () => {
    const opts: SpawnDaemonOptions = {
      root: testRoot,
      clangdBin: "clangd",
      clangdArgs: ["--background-index"],
      bridgeScript: resolveBridgeScript(),
    }

    const state = await spawnDaemon(opts)

    expect(state.bridgePid).toBeGreaterThan(0)
    expect(state.port).toBeGreaterThan(1024)
    expect(state.root).toBe(testRoot)

    // Verify state file was written
    const readBack = readState(testRoot)
    expect(readBack).toEqual(state)

    // Verify port is open
    const portOpen = await waitForPort(state.port, 5000)
    expect(portOpen).toBe(true)

    // Clean up
    process.kill(state.bridgePid, "SIGTERM")
  }, 15000)

  it("checkDaemonAlive validates running daemon", async () => {
    const opts: SpawnDaemonOptions = {
      root: testRoot,
      clangdBin: "clangd",
      clangdArgs: [],
      bridgeScript: resolveBridgeScript(),
    }

    const state = await spawnDaemon(opts)
    const alive = await checkDaemonAlive(state, testRoot)
    expect(alive).toBe(true)

    // Kill daemon and verify it's detected as dead
    process.kill(state.bridgePid, "SIGKILL")
    await new Promise(r => setTimeout(r, 500))

    const stillAlive = await checkDaemonAlive(state, testRoot)
    expect(stillAlive).toBe(false)
  }, 15000)
})
