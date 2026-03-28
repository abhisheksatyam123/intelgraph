import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs"
import path from "path"
import os from "os"
import { cleanCompileCommands } from "../../src/utils/compile-commands-cleaner.js"

type Entry = {
  directory: string
  file: string
  arguments: string[]
}

function writeCompileCommands(root: string, entries: Entry[]): void {
  writeFileSync(path.join(root, "compile_commands.json"), JSON.stringify(entries, null, 2), "utf8")
}

describe("compile_commands preflight policy", () => {
  it("defaults requireZeroUnmatched to false so unmatched patch entries do not hard-fail startup", async () => {
    const tempBase = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-preflight-unmatched-default-"))
    const workspaceRoot = path.join(tempBase, "WLAN.CNG.1.0-01968.1")
    try {
      mkdirSync(path.join(workspaceRoot, "wlan_proc/module/rom/v1/patch"), { recursive: true })
      const patchOnlyFile = path.join(workspaceRoot, "wlan_proc/module/rom/v1/patch/unmatched_patch.c")
      writeFileSync(patchOnlyFile, "int unmatched_patch(void){return 0;}\n", "utf8")

      writeCompileCommands(workspaceRoot, [
        { directory: path.dirname(patchOnlyFile), file: patchOnlyFile, arguments: ["clang", "-c", patchOnlyFile] },
      ])

      const result = await cleanCompileCommands(workspaceRoot, {
        enabled: true,
        cleanFlags: true,
        removeTests: false,
        requireZeroUnmatched: false,
      })

      expect(result.stats.requireZeroUnmatched).toBe(false)
      expect(result.stats.unmatchedPatchCount).toBeGreaterThan(0)
      expect(result.preflightOk).toBe(true)
    } finally {
      rmSync(tempBase, { recursive: true, force: true })
    }
  })

  it("defaults to remap policy when preflightPolicy is omitted", async () => {
    const tempBase = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-preflight-default-"))
    const workspaceRoot = path.join(tempBase, "WLAN.CNG.1.0-01968.1")
    const otherRoot = path.join(tempBase, "WLAN.CNG.1.0-01880.3")
    try {
      mkdirSync(path.join(workspaceRoot, "wlan_proc/core/src"), { recursive: true })
      mkdirSync(path.join(otherRoot, "wlan_proc/core/src"), { recursive: true })

      const localFile = path.join(workspaceRoot, "wlan_proc/core/src/local_ok.c")
      const foreignFile = path.join(otherRoot, "wlan_proc/core/src/foreign_bad.c")
      writeFileSync(localFile, "int local_ok(void){return 0;}\n", "utf8")
      writeFileSync(foreignFile, "int foreign_bad(void){return 0;}\n", "utf8")

      writeCompileCommands(workspaceRoot, [
        { directory: path.dirname(localFile), file: localFile, arguments: ["clang", "-c", localFile] },
        { directory: path.dirname(foreignFile), file: foreignFile, arguments: ["clang", "-c", foreignFile] },
      ])

      const result = await cleanCompileCommands(workspaceRoot, {
        enabled: true,
        cleanFlags: true,
        removeTests: false,
        requireZeroUnmatched: false,
      })

      expect(result.preflightOk).toBe(true)
      expect(result.stats.preflightPolicy).toBe("remap")
      expect(result.stats.externalEntryCount).toBe(1)
      expect(result.stats.removedExternalCount).toBe(1)
    } finally {
      rmSync(tempBase, { recursive: true, force: true })
    }
  })

  it("reject policy fails when external entries exist", async () => {
    const tempBase = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-preflight-reject-"))
    const workspaceRoot = path.join(tempBase, "WLAN.CNG.1.0-01968.1")
    const otherRoot = path.join(tempBase, "WLAN.CNG.1.0-01880.3")
    try {
      mkdirSync(path.join(workspaceRoot, "wlan_proc/core/src"), { recursive: true })
      mkdirSync(path.join(otherRoot, "wlan_proc/core/src"), { recursive: true })

      const localFile = path.join(workspaceRoot, "wlan_proc/core/src/local_ok.c")
      const foreignFile = path.join(otherRoot, "wlan_proc/core/src/foreign_bad.c")
      writeFileSync(localFile, "int local_ok(void){return 0;}\n", "utf8")
      writeFileSync(foreignFile, "int foreign_bad(void){return 0;}\n", "utf8")

      writeCompileCommands(workspaceRoot, [
        { directory: path.dirname(localFile), file: localFile, arguments: ["clang", "-c", localFile] },
        { directory: path.dirname(foreignFile), file: foreignFile, arguments: ["clang", "-c", foreignFile] },
      ])

      const result = await cleanCompileCommands(workspaceRoot, {
        enabled: true,
        cleanFlags: true,
        removeTests: false,
        requireZeroUnmatched: false,
        preflightPolicy: "reject",
      })

      expect(result.preflightOk).toBe(false)
      expect(result.stats.externalEntryCount).toBe(1)
    } finally {
      rmSync(tempBase, { recursive: true, force: true })
    }
  })

  it("fix policy drops external entries and passes preflight", async () => {
    const tempBase = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-preflight-fix-"))
    const workspaceRoot = path.join(tempBase, "WLAN.CNG.1.0-01968.1")
    const otherRoot = path.join(tempBase, "WLAN.CNG.1.0-01880.3")
    try {
      mkdirSync(path.join(workspaceRoot, "wlan_proc/core/src"), { recursive: true })
      mkdirSync(path.join(otherRoot, "wlan_proc/core/src"), { recursive: true })

      const localFile = path.join(workspaceRoot, "wlan_proc/core/src/local_ok.c")
      const foreignFile = path.join(otherRoot, "wlan_proc/core/src/foreign_bad.c")
      writeFileSync(localFile, "int local_ok(void){return 0;}\n", "utf8")
      writeFileSync(foreignFile, "int foreign_bad(void){return 0;}\n", "utf8")

      writeCompileCommands(workspaceRoot, [
        { directory: path.dirname(localFile), file: localFile, arguments: ["clang", "-c", localFile] },
        { directory: path.dirname(foreignFile), file: foreignFile, arguments: ["clang", "-c", foreignFile] },
      ])

      const result = await cleanCompileCommands(workspaceRoot, {
        enabled: true,
        cleanFlags: true,
        removeTests: false,
        requireZeroUnmatched: false,
        preflightPolicy: "fix",
      })

      expect(result.preflightOk).toBe(true)
      expect(result.stats.externalEntryCount).toBe(1)
      expect(result.stats.removedExternalCount).toBe(1)

      const cleaned = JSON.parse(readFileSync(path.join(workspaceRoot, "compile_commands.json"), "utf8")) as Entry[]
      expect(cleaned).toHaveLength(1)
      expect(cleaned[0]?.file).toBe(localFile)
    } finally {
      rmSync(tempBase, { recursive: true, force: true })
    }
  })

  it("remap policy rewrites external entries to workspace paths when candidate exists", async () => {
    const tempBase = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-preflight-remap-"))
    const workspaceRoot = path.join(tempBase, "WLAN.CNG.1.0-01968.1")
    const otherRoot = path.join(tempBase, "WLAN.CNG.1.0-01880.3")
    try {
      mkdirSync(path.join(workspaceRoot, "wlan_proc/core/src"), { recursive: true })
      mkdirSync(path.join(otherRoot, "wlan_proc/core/src"), { recursive: true })

      const localTwin = path.join(workspaceRoot, "wlan_proc/core/src/shared_name.c")
      const foreignFile = path.join(otherRoot, "wlan_proc/core/src/shared_name.c")
      writeFileSync(localTwin, "int shared_name(void){return 1;}\n", "utf8")
      writeFileSync(foreignFile, "int shared_name(void){return 0;}\n", "utf8")

      writeCompileCommands(workspaceRoot, [
        { directory: path.dirname(foreignFile), file: foreignFile, arguments: ["clang", "-c", foreignFile] },
      ])

      const result = await cleanCompileCommands(workspaceRoot, {
        enabled: true,
        cleanFlags: true,
        removeTests: false,
        requireZeroUnmatched: false,
        preflightPolicy: "remap",
      })

      expect(result.preflightOk).toBe(true)
      expect(result.stats.externalEntryCount).toBe(1)
      expect(result.stats.remappedExternalCount).toBe(1)
      expect(result.stats.removedExternalCount).toBe(0)

      const cleaned = JSON.parse(readFileSync(path.join(workspaceRoot, "compile_commands.json"), "utf8")) as Entry[]
      expect(cleaned).toHaveLength(1)
      expect(cleaned[0]?.file).toBe(localTwin)
      expect(cleaned[0]?.arguments).toContain(localTwin)
      expect(cleaned[0]?.arguments).not.toContain(foreignFile)
    } finally {
      rmSync(tempBase, { recursive: true, force: true })
    }
  })
})
