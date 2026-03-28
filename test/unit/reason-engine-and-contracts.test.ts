import { describe, expect, it } from "vitest"
import os from "os"
import path from "path"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { readReasoningConfig } from "../../src/tools/reason-engine/reason-config.js"
import { formatReasonChainText } from "../../src/tools/reason-engine/format-reason-chain.js"
import { toRuntimeFlowRecord } from "../../src/tools/reason-engine/runtime-flow.js"
import { buildRuntimeFlowPayload } from "../../src/tools/reason-engine/runtime-flow-output.js"
import { prepareReasonQuery } from "../../src/tools/reason-engine/reason-query.js"
import type { ReasonPath, RuntimeFlowRecord } from "../../src/tools/reason-engine/contracts.js"
import type { IQueryService } from "../../src/intelligence/contracts/query-service.js"
import type { IExtractionAdapter } from "../../src/intelligence/contracts/extraction-adapter.js"
import type { IDbFoundation, ISnapshotIngestWriter } from "../../src/intelligence/contracts/db-foundation.js"
import type { IIndirectCallerIngestion } from "../../src/intelligence/contracts/indirect-caller-ingestion.js"
import type { RuntimeCallerRow } from "../../src/intelligence/contracts/common.js"

describe("reason-engine modules are codebase-derived", () => {
  it("reads reasoning config defaults and overrides from real config module", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-reason-cfg-"))
    try {
      writeFileSync(
        path.join(dir, ".clangd-mcp.json"),
        JSON.stringify({ llmReasoning: { enabled: true, model: "m1", fallbackModels: ["m2"], maxCallsPerQuery: 9 } }),
      )
      const got = readReasoningConfig(dir)
      expect(got.enabled).toBe(true)
      expect(got.model).toBe("m1")
      expect(got.fallbackModels).toEqual(["m2"])
      expect(got.maxCallsPerQuery).toBe(9)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("converts invocation reason to runtime flow record", () => {
    const rec = toRuntimeFlowRecord("target", {
      runtimeTrigger: "rx packet",
      dispatchChain: ["a", "b", "target"],
      dispatchSite: { file: "/f.c", line: 10, snippet: "tbl[i].fn()" },
      registrationGate: { registrarFn: "r", registrationApi: "api", conditions: ["c1"] },
    }) as RuntimeFlowRecord
    expect(rec.targetApi).toBe("target")
    expect(rec.immediateInvoker).toBe("b")
  })

  it("formats reason chain and emits runtime-flow json fence", () => {
    const reasonPaths: ReasonPath[] = [
      {
        targetSymbol: "target",
        invocationReason: {
          runtimeTrigger: "event",
          dispatchChain: ["x", "target"],
          dispatchSite: { file: "/a.c", line: 1, snippet: "cb()" },
          registrationGate: { registrarFn: "reg", registrationApi: "api", conditions: ["ok"] },
        },
        gates: [],
        evidence: [],
        provenance: "deterministic",
        confidence: { score: 0.9, reasons: ["r"] },
      },
    ]
    const out = formatReasonChainText(
      { reasonPaths, usedLlm: false, rejected: 0, cacheHit: false, cacheMismatchedFiles: [] },
      "target",
      "/a.c",
      (p) => p,
    )
    expect(out).toContain("Invocation reason chain")
    expect(out).toContain("---runtime-flow-json---")
    expect(out).toContain("targetApi")
  })

  it("builds runtime-flow payload from reason paths", () => {
    const p = buildRuntimeFlowPayload("api", {
      reasonPaths: [
        {
          targetSymbol: "api",
          invocationReason: {
            runtimeTrigger: "evt",
            dispatchChain: ["f", "api"],
            dispatchSite: { file: "/b.c", line: 2, snippet: "fn()" },
          },
          gates: [],
          evidence: [],
          provenance: "deterministic",
          confidence: { score: 1, reasons: [] },
        },
      ],
      cacheHit: true,
      usedLlm: false,
      cacheMismatchedFiles: [],
    })
    expect(p.targetApi).toBe("api")
    expect(p.runtimeFlows.length).toBe(1)
  })

  it("prepares reason query from backend/client stubs", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clangd-mcp-reason-q-"))
    try {
      const file = path.join(dir, "x.c")
      writeFileSync(file, "int target_fn(int x) { return x; }\n")
      const backend = {
        patterns: {
          collectIndirectCallers: async () => ({
            seed: { name: "target_fn" },
            nodes: [{ file, line: 1, sourceText: "target_fn" }],
          }),
        },
      } as any
      const got = await prepareReasonQuery(backend, {} as any, { file, line: 1, character: 5 })
      expect(got.symbol).toBe("target_fn")
      expect(got.knownEvidence.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("intelligence contracts compile with realistic shapes", () => {
  it("query-service, extraction, db, ingestion contract signatures are satisfiable", async () => {
    const q: IQueryService = {
      async getCallers() { return { snapshotId: 1, apiName: "a", depth: 1, nodes: [], edges: [] } },
      async getCallees() { return { snapshotId: 1, apiName: "a", depth: 1, nodes: [], edges: [] } },
      async getEdgeProvenance() { return { edgeId: "e", evidence: [] } },
    }
    const x: IExtractionAdapter = {
      async extractSymbols() { return { symbols: [] } },
      async extractTypes() { return { types: [], fields: [] } },
      async extractEdges() { return { edges: [] } },
      async materializeSnapshot(snapshotId) {
        return { snapshotId, inserted: { symbols: 0, types: 0, fields: 0, edges: 0, runtimeCallers: 0 }, warnings: [] }
      },
    }
    const d: IDbFoundation = {
      async initSchema() {},
      async runMigrations() {},
      async beginSnapshot() { return { snapshotId: 1, createdAt: new Date().toISOString(), status: "building" } },
      async commitSnapshot() {},
      async failSnapshot() {},
      async withTransaction(fn) { return await fn({ async query() { return [] } }) },
    }
    const w: ISnapshotIngestWriter = {
      async writeSnapshotBatch(snapshotId) {
        return { snapshotId, inserted: { symbols: 0, types: 0, fields: 0, edges: 0, runtimeCallers: 0 }, warnings: [] }
      },
    }
    const i: IIndirectCallerIngestion = {
      async parseRuntimeCallers(input) { return { rows: input.records ?? [] } },
      async linkToSymbols(_sid, batch) { return { linked: batch.rows, unresolved: [], warnings: [] } },
      async persistRuntimeChains(snapshotId) {
        return { snapshotId, inserted: { symbols: 0, types: 0, fields: 0, edges: 0, runtimeCallers: 0 }, warnings: [] }
      },
    }

    const rows: RuntimeCallerRow[] = [{
      targetApi: "api",
      runtimeTrigger: "evt",
      dispatchChain: ["a", "api"],
      immediateInvoker: "a",
      dispatchSite: { filePath: "/a.c", line: 1 },
      confidence: 0.9,
    }]

    await q.getCallers("x")
    await x.extractSymbols({ workspaceRoot: "/ws" })
    await d.initSchema()
    await w.writeSnapshotBatch(1, { runtimeCallers: rows })
    const parsed = await i.parseRuntimeCallers({ workspaceRoot: "/ws", records: rows })
    const linked = await i.linkToSymbols(1, parsed)
    expect(linked.linked.length).toBe(1)
  })
})
