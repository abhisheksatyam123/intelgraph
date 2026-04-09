/**
 * Layer 1 + Layer 2 + Layer 4: Entity fixture schema validation, family-contract
 * validation, and coverage enforcement.
 *
 * These tests run entirely from the fixture corpus on disk — no backend, no mocks.
 *
 * Layer 1 — Schema validation
 *   Every fixture file is valid JSON with required base fields.
 *
 * Layer 2 — Entity-contract validation
 *   Each entity has the relation kinds required for its family.
 *
 * Layer 4 — Coverage enforcement
 *   Every supported entity kind has at least one fixture.
 *   The manifest lists every fixture file; orphan files fail.
 */

import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = join(__dirname, "../../fixtures/c/wlan")
const MANIFEST_PATH = join(FIXTURE_ROOT, "index.json")

// ── Supported entity families ─────────────────────────────────────────────────

const SUPPORTED_FAMILIES = [
  "api",
  "struct",
  "ring",
  "hw_block",
  "thread",
  "signal",
  "interrupt",
  "timer",
  "dispatch_table",
  "message",
  "log_point",
] as const

type EntityFamily = (typeof SUPPORTED_FAMILIES)[number]

// ── Canonical kind_verbose labels ─────────────────────────────────────────────

const KIND_VERBOSE: Record<EntityFamily, string> = {
  api: "application_programming_interface",
  struct: "structure_type",
  ring: "ring_endpoint",
  hw_block: "hardware_execution_block",
  thread: "thread_context",
  signal: "signal_trigger",
  interrupt: "interrupt_source",
  timer: "timer_trigger",
  dispatch_table: "dispatch_table",
  message: "inter_thread_message",
  log_point: "log_emission_point",
}

// ── Required relation buckets per family ──────────────────────────────────────

const FAMILY_REQUIRED_BUCKETS: Record<EntityFamily, string[]> = {
  api: ["calls_in_runtime", "calls_in_direct", "calls_out", "registrations_in", "structures", "logs"],
  struct: ["structures", "owns", "uses"],
  ring: ["registrations_out", "uses"],
  hw_block: ["registrations_out", "uses"],
  thread: ["calls_in_runtime", "calls_out", "registrations_out"],
  signal: ["calls_in_runtime"],
  interrupt: ["calls_out", "registrations_out"],
  timer: ["calls_out", "registrations_out"],
  dispatch_table: ["calls_out", "registrations_in"],
  message: ["calls_in_runtime", "calls_out"],
  log_point: ["logs"],
}

// ── Minimum required non-empty buckets per family ─────────────────────────────
// At least one of these buckets must be non-empty for the entity to be useful.

const FAMILY_MIN_NONEMPTY: Record<EntityFamily, string[]> = {
  api: ["calls_in_runtime", "calls_in_direct", "registrations_in"],
  struct: ["structures"],
  ring: ["registrations_out", "uses"],
  hw_block: ["registrations_out", "uses"],
  thread: ["calls_in_runtime", "calls_out"],
  signal: ["calls_in_runtime"],
  interrupt: ["calls_out", "registrations_out"],
  timer: ["calls_out", "registrations_out"],
  dispatch_table: ["calls_out"],
  message: ["calls_in_runtime", "calls_out"],
  log_point: ["logs"],
}

// ── Base required fields ──────────────────────────────────────────────────────

const BASE_REQUIRED_FIELDS = [
  "kind",
  "kind_verbose",
  "canonical_name",
  "aliases",
  "source",
  "relations",
  "contract",
] as const

const SOURCE_REQUIRED_FIELDS = ["file", "line"] as const

const CONTRACT_REQUIRED_FIELDS = [
  "required_relation_kinds",
  "required_directions",
  "minimum_counts",
] as const

