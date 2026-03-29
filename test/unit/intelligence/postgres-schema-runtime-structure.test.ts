import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"

const schemaSql = readFileSync(new URL("../../../src/intelligence/db/postgres/schema.sql", import.meta.url), "utf8")

// Frozen structure-centric payload key fixtures.
// Invariant: every public output key must be >=3-word snake_case (regex: /^[a-z0-9]+(?:_[a-z0-9]+){2,}$/).
const STRUCTURE_CENTRIC_PAYLOAD_FIXTURES: Array<{ intent: string; keys: string[] }> = [
  {
    intent: "current_structure_runtime_writers_of_structure",
    keys: [
      "current_structure_runtime_writer_api_name",
      "current_structure_runtime_target_structure_name",
      "current_structure_runtime_structure_operation_type_classification",
      "current_structure_runtime_structure_operation_confidence_score",
      "current_structure_runtime_relation_derivation_source",
    ],
  },
  {
    intent: "current_structure_runtime_readers_of_structure",
    keys: [
      "current_structure_runtime_reader_api_name",
      "current_structure_runtime_target_structure_name",
      "current_structure_runtime_structure_operation_type_classification",
      "current_structure_runtime_structure_operation_confidence_score",
      "current_structure_runtime_relation_derivation_source",
    ],
  },
  {
    intent: "current_structure_runtime_initializers_of_structure",
    keys: [
      "current_structure_runtime_initializer_api_name",
      "current_structure_runtime_target_structure_name",
      "current_structure_runtime_structure_operation_type_classification",
      "current_structure_runtime_structure_operation_confidence_score",
      "current_structure_runtime_relation_derivation_source",
    ],
  },
  {
    intent: "current_structure_runtime_mutators_of_structure",
    keys: [
      "current_structure_runtime_mutator_api_name",
      "current_structure_runtime_target_structure_name",
      "current_structure_runtime_structure_operation_type_classification",
      "current_structure_runtime_structure_operation_confidence_score",
      "current_structure_runtime_relation_derivation_source",
    ],
  },
]

const THREE_WORD_SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+){2,}$/

describe("postgres runtime structure schema", () => {
  it("defines structure_runtime_relation table", () => {
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS structure_runtime_relation")
    expect(schemaSql).toContain("target_structure_name      TEXT NOT NULL")
    expect(schemaSql).toContain("structure_runtime_role     TEXT NOT NULL")
    expect(schemaSql).toContain("related_api_name           TEXT NOT NULL")
    expect(schemaSql).toContain("runtime_structure_evidence JSONB")
  })

  it("defines structure runtime lookup indexes", () => {
    expect(schemaSql).toContain("CREATE INDEX IF NOT EXISTS structure_runtime_relation_snapshot_target_role")
    expect(schemaSql).toContain("ON structure_runtime_relation(snapshot_id, target_structure_name, structure_runtime_role)")
    expect(schemaSql).toContain("CREATE INDEX IF NOT EXISTS structure_runtime_relation_snapshot_related_api")
    expect(schemaSql).toContain("ON structure_runtime_relation(snapshot_id, related_api_name, structure_runtime_role)")
  })

  it("structure-centric payload key fixtures: all keys are >=3-word snake_case", () => {
    for (const fixture of STRUCTURE_CENTRIC_PAYLOAD_FIXTURES) {
      for (const key of fixture.keys) {
        expect(
          key,
          `intent=${fixture.intent} key="${key}" must be >=3-word snake_case`,
        ).toMatch(THREE_WORD_SNAKE_CASE)
      }
    }
  })

  it("structure-centric payload fixtures cover all four roles: writers, readers, initializers, mutators", () => {
    const intents = STRUCTURE_CENTRIC_PAYLOAD_FIXTURES.map((f) => f.intent)
    expect(intents).toContain("current_structure_runtime_writers_of_structure")
    expect(intents).toContain("current_structure_runtime_readers_of_structure")
    expect(intents).toContain("current_structure_runtime_initializers_of_structure")
    expect(intents).toContain("current_structure_runtime_mutators_of_structure")
  })

  it("structure-centric payload fixtures: each intent has at least 5 keys", () => {
    for (const fixture of STRUCTURE_CENTRIC_PAYLOAD_FIXTURES) {
      expect(
        fixture.keys.length,
        `intent=${fixture.intent} must have >=5 payload keys`,
      ).toBeGreaterThanOrEqual(5)
    }
  })
})
