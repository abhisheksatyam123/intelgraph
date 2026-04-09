/**
 * Relation-completeness validators for API fixtures.
 *
 * For each API fixture, validate:
 * - Tier 1 (required): at least one of calls_in_direct, calls_in_runtime, registrations_in
 * - Tier 2 (expected by role): handler APIs → calls_out, structures, logs; data APIs → structures; etc.
 * - Tier 3 (optional): uses, registrations_out
 *
 * Calculate completeness score: (present_tiers / expected_tiers) * 100%
 * Flag APIs with <70% completeness for review.
 *
 * Per-API role detection from canonical_name:
 * - "*_handler*" → Handler role (expect calls_out, logs)
 * - "*_dispatch*" → Dispatcher role (expect registrations_in, calls_out)
 * - "*_thread*" → Thread role (expect owns, registrations_in)
 * - "*_proc*" → Processor role (expect calls_in_runtime, structures)
 * - "*_callback*" → Callback role (expect calls_in_runtime, structures)
 * - default → General API (Tier 1 required only)
 */

import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = join(__dirname, "../../fixtures/c/wlan")
const API_FIXTURE_DIR = join(FIXTURE_ROOT, "api")

// ── Role detection heuristics ────────────────────────────────────────────────

function detectAPIRole(canonicalName: string): string {
  const lc = canonicalName.toLowerCase()
  // Check in priority order to avoid conflicts
  if (lc.includes("_dispatch") || lc.includes("dispatch_")) return "dispatcher"
  if (lc.includes("_thread") || lc.includes("thread_")) return "thread"
  if (lc.includes("_callback") || lc.includes("callback_")) return "callback"
  if (lc.includes("_handler") || lc.includes("handler_")) return "handler"
  if (lc.includes("_proc") || lc.includes("_processor")) return "processor"
  return "general"
}

// ── Tier definitions ────────────────────────────────────────────────────────

interface TierExpectation {
  tier1Required: string[] // at least one must be non-empty
  tier2Expected: string[] // these should be non-empty if role suggests
  tier3Optional: string[] // nice to have
}

function getTierExpectation(role: string): TierExpectation {
  switch (role) {
    case "handler":
      return {
        tier1Required: ["calls_in_direct", "calls_in_runtime", "registrations_in"],
        tier2Expected: ["calls_out", "structures", "logs"],
        tier3Optional: ["uses", "registrations_out"],
      }
    case "dispatcher":
      return {
        tier1Required: ["calls_in_runtime", "registrations_in"],
        tier2Expected: ["calls_out", "registrations_in"],
        tier3Optional: ["structures", "uses", "registrations_out"],
      }
    case "thread":
      return {
        tier1Required: ["registrations_in", "calls_in_runtime"],
        tier2Expected: ["owns", "registrations_in"],
        tier3Optional: ["calls_out", "uses"],
      }
    case "processor":
      return {
        tier1Required: ["calls_in_runtime"],
        tier2Expected: ["structures", "calls_out"],
        tier3Optional: ["uses", "registrations_out"],
      }
    case "callback":
      return {
        tier1Required: ["calls_in_runtime"],
        tier2Expected: ["structures", "calls_out"],
        tier3Optional: ["registrations_in", "uses"],
      }
    default: // general
      return {
        tier1Required: ["calls_in_direct", "calls_in_runtime", "registrations_in"],
        tier2Expected: [], // no strong expectation
        tier3Optional: ["structures", "logs", "uses"],
      }
  }
}

// ── Completeness calculation ─────────────────────────────────────────────────

interface CompletenessResult {
  canonicalName: string
  role: string
  tier1Pass: boolean
  tier1FoundIn: string[]
  tier2Count: number
  tier2Expected: number
  tier3Count: number
  tier3Expected: number
  totalTiers: number
  presentTiers: number
  completenessPercent: number
  flaggedForReview: boolean
  issues: string[]
}