const RELATIONS_REQUIRED_BUCKETS = [
  "calls_in_direct",
  "calls_in_runtime",
  "calls_out",
  "registrations_in",
  "registrations_out",
  "structures",
  "logs",
  "owns",
  "uses",
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadManifest(): { families: Record<string, string[]> } {
  expect(existsSync(MANIFEST_PATH), `Manifest not found at ${MANIFEST_PATH}`).toBe(true)
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
}

function loadFixture(family: string, name: string): Record<string, unknown> {
  const path = join(FIXTURE_ROOT, family, `${name}.json`)
  expect(existsSync(path), `Fixture not found: ${path}`).toBe(true)
  return JSON.parse(readFileSync(path, "utf8"))
}

function fixtureFilesInFamily(family: string): string[] {
  const dir = join(FIXTURE_ROOT, family)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
}

// ── Layer 4: Coverage enforcement ────────────────────────────────────────────

describe("Layer 4 — Coverage enforcement", () => {
  it("fixture root exists", () => {
    expect(existsSync(FIXTURE_ROOT)).toBe(true)
  })

  it("manifest exists and is valid JSON", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true)
    const manifest = loadManifest()
    expect(manifest).toHaveProperty("families")
    expect(typeof manifest.families).toBe("object")
  })

  it("every supported family has a directory", () => {
    for (const family of SUPPORTED_FAMILIES) {
      const dir = join(FIXTURE_ROOT, family)
      expect(existsSync(dir), `Missing fixture directory for family: ${family}`).toBe(true)
    }
  })

  it("every supported family has at least one fixture", () => {
    for (const family of SUPPORTED_FAMILIES) {
      const files = fixtureFilesInFamily(family)
      expect(files.length, `No fixtures found for family: ${family}`).toBeGreaterThan(0)
    }
  })

  it("manifest lists every fixture file (no orphans)", () => {
    const manifest = loadManifest()
    for (const family of SUPPORTED_FAMILIES) {
      const onDisk = fixtureFilesInFamily(family)
      const inManifest: string[] = manifest.families[family] ?? []
      for (const name of onDisk) {
        expect(
          inManifest.includes(name),
          `Orphan fixture: ${family}/${name}.json is not listed in manifest`,
        ).toBe(true)
      }
    }
  })

  it("manifest has no entries pointing to missing files", () => {
    const manifest = loadManifest()
    for (const family of SUPPORTED_FAMILIES) {
      const inManifest: string[] = manifest.families[family] ?? []
      for (const name of inManifest) {
        const path = join(FIXTURE_ROOT, family, `${name}.json`)
        expect(existsSync(path), `Manifest entry ${family}/${name} has no fixture file`).toBe(true)
      }
    }
  })
})

// ── Layer 1: Schema validation ────────────────────────────────────────────────

describe("Layer 1 — Schema validation", () => {
  const manifest = loadManifest()

  for (const family of SUPPORTED_FAMILIES) {
    const names: string[] = manifest.families[family] ?? []

    describe(`family: ${family}`, () => {
      for (const name of names) {
        describe(`entity: ${name}`, () => {
          let fixture: Record<string, unknown>

          it("fixture file is valid JSON with base fields", () => {
            fixture = loadFixture(family, name)
            for (const field of BASE_REQUIRED_FIELDS) {
              expect(fixture, `Missing base field '${field}' in ${family}/${name}`).toHaveProperty(field)
            }
          })

          it("kind matches family folder", () => {
            fixture = loadFixture(family, name)
            expect(fixture.kind, `kind mismatch in ${family}/${name}`).toBe(family)
          })

          it("kind_verbose matches canonical label", () => {
            fixture = loadFixture(family, name)
            expect(fixture.kind_verbose, `kind_verbose mismatch in ${family}/${name}`).toBe(
              KIND_VERBOSE[family as EntityFamily],
            )
          })

          it("canonical_name is a non-empty string", () => {
            fixture = loadFixture(family, name)
            expect(typeof fixture.canonical_name).toBe("string")
            expect((fixture.canonical_name as string).length).toBeGreaterThan(0)
          })

          it("aliases is an array", () => {
            fixture = loadFixture(family, name)
            expect(Array.isArray(fixture.aliases)).toBe(true)
          })

          it("source has required fields", () => {
            fixture = loadFixture(family, name)
            const source = fixture.source as Record<string, unknown>
            for (const field of SOURCE_REQUIRED_FIELDS) {
              expect(source, `Missing source.${field} in ${family}/${name}`).toHaveProperty(field)
            }
            expect(typeof source.file).toBe("string")
            expect(typeof source.line).toBe("number")
            expect(source.line as number).toBeGreaterThan(0)
          })

          it("relations has all required buckets", () => {
            fixture = loadFixture(family, name)
            const relations = fixture.relations as Record<string, unknown>
            for (const bucket of RELATIONS_REQUIRED_BUCKETS) {
              expect(relations, `Missing relations.${bucket} in ${family}/${name}`).toHaveProperty(bucket)
              expect(Array.isArray(relations[bucket]), `relations.${bucket} must be an array in ${family}/${name}`).toBe(true)
            }
          })

          it("contract has required fields", () => {
            fixture = loadFixture(family, name)
            const contract = fixture.contract as Record<string, unknown>
            for (const field of CONTRACT_REQUIRED_FIELDS) {
              expect(contract, `Missing contract.${field} in ${family}/${name}`).toHaveProperty(field)
            }
            expect(Array.isArray(contract.required_relation_kinds)).toBe(true)
            expect((contract.required_relation_kinds as unknown[]).length).toBeGreaterThan(0)
            expect(Array.isArray(contract.required_directions)).toBe(true)
            expect(typeof contract.minimum_counts).toBe("object")
          })
        })
      }
    })
  }
})

