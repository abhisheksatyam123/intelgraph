import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"

const schemaSql = readFileSync(new URL("../../../src/intelligence/db/postgres/schema.sql", import.meta.url), "utf8")

describe("postgres timer and log schema", () => {
  it("defines api_timer_trigger table with required columns", () => {
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS api_timer_trigger")
    expect(schemaSql).toContain("api_name                              TEXT NOT NULL")
    expect(schemaSql).toContain("timer_identifier_name                 TEXT NOT NULL")
    expect(schemaSql).toContain("timer_trigger_condition_description   TEXT")
    expect(schemaSql).toContain("timer_trigger_confidence_score        REAL NOT NULL DEFAULT 1.0")
    expect(schemaSql).toContain("derivation                            TEXT NOT NULL")
    expect(schemaSql).toContain("evidence                              JSONB")
  })

  it("defines api_timer_trigger lookup index on snapshot_id and api_name", () => {
    expect(schemaSql).toContain("CREATE INDEX IF NOT EXISTS api_timer_trigger_snapshot_api")
    expect(schemaSql).toContain("ON api_timer_trigger(snapshot_id, api_name)")
  })

  it("adds normalized_level column to api_log via idempotent DO block", () => {
    expect(schemaSql).toContain("normalized_level")
    expect(schemaSql).toContain("ALTER TABLE api_log ADD COLUMN normalized_level TEXT")
  })

  it("defines normalized_level CHECK constraint with all required enum values", () => {
    expect(schemaSql).toContain("'runtime_log_error'")
    expect(schemaSql).toContain("'runtime_log_warn'")
    expect(schemaSql).toContain("'runtime_log_info'")
    expect(schemaSql).toContain("'runtime_log_debug'")
    expect(schemaSql).toContain("'runtime_log_trace'")
    expect(schemaSql).toContain("'runtime_log_unknown'")
  })

  it("defines api_log normalized_level lookup index on snapshot_id, api_name, normalized_level", () => {
    expect(schemaSql).toContain("CREATE INDEX IF NOT EXISTS api_log_snapshot_api_normalized_level")
    expect(schemaSql).toContain("ON api_log(snapshot_id, api_name, normalized_level)")
  })

  it("defines schema_migration_version table for tracking applied migrations", () => {
    expect(schemaSql).toContain("CREATE TABLE IF NOT EXISTS schema_migration_version")
    expect(schemaSql).toContain("migration_name TEXT NOT NULL UNIQUE")
    expect(schemaSql).toContain("applied_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()")
  })
})
