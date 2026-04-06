import { describe, it, expect } from "vitest"
import {
  scoreConfidence,
  aggregateFamilyConfidence,
  CONFIDENCE_WEIGHTS,
  CONFIDENCE_THRESHOLDS,
  type ConfidenceInput,
  type ConfidenceResult,
} from "../../../src/fixtures/confidence-scorer"

// Helper: build a perfect input
const perfect: ConfidenceInput = {
  coverage_score: 1.0,
  backend_match_score: 1.0,
  evidence_quality_score: 1.0,
  consistency_score: 1.0,
  has_s0_s1_mismatch: false,
}

// Helper: compute expected aggregate from weights
function expectedAggregate(input: ConfidenceInput): number {
  return (
    input.coverage_score * CONFIDENCE_WEIGHTS.coverage +
    input.backend_match_score * CONFIDENCE_WEIGHTS.backend_match +
    input.evidence_quality_score * CONFIDENCE_WEIGHTS.evidence_quality +
    input.consistency_score * CONFIDENCE_WEIGHTS.consistency
  )
}

describe("confidence-scorer", () => {
  describe("scoreConfidence — threshold edge tests", () => {
    it("all scores = 1.0 → aggregate = 1.0, ci_outcome = PASS", () => {
      const result = scoreConfidence(perfect)
      expect(result.aggregate_confidence).toBeCloseTo(1.0)
      expect(result.ci_outcome).toBe("PASS")
    })

    it("aggregate exactly 0.85 → PASS", () => {
      // Solve: 0.25*c + 0.35*b + 0.20*e + 0.20*k = 0.85
      // Use: c=1, b=1, e=0.75, k=1 → 0.25 + 0.35 + 0.15 + 0.20 = 0.95 — too high
      // Use: c=0.6, b=0.85, e=0.85, k=0.85 → 0.15 + 0.2975 + 0.17 + 0.17 = 0.7875 — too low
      // Construct directly: set all to produce exactly 0.85
      // 0.25*1 + 0.35*1 + 0.20*1 + 0.20*0.75 = 0.25+0.35+0.20+0.15 = 0.95 — no
      // 0.25*1 + 0.35*0.85 + 0.20*0.85 + 0.20*0.85 = 0.25+0.2975+0.17+0.17 = 0.8875 — no
      // Exact: 0.25*c + 0.35*b + 0.20*e + 0.20*k = 0.85
      // Set c=1, k=1, e=1, solve for b: 0.25 + 0.35b + 0.20 + 0.20 = 0.85 → 0.35b = 0.20 → b = 4/7
      const b = 0.20 / 0.35
      const input: ConfidenceInput = {
        coverage_score: 1.0,
        backend_match_score: b,
        evidence_quality_score: 1.0,
        consistency_score: 1.0,
        has_s0_s1_mismatch: false,
      }
      const agg = expectedAggregate(input)
      expect(agg).toBeCloseTo(0.85, 10)
      const result = scoreConfidence(input)
      expect(result.aggregate_confidence).toBeCloseTo(0.85, 10)
      expect(result.ci_outcome).toBe("PASS")
    })

    it("aggregate exactly 0.84 → WARN", () => {
      // 0.25*1 + 0.35*b + 0.20*1 + 0.20*1 = 0.84 → 0.35b = 0.19 → b = 0.19/0.35
      const b = 0.19 / 0.35
      const input: ConfidenceInput = {
        coverage_score: 1.0,
        backend_match_score: b,
        evidence_quality_score: 1.0,
        consistency_score: 1.0,
        has_s0_s1_mismatch: false,
      }
      const agg = expectedAggregate(input)
      expect(agg).toBeCloseTo(0.84, 10)
      const result = scoreConfidence(input)
      expect(result.ci_outcome).toBe("WARN")
    })

    it("aggregate exactly 0.70 → WARN", () => {
      // 0.25*1 + 0.35*b + 0.20*1 + 0.20*1 = 0.70 → 0.35b = 0.05 → b = 1/7
      const b = 0.05 / 0.35
      const input: ConfidenceInput = {
        coverage_score: 1.0,
        backend_match_score: b,
        evidence_quality_score: 1.0,
        consistency_score: 1.0,
        has_s0_s1_mismatch: false,
      }
      const agg = expectedAggregate(input)
      expect(agg).toBeCloseTo(0.70, 10)
      const result = scoreConfidence(input)
      expect(result.ci_outcome).toBe("WARN")
    })

    it("aggregate exactly 0.69 → FAIL", () => {
      // 0.25*1 + 0.35*b + 0.20*1 + 0.20*1 = 0.69 → 0.35b = 0.04 → b = 4/35
      const b = 0.04 / 0.35
      const input: ConfidenceInput = {
        coverage_score: 1.0,
        backend_match_score: b,
        evidence_quality_score: 1.0,
        consistency_score: 1.0,
        has_s0_s1_mismatch: false,
      }
      const agg = expectedAggregate(input)
      expect(agg).toBeCloseTo(0.69, 10)
      const result = scoreConfidence(input)
      expect(result.ci_outcome).toBe("FAIL")
    })

    it("has_s0_s1_mismatch = true → FAIL regardless of scores", () => {
      const result = scoreConfidence({ ...perfect, has_s0_s1_mismatch: true })
      expect(result.ci_outcome).toBe("FAIL")
      // aggregate is still 1.0 — override wins
      expect(result.aggregate_confidence).toBeCloseTo(1.0)
    })
  })

  describe("scoreConfidence — remediation hints", () => {
    it("coverage_score = 0.3 → includes coverage hint", () => {
      const result = scoreConfidence({ ...perfect, coverage_score: 0.3 })
      expect(result.remediation_hints).toContain(
        "Run enrichment pipeline to populate missing relation buckets",
      )
    })

    it("backend_match_score = 0.5 → includes backend_match hint", () => {
      const result = scoreConfidence({ ...perfect, backend_match_score: 0.5 })
      expect(result.remediation_hints).toContain(
        "Backend is missing fixture-expected relations — check DB snapshot freshness",
      )
    })

    it("evidence_quality_score = 0.5 → includes evidence_quality hint", () => {
      const result = scoreConfidence({ ...perfect, evidence_quality_score: 0.5 })
      expect(result.remediation_hints).toContain(
        "Relations have weak evidence — re-run enrichment with higher confidence threshold",
      )
    })

    it("consistency_score = 0.0 → includes consistency hint", () => {
      const result = scoreConfidence({ ...perfect, consistency_score: 0.0 })
      expect(result.remediation_hints).toContain(
        "Mock/live backend inconsistency detected — investigate DB query path",
      )
    })

    it("aggregate < 0.70 → includes aggregate threshold hint", () => {
      // All zeros → aggregate = 0
      const result = scoreConfidence({
        coverage_score: 0.0,
        backend_match_score: 0.0,
        evidence_quality_score: 0.0,
        consistency_score: 0.0,
        has_s0_s1_mismatch: false,
      })
      expect(result.remediation_hints).toContain(
        "Entity below release threshold — remediate before merge",
      )
    })

    it("all scores high → no hints", () => {
      const result = scoreConfidence(perfect)
      expect(result.remediation_hints).toHaveLength(0)
    })
  })

  describe("aggregateFamilyConfidence — aggregation tests", () => {
    it("mix of PASS/WARN/FAIL entities → correct family summary", () => {
      const results = [
        {
          entity: "api_a",
          family: "api",
          confidence: scoreConfidence(perfect),
        },
        {
          entity: "api_b",
          family: "api",
          confidence: scoreConfidence({
            coverage_score: 0.0,
            backend_match_score: 0.0,
            evidence_quality_score: 0.0,
            consistency_score: 0.0,
            has_s0_s1_mismatch: false,
          }),
        },
        {
          entity: "struct_a",
          family: "struct",
          confidence: scoreConfidence(perfect),
        },
      ]

      const summaries = aggregateFamilyConfidence(results)
      expect(summaries).toHaveLength(2)

      const apiSummary = summaries.find((s) => s.family === "api")!
      expect(apiSummary).toBeDefined()
      expect(apiSummary.entity_count).toBe(2)
      expect(apiSummary.avg_confidence).toBeCloseTo(0.5, 5)

      const structSummary = summaries.find((s) => s.family === "struct")!
      expect(structSummary).toBeDefined()
      expect(structSummary.entity_count).toBe(1)
      expect(structSummary.avg_confidence).toBeCloseTo(1.0, 5)
      expect(structSummary.ci_outcome).toBe("PASS")
    })

    it("low_confidence_entities lists only entities below warn threshold (0.70)", () => {
      // api_a: aggregate = 1.0 (above warn)
      // api_b: aggregate = 0.0 (below warn)
      // api_c: aggregate = 0.69 (below warn)
      const b = 0.04 / 0.35
      const results = [
        { entity: "api_a", family: "api", confidence: scoreConfidence(perfect) },
        {
          entity: "api_b",
          family: "api",
          confidence: scoreConfidence({
            coverage_score: 0.0,
            backend_match_score: 0.0,
            evidence_quality_score: 0.0,
            consistency_score: 0.0,
            has_s0_s1_mismatch: false,
          }),
        },
        {
          entity: "api_c",
          family: "api",
          confidence: scoreConfidence({
            coverage_score: 1.0,
            backend_match_score: b,
            evidence_quality_score: 1.0,
            consistency_score: 1.0,
            has_s0_s1_mismatch: false,
          }),
        },
      ]

      const summaries = aggregateFamilyConfidence(results)
      const apiSummary = summaries.find((s) => s.family === "api")!
      expect(apiSummary.low_confidence_entities).toContain("api_b")
      expect(apiSummary.low_confidence_entities).toContain("api_c")
      expect(apiSummary.low_confidence_entities).not.toContain("api_a")
    })
  })

  describe("scoreConfidence — stability / determinism", () => {
    it("same input twice → identical output", () => {
      const input: ConfidenceInput = {
        coverage_score: 0.72,
        backend_match_score: 0.88,
        evidence_quality_score: 0.65,
        consistency_score: 1.0,
        has_s0_s1_mismatch: false,
      }
      const r1 = scoreConfidence(input)
      const r2 = scoreConfidence(input)
      expect(r1).toEqual(r2)
    })
  })

  describe("CONFIDENCE_WEIGHTS and CONFIDENCE_THRESHOLDS constants", () => {
    it("weights sum to 1.0", () => {
      const sum =
        CONFIDENCE_WEIGHTS.coverage +
        CONFIDENCE_WEIGHTS.backend_match +
        CONFIDENCE_WEIGHTS.evidence_quality +
        CONFIDENCE_WEIGHTS.consistency
      expect(sum).toBeCloseTo(1.0)
    })

    it("pass threshold > warn threshold", () => {
      expect(CONFIDENCE_THRESHOLDS.pass).toBeGreaterThan(CONFIDENCE_THRESHOLDS.warn)
    })
  })
})
