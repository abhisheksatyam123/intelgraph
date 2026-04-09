/**
 * Regression tests for src/fixtures/schema-validator.ts
 *
 * Covers:
 *   1. Valid api fixture passes
 *   2. Missing/invalid kind fails
 *   3. Empty canonical_name fails
 *   4. Missing source.file fails
 *   5. Non-positive source.line fails
 *   6. Missing relation bucket fails
 *   7. Family-specific non-empty bucket rule violated
 *   8. All 11 family types pass with minimal valid fixture
 *   9. Empty description fails
 *  10. Optional contract field type checks
 */

import { describe, it, expect } from "vitest"
import { validateFixture, validateFixtureFile, validateCorpus } from "../../../src/fixtures/schema-validator"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = join(__dirname, "../../fixtures/c/wlan")

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_RELATIONS = {
  calls_in_direct: [],
  calls_in_runtime: [{ caller: "x", callee: "y", edge_kind: "call_runtime", edge_kind_verbose: "runtime_invokes_api" }],
  calls_out: [],
  registrations_in: [],
  registrations_out: [],
  structures: [],
  logs: [],
  owns: [],
  uses: [],
}

function makeApiFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "api",
    kind_verbose: "application_programming_interface",
    canonical_name: "test_api_fn",
    aliases: ["_test_api_fn"],
    source: { file: "wlan/src/test.c", line: 42 },
    description: "A test API function for validation purposes.",
    relations: { ...VALID_RELATIONS },
    contract: {
      required_relation_kinds: ["call_runtime"],
      required_directions: ["incoming"],
      minimum_counts: { who_calls_api: 1 },
    },
    ...overrides,
  }
}

function makeMinimalFixture(kind: string, relationsOverride: Record<string, unknown[]>): Record<string, unknown> {
  return {
    kind,
    kind_verbose: `${kind}_verbose`,
    canonical_name: `test_${kind}_entity`,
    aliases: [],
    source: { file: `wlan/src/${kind}.c`, line: 1 },
    description: `A minimal valid ${kind} fixture for schema validation.`,
    relations: {
      calls_in_direct: [],
      calls_in_runtime: [],
      calls_out: [],
      registrations_in: [],
      registrations_out: [],
      structures: [],
      logs: [],
      owns: [],
      uses: [],
      ...relationsOverride,
    },
  }
}

// ── Test 1: Valid api fixture passes ─────────────────────────────────────────

describe("validateFixture — valid api fixture", () => {
  it("passes for a well-formed api fixture", () => {
    const result = validateFixture(makeApiFixture())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

// ── Test 2: Missing/invalid kind ─────────────────────────────────────────────

describe("validateFixture — kind field", () => {
  it("fails when kind is missing", () => {
    const f = makeApiFixture()
    delete (f as Record<string, unknown>).kind
    const result = validateFixture(f)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "kind")).toBe(true)
  })

  it("fails when kind is an invalid value", () => {
    const result = validateFixture(makeApiFixture({ kind: "unknown_family" }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "kind" && e.message.includes("must be one of"))).toBe(true)
  })

  it("fails when kind is an empty string", () => {
    const result = validateFixture(makeApiFixture({ kind: "" }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "kind")).toBe(true)
  })

  it("fails when kind is a number", () => {
    const result = validateFixture(makeApiFixture({ kind: 42 }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "kind")).toBe(true)
  })
})

// ── Test 3: Empty canonical_name ─────────────────────────────────────────────

describe("validateFixture — canonical_name field", () => {
  it("fails when canonical_name is empty string", () => {
    const result = validateFixture(makeApiFixture({ canonical_name: "" }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "canonical_name")).toBe(true)
  })

  it("fails when canonical_name is missing", () => {
    const f = makeApiFixture()
    delete (f as Record<string, unknown>).canonical_name
    const result = validateFixture(f)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "canonical_name")).toBe(true)
  })

  it("fails when canonical_name is a number", () => {
    const result = validateFixture(makeApiFixture({ canonical_name: 123 }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "canonical_name")).toBe(true)
  })
})

