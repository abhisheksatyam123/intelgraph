import { describe, expect, it, vi, beforeEach } from "vitest"
import { TOOLS, setDbFoundation } from "../../../src/tools/index.js"
import type { IDbFoundation } from "../../../src/intelligence/contracts/db-foundation.js"

// ---------------------------------------------------------------------------
// Find the intelligence_snapshot tool
// ---------------------------------------------------------------------------

const tool = TOOLS.find((t) => t.name === "intelligence_snapshot")!

// ---------------------------------------------------------------------------
// Mock IDbFoundation factory
// ---------------------------------------------------------------------------

function mkDb(overrides: Partial<IDbFoundation> = {}): IDbFoundation {
  return {
    initSchema: vi.fn(async () => {}),
    runMigrations: vi.fn(async () => {}),
    beginSnapshot: vi.fn(async () => ({ snapshotId: 42, status: "building" as const, createdAt: "2026-01-01T00:00:00Z" })),
    commitSnapshot: vi.fn(async () => {}),
    failSnapshot: vi.fn(async () => {}),
    withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => []) })),
    ...overrides,
  }
}

const mockClient = {} as Parameters<typeof tool.execute>[1]
const mockTracker = {} as Parameters<typeof tool.execute>[2]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intelligence_snapshot MCP tool", () => {
  beforeEach(() => setDbFoundation(null as never))

  it("tool is registered in TOOLS array", () => {
    expect(tool).toBeDefined()
    expect(tool.name).toBe("intelligence_snapshot")
    expect(tool.description).toContain("snapshot lifecycle")
  })

  it("returns not-initialized message when db not set", async () => {
    const res = await tool.execute({ action: "begin", workspaceRoot: "/wlan", compileDbHash: "abc" }, mockClient, mockTracker)
    expect(res).toContain("not initialized")
  })

  it("begin: returns snapshotId and status", async () => {
    setDbFoundation(mkDb())
    const res = await tool.execute({
      action: "begin",
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      compileDbHash: "deadbeef",
      parserVersion: "1.0.0",
    }, mockClient, mockTracker)
    expect(res).toContain("snapshotId:  42")
    expect(res).toContain("status:      building")
  })

  it("begin: returns error when workspaceRoot missing", async () => {
    setDbFoundation(mkDb())
    const res = await tool.execute({ action: "begin" }, mockClient, mockTracker)
    expect(res).toContain("workspaceRoot and compileDbHash are required")
  })

  it("begin: returns error when compileDbHash missing", async () => {
    setDbFoundation(mkDb())
    const res = await tool.execute({ action: "begin", workspaceRoot: "/wlan" }, mockClient, mockTracker)
    expect(res).toContain("workspaceRoot and compileDbHash are required")
  })

  it("commit: calls commitSnapshot and returns success message", async () => {
    const db = mkDb()
    setDbFoundation(db)
    const res = await tool.execute({ action: "commit", snapshotId: 42 }, mockClient, mockTracker)
    expect(res).toContain("42")
    expect(res).toContain("committed")
    expect(db.commitSnapshot).toHaveBeenCalledWith(42)
  })

  it("commit: returns error when snapshotId missing", async () => {
    setDbFoundation(mkDb())
    const res = await tool.execute({ action: "commit" }, mockClient, mockTracker)
    expect(res).toContain("snapshotId is required")
  })

  it("fail: calls failSnapshot with reason and returns message", async () => {
    const db = mkDb()
    setDbFoundation(db)
    const res = await tool.execute({ action: "fail", snapshotId: 42, failReason: "extraction error" }, mockClient, mockTracker)
    expect(res).toContain("42")
    expect(res).toContain("failed")
    expect(res).toContain("extraction error")
    expect(db.failSnapshot).toHaveBeenCalledWith(42, "extraction error")
  })

  it("fail: uses default reason when failReason not provided", async () => {
    const db = mkDb()
    setDbFoundation(db)
    const res = await tool.execute({ action: "fail", snapshotId: 42 }, mockClient, mockTracker)
    expect(res).toContain("unknown")
    expect(db.failSnapshot).toHaveBeenCalledWith(42, "unknown")
  })

  it("WLAN-grounded: begin snapshot for WLAN workspace root", async () => {
    const db = mkDb()
    setDbFoundation(db)
    const res = await tool.execute({
      action: "begin",
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      compileDbHash: "wlan01880hash",
      parserVersion: "1.0.0",
    }, mockClient, mockTracker)
    expect(res).toContain("snapshotId:  42")
    expect(db.beginSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      compileDbHash: "wlan01880hash",
    }))
  })
})
