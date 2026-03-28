/**
 * Telemetry and error classification for orchestration and persistence layers.
 * Provides structured diagnostics for failures by stage and cause.
 */

export type TelemetryStage =
  | "validation"
  | "db_lookup"
  | "clangd_enrichment"
  | "c_parser_enrichment"
  | "llm_enrichment"
  | "persist_enrichment"
  | "graph_projection_sync"
  | "retry_lookup"
  | "orchestration_guard"

export type TelemetryOutcome = "success" | "miss" | "failed" | "skipped" | "guard_exceeded"

export interface TelemetryEvent {
  stage: TelemetryStage
  outcome: TelemetryOutcome
  snapshotId: number
  intent: string
  durationMs: number
  detail?: string
  error?: string
}

export interface TelemetryReport {
  events: TelemetryEvent[]
  totalMs: number
  finalStatus: string
  provenancePath: string
}

export class IntelligenceTelemetry {
  private events: TelemetryEvent[] = []
  private start = performance.now()

  record(event: Omit<TelemetryEvent, "durationMs"> & { durationMs?: number }) {
    this.events.push({
      durationMs: 0,
      ...event,
    })
  }

  report(finalStatus: string, provenancePath: string): TelemetryReport {
    return {
      events: this.events,
      totalMs: performance.now() - this.start,
      finalStatus,
      provenancePath,
    }
  }

  // Classify error by stage for actionable diagnostics
  static classifyError(stage: TelemetryStage, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err)
    switch (stage) {
      case "db_lookup":
        return `DB lookup failed: ${msg}`
      case "clangd_enrichment":
        return `clangd enrichment failed: ${msg}`
      case "c_parser_enrichment":
        return `c_parser enrichment failed: ${msg}`
      case "llm_enrichment":
        return `LLM enrichment failed: ${msg}`
      case "persist_enrichment":
        return `persistence write failed: ${msg}`
      case "graph_projection_sync":
        return `Neo4j projection sync failed: ${msg}`
      case "retry_lookup":
        return `retry lookup failed: ${msg}`
      case "orchestration_guard":
        return `orchestration guard exceeded: ${msg}`
      default:
        return `${stage} failed: ${msg}`
    }
  }
}