// ── Test 4: Missing source.file ───────────────────────────────────────────────

describe("validateFixture — source.file field", () => {
  it("fails when source.file is missing", () => {
    const result = validateFixture(makeApiFixture({ source: { line: 42 } }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "source.file")).toBe(true)
  })

  it("fails when source.file is empty string", () => {
    const result = validateFixture(makeApiFixture({ source: { file: "", line: 42 } }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "source.file")).toBe(true)
  })

  it("fails when source is missing entirely", () => {
    const f = makeApiFixture()
    delete (f as Record<string, unknown>).source
    const result = validateFixture(f)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "source")).toBe(true)
  })
})

// ── Test 5: Non-positive source.line ─────────────────────────────────────────

describe("validateFixture — source.line field", () => {
  it("fails when source.line is 0", () => {
    const result = validateFixture(makeApiFixture({ source: { file: "wlan/src/test.c", line: 0 } }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "source.line")).toBe(true)
  })

  it("fails when source.line is negative", () => {
    const result = validateFixture(makeApiFixture({ source: { file: "wlan/src/test.c", line: -1 } }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "source.line")).toBe(true)
  })

  it("fails when source.line is a string", () => {
    const result = validateFixture(makeApiFixture({ source: { file: "wlan/src/test.c", line: "42" } }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "source.line")).toBe(true)
  })

  it("fails when source.line is a float", () => {
    const result = validateFixture(makeApiFixture({ source: { file: "wlan/src/test.c", line: 1.5 } }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "source.line")).toBe(true)
  })

  it("passes when source.line is a positive integer", () => {
    const result = validateFixture(makeApiFixture({ source: { file: "wlan/src/test.c", line: 1 } }))
    expect(result.valid).toBe(true)
  })
})

// ── Test 6: Missing relation bucket ──────────────────────────────────────────

describe("validateFixture — relations buckets", () => {
  it("fails when relations is missing entirely", () => {
    const f = makeApiFixture()
    delete (f as Record<string, unknown>).relations
    const result = validateFixture(f)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "relations")).toBe(true)
  })

  it("fails when a required bucket is missing", () => {
    const rel = { ...VALID_RELATIONS }
    delete (rel as Record<string, unknown>).calls_in_direct
    const result = validateFixture(makeApiFixture({ relations: rel }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "relations.calls_in_direct")).toBe(true)
  })

  it("fails when a bucket is not an array", () => {
    const result = validateFixture(makeApiFixture({ relations: { ...VALID_RELATIONS, calls_out: "not-an-array" } }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "relations.calls_out")).toBe(true)
  })

  it("fails when relations is not an object", () => {
    const result = validateFixture(makeApiFixture({ relations: "bad" }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "relations")).toBe(true)
  })
})

// ── Test 7: Family-specific non-empty bucket rule ─────────────────────────────

describe("validateFixture — family-specific non-empty bucket rules", () => {
  it("fails for api when calls_in_direct, calls_in_runtime, and registrations_in are all empty", () => {
    const rel = {
      ...VALID_RELATIONS,
      calls_in_direct: [],
      calls_in_runtime: [],
      registrations_in: [],
    }
    const result = validateFixture(makeApiFixture({ relations: rel }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("non-empty bucket"))).toBe(true)
  })

  it("passes for api when calls_in_runtime is non-empty", () => {
    const result = validateFixture(makeApiFixture())
    expect(result.valid).toBe(true)
  })

  it("passes for api when only calls_in_direct is non-empty", () => {
    const rel = {
      ...VALID_RELATIONS,
      calls_in_direct: [{ caller: "x", callee: "y", edge_kind: "call_direct", edge_kind_verbose: "static_direct_calls" }],
      calls_in_runtime: [],
      registrations_in: [],
    }
    const result = validateFixture(makeApiFixture({ relations: rel }))
    expect(result.valid).toBe(true)
  })

  it("fails for struct when structures is empty", () => {
    const result = validateFixture(
      makeMinimalFixture("struct", { structures: [] }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("non-empty bucket"))).toBe(true)
  })

  it("passes for struct when structures is non-empty", () => {
    const result = validateFixture(
      makeMinimalFixture("struct", {
        structures: [{ api: "x", struct: "y", field: "z", edge_kind: "mutate", edge_kind_verbose: "mutates_structure_state" }],
      }),
    )
    expect(result.valid).toBe(true)
  })

  it("fails for log_point when logs is empty", () => {
    const result = validateFixture(makeMinimalFixture("log_point", { logs: [] }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("non-empty bucket"))).toBe(true)
  })

  it("passes for log_point when logs is non-empty", () => {
    const result = validateFixture(
      makeMinimalFixture("log_point", {
        logs: [{ api: "x", log_format: "msg", edge_kind: "emit_log", edge_kind_verbose: "emits_runtime_log_event" }],
      }),
    )
    expect(result.valid).toBe(true)
  })
})