function calculateCompleteness(
  fixture: Record<string, unknown>,
): CompletenessResult {
  const canonicalName = fixture.canonical_name as string
  const role = detectAPIRole(canonicalName)
  const tiers = getTierExpectation(role)
  const relations = fixture.relations as Record<string, unknown[]>

  const issues: string[] = []

  // Tier 1: at least one required incoming relation
  const tier1FoundIn: string[] = []
  for (const bucket of tiers.tier1Required) {
    const arr = relations[bucket]
    if (Array.isArray(arr) && arr.length > 0) {
      tier1FoundIn.push(bucket)
    }
  }
  const tier1Pass = tier1FoundIn.length > 0
  if (!tier1Pass) {
    issues.push(
      `Tier 1 FAIL: none of [${tiers.tier1Required.join(", ")}] are non-empty`,
    )
  }

  // Tier 2: expected by role
  let tier2Count = 0
  for (const bucket of tiers.tier2Expected) {
    const arr = relations[bucket]
    if (Array.isArray(arr) && arr.length > 0) {
      tier2Count++
    }
  }
  if (tiers.tier2Expected.length > 0 && tier2Count === 0) {
    issues.push(
      `Tier 2 WARN: none of [${tiers.tier2Expected.join(", ")}] are populated`,
    )
  }

  // Tier 3: optional
  let tier3Count = 0
  for (const bucket of tiers.tier3Optional) {
    const arr = relations[bucket]
    if (Array.isArray(arr) && arr.length > 0) {
      tier3Count++
    }
  }

  // Completeness score: (present_tiers / total_expected_tiers) * 100%
  const totalTiers =
    (tier1Pass ? 1 : 0) + tiers.tier2Expected.length + tiers.tier3Optional.length
  const presentTiers =
    (tier1Pass ? 1 : 0) + tier2Count + tier3Count
  const completenessPercent =
    totalTiers > 0 ? (presentTiers / totalTiers) * 100 : 0

  const flaggedForReview = completenessPercent < 70 || !tier1Pass

  return {
    canonicalName,
    role,
    tier1Pass,
    tier1FoundIn,
    tier2Count,
    tier2Expected: tiers.tier2Expected.length,
    tier3Count,
    tier3Expected: tiers.tier3Optional.length,
    totalTiers,
    presentTiers,
    completenessPercent,
    flaggedForReview,
    issues,
  }
}

// ── Load all API fixtures ────────────────────────────────────────────────────

