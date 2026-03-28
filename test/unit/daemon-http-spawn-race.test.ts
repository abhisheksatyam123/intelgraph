import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs"
import path from "path"
import { tmpdir } from "os"
import { createServer } from "net"
import {
  releaseSpawnLock,
  spawnHttpDaemon,
  stateFilePath,
  tryAcquireSpawnLock,
  writeState,
  type DaemonState,
} from "../../src/daemon/index.js"

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "clangd-mcp-http-race-"))
}

describe("spawnHttpDaemon race/reuse behavior", () => {
  it("serializes concurrent lock contenders on same root", async () => {
    const root = makeTempRoot()
    try {
      const first = tryAcquireSpawnLock(root)
      const secondImmediate = tryAcquireSpawnLock(root)
      expect(first).toBe(true)
      expect(secondImmediate).toBe(false)

      releaseSpawnLock(root)
      const secondAfterRelease = tryAcquireSpawnLock(root)
      expect(secondAfterRelease).toBe(true)
      releaseSpawnLock(root)
    } finally {
      releaseSpawnLock(root)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("reuses existing daemon state after waiting for lock holder", async () => {
    const root = makeTempRoot()
    const lockPath = path.join(root, ".clangd-mcp-spawn.lock")
    const tcp = createServer()

    try {
      await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", () => resolve()))
      const addr = tcp.address()
      if (!addr || typeof addr === "string") throw new Error("failed to allocate tcp port")
      const httpPort = addr.port

      // Simulate another process currently holding the spawn lock.
      writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, "utf8")

      // Simulate first spawner finishing: writes reusable state then releases lock.
      setTimeout(() => {
        const state: DaemonState = {
          version: 1,
          bridgePid: 12345,
          clangdPid: 12346,
          port: 12347,
          root,
          clangdBin: "clangd",
          clangdArgs: [],
          startedAt: new Date().toISOString(),
          httpPort,
          httpPid: process.pid,
        }
        writeState(root, state)
        try {
          unlinkSync(lockPath)
        } catch {
          // ignore
        }
      }, 150)

      const reused = await spawnHttpDaemon({
        root,
        clangdBin: "clangd",
        clangdArgs: [],
        bridgeScript: "/tmp/bridge.js",
      })

      expect(reused.httpPort).toBe(httpPort)
      expect(reused.httpPid).toBe(process.pid)
      expect(stateFilePath(root)).toContain(root)
    } finally {
      tcp.close()
      releaseSpawnLock(root)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