// ── Test 8: All 11 family types pass with minimal valid fixture ───────────────

describe("validateFixture — all 11 family types", () => {
  const familyMinRelations: Record<string, Record<string, unknown[]>> = {
    api: { calls_in_runtime: [{ caller: "x", callee: "y", edge_kind: "call_runtime", edge_kind_verbose: "runtime_invokes_api" }] },
    struct: { structures: [{ api: "x", struct: "y", field: "z", edge_kind: "mutate", edge_kind_verbose: "mutates_structure_state" }] },
    ring: {
      registrations_out: [{ registrar: "x", callback: "y", edge_kind: "register", edge_kind_verbose: "registers_callback_handler" }],
      uses: [{ api: "x", dep: "y", edge_kind: "use", edge_kind_verbose: "uses_dependency_entity" }],
    },
    hw_block: {
      registrations_out: [{ registrar: "x", callback: "y", edge_kind: "register", edge_kind_verbose: "registers_callback_handler" }],
      uses: [{ api: "x", dep: "y", edge_kind: "use", edge_kind_verbose: "uses_dependency_entity" }],
    },
    thread: {
      calls_in_runtime: [{ caller: "x", callee: "y", edge_kind: "call_runtime", edge_kind_verbose: "runtime_invokes_api" }],
      calls_out: [{ caller: "x", callee: "y", edge_kind: "call_direct", edge_kind_verbose: "static_direct_calls" }],
    },
    signal: { calls_in_runtime: [{ caller: "x", callee: "y", edge_kind: "call_runtime", edge_kind_verbose: "runtime_invokes_api" }] },
    interrupt: {
      calls_out: [{ caller: "x", callee: "y", edge_kind: "call_direct", edge_kind_verbose: "static_direct_calls" }],
      registrations_out: [{ registrar: "x", callback: "y", edge_kind: "register", edge_kind_verbose: "registers_callback_handler" }],
    },
    timer: {
      calls_out: [{ caller: "x", callee: "y", edge_kind: "call_direct", edge_kind_verbose: "static_direct_calls" }],
      registrations_out: [{ registrar: "x", callback: "y", edge_kind: "register", edge_kind_verbose: "registers_callback_handler" }],
    },
    dispatch_table: {
      calls_out: [{ caller: "x", callee: "y", edge_kind: "call_direct", edge_kind_verbose: "static_direct_calls" }],
    },
    message: {
      calls_in_runtime: [{ caller: "x", callee: "y", edge_kind: "call_runtime", edge_kind_verbose: "runtime_invokes_api" }],
      calls_out: [{ caller: "x", callee: "y", edge_kind: "call_direct", edge_kind_verbose: "static_direct_calls" }],
    },
    log_point: {
      logs: [{ api: "x", log_format: "msg", edge_kind: "emit_log", edge_kind_verbose: "emits_runtime_log_event" }],
    },
  }

  for (const [family, relOverride] of Object.entries(familyMinRelations)) {
    it(`passes for family '${family}' with minimal valid fixture`, () => {
      const result = validateFixture(makeMinimalFixture(family, relOverride))
      expect(result.valid, `family '${family}' should pass: ${JSON.stringify(result.errors)}`).toBe(true)
    })
  }
})

