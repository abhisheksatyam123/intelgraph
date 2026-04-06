/**
 * Tests for report-emitter.ts
 *
 * Covers:
 * - formatMarkdownSummary: header, aggregate table, entity sections, CI badge
 * - emitJsonReport: writes valid JSON with correct schema
 * - emitMarkdownReport: writes file with expected sections
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatMarkdownSummary,
  emitJsonReport,
  emitMarkdownReport,
} from "../../../src/fixtures/report-emitter"
import type { ComparatorReport } from "../../../src/fixtures/fixture-comparator"

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePassReport(): ComparatorReport {
  return {
    run_id: "run-deadbeef",
    fixture_count: 2,
    entity_results: [
      {
        entity: "api_a",
        intent: "what_api_calls",
        bucket: "calls_out",
        diffs: [],
        ci_outcome: "pass",
        summary: { total_diffs: 0, fail_count: 0, warn_count: 0, pass_count: 0 },
      },
      {
        entity: "api_b",
        intent: "who_calls_api",
        bucket: "calls_in_direct",
        diffs: [],
        ci_outcome: "pass",
        summary: { total_diffs: 0, fail_count: 0, warn_count: 0, pass_count: 0 },
      },
    ],
    aggregate: {
      total_entities: 2,
      fail_entities: 0,
      warn_entities: 0,
      pass_entities: 2,
      ci_outcome: "pass",
    },
  }
}

function makeFailReport(): ComparatorReport {
  return {
    run_id: "run-cafebabe",
    fixture_count: 1,
    entity_results: [
      {
        entity: "broken_api",
        intent: "what_api_calls",
        bucket: "calls_out",
        diffs: [
          {
            field: "status",
            expected: "hit|enriched",
            actual: "miss",
            mismatch_type: "consistency",
            severity: "S0",
            rule_id: "CONSISTENCY_STATUS",
          },
        ],
        ci_outcome: "fail",
        summary: { total_diffs: 1, fail_count: 1, warn_count: 0, pass_count: 0 },
      },
    ],
    aggregate: {
      total_entities: 1,
      fail_entities: 1,
      warn_entities: 0,
      pass_entities: 0,
      ci_outcome: "fail",
    },
  }
}

function makeWarnReport(): ComparatorReport {
  return {
    run_id: "run-aabbccdd",
    fixture_count: 1,
    entity_results: [
      {
        entity: "warn_api",
        intent: "what_api_calls",
        bucket: "calls_out",
        diffs: [
          {
            field: "rel.calls_out",
            expected: null,
            actual: "test_api|extra_fn|call_direct",
            mismatch_type: "extra",
            severity: "S2",
            rule_id: "EXTRA_RELATION",
          },
        ],
        ci_outcome: "warn",
        summary: { total_diffs: 1, fail_count: 0, warn_count: 1, pass_count: 0 },
      },
    ],
    aggregate: {
      total_entities: 1,
      fail_entities: 0,
      warn_entities: 1,
      pass_entities: 0,
      ci_outcome: "warn",
    },
  }
}

// ── formatMarkdownSummary ─────────────────────────────────────────────────────

describe("formatMarkdownSummary", () => {
  it("includes run_id in header", () => {
    const md = formatMarkdownSummary(makePassReport())
    expect(md).toContain("run-deadbeef")
  })

  it("includes CI outcome badge for pass", () => {
    const md = formatMarkdownSummary(makePassReport())
    expect(md).toContain("PASS")
  })

  it("includes CI outcome badge for fail", () => {
    const md = formatMarkdownSummary(makeFailReport())
    expect(md).toContain("FAIL")
  })

  it("includes CI outcome badge for warn", () => {
    const md = formatMarkdownSummary(makeWarnReport())
    expect(md).toContain("WARN")
  })

  it("includes aggregate summary table", () => {
    const md = formatMarkdownSummary(makePassReport())
    expect(md).toContain("## Aggregate Summary")
    expect(md).toContain("Total entities")
    expect(md).toContain("Fail entities")
    expect(md).toContain("Warn entities")
    expect(md).toContain("Pass entities")
  })

  it("aggregate table shows correct counts for pass report", () => {
    const md = formatMarkdownSummary(makePassReport())
    // 2 total, 0 fail, 0 warn, 2 pass
    expect(md).toContain("| Total entities | 2 |")
    expect(md).toContain("| Fail entities | 0 |")
    expect(md).toContain("| Pass entities | 2 |")
  })

  it("aggregate table shows correct counts for fail report", () => {
    const md = formatMarkdownSummary(makeFailReport())
    expect(md).toContain("| Total entities | 1 |")
    expect(md).toContain("| Fail entities | 1 |")
    expect(md).toContain("| Pass entities | 0 |")
  })

  it("includes entity results section header", () => {
    const md = formatMarkdownSummary(makeFailReport())
    expect(md).toContain("## Entity Results")
  })

  it("includes entity name in per-entity section", () => {
    const md = formatMarkdownSummary(makeFailReport())
    expect(md).toContain("broken_api")
  })

  it("includes diff table headers when diffs exist", () => {
    const md = formatMarkdownSummary(makeFailReport())
    expect(md).toContain("| Field | Expected | Actual | Mismatch Type | Severity | Rule ID |")
  })

  it("includes diff row data", () => {
    const md = formatMarkdownSummary(makeFailReport())
    expect(md).toContain("consistency")
    expect(md).toContain("S0")
    expect(md).toContain("CONSISTENCY_STATUS")
  })

  it("includes intent and bucket in per-entity section", () => {
    const md = formatMarkdownSummary(makeFailReport())
    expect(md).toContain("what_api_calls")
    expect(md).toContain("calls_out")
  })

  it("no entity results section when all pass with no diffs", () => {
    const md = formatMarkdownSummary(makePassReport())
    // Entity Results section exists but no diff tables (no diffs to show)
    // The section header should still be present
    expect(md).toContain("## Entity Results")
  })

  it("includes fixture count in header", () => {
    const md = formatMarkdownSummary(makePassReport())
    expect(md).toContain("**Fixtures:** 2")
  })

  it("output is a non-empty string", () => {
    const md = formatMarkdownSummary(makePassReport())
    expect(typeof md).toBe("string")
    expect(md.length).toBeGreaterThan(0)
  })
})

// ── emitJsonReport ────────────────────────────────────────────────────────────

describe("emitJsonReport", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "report-emitter-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("writes valid JSON to disk", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.json")
    await emitJsonReport(report, outPath)
    const content = await readFile(outPath, "utf-8")
    const parsed = JSON.parse(content)
    expect(parsed).toBeDefined()
  })

  it("written JSON has correct run_id", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.json")
    await emitJsonReport(report, outPath)
    const parsed = JSON.parse(await readFile(outPath, "utf-8"))
    expect(parsed.run_id).toBe("run-deadbeef")
  })

  it("written JSON has correct fixture_count", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.json")
    await emitJsonReport(report, outPath)
    const parsed = JSON.parse(await readFile(outPath, "utf-8"))
    expect(parsed.fixture_count).toBe(2)
  })

  it("written JSON has aggregate section", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.json")
    await emitJsonReport(report, outPath)
    const parsed = JSON.parse(await readFile(outPath, "utf-8"))
    expect(parsed.aggregate).toBeDefined()
    expect(parsed.aggregate.ci_outcome).toBe("pass")
    expect(parsed.aggregate.total_entities).toBe(2)
  })

  it("written JSON has entity_results array", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.json")
    await emitJsonReport(report, outPath)
    const parsed = JSON.parse(await readFile(outPath, "utf-8"))
    expect(Array.isArray(parsed.entity_results)).toBe(true)
    expect(parsed.entity_results).toHaveLength(2)
  })

  it("written JSON is pretty-printed (has newlines)", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.json")
    await emitJsonReport(report, outPath)
    const content = await readFile(outPath, "utf-8")
    expect(content).toContain("\n")
  })
})

// ── emitMarkdownReport ────────────────────────────────────────────────────────

describe("emitMarkdownReport", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "report-emitter-md-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("writes Markdown file to disk", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.md")
    await emitMarkdownReport(report, outPath)
    const content = await readFile(outPath, "utf-8")
    expect(content.length).toBeGreaterThan(0)
  })

  it("written Markdown has header", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.md")
    await emitMarkdownReport(report, outPath)
    const content = await readFile(outPath, "utf-8")
    expect(content).toContain("# Comparator Report")
  })

  it("written Markdown has aggregate summary section", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.md")
    await emitMarkdownReport(report, outPath)
    const content = await readFile(outPath, "utf-8")
    expect(content).toContain("## Aggregate Summary")
  })

  it("written Markdown has entity results section", async () => {
    const report = makeFailReport()
    const outPath = join(tmpDir, "report.md")
    await emitMarkdownReport(report, outPath)
    const content = await readFile(outPath, "utf-8")
    expect(content).toContain("## Entity Results")
    expect(content).toContain("broken_api")
  })

  it("written Markdown has CI outcome badge", async () => {
    const report = makeFailReport()
    const outPath = join(tmpDir, "report.md")
    await emitMarkdownReport(report, outPath)
    const content = await readFile(outPath, "utf-8")
    expect(content).toContain("FAIL")
  })

  it("written Markdown has run_id", async () => {
    const report = makePassReport()
    const outPath = join(tmpDir, "report.md")
    await emitMarkdownReport(report, outPath)
    const content = await readFile(outPath, "utf-8")
    expect(content).toContain("run-deadbeef")
  })
})
