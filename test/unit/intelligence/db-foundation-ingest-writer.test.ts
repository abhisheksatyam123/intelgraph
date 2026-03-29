import { describe, expect, it, vi, beforeEach } from "vitest"
import { PostgresDbFoundation } from "../../../src/intelligence/db/postgres/client.js"
import { PostgresSnapshotIngestWriter, classifyAndStoreInvocationType } from "../../../src/intelligence/db/postgres/ingest-writer.js"
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
      if (sql.includes("INSERT INTO api_timer_trigger")) return { rows: [] }
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

  it("writes timer trigger rows and returns correct inserted count", async () => {
    const pool = mkPool()
    const writer = new PostgresSnapshotIngestWriter(pool)
    const report = await writer.writeSnapshotBatch(42, {
      timerTriggers: [
        {
          apiName: "wlan_bpf_traffic_timer_handler",
          timerIdentifierName: "bpf_traffic_watchdog_timer",
          timerTriggerConditionDescription: "Periodic traffic watchdog timer expiry every 500ms",
          timerTriggerConfidenceScore: 0.99,
          derivation: "runtime",
          evidence: { sourceKind: "file_line", location: { filePath: "bpf_traffic.c", line: 139 } },
        },
        {
          apiName: "wlan_scan_timer_handler",
          timerIdentifierName: "wlan_scan_periodic_timer",
          timerTriggerConfidenceScore: 0.95,
          derivation: "clangd",
        },
      ],
    })
    expect(report.snapshotId).toBe(42)
    expect(report.inserted.timerTriggers).toBe(2)
    expect(report.inserted.symbols).toBe(0)
    expect(report.warnings).toHaveLength(0)

    const client = await (pool.connect as ReturnType<typeof import("vitest").vi.fn>).mock.results[0]?.value
    const timerCalls = (client.query as ReturnType<typeof import("vitest").vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO api_timer_trigger"),
    )
    expect(timerCalls).toHaveLength(2)
    expect(timerCalls[0]![1]).toEqual([
      42,
      "wlan_bpf_traffic_timer_handler",
      "bpf_traffic_watchdog_timer",
      "Periodic traffic watchdog timer expiry every 500ms",
      0.99,
      "runtime",
      expect.stringContaining("bpf_traffic.c"),
    ])
    expect(timerCalls[1]![1]).toEqual([
      42,
      "wlan_scan_timer_handler",
      "wlan_scan_periodic_timer",
      null,
      0.95,
      "clangd",
      null,
    ])
  })
})

// ---------------------------------------------------------------------------
// classifyAndStoreInvocationType helper tests
// ---------------------------------------------------------------------------

describe("classifyAndStoreInvocationType", () => {
  it("maps 'calls' edge_kind to runtime_direct_call", () => {
    expect(classifyAndStoreInvocationType("calls")).toBe("runtime_direct_call")
  })

  it("maps 'registers_callback' edge_kind to runtime_callback_registration_call", () => {
    expect(classifyAndStoreInvocationType("registers_callback")).toBe("runtime_callback_registration_call")
  })

  it("maps 'indirect_calls' edge_kind to runtime_function_pointer_call", () => {
    expect(classifyAndStoreInvocationType("indirect_calls")).toBe("runtime_function_pointer_call")
  })

  it("maps 'dispatches_to' edge_kind to runtime_dispatch_table_call", () => {
    expect(classifyAndStoreInvocationType("dispatches_to")).toBe("runtime_dispatch_table_call")
  })

  it("maps unknown edge_kind to runtime_unknown_call_path", () => {
    expect(classifyAndStoreInvocationType("reads_field")).toBe("runtime_unknown_call_path")
    expect(classifyAndStoreInvocationType("writes_field")).toBe("runtime_unknown_call_path")
    expect(classifyAndStoreInvocationType("operates_on_struct")).toBe("runtime_unknown_call_path")
    expect(classifyAndStoreInvocationType("")).toBe("runtime_unknown_call_path")
    expect(classifyAndStoreInvocationType("unknown_edge_kind")).toBe("runtime_unknown_call_path")
  })
})

// ---------------------------------------------------------------------------
// invocation_type_classification stored in metadata JSONB during edge ingest
// ---------------------------------------------------------------------------