// ── Test 9: Empty description ─────────────────────────────────────────────────

describe("validateFixture — description field", () => {
  it("fails when description is empty string", () => {
    const result = validateFixture(makeApiFixture({ description: "" }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "description")).toBe(true)
  })

  it("fails when description is missing", () => {
    const f = makeApiFixture()
    delete (f as Record<string, unknown>).description
    const result = validateFixture(f)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "description")).toBe(true)
  })

  it("fails when description is a number", () => {
    const result = validateFixture(makeApiFixture({ description: 42 }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "description")).toBe(true)
  })

  it("warns when description is very short (< 10 chars)", () => {
    const result = validateFixture(makeApiFixture({ description: "Short" }))
    // "Short" is 5 chars — should warn but still be valid (non-empty)
    expect(result.warnings.some((w) => w.field === "description")).toBe(true)
  })
})

// ── Test 10: Optional contract field type checks ──────────────────────────────

describe("validateFixture — contract field types", () => {
  it("passes when contract is absent", () => {
    const f = makeApiFixture()
    delete (f as Record<string, unknown>).contract
    const result = validateFixture(f)
    expect(result.valid).toBe(true)
  })

  it("fails when contract.required_relation_kinds is not an array", () => {
    const result = validateFixture(
      makeApiFixture({
        contract: { required_relation_kinds: "call_runtime", required_directions: ["incoming"], minimum_counts: {} },
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "contract.required_relation_kinds")).toBe(true)
  })

  it("fails when contract.required_directions is not an array", () => {
    const result = validateFixture(
      makeApiFixture({
        contract: { required_relation_kinds: ["call_runtime"], required_directions: "incoming", minimum_counts: {} },
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "contract.required_directions")).toBe(true)
  })

  it("fails when contract.minimum_counts is not an object", () => {
    const result = validateFixture(
      makeApiFixture({
        contract: { required_relation_kinds: ["call_runtime"], required_directions: ["incoming"], minimum_counts: [1, 2] },
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "contract.minimum_counts")).toBe(true)
  })

  it("passes when contract has all valid fields", () => {
    const result = validateFixture(makeApiFixture())
    expect(result.valid).toBe(true)
  })
})

// ── Test 11: validateFixture handles non-object inputs ────────────────────────

describe("validateFixture — non-object inputs", () => {
  it("fails for null", () => {
    const result = validateFixture(null)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "(root)")).toBe(true)
  })

  it("fails for a string", () => {
    const result = validateFixture("not an object")
    expect(result.valid).toBe(false)
  })

  it("fails for an array", () => {
    const result = validateFixture([])
    expect(result.valid).toBe(false)
  })
})

// ── Test 12: validateFixtureFile — real fixture on disk ───────────────────────

describe("validateFixtureFile — real fixture", () => {
  it("passes for a real api fixture from the corpus", async () => {
    const path = join(FIXTURE_ROOT, "api", "wlan_thread_irq_route_wmac_tx.json")
    const result = await validateFixtureFile(path)
    expect(result.valid, `Expected valid but got errors: ${JSON.stringify(result.errors)}`).toBe(true)
  })

  it("returns error for a non-existent file", async () => {
    const result = await validateFixtureFile("/nonexistent/path/fixture.json")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === "(file)")).toBe(true)
  })
})

// ── Test 13: validateCorpus — api family directory ────────────────────────────

describe("validateCorpus — api family directory", () => {
  it("validates all api fixtures and reports summary", async () => {
    const apiDir = join(FIXTURE_ROOT, "api")
    const { results, summary } = await validateCorpus(apiDir)
    expect(summary.total).toBeGreaterThan(0)
    expect(summary.valid + summary.invalid).toBe(summary.total)
    // All real api fixtures should be valid
    expect(summary.invalid).toBe(0)
  })
})
