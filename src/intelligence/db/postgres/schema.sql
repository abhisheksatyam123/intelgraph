-- PostgreSQL authoritative schema for intelligent-code-exploration-tool
-- All tables are snapshot-scoped: every row belongs to exactly one snapshot.

CREATE TABLE IF NOT EXISTS snapshot (
  id          BIGSERIAL PRIMARY KEY,
  workspace_root   TEXT NOT NULL,
  source_revision  TEXT,
  compile_db_hash  TEXT NOT NULL,
  parser_version   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','failed')),
  fail_reason      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata         JSONB
);

CREATE TABLE IF NOT EXISTS symbol (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_id     BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  qualified_name  TEXT,
  signature       TEXT,
  linkage         TEXT,
  file_path       TEXT,
  line            INT,
  col             INT,
  metadata        JSONB
);
CREATE INDEX IF NOT EXISTS symbol_snapshot_kind_name ON symbol(snapshot_id, kind, name);
CREATE INDEX IF NOT EXISTS symbol_snapshot_name ON symbol(snapshot_id, name);

CREATE TABLE IF NOT EXISTS c_type (
  id          BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  spelling    TEXT NOT NULL,
  size_bits   INT,
  align_bits  INT,
  symbol_name TEXT
);
CREATE INDEX IF NOT EXISTS c_type_snapshot_spelling ON c_type(snapshot_id, spelling);

CREATE TABLE IF NOT EXISTS aggregate_field (
  id                    BIGSERIAL PRIMARY KEY,
  snapshot_id           BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  aggregate_symbol_name TEXT NOT NULL,
  name                  TEXT NOT NULL,
  ordinal               INT NOT NULL,
  type_spelling         TEXT NOT NULL,
  bit_offset            INT,
  bit_width             INT,
  is_bitfield           BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS agg_field_snapshot_agg ON aggregate_field(snapshot_id, aggregate_symbol_name);

CREATE TABLE IF NOT EXISTS evidence (
  id          BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  file_path   TEXT,
  line        INT,
  col         INT,
  raw         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS semantic_edge (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_id     BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  edge_kind       TEXT NOT NULL,
  src_symbol_name TEXT,
  dst_symbol_name TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  derivation      TEXT NOT NULL,
  evidence_id     BIGINT REFERENCES evidence(id),
  metadata        JSONB
);
CREATE INDEX IF NOT EXISTS edge_snapshot_src ON semantic_edge(snapshot_id, src_symbol_name, edge_kind);
CREATE INDEX IF NOT EXISTS edge_snapshot_dst ON semantic_edge(snapshot_id, dst_symbol_name, edge_kind);

CREATE TABLE IF NOT EXISTS runtime_observation (
  id                BIGSERIAL PRIMARY KEY,
  snapshot_id       BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  target_api        TEXT NOT NULL,
  runtime_trigger   TEXT NOT NULL,
  dispatch_chain    JSONB NOT NULL,
  immediate_invoker TEXT NOT NULL,
  dispatch_site     JSONB,
  confidence        REAL NOT NULL DEFAULT 1.0,
  evidence          JSONB,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS runtime_obs_snapshot_api ON runtime_observation(snapshot_id, target_api);

CREATE TABLE IF NOT EXISTS api_log (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_id     BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  api_name        TEXT NOT NULL,
  level           TEXT NOT NULL,
  template        TEXT NOT NULL,
  subsystem       TEXT,
  file_path       TEXT,
  line            INT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  evidence        JSONB
);
CREATE INDEX IF NOT EXISTS api_log_snapshot_api ON api_log(snapshot_id, api_name);
CREATE INDEX IF NOT EXISTS api_log_snapshot_level ON api_log(snapshot_id, level);

-- Additive: normalized_level column for api_log (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_log' AND column_name = 'normalized_level'
  ) THEN
    ALTER TABLE api_log ADD COLUMN normalized_level TEXT CHECK (normalized_level IN (
      'runtime_log_error',
      'runtime_log_warn',
      'runtime_log_info',
      'runtime_log_debug',
      'runtime_log_trace',
      'runtime_log_unknown'
    ));
  END IF;
END$$;
CREATE INDEX IF NOT EXISTS api_log_snapshot_api_normalized_level ON api_log(snapshot_id, api_name, normalized_level);

CREATE TABLE IF NOT EXISTS schema_migration_version (
  id             SERIAL PRIMARY KEY,
  migration_name TEXT NOT NULL UNIQUE,
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_timer_trigger (
  id                                    BIGSERIAL PRIMARY KEY,
  snapshot_id                           BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  api_name                              TEXT NOT NULL,
  timer_identifier_name                 TEXT NOT NULL,
  timer_trigger_condition_description   TEXT,
  timer_trigger_confidence_score        REAL NOT NULL DEFAULT 1.0,
  derivation                            TEXT NOT NULL,
  evidence                              JSONB
);
CREATE INDEX IF NOT EXISTS api_timer_trigger_snapshot_api ON api_timer_trigger(snapshot_id, api_name);

CREATE TABLE IF NOT EXISTS structure_runtime_relation (
  id                         BIGSERIAL PRIMARY KEY,
  snapshot_id                BIGINT NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
  target_structure_name      TEXT NOT NULL,
  structure_runtime_role     TEXT NOT NULL,
  related_api_name           TEXT NOT NULL,
  confidence                 REAL NOT NULL DEFAULT 1.0,
  derivation                 TEXT NOT NULL,
  runtime_structure_evidence JSONB
);
CREATE INDEX IF NOT EXISTS structure_runtime_relation_snapshot_target_role
  ON structure_runtime_relation(snapshot_id, target_structure_name, structure_runtime_role);
CREATE INDEX IF NOT EXISTS structure_runtime_relation_snapshot_related_api
  ON structure_runtime_relation(snapshot_id, related_api_name, structure_runtime_role);
