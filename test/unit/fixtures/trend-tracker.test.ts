import { describe, it, expect } from "vitest"
import {
  analyzeTrend,
  createTrendEntry,
  isTrendConcern,
  formatTrendSummary,
  type TrendEntry,
  type TrendAnalysis,
} from "../../../src/fixtures/trend-tracker"

describe("trend-tracker — degradation band crossing", () => {
  describe("PASS to WARN threshold crossing", () => {
    it("confidence drops from 0.90 to 0.80 → crosses PASS→WARN", () => {
      const prior = createTrendEntry("run-1", 1000, 0.9, "none", 0)
      const current = createTrendEntry("run-2", 2000, 0.8, "S3", 1)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("PASS->WARN")
      expect(trend.verdict).toBe("THRESHOLD_BREACH")
      expect(trend.confidence_delta).toBeCloseTo(-0.1, 5)
      expect(isTrendConcern(trend)).toBe(true)
    })

    it("confidence drops from 0.95 to 0.84 → crosses PASS→WARN", () => {
      const prior = createTrendEntry("run-baseline", 1000, 0.95, "none", 0)
      const current = createTrendEntry("run-current", 2000, 0.84, "S3", 2)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("PASS->WARN")
      expect(trend.verdict).toBe("THRESHOLD_BREACH")
    })

    it("confidence exactly at 0.85 (boundary) → no crossing if prior was ≥0.85", () => {
      const prior = createTrendEntry("run-1", 1000, 0.85, "none", 0)
      const current = createTrendEntry("run-2", 2000, 0.85, "none", 0)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("none")
      expect(trend.verdict).toBe("STABLE")
    })

    it("confidence stays in PASS (0.90→0.87) → no crossing, no degradation", () => {
      const prior = createTrendEntry("run-1", 1000, 0.9, "none", 0)
      const current = createTrendEntry("run-2", 2000, 0.87, "none", 0)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("none")
      expect(trend.verdict).toBe("STABLE") // only 0.03 drop = stable
    })
  })

  describe("PASS to FAIL threshold crossing (direct drop)", () => {
    it("confidence drops from 0.95 to 0.60 → crosses PASS→FAIL", () => {
      const prior = createTrendEntry("run-baseline", 1000, 0.95, "none", 0)
      const current = createTrendEntry("run-broken", 2000, 0.6, "S1", 15)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("PASS->FAIL")
      expect(trend.verdict).toBe("THRESHOLD_BREACH")
      expect(isTrendConcern(trend)).toBe(true)
    })

    it("confidence drops from 0.90 to 0.69 → crosses PASS→FAIL", () => {
      const prior = createTrendEntry("run-1", 1000, 0.9, "none", 0)
      const current = createTrendEntry("run-2", 2000, 0.69, "S2", 8)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("PASS->FAIL")
      expect(trend.verdict).toBe("THRESHOLD_BREACH")
    })
  })

  describe("WARN to FAIL threshold crossing", () => {
    it("confidence drops from 0.75 to 0.65 → crosses WARN→FAIL", () => {
      const prior = createTrendEntry("run-1", 1000, 0.75, "S3", 2)
      const current = createTrendEntry("run-2", 2000, 0.65, "S2", 5)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("WARN->FAIL")
      expect(trend.verdict).toBe("THRESHOLD_BREACH")
    })

    it("confidence drops from 0.80 to 0.60 → crosses WARN→FAIL", () => {
      const prior = createTrendEntry("run-stable", 1000, 0.8, "S3", 1)
      const current = createTrendEntry("run-degraded", 2000, 0.6, "S1", 10)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("WARN->FAIL")
      expect(trend.verdict).toBe("THRESHOLD_BREACH")
    })

    it("confidence stays in WARN (0.75→0.72) → no crossing, stable", () => {
      const prior = createTrendEntry("run-1", 1000, 0.75, "S3", 2)
      const current = createTrendEntry("run-2", 2000, 0.72, "S3", 2)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("none")
      expect(trend.verdict).toBe("STABLE")
    })
  })

  describe("No crossing — degradation within band", () => {
    it("confidence drops 0.75→0.73 in WARN band → stable (small drop)", () => {
      const prior = createTrendEntry("run-1", 1000, 0.75, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.73, "S3", 2)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("none")
      expect(trend.verdict).toBe("STABLE") // only 0.02 drop = stable
    })

    it("confidence drops 0.80→0.75 in WARN band (5% drop) → degrading", () => {
      const prior = createTrendEntry("run-1", 1000, 0.8, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.75, "S3", 3)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("none")
      expect(trend.verdict).toBe("DEGRADING")
    })

    it("confidence drops 0.85→0.80 at boundary (5% drop) → degrading, stays in PASS", () => {
      const prior = createTrendEntry("run-1", 1000, 0.85, "none", 0)
      const current = createTrendEntry("run-2", 2000, 0.80, "S3", 1)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("PASS->WARN") // 0.80 < 0.85, so crosses boundary
      expect(trend.verdict).toBe("THRESHOLD_BREACH")
    })
  })

  describe("Severity escalation triggers degradation", () => {
    it("score stays same (0.80) but severity escalates S3→S2 → degrading", () => {
      const prior = createTrendEntry("run-1", 1000, 0.8, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.8, "S2", 3) // same score, worse severity

      const trend = analyzeTrend(prior, current)

      expect(trend.severity_escalated).toBe(true)
      expect(trend.verdict).toBe("DEGRADING")
    })

    it("score slight improvement (0.78→0.80) but severity escalates S3→S1 → degrading", () => {
      const prior = createTrendEntry("run-1", 1000, 0.78, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.8, "S1", 5)

      const trend = analyzeTrend(prior, current)

      expect(trend.severity_escalated).toBe(true)
      expect(trend.verdict).toBe("DEGRADING") // 0.02 improvement is not enough to override S3→S1 escalation
    })

    it("score S0 severity override → THRESHOLD_BREACH takes precedence", () => {
      const prior = createTrendEntry("run-1", 1000, 0.9, "none", 0)
      const current = createTrendEntry("run-2", 2000, 0.88, "S0", 1)

      const trend = analyzeTrend(prior, current)

      // Severity escalation alone wouldn't be threshold breach, but S0 is critical
      expect(trend.severity_escalated).toBe(true)
      expect(trend.verdict).toBe("DEGRADING") // 0.88 still in PASS
    })
  })

  describe("Improvement scenarios", () => {
    it("confidence improves from 0.70 to 0.80 → improving", () => {
      const prior = createTrendEntry("run-prev", 1000, 0.7, "S2", 5)
      const current = createTrendEntry("run-curr", 2000, 0.8, "S3", 1)

      const trend = analyzeTrend(prior, current)

      expect(trend.confidence_delta).toBeCloseTo(0.1, 5)
      expect(trend.verdict).toBe("IMPROVING")
      expect(isTrendConcern(trend)).toBe(false)
    })

    it("confidence improves from WARN to PASS (0.75→0.87) → improving, crosses boundary", () => {
      const prior = createTrendEntry("run-1", 1000, 0.75, "S3", 2)
      const current = createTrendEntry("run-2", 2000, 0.87, "none", 0)

      const trend = analyzeTrend(prior, current)

      expect(trend.confidence_delta).toBeCloseTo(0.12, 5)
      expect(trend.verdict).toBe("IMPROVING")
      expect(trend.ci_boundary_crossed).toBe("none") // improving, not worsening
      expect(isTrendConcern(trend)).toBe(false)
    })

    it("confidence improves from FAIL to WARN (0.60→0.72) → improving", () => {
      const prior = createTrendEntry("run-broken", 1000, 0.6, "S1", 10)
      const current = createTrendEntry("run-fixed", 2000, 0.72, "S2", 3)

      const trend = analyzeTrend(prior, current)

      expect(trend.verdict).toBe("IMPROVING")
      expect(isTrendConcern(trend)).toBe(false)
    })
  })

  describe("Edge cases and stability", () => {
    it("identical runs → stable verdict", () => {
      const prior = createTrendEntry("run-1", 1000, 0.8, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.8, "S3", 1)

      const trend = analyzeTrend(prior, current)

      expect(trend.confidence_delta).toBeCloseTo(0, 10)
      expect(trend.verdict).toBe("STABLE")
      expect(isTrendConcern(trend)).toBe(false)
    })

    it("all threshold boundary cases consistent across repeated calls", () => {
      const prior = createTrendEntry("run-1", 1000, 0.85, "none", 0)
      const current = createTrendEntry("run-2", 2000, 0.84, "S3", 1)

      const trend1 = analyzeTrend(prior, current)
      const trend2 = analyzeTrend(prior, current)

      expect(trend1.verdict).toBe(trend2.verdict)
      expect(trend1.ci_boundary_crossed).toBe(trend2.ci_boundary_crossed)
    })

    it("confidence = 0.70 exactly (WARN threshold) → no degradation if prior also 0.70", () => {
      const prior = createTrendEntry("run-1", 1000, 0.7, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.7, "S3", 1)

      const trend = analyzeTrend(prior, current)

      expect(trend.verdict).toBe("STABLE")
      expect(trend.ci_boundary_crossed).toBe("none")
    })

    it("confidence = 0.6999 (just below WARN) → crossing if prior ≥ 0.70", () => {
      const prior = createTrendEntry("run-1", 1000, 0.71, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.6999, "S2", 2)

      const trend = analyzeTrend(prior, current)

      expect(trend.ci_boundary_crossed).toBe("WARN->FAIL")
      expect(trend.verdict).toBe("THRESHOLD_BREACH")
    })
  })

  describe("formatTrendSummary", () => {
    it("formats threshold breach summary", () => {
      const prior = createTrendEntry("run-baseline", 1000, 0.9, "none", 0)
      const current = createTrendEntry("run-current", 2000, 0.65, "S1", 8)

      const trend = analyzeTrend(prior, current)
      const summary = formatTrendSummary(trend)

      expect(summary).toContain("run-baseline")
      expect(summary).toContain("run-current")
      expect(summary).toContain("PASS")
      expect(summary).toContain("FAIL")
      expect(summary).toContain("THRESHOLD_BREACH")
      expect(summary).toContain("⚠️")
    })

    it("formats stable trend summary", () => {
      const prior = createTrendEntry("run-1", 1000, 0.8, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.8, "S3", 1)

      const trend = analyzeTrend(prior, current)
      const summary = formatTrendSummary(trend)

      expect(summary).toContain("STABLE")
      expect(summary).not.toContain("⚠️")
    })
  })

  describe("Multi-run degradation sequences", () => {
    it("detects degradation: PASS → PASS (5% drop) → WARN", () => {
      const run1 = createTrendEntry("run-1", 1000, 0.95, "none", 0)
      const run2 = createTrendEntry("run-2", 2000, 0.88, "S3", 2)
      const run3 = createTrendEntry("run-3", 3000, 0.75, "S2", 5)

      const trend12 = analyzeTrend(run1, run2)
      const trend23 = analyzeTrend(run2, run3)

      expect(trend12.verdict).toBe("DEGRADING") // 7% drop, within PASS
      expect(trend12.ci_boundary_crossed).toBe("none")

      expect(trend23.verdict).toBe("THRESHOLD_BREACH") // crosses PASS→WARN
      expect(trend23.ci_boundary_crossed).toBe("PASS->WARN")
    })

    it("detects recovery: FAIL → WARN → PASS", () => {
      const runFail = createTrendEntry("run-fail", 1000, 0.6, "S1", 10)
      const runWarn = createTrendEntry("run-warn", 2000, 0.75, "S3", 2)
      const runPass = createTrendEntry("run-pass", 3000, 0.9, "none", 0)

      const trendFailWarn = analyzeTrend(runFail, runWarn)
      const trendWarnPass = analyzeTrend(runWarn, runPass)

      expect(trendFailWarn.verdict).toBe("IMPROVING")
      expect(trendWarnPass.verdict).toBe("IMPROVING")
    })
  })

  describe("Concern detection (isTrendConcern)", () => {
    it("returns true for threshold breach", () => {
      const prior = createTrendEntry("run-1", 1000, 0.9, "none", 0)
      const current = createTrendEntry("run-2", 2000, 0.69, "S2", 5)
      const trend = analyzeTrend(prior, current)
      expect(isTrendConcern(trend)).toBe(true)
    })

    it("returns true for degradation", () => {
      const prior = createTrendEntry("run-1", 1000, 0.8, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.75, "S3", 3)
      const trend = analyzeTrend(prior, current)
      expect(isTrendConcern(trend)).toBe(true)
    })

    it("returns false for stable", () => {
      const prior = createTrendEntry("run-1", 1000, 0.8, "S3", 1)
      const current = createTrendEntry("run-2", 2000, 0.8, "S3", 1)
      const trend = analyzeTrend(prior, current)
      expect(isTrendConcern(trend)).toBe(false)
    })

    it("returns false for improving", () => {
      const prior = createTrendEntry("run-1", 1000, 0.6, "S1", 10)
      const current = createTrendEntry("run-2", 2000, 0.8, "S3", 1)
      const trend = analyzeTrend(prior, current)
      expect(isTrendConcern(trend)).toBe(false)
    })
  })
})