// ── Layer 2: Entity-contract validation ──────────────────────────────────────

describe("Layer 2 — Entity-contract validation", () => {
  const manifest = loadManifest()

  for (const family of SUPPORTED_FAMILIES) {
    const names: string[] = manifest.families[family] ?? []

    describe(`family: ${family}`, () => {
      for (const name of names) {
        describe(`entity: ${name}`, () => {
          it("has at least one non-empty required relation bucket for its family", () => {
            const fixture = loadFixture(family, name)
            const relations = fixture.relations as Record<string, unknown[]>
            const minBuckets = FAMILY_MIN_NONEMPTY[family as EntityFamily]
            const hasAny = minBuckets.some((bucket) => {
              const arr = relations[bucket]
              return Array.isArray(arr) && arr.length > 0
            })
            expect(
              hasAny,
              `${family}/${name}: none of the required buckets [${minBuckets.join(", ")}] are non-empty`,
            ).toBe(true)
          })

          it("contract.required_relation_kinds are valid edge kinds", () => {
            const fixture = loadFixture(family, name)
            const contract = fixture.contract as Record<string, unknown>
            const validKinds = new Set([
              "call_direct", "call_runtime", "register", "dispatch",
              "read", "write", "init", "mutate", "owner", "use",
              "inherit", "implement", "emit_log",
            ])
            for (const kind of contract.required_relation_kinds as string[]) {
              expect(validKinds.has(kind), `Invalid edge kind '${kind}' in ${family}/${name} contract`).toBe(true)
            }
          })

          it("contract.required_directions are valid", () => {
            const fixture = loadFixture(family, name)
            const contract = fixture.contract as Record<string, unknown>
            const validDirs = new Set(["incoming", "outgoing", "bidirectional"])
            for (const dir of contract.required_directions as string[]) {
              expect(validDirs.has(dir), `Invalid direction '${dir}' in ${family}/${name} contract`).toBe(true)
            }
          })

          it("every relation row has edge_kind and edge_kind_verbose", () => {
            const fixture = loadFixture(family, name)
            const relations = fixture.relations as Record<string, unknown[]>
            const validEdgeKinds = new Set([
              "call_direct", "call_runtime", "register", "dispatch",
              "read", "write", "init", "mutate", "owner", "use",
              "inherit", "implement", "emit_log",
            ])
            const validVerbose = new Set([
              "static_direct_calls", "runtime_invokes_api", "registers_callback_handler",
              "dispatches_execution_to_api", "reads_structure_field", "writes_structure_field",
              "initializes_structure_state", "mutates_structure_state", "owns_structure_entity",
              "uses_dependency_entity", "inherits_from_parent_type", "implemented_by_concrete_type",
              "emits_runtime_log_event",
            ])
            for (const bucket of Object.keys(relations)) {
              for (const row of relations[bucket] ?? []) {
                const r = row as Record<string, unknown>
                expect(
                  validEdgeKinds.has(r.edge_kind as string),
                  `Invalid edge_kind '${r.edge_kind}' in ${family}/${name}.relations.${bucket}`,
                ).toBe(true)
                expect(
                  validVerbose.has(r.edge_kind_verbose as string),
                  `Invalid edge_kind_verbose '${r.edge_kind_verbose}' in ${family}/${name}.relations.${bucket}`,
                ).toBe(true)
              }
            }
          })

          it("every relation row has an evidence object with kind and loc", () => {
            const fixture = loadFixture(family, name)
            const relations = fixture.relations as Record<string, unknown[]>
            const validEvidenceKinds = new Set([
              "call_expr", "fn_ptr_assign", "dispatch_table_entry",
              "register_call", "log_site", "field_access", "unknown",
            ])
            for (const bucket of Object.keys(relations)) {
              for (const row of relations[bucket] ?? []) {
                const r = row as Record<string, unknown>
                const ev = r.evidence as Record<string, unknown> | undefined
                if (!ev) continue
                expect(
                  validEvidenceKinds.has(ev.kind as string),
                  `Invalid evidence.kind '${ev.kind}' in ${family}/${name}.relations.${bucket}`,
                ).toBe(true)
                const loc = ev.loc as Record<string, unknown> | undefined
                if (loc) {
                  expect(typeof loc.file).toBe("string")
                  expect(typeof loc.line).toBe("number")
                }
              }
            }
          })

          it("family-specific required buckets are present in relations", () => {
            const fixture = loadFixture(family, name)
            const relations = fixture.relations as Record<string, unknown>
            const required = FAMILY_REQUIRED_BUCKETS[family as EntityFamily]
            for (const bucket of required) {
              expect(
                relations,
                `${family}/${name}: missing required bucket '${bucket}' for family ${family}`,
              ).toHaveProperty(bucket)
            }
          })
        })
      }
    })
  }
})
