import { describe, it, expect } from "vitest"
import { generateCompletenessAudit, formatAuditReport, formatAuditReportJson, formatAuditReportMarkdown } from "../../../src/fixtures/completeness-audit"

describe("completeness-audit", () => {
  describe("generateCompletenessAudit", () => {
    it("loads all 60 API fixtures and generates audit report", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")

      expect(report).toBeDefined()
      expect(report.total_apis).toBe(60)
      expect(report.timestamp).toBeDefined()
    })

    it("calculates average completeness score across all APIs", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")

      expect(report.average_completeness_score).toBeGreaterThanOrEqual(0)
      expect(report.average_completeness_score).toBeLessThanOrEqual(100)
    })

    it("identifies per-API tier completeness", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")

      const totalApis =
        report.tier_distribution.tier1_only.count +
        report.tier_distribution.tier1_and_2.count +
        report.tier_distribution.tier1_and_2_and_3.count

      expect(totalApis).toBe(60)
    })

    it("calculates total relation count", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")

      const totalRelations = Object.values(report.relation_distribution).reduce(
        (a, b) => a + b,
        0,
      )
      expect(totalRelations).toBe(report.total_relations)
      expect(report.total_relations).toBeGreaterThan(0)
    })

    it("identifies APIs needing follow-up (< 70% completeness)", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")

      // All APIs in needing_followup should be < 70%
      report.apis_needing_followup.forEach((api) => {
        expect(api.completeness_score).toBeLessThan(70)
      })

      // Should have missing_relations array
      report.apis_needing_followup.forEach((api) => {
        expect(Array.isArray(api.missing_relations)).toBe(true)
      })
    })

    it("returns per-API scores sorted by completeness descending", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")

      for (let i = 0; i < report.per_api_scores.length - 1; i++) {
        expect(report.per_api_scores[i].completeness_score).toBeGreaterThanOrEqual(
          report.per_api_scores[i + 1].completeness_score,
        )
      }
    })
  })

  describe("formatAuditReport", () => {
    it("formats audit report with box-drawn characters", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")
      const formatted = formatAuditReport(report)

      expect(formatted).toContain("╔════════════════════════════════════════════════════════════════════════════╗")
      expect(formatted).toContain("║ FIXTURE COMPLETENESS AUDIT REPORT")
      expect(formatted).toContain("╚════════════════════════════════════════════════════════════════════════════╝")
    })

    it("includes all key metrics in formatted output", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")
      const formatted = formatAuditReport(report)

      expect(formatted).toContain(`Total APIs: ${report.total_apis}`)
      expect(formatted).toContain(`Average Completeness Score: ${report.average_completeness_score}%`)
      expect(formatted).toContain("Tier Distribution:")
      expect(formatted).toContain("Relation Distribution:")
    })

    it("includes APIs needing follow-up in formatted output", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")
      const formatted = formatAuditReport(report)

      if (report.apis_needing_followup.length > 0) {
        expect(formatted).toContain("APIs Needing Follow-up")
        report.apis_needing_followup.slice(0, 2).forEach((api) => {
          expect(formatted).toContain(api.name)
        })
      }
    })
  })

  describe("formatAuditReportJson", () => {
    it("formats audit report as valid JSON", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")
      const formatted = formatAuditReportJson(report)

      expect(() => JSON.parse(formatted)).not.toThrow()
      const parsed = JSON.parse(formatted)
      expect(parsed.total_apis).toBe(60)
    })
  })

  describe("formatAuditReportMarkdown", () => {
    it("formats audit report as markdown", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")
      const formatted = formatAuditReportMarkdown(report)

      expect(formatted).toContain("# WLAN Fixture Completeness Audit Report")
      expect(formatted).toContain("## Tier Distribution")
      expect(formatted).toContain("## Relation Distribution")
    })
  })

  describe("audit report structure", () => {
    it("provides complete per-API scoring information", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")

      report.per_api_scores.forEach((score) => {
        expect(score.name).toBeDefined()
        expect(score.tier1_complete).toBeDefined()
        expect(score.tier2_complete).toBeDefined()
        expect(score.tier3_complete).toBeDefined()
        expect(score.completeness_score).toBeGreaterThanOrEqual(0)
        expect(score.completeness_score).toBeLessThanOrEqual(100)
        expect(Array.isArray(score.missing_relations)).toBe(true)
        expect(score.relation_counts).toBeDefined()
      })
    })

    it("correctly identifies relation type counts", async () => {
      const report = await generateCompletenessAudit("test/fixtures/wlan/api")

      const dist = report.relation_distribution
      expect(dist.calls_in_direct).toBeGreaterThanOrEqual(0)
      expect(dist.calls_in_runtime).toBeGreaterThanOrEqual(0)
      expect(dist.calls_out).toBeGreaterThanOrEqual(0)
      expect(dist.registrations_in).toBeGreaterThanOrEqual(0)
      expect(dist.registrations_out).toBeGreaterThanOrEqual(0)
      expect(dist.structures).toBeGreaterThanOrEqual(0)
      expect(dist.logs).toBeGreaterThanOrEqual(0)
      expect(dist.owns).toBeGreaterThanOrEqual(0)
      expect(dist.uses).toBeGreaterThanOrEqual(0)
    })
  })
})
