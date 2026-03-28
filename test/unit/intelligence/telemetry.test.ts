import { describe, expect, it } from "vitest"
import { IntelligenceTelemetry } from "../../../src/intelligence/telemetry.js"

describe("IntelligenceTelemetry", () => {
  it("records events and produces report with correct stage/outcome", () => {
    const t = new IntelligenceTelemetry()
    t.record({ stage: "db_lookup", outcome: "miss", snapshotId: 42, intent: "who_calls_api", detail: "no rows" })
    t.record({ stage: "clangd_enrichment", outcome: "success", snapshotId: 42, intent: "who_calls_api" })
    t.record({ stage: "persist_enrichment", outcome: "success", snapshotId: 42, intent: "who_calls_api" })
    t.record({ stage: "retry_lookup", outcome: "success", snapshotId: 42, intent: "who_calls_api" })
    const report = t.report("enriched", "db_miss_deterministic")
    expect(report.events).toHaveLength(4)
    expect(report.events[0]!.stage).toBe("db_lookup")
    expect(report.events[0]!.outcome).toBe("miss")
    expect(report.finalStatus).toBe("enriched")
    expect(report.provenancePath).toBe("db_miss_deterministic")
    expect(report.totalMs).toBeGreaterThanOrEqual(0)
  })

  it("classifyError returns actionable diagnostic for db_lookup", () => {
    const msg = IntelligenceTelemetry.classifyError("db_lookup", new Error("connection refused"))
    expect(msg).toContain("DB lookup failed")
    expect(msg).toContain("connection refused")
  })

  it("classifyError returns actionable diagnostic for graph_projection_sync", () => {
    const msg = IntelligenceTelemetry.classifyError("graph_projection_sync", new Error("neo4j timeout"))
    expect(msg).toContain("Neo4j projection sync failed")
    expect(msg).toContain("neo4j timeout")
  })

  it("classifyError returns actionable diagnostic for llm_enrichment", () => {
    const msg = IntelligenceTelemetry.classifyError("llm_enrichment", new Error("rate limit"))
    expect(msg).toContain("LLM enrichment failed")
    expect(msg).toContain("rate limit")
  })

  it("classifyError handles non-Error objects", () => {
    const msg = IntelligenceTelemetry.classifyError("persist_enrichment", "disk full")
    expect(msg).toContain("persistence write failed")
    expect(msg).toContain("disk full")
  })

  it("report includes all events in order", () => {
    const t = new IntelligenceTelemetry()
    const stages = ["validation", "db_lookup", "clangd_enrichment", "persist_enrichment"] as const
    for (const stage of stages) {
      t.record({ stage, outcome: "success", snapshotId: 1, intent: "who_calls_api" })
    }
    const report = t.report("hit", "db_hit")
    expect(report.events.map((e) => e.stage)).toEqual(stages)
  })

  it("error propagation: classifyError for orchestration_guard", () => {
    const msg = IntelligenceTelemetry.classifyError("orchestration_guard", new Error("guard limit exceeded"))
    expect(msg).toContain("orchestration guard exceeded")
  })
})
