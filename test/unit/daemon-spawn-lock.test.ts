import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs"
import path from "path"
import { tmpdir } from "os"
import {
  releaseSpawnLock,
  tryAcquireSpawnLock,
  waitForSpawnLockRelease,
} from "../../src/daemon/index.js"

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "clangd-mcp-spawn-lock-"))
}

describe("daemon spawn lock", () => {
  it("allows only one lock owner at a time", () => {
    const root = makeTempRoot()
    try {
      const first = tryAcquireSpawnLock(root)
      const second = tryAcquireSpawnLock(root)

      expect(first).toBe(true)
      expect(second).toBe(false)

      releaseSpawnLock(root)
      const third = tryAcquireSpawnLock(root)
      expect(third).toBe(true)

      releaseSpawnLock(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("waits until lock is released by holder", async () => {
    const root = makeTempRoot()
    try {
      expect(tryAcquireSpawnLock(root)).toBe(true)

      setTimeout(() => {
        releaseSpawnLock(root)
      }, 120)

      const released = await waitForSpawnLockRelease(root, 2_000)
      expect(released).toBe(true)
    } finally {
      releaseSpawnLock(root)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("cleans stale lock when owner pid is dead", async () => {
    const root = makeTempRoot()
    const lockPath = path.join(root, ".clangd-mcp-spawn.lock")
    try {
      writeFileSync(lockPath, "999999\n2026-01-01T00:00:00.000Z\n", "utf8")
      expect(existsSync(lockPath)).toBe(true)

      const released = await waitForSpawnLockRelease(root, 1_500)
      expect(released).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      releaseSpawnLock(root)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
