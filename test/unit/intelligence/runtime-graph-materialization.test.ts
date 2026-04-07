import { describe, expect, it, vi } from "vitest"
import { IndirectCallerIngestionService } from "../../../src/intelligence/db/ingestion/indirect-caller-ingestion-service.js"
import { runtimeRows } from "../../../src/intelligence/db/graph-rows.js"
import type { RuntimeCallerRow } from "../../../src/intelligence/contracts/common.js"

function signalDispatchRow(): RuntimeCallerRow {
  return {
    targetApi: "wlan_thread_signal_route_wmac_rx",
    runtimeTrigger: "WMAC RX interrupt routes through RAC thread signal wrapper",
    dispatchChain: [
      "A_INUM_WMAC0_RX_OK",
      "WLAN_THREAD_RAC0",
      "WLAN_THREAD_SIG_WMAC_RX",
      "wlan_thread_signal_route_wmac_rx",
    ],
    immediateInvoker: "WLAN_THREAD_SIG_WMAC_RX",
    dispatchSite: {
      filePath: "wlan/syssw_platform/src/thread/wlan_thread.c",
      line: 1026,
    },
    confidence: 1,
    evidence: {
      sourceKind: "runtime_parser",
      location: {
        filePath: "wlan/syssw_platform/src/thread/wlan_thread.c",
        line: 1026,
      },
    },
    participants: [
      {
        name: "A_INUM_WMAC0_RX_OK",
        kind: "interrupt",
        role: "trigger",
        location: {
          filePath: "wlan/syssw_platform/src/thread/wlan_thread.c",
          line: 1026,
        },
      },
      {
        name: "WLAN_THREAD_RAC0",
        kind: "thread",
        role: "context",
        location: {
          filePath: "wlan/syssw_platform/src/thread/rac_thread.c",
          line: 392,
        },
      },
      {
        name: "WLAN_THREAD_SIG_WMAC_RX",
        kind: "signal",
        role: "invoker",
        location: {
          filePath: "wlan/syssw_platform/src/thread/rac_thread.c",
          line: 142,
        },
      },
      {
        name: "wlan_thread_signal_route_wmac_rx",
        kind: "function",
        role: "target",
        location: {
          filePath: "wlan/syssw_platform/src/thread/rac_thread.c",
          line: 54,
        },
      },
    ],
    targetKind: "function",
  }
}

describe("runtime graph materialization", () => {
  it("materializes participant-aware runtime nodes and chain edges", () => {
    const materialized = runtimeRows(7, signalDispatchRow())

    expect(materialized.nodes).toHaveLength(4)
    expect(materialized.nodes.map((node) => [node.canonical_name, node.kind])).toEqual([
      ["A_INUM_WMAC0_RX_OK", "interrupt"],
      ["WLAN_THREAD_RAC0", "thread"],
      ["WLAN_THREAD_SIG_WMAC_RX", "signal"],
      ["wlan_thread_signal_route_wmac_rx", "function"],
    ])

    expect(materialized.edges).toHaveLength(3)
    expect(materialized.edges.map((edge) => ({ id: edge.edge_id, src: edge.src_node_id, dst: edge.dst_node_id, kind: edge.metadata.runtime_call_kind }))).toEqual([
      {
        id: "graph_edge:7:runtime_chain:0:A_INUM_WMAC0_RX_OK:WLAN_THREAD_RAC0",
        src: "graph_node:7:runtime:interrupt:A_INUM_WMAC0_RX_OK",
        dst: "graph_node:7:runtime:thread:WLAN_THREAD_RAC0",
        kind: "runtime_chain_step",
      },
      {
        id: "graph_edge:7:runtime_chain:1:WLAN_THREAD_RAC0:WLAN_THREAD_SIG_WMAC_RX",
        src: "graph_node:7:runtime:thread:WLAN_THREAD_RAC0",
        dst: "graph_node:7:runtime:signal:WLAN_THREAD_SIG_WMAC_RX",
        kind: "runtime_chain_step",
      },
      {
        id: "graph_edge:7:runtime_invokes:WLAN_THREAD_SIG_WMAC_RX:wlan_thread_signal_route_wmac_rx",
        src: "graph_node:7:runtime:signal:WLAN_THREAD_SIG_WMAC_RX",
        dst: "graph_node:7:symbol:wlan_thread_signal_route_wmac_rx",
        kind: "runtime_observed",
      },
    ])

    expect(materialized.observation.node_id).toBe("graph_node:7:symbol:wlan_thread_signal_route_wmac_rx")
    expect(materialized.observation.payload.dispatch_chain).toEqual(signalDispatchRow().dispatchChain)
    expect(materialized.evidence?.edge_id).toBe("graph_edge:7:runtime_invokes:WLAN_THREAD_SIG_WMAC_RX:wlan_thread_signal_route_wmac_rx")
  })

  it("keeps backward-compatible placeholder materialization for minimal runtime rows", () => {
    const row: RuntimeCallerRow = {
      targetApi: "wlan_bpf_filter_offload_handler",
      runtimeTrigger: "Incoming RX packet dispatched by offload manager",
      dispatchChain: ["_offldmgr_enhanced_data_handler", "wlan_bpf_filter_offload_handler"],
      immediateInvoker: "_offldmgr_enhanced_data_handler",
      dispatchSite: {
        filePath: "wlan/protocol/src/cmn_infra/src/offload_mgr/offload_mgr_ext.c",
        line: 1098,
      },
      confidence: 0.9,
      targetKind: "function",
    }

    const materialized = runtimeRows(9, row)

    expect(materialized.nodes).toHaveLength(2)
    expect(materialized.nodes.map((node) => [node.canonical_name, node.kind])).toEqual([
      ["wlan_bpf_filter_offload_handler", "function"],
      ["_offldmgr_enhanced_data_handler", "unknown"],
    ])
    expect(materialized.edges).toHaveLength(1)
    expect(materialized.edges[0]?.src_node_id).toBe("graph_node:9:runtime:unknown:_offldmgr_enhanced_data_handler")
    expect(materialized.edges[0]?.dst_node_id).toBe("graph_node:9:symbol:wlan_bpf_filter_offload_handler")
    expect(materialized.observation.payload.immediate_invoker).toBe("_offldmgr_enhanced_data_handler")
  })

  it("writes deduplicated runtime nodes and edges through the ingestion service", async () => {
    const sink = {
      write: vi.fn(async () => {}),
    }
    const finder = {
      hasSymbol: vi.fn(async () => true),
    }
    const service = new IndirectCallerIngestionService(finder, sink)
    const row = signalDispatchRow()

    const report = await service.persistRuntimeChains(11, {
      linked: [row, row],
      unresolved: [],
      warnings: [],
    })

    expect(sink.write).toHaveBeenCalledTimes(1)
    const batch = sink.write.mock.calls[0]?.[0]
    expect(batch.nodes).toHaveLength(4)
    expect(batch.edges).toHaveLength(3)
    expect(batch.observations).toHaveLength(1)
    expect(batch.evidence).toHaveLength(1)
    expect(batch.nodes.map((node: { kind: string }) => node.kind)).toEqual([
      "interrupt",
      "thread",
      "signal",
      "function",
    ])
    expect(report.inserted.edges).toBe(3)
    expect(report.inserted.runtimeCallers).toBe(2)
  })
})
