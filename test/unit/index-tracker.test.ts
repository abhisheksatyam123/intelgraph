import { describe, it, expect, beforeEach } from "vitest"
import { IndexTracker } from "../../src/tracking/index.js"

describe("IndexTracker", () => {
  let tracker: IndexTracker

  beforeEach(() => {
    tracker = new IndexTracker()
  })

  it("starts in not-ready state", () => {
    expect(tracker.state.isReady).toBe(false)
    expect(tracker.state.percentage).toBe(0)
  })

  it("tracks progress tokens", () => {
    tracker.onProgressCreate("token-1")
    tracker.onProgress("token-1", { kind: "begin", percentage: 0, message: "Starting" })

    expect(tracker.state.isReady).toBe(false)
    expect(tracker.state.percentage).toBe(0)
    expect(tracker.state.message).toContain("Starting")
  })

  it("marks ready when all tokens complete", () => {
    tracker.onProgressCreate("token-1")
    tracker.onProgress("token-1", { kind: "begin" })
    tracker.onProgress("token-1", { kind: "report", percentage: 50 })
    tracker.onProgress("token-1", { kind: "end" })

    expect(tracker.state.isReady).toBe(true)
    expect(tracker.state.percentage).toBe(100)
  })

  it("tracks per-file parse state", () => {
    tracker.onFileStatus("file:///workspace/test.c", "parsing")
    expect(tracker.fileState("/workspace/test.c")).toBe("parsing")

    tracker.onFileStatus("file:///workspace/test.c", "idle")
    expect(tracker.isFileReady("/workspace/test.c")).toBe(true)
  })

  it("returns status suffix when not ready", () => {
    tracker.onProgressCreate("token-1")
    tracker.onProgress("token-1", { kind: "begin", percentage: 30 })

    const suffix = tracker.statusSuffix()
    expect(suffix).toContain("Index: building")
    expect(suffix).toContain("30%")
  })

  it("returns empty suffix when ready", () => {
    tracker.markReady()
    expect(tracker.statusSuffix()).toBe("")
  })

  it("returns file suffix when file is not idle", () => {
    tracker.onFileStatus("file:///workspace/test.c", "parsing")
    const suffix = tracker.fileSuffix("/workspace/test.c")
    expect(suffix).toContain("File: parsing")
  })
})
