import { describe, expect, it, vi, beforeEach } from "vitest"
import { PostgresDbFoundation } from "../../../src/intelligence/db/postgres/client.js"
import { PostgresSnapshotIngestWriter } from "../../../src/intelligence/db/postgres/ingest-writer.js"
import type { SnapshotMeta } from "../../../src/intelligence/contracts/common.js"

// ---------------------------------------------------------------------------
// Mock pool factory — simulates pg.Pool without a real DB
// ---------------------------------------------------------------------------

function mkPool(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown[]> = {}
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO snapshot") && sql.includes("RETURNING")) {
        return { rows: [{ id: "42", created_at: "2026-01-01T00:00:00Z" }] }
      }
      if (sql.includes("INSERT INTO symbol")) return { rows: [] }
      if (sql.includes("INSERT INTO c_type")) return { rows: [] }
      if (sql.includes("INSERT INTO aggregate_field")) return { rows: [] }
      if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) {
        return { rows: [{ id: "1" }] }
      }
      if (sql.includes("INSERT INTO semantic_edge")) return { rows: [] }
      if (sql.includes("INSERT INTO runtime_observation")) return { rows: [] }
      if (sql.includes("UPDATE snapshot")) return { rows: [] }
      if (sql.includes("BEGIN") || sql.includes("COMMIT") || sql.includes("ROLLBACK")) return { rows: [] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO snapshot") && sql.includes("RETURNING")) {
        return { rows: [{ id: "42", created_at: "2026-01-01T00:00:00Z" }] }
      }
      if (sql.includes("UPDATE snapshot")) return { rows: [] }
      return { rows: [] }
    }),
    connect: vi.fn(async () => client),
    ...overrides,
  } as unknown as import("pg").Pool
}

// ---------------------------------------------------------------------------
// PostgresDbFoundation tests
// ---------------------------------------------------------------------------

describe("PostgresDbFoundation", () => {
  it("beginSnapshot inserts and returns SnapshotRef", async () => {
    const pool = mkPool()
    const db = new PostgresDbFoundation(pool)
    const meta: SnapshotMeta = {
      workspaceRoot: "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
      compileDbHash: "abc123",
      parserVersion: "1.0.0",
    }
    const ref = await db.beginSnapshot(meta)
    expect(ref.snapshotId).toBe(42)
    expect(ref.status).toBe("building")
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO snapshot"),
      expect.arrayContaining([meta.workspaceRoot, meta.compileDbHash]),
    )
  })

  it("commitSnapshot updates status to ready", async () => {
    const pool = mkPool()
    const db = new PostgresDbFoundation(pool)
    await db.commitSnapshot(42)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE snapshot SET status = 'ready'"),
      [42],
    )
  })

  it("failSnapshot updates status to failed with reason", async () => {
    const pool = mkPool()
    const db = new PostgresDbFoundation(pool)
    await db.failSnapshot(42, "extraction error")
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE snapshot SET status = 'failed'"),
      [42, "extraction error"],
    )
  })

  it("withTransaction commits on success", async () => {
    const pool = mkPool()
    const db = new PostgresDbFoundation(pool)
    const result = await db.withTransaction(async (tx) => {
      const rows = await tx.query("SELECT 1")
      return rows.length
    })
    expect(result).toBe(0)
    const client = await (pool.connect as ReturnType<typeof vi.fn>).mock.results[0]?.value
    expect(client.query).toHaveBeenCalledWith("BEGIN")
    expect(client.query).toHaveBeenCalledWith("COMMIT")
  })

  it("withTransaction rolls back on error", async () => {
    const pool = mkPool()
    const db = new PostgresDbFoundation(pool)
    await expect(
      db.withTransaction(async () => { throw new Error("boom") }),
    ).rejects.toThrow("boom")
    const client = await (pool.connect as ReturnType<typeof vi.fn>).mock.results[0]?.value
    expect(client.query).toHaveBeenCalledWith("ROLLBACK")
  })
})

// ---------------------------------------------------------------------------
// PostgresSnapshotIngestWriter tests
// ---------------------------------------------------------------------------

describe("PostgresSnapshotIngestWriter", () => {
  it("writes symbols and returns correct inserted count", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, {
      symbols: [
        { kind: "function", name: "wlan_bpf_filter_offload_handler",
          location: { filePath: "bpf_offload.c", line: 83 } },
        { kind: "function", name: "offldmgr_register_data_offload",
          location: { filePath: "offload_mgr_ext.c", line: 100 } },
      ],
    })
    expect(report.snapshotId).toBe(42)
    expect(report.inserted.symbols).toBe(2)
    expect(report.inserted.edges).toBe(0)
    expect(report.warnings).toHaveLength(0)
  })

  it("writes edges with evidence and returns correct counts", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, {
      edges: [
        {
          edgeKind: "calls",
          srcSymbolName: "wlan_bpf_enable_data_path",
          dstSymbolName: "offldmgr_register_data_offload",
          confidence: 1.0,
          derivation: "clangd",
          evidence: { sourceKind: "clangd_response", location: { filePath: "bpf_offload_int.c", line: 1093 } },
        },
      ],
    })
    expect(report.inserted.edges).toBe(1)
    expect(report.warnings).toHaveLength(0)
  })

  it("writes runtime callers and returns correct counts", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, {
      runtimeCallers: [
        {
          targetApi: "wlan_bpf_filter_offload_handler",
          runtimeTrigger: "Incoming RX data packet from hardware",
          dispatchChain: ["offloadif_data_ind", "_offldmgr_protocol_data_handler", "_offldmgr_enhanced_data_handler"],
          immediateInvoker: "_offldmgr_enhanced_data_handler",
          dispatchSite: { filePath: "offload_mgr_ext.c", line: 1107 },
          confidence: 1.0,
        },
      ],
    })
    expect(report.inserted.runtimeCallers).toBe(1)
    expect(report.warnings).toHaveLength(0)
  })

  it("rolls back and records warning on batch failure", async () => {
    const pool = mkPool({
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string) => {
          if (sql.includes("BEGIN")) return { rows: [] }
          if (sql.includes("INSERT INTO symbol")) throw new Error("db error")
          return { rows: [] }
        }),
        release: vi.fn(),
      })),
    })
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, {
      symbols: [{ kind: "function", name: "foo" }],
    })
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(report.warnings[0]).toContain("db error")
  })

  it("handles empty batch without errors", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, {})
    expect(report.inserted.symbols).toBe(0)
    expect(report.inserted.edges).toBe(0)
    expect(report.warnings).toHaveLength(0)
  })
})