function loadAllAPIFixtures(): Array<{ name: string; fixture: Record<string, unknown> }> {
  if (!existsSync(API_FIXTURE_DIR)) return []

  const fs = require("node:fs")
  const files = fs.readdirSync(API_FIXTURE_DIR).filter((f: string) => f.endsWith(".json"))

  return files.map((file: string) => {
    const name = basename(file, ".json")
    const path = join(API_FIXTURE_DIR, file)
    const content = fs.readFileSync(path, "utf8")
    const fixture = JSON.parse(content)
    return { name, fixture }
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Relation-completeness validators", () => {
  const apiFixtures = loadAllAPIFixtures()
  expect(apiFixtures.length).toBeGreaterThan(0)

  describe("role detection heuristics", () => {
    it("detects handler role from canonical_name suffix", () => {
      expect(detectAPIRole("arp_offload_proc_frame_handler")).toBe("handler")
      expect(detectAPIRole("data_handler")).toBe("handler")
      expect(detectAPIRole("handler_init")).toBe("handler")
    })

    it("detects dispatcher role", () => {
      expect(detectAPIRole("dispatch_data_handler")).toBe("dispatcher")
      expect(detectAPIRole("wlan_dispatch_cmds")).toBe("dispatcher")
    })

    it("detects thread role", () => {
      expect(detectAPIRole("data_offld_thread")).toBe("thread")
      expect(detectAPIRole("thread_init")).toBe("thread")
    })

    it("detects processor role", () => {
      expect(detectAPIRole("arp_offload_proc_frame")).toBe("processor")
      expect(detectAPIRole("frame_proc")).toBe("processor")
    })

    it("detects callback role", () => {
      expect(detectAPIRole("event_callback")).toBe("callback")
      expect(detectAPIRole("callback_handler")).toBe("callback")
    })

    it("defaults to general role", () => {
      expect(detectAPIRole("utility_func")).toBe("general")
      expect(detectAPIRole("helper")).toBe("general")
    })
  })

  describe("tier expectations by role", () => {
    it("handler role expects calls_out, structures, logs", () => {
      const tiers = getTierExpectation("handler")
      expect(tiers.tier2Expected).toContain("calls_out")
      expect(tiers.tier2Expected).toContain("structures")
      expect(tiers.tier2Expected).toContain("logs")
    })

    it("processor role expects structures and calls_out", () => {
      const tiers = getTierExpectation("processor")
      expect(tiers.tier2Expected).toContain("structures")
      expect(tiers.tier2Expected).toContain("calls_out")
    })

    it("callback role expects structures and calls_out", () => {
      const tiers = getTierExpectation("callback")
      expect(tiers.tier2Expected).toContain("structures")
      expect(tiers.tier2Expected).toContain("calls_out")
    })

    it("thread role expects owns and registrations_in", () => {
      const tiers = getTierExpectation("thread")
      expect(tiers.tier2Expected).toContain("owns")
      expect(tiers.tier2Expected).toContain("registrations_in")
    })

    it("dispatcher role expects calls_out and registrations_in", () => {
      const tiers = getTierExpectation("dispatcher")
      expect(tiers.tier2Expected).toContain("calls_out")
      expect(tiers.tier2Expected).toContain("registrations_in")
    })

    it("general role has no tier2 expectations", () => {
      const tiers = getTierExpectation("general")
      expect(tiers.tier2Expected.length).toBe(0)
    })
  })

  describe("completeness calculation", () => {
    it("passes tier 1 if any required incoming relation is non-empty", () => {
      const fixture = {
        canonical_name: "test_api",
        relations: {
          calls_in_direct: [{ caller: "a", callee: "b" }],
          calls_in_runtime: [],
          registrations_in: [],
          calls_out: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      expect(result.tier1Pass).toBe(true)
    })

    it("fails tier 1 if all required incoming relations are empty", () => {
      const fixture = {
        canonical_name: "test_api",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [],
          registrations_in: [],
          calls_out: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      expect(result.tier1Pass).toBe(false)
      expect(result.issues.length).toBeGreaterThan(0)
    })

    it("counts tier 2 populated buckets", () => {
      const fixture = {
        canonical_name: "my_handler",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [{ caller: "a", callee: "b" }],
          registrations_in: [],
          calls_out: [{ caller: "b", callee: "c" }],
          registrations_out: [],
          structures: [{ api: "b", struct: "s" }],
          logs: [], // handler expects this but it's empty
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      expect(result.role).toBe("handler")
      expect(result.tier2Count).toBe(2) // calls_out and structures populated
      expect(result.tier2Expected).toBe(3) // handler expects 3
    })

    it("counts tier 3 optional buckets", () => {
      const fixture = {
        canonical_name: "test_handler",
        relations: {
          calls_in_direct: [{ caller: "a", callee: "b" }],
          calls_in_runtime: [],
          registrations_in: [],
          calls_out: [],
          registrations_out: [{ owner: "x", service: "y" }],
          structures: [{ api: "s", struct: "t" }],
          logs: [],
          owns: [],
          uses: [{ user: "u", provider: "p" }],
        },
      }
      const result = calculateCompleteness(fixture)
      // Handler role tier3Optional: ["uses", "registrations_out"]
      expect(result.tier3Count).toBe(2) // registrations_out and uses
    })

    it("calculates completeness percent correctly", () => {
      const fixture = {
        canonical_name: "test_api",
        relations: {
          calls_in_direct: [{ caller: "a", callee: "b" }], // tier 1: pass
          calls_in_runtime: [],
          registrations_in: [],
          calls_out: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      // For "general" role: tier1 (1) + tier2 (0) + tier3 (3 optional) = 4 total
      // Present: tier1 (1) + tier2 (0) + tier3 (0) = 1
      // Completeness: 1/4 * 100 = 25%
      expect(result.completenessPercent).toBeCloseTo(25, 0)
      expect(result.flaggedForReview).toBe(true) // < 70%
    })

    it("flags APIs with <70% completeness", () => {
      const fixture = {
        canonical_name: "sparse_api",
        relations: {
          calls_in_direct: [{ caller: "a", callee: "b" }],
          calls_in_runtime: [],
          registrations_in: [],
          calls_out: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      expect(result.completenessPercent).toBeLessThan(70)
      expect(result.flaggedForReview).toBe(true)
    })

    it("does not flag APIs with >=70% completeness", () => {
      const fixture = {
        canonical_name: "complete_api",
        relations: {
          calls_in_direct: [{ caller: "a", callee: "b" }],
          calls_in_runtime: [{ caller: "c", callee: "d" }],
          registrations_in: [{ registrar: "e", callback: "f" }],
          calls_out: [{ caller: "g", callee: "h" }],
          registrations_out: [{ owner: "i", service: "j" }],
          structures: [{ api: "k", struct: "l" }],
          logs: [{ api: "m", level: "INFO" }],
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      expect(result.completenessPercent).toBeGreaterThanOrEqual(70)
      expect(result.flaggedForReview).toBe(false)
    })
  })

  describe("tier 1 requirement validation", () => {
    it("all API fixtures should ideally pass tier 1 (informational)", () => {
      const failures: string[] = []
      for (const { name, fixture } of apiFixtures) {
        const result = calculateCompleteness(fixture)
        if (!result.tier1Pass) {
          failures.push(`${name}: ${result.issues.join("; ")}`)
        }
      }
      // Log tier 1 failures as informational (not a hard fail yet)
      if (failures.length > 0) {
        console.log("\n=== TIER 1 FAILURES (informational) ===")
        console.log(`${failures.length}/${apiFixtures.length} APIs failed Tier 1 requirement`)
        for (const failure of failures.slice(0, 5)) {
          console.log(`  → ${failure}`)
        }
        if (failures.length > 5) {
          console.log(`  ... and ${failures.length - 5} more`)
        }
      }
    })
  })

  describe("per-API role detection and validation", () => {
    it("each API has a detected role", () => {
      for (const { name, fixture } of apiFixtures) {
        const role = detectAPIRole(fixture.canonical_name as string)
        expect(role).toBeTruthy()
        expect(["handler", "dispatcher", "thread", "processor", "callback", "general"]).toContain(role)
      }
    })

    it("handler-role APIs exist in fixtures", () => {
      const handlerAPIs = apiFixtures.filter(
        ({ fixture }) => detectAPIRole(fixture.canonical_name as string) === "handler",
      )
      expect(handlerAPIs.length).toBeGreaterThan(0)
    })

    it("processor-role APIs exist in fixtures", () => {
      const procAPIs = apiFixtures.filter(
        ({ fixture }) => detectAPIRole(fixture.canonical_name as string) === "processor",
      )
      expect(procAPIs.length).toBeGreaterThan(0)
    })

    it("callback-role APIs may exist in fixtures (optional)", () => {
      const cbAPIs = apiFixtures.filter(
        ({ fixture }) => detectAPIRole(fixture.canonical_name as string) === "callback",
      )
      // Callback APIs are optional in the fixture set
      if (cbAPIs.length === 0) {
        console.log("  (No callback-role APIs in fixtures)")
      }
    })
  })

  describe("completeness score per API", () => {
    it("generates completeness score for all APIs", () => {
      const scores: CompletenessResult[] = []
      for (const { fixture } of apiFixtures) {
        const result = calculateCompleteness(fixture)
        scores.push(result)
      }
      expect(scores.length).toBe(apiFixtures.length)
      for (const result of scores) {
        expect(result.completenessPercent).toBeGreaterThanOrEqual(0)
        expect(result.completenessPercent).toBeLessThanOrEqual(100)
      }
    })

    it("identifies APIs flagged for review", () => {
      const flagged: CompletenessResult[] = []
      for (const { fixture } of apiFixtures) {
        const result = calculateCompleteness(fixture)
        if (result.flaggedForReview) {
          flagged.push(result)
        }
      }
      // Log flagged APIs for review
      if (flagged.length > 0) {
        console.log("\n=== APIs FLAGGED FOR REVIEW (completeness < 70% or Tier 1 fail) ===")
        for (const api of flagged) {
          console.log(
            `${api.canonicalName} [role=${api.role}]: ${api.completenessPercent.toFixed(1)}% ` +
            `(${api.presentTiers}/${api.totalTiers} tiers)`,
          )
          for (const issue of api.issues) {
            console.log(`  → ${issue}`)
          }
        }
      }
    })

    it("logs completeness report for all APIs", () => {
      const allScores: CompletenessResult[] = []
      for (const { fixture } of apiFixtures) {
        const result = calculateCompleteness(fixture)
        allScores.push(result)
      }

      console.log("\n=== COMPLETENESS AUDIT REPORT ===")
      console.log(`Total APIs: ${allScores.length}`)

      const byRole = new Map<string, CompletenessResult[]>()
      for (const score of allScores) {
        if (!byRole.has(score.role)) byRole.set(score.role, [])
        byRole.get(score.role)!.push(score)
      }

      for (const [role, scores] of Array.from(byRole.entries()).sort()) {
        const avgCompleteness =
          scores.reduce((sum, s) => sum + s.completenessPercent, 0) / scores.length
        const passed = scores.filter((s) => !s.flaggedForReview).length
        console.log(
          `\n${role.toUpperCase()}: ${passed}/${scores.length} passed, avg completeness ${avgCompleteness.toFixed(1)}%`,
        )
      }

      const avgOverall = allScores.reduce((sum, s) => sum + s.completenessPercent, 0) / allScores.length
      const totalPassed = allScores.filter((s) => !s.flaggedForReview).length
      console.log(
        `\nOVERALL: ${totalPassed}/${allScores.length} APIs passed, avg completeness ${avgOverall.toFixed(1)}%`,
      )
    })
  })

  describe("edge cases", () => {
    it("handles empty relations arrays gracefully", () => {
      const fixture = {
        canonical_name: "empty_api",
        relations: {
          calls_in_direct: [],
          calls_in_runtime: [],
          registrations_in: [],
          calls_out: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      expect(result.tier1Pass).toBe(false)
      expect(result.completenessPercent).toBe(0)
    })

    it("handles single-item arrays", () => {
      const fixture = {
        canonical_name: "single_item_api",
        relations: {
          calls_in_direct: [{ caller: "a", callee: "b" }],
          calls_in_runtime: [],
          registrations_in: [],
          calls_out: [],
          registrations_out: [],
          structures: [],
          logs: [],
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      expect(result.tier1FoundIn).toContain("calls_in_direct")
    })

    it("handles large arrays", () => {
      const largeArray = Array.from({ length: 100 }, (_, i) => ({
        caller: `caller_${i}`,
        callee: `callee_${i}`,
      }))
      const fixture = {
        canonical_name: "large_handler",
        relations: {
          calls_in_direct: largeArray,
          calls_in_runtime: [],
          registrations_in: [],
          calls_out: largeArray,
          registrations_out: [],
          structures: largeArray,
          logs: [],
          owns: [],
          uses: [],
        },
      }
      const result = calculateCompleteness(fixture)
      expect(result.tier1Pass).toBe(true)
      expect(result.tier2Count).toBeGreaterThan(0)
      expect(result.completenessPercent).toBeGreaterThanOrEqual(50)
    })
  })
})