describe("PostgresSnapshotIngestWriter — invocation type in metadata", () => {
  function mkPoolCapturingEdgeCalls() {
    const edgeCalls: unknown[][] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) {
          return { rows: [{ id: "1" }] }
        }
        if (sql.includes("INSERT INTO semantic_edge")) {
          edgeCalls.push(params ?? [])
          return { rows: [] }
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as import("pg").Pool
    return { pool, edgeCalls, client }
  }

  it("stores runtime_direct_call in metadata for 'calls' edge", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{ edgeKind: "calls", srcSymbolName: "foo", dstSymbolName: "bar", confidence: 1.0, derivation: "clangd" }],
    })
    expect(edgeCalls).toHaveLength(1)
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.invocation_type_classification).toBe("runtime_direct_call")
  })

  it("stores runtime_callback_registration_call in metadata for 'registers_callback' edge", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{ edgeKind: "registers_callback", srcSymbolName: "foo", dstSymbolName: "bar", confidence: 0.9, derivation: "clangd" }],
    })
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.invocation_type_classification).toBe("runtime_callback_registration_call")
  })

  it("stores runtime_function_pointer_call in metadata for 'indirect_calls' edge", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{ edgeKind: "indirect_calls", srcSymbolName: "foo", dstSymbolName: "bar", confidence: 0.7, derivation: "clangd" }],
    })
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.invocation_type_classification).toBe("runtime_function_pointer_call")
  })

  it("stores runtime_dispatch_table_call in metadata for 'dispatches_to' edge", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{ edgeKind: "dispatches_to", srcSymbolName: "foo", dstSymbolName: "bar", confidence: 0.8, derivation: "clangd" }],
    })
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.invocation_type_classification).toBe("runtime_dispatch_table_call")
  })

  it("stores runtime_unknown_call_path in metadata for unknown edge_kind", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{ edgeKind: "reads_field", srcSymbolName: "foo", dstSymbolName: "bar", confidence: 0.5, derivation: "clangd" }],
    })
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.invocation_type_classification).toBe("runtime_unknown_call_path")
  })

  it("preserves existing metadata fields when adding invocation_type_classification", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{
        edgeKind: "calls",
        srcSymbolName: "foo",
        dstSymbolName: "bar",
        confidence: 1.0,
        derivation: "clangd",
        metadata: { custom_field: "custom_value", priority: 42 },
      }],
    })
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.invocation_type_classification).toBe("runtime_direct_call")
    expect(metadata.custom_field).toBe("custom_value")
    expect(metadata.priority).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// access_path and source_location stored in metadata JSONB during edge ingest
// ---------------------------------------------------------------------------

describe("PostgresSnapshotIngestWriter — struct evidence parity fields in metadata", () => {
  function mkPoolCapturingEdgeCalls() {
    const edgeCalls: unknown[][] = []
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO evidence") && sql.includes("RETURNING")) {
          return { rows: [{ id: "1" }] }
        }
        if (sql.includes("INSERT INTO semantic_edge")) {
          edgeCalls.push(params ?? [])
          return { rows: [] }
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as import("pg").Pool
    return { pool, edgeCalls, client }
  }

  it("stores access_path in metadata JSONB when EdgeRow provides accessPath", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{
        edgeKind: "writes_field",
        srcSymbolName: "wlan_bpf_enable_filter",
        dstSymbolName: "bpf_vdev_t",
        confidence: 0.9,
        derivation: "clangd",
        accessPath: "bpf_vdev_t.state.filter_enabled",
      }],
    })
    expect(edgeCalls).toHaveLength(1)
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.access_path).toBe("bpf_vdev_t.state.filter_enabled")
  })

  it("stores source_location in metadata JSONB when EdgeRow provides sourceLocation", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{
        edgeKind: "reads_field",
        srcSymbolName: "wlan_bpf_check_filter_state",
        dstSymbolName: "bpf_vdev_t",
        confidence: 0.85,
        derivation: "clangd",
        sourceLocation: { sourceFilePath: "bpf_filter_offload.c", sourceLineNumber: 221 },
      }],
    })
    expect(edgeCalls).toHaveLength(1)
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.source_location).toEqual({ sourceFilePath: "bpf_filter_offload.c", sourceLineNumber: 221 })
  })

  it("stores both access_path and source_location when EdgeRow provides both", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{
        edgeKind: "operates_on_struct",
        srcSymbolName: "wlan_bpf_init_vdev_state",
        dstSymbolName: "bpf_vdev_t",
        confidence: 1.0,
        derivation: "clangd",
        accessPath: "bpf_vdev_t.state",
        sourceLocation: { sourceFilePath: "bpf_vdev_init.c", sourceLineNumber: 83 },
      }],
    })
    expect(edgeCalls).toHaveLength(1)
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata.access_path).toBe("bpf_vdev_t.state")
    expect(metadata.source_location).toEqual({ sourceFilePath: "bpf_vdev_init.c", sourceLineNumber: 83 })
    expect(metadata.invocation_type_classification).toBe("runtime_unknown_call_path")
  })

  it("does not include access_path or source_location keys when EdgeRow omits them", async () => {
    const { pool, edgeCalls } = mkPoolCapturingEdgeCalls()
    const writer = new PostgresSnapshotIngestWriter(pool)
    await writer.writeSnapshotBatch(1, {
      edges: [{
        edgeKind: "calls",
        srcSymbolName: "foo",
        dstSymbolName: "bar",
        confidence: 1.0,
        derivation: "clangd",
      }],
    })
    expect(edgeCalls).toHaveLength(1)
    const metadata = JSON.parse(edgeCalls[0]![7] as string)
    expect(metadata).not.toHaveProperty("access_path")
    expect(metadata).not.toHaveProperty("source_location")
    expect(metadata.invocation_type_classification).toBe("runtime_direct_call")
  })
})
