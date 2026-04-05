/**
 * Layer 3: Backend reconciliation tests.
 *
 * For every entity fixture in the corpus, this suite:
 *   1. Builds mock DB rows from the fixture's relations section
 *   2. Injects them into the intelligence_query tool via setIntelligenceDeps
 *   3. Calls the tool with the entity's canonical name and each required intent
 *   4. Compares the backend response to the fixture's contract expectations
 *   5. Reports mismatches at (entity, relation_bucket, field) granularity
 *
 * Tests run entirely with mocked DB rows — no live backend required.
 * The fixture is the source of truth; the backend must match it.
 */

import { afterEach, describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { vi } from "vitest"
import { setIntelligenceDeps } from "../../../src/tools/index.js"
import type { NodeProtocolResponse } from "../../../src/intelligence/contracts/node-protocol.js"
import { tool, ctx } from "./test-kit.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = join(__dirname, "../../fixtures/wlan")
const MANIFEST_PATH = join(FIXTURE_ROOT, "index.json")

const t = tool("intelligence_query")
const { client, tracker } = ctx(t)

// ── Supported families ────────────────────────────────────────────────────────

const SUPPORTED_FAMILIES = [
  "api", "struct", "ring", "hw_block", "thread",
  "signal", "interrupt", "timer", "dispatch_table", "message", "log_point",
] as const

type EntityFamily = (typeof SUPPORTED_FAMILIES)[number]

// ── Intent map per family ─────────────────────────────────────────────────────
// Maps each family to the intelligence_query intents that should be exercised.

const FAMILY_INTENTS: Record<EntityFamily, string[]> = {
  api: [
    "who_calls_api",
    "who_calls_api_at_runtime",
    "what_api_calls",
    "show_registration_chain",
    "find_api_logs",
    "find_api_struct_reads",
    "find_api_struct_writes",
  ],
  struct: [
    "where_struct_modified",
    "where_struct_initialized",
    "find_struct_readers",
    "find_struct_writers",
    "find_struct_owners",
  ],
  ring: [
    "who_calls_api_at_runtime",
    "find_callback_registrars",
  ],
  hw_block: [
    "who_calls_api_at_runtime",
    "find_callback_registrars",
  ],
  thread: [
    "who_calls_api_at_runtime",
    "what_api_calls",
    "find_callback_registrars",
  ],
  signal: [
    "who_calls_api_at_runtime",
  ],
  interrupt: [
    "what_api_calls",
    "find_callback_registrars",
  ],
  timer: [
    "find_api_timer_triggers",
    "find_callback_registrars",
  ],
  dispatch_table: [
    "show_dispatch_sites",
    "find_callback_registrars",
  ],
  message: [
    "who_calls_api_at_runtime",
    "show_dispatch_sites",
  ],
  log_point: [
    "find_api_logs",
    "find_api_logs_by_level",
  ],
}

// ── Relation bucket → intent mapping ─────────────────────────────────────────
// Which relation buckets are expected to be non-empty for a given intent.

const INTENT_EXPECTED_BUCKETS: Record<string, string[]> = {
  who_calls_api: ["calls_in_direct", "calls_in_runtime"],
  who_calls_api_at_runtime: ["calls_in_runtime"],
  what_api_calls: ["calls_out"],
  show_registration_chain: ["registrations_in"],
  find_callback_registrars: ["registrations_in"],
  find_api_logs: ["logs"],
  find_api_logs_by_level: ["logs"],
  find_api_struct_reads: ["structures"],
  find_api_struct_writes: ["structures"],
  where_struct_modified: ["structures"],
  where_struct_initialized: ["structures"],
  find_struct_readers: ["structures"],
  find_struct_writers: ["structures"],
  find_struct_owners: ["owns"],
  show_dispatch_sites: ["calls_out"],
  find_api_timer_triggers: ["calls_out"],
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadManifest(): { families: Record<string, string[]> } {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
}

function loadFixture(family: string, name: string): Record<string, unknown> {
  const path = join(FIXTURE_ROOT, family, `${name}.json`)
  return JSON.parse(readFileSync(path, "utf8"))
}

/**
 * Map fixture edge_kind (protocol format) → DB edge_kind (storage format).
 * The DB layer uses its own edge_kind vocabulary; the node-adapter translates
 * them back to protocol format when building NodeProtocolResponse.
 */
const PROTOCOL_TO_DB_EDGE_KIND: Record<string, string> = {
  call_direct: "calls",
  call_runtime: "runtime_calls",
  register: "registers_callback",
  dispatch: "dispatches_to",
  read: "reads_field",
  write: "writes_field",
  init: "reads_field",
  mutate: "writes_field",
  owner: "owns",
  use: "operates_on_struct",
  inherit: "calls",
  implement: "calls",
  emit_log: "logs_event",
}

/**
 * Convert fixture relation rows into the flat DB row format expected by the
 * intelligence_query mock. The DB lookup returns rows with:
 *   - canonical_name, kind  — the primary node identity
 *   - file_path, line_number — source location (from GraphNode.location)
 *   - caller, callee — edge endpoints
 *   - edge_kind — DB-layer edge kind (calls, runtime_calls, registers_callback, etc.)
 *   - confidence, derivation
 *
 * The primary node identity depends on the DB query:
 *   - Incoming-edge queries (who_calls_api, etc.): canonical_name = caller/registrar
 *   - Outgoing-edge queries (what_api_calls, etc.): canonical_name = callee
 *   - Struct-accessor queries: canonical_name = accessor (the API), not the struct
 *   - Log queries: canonical_name = log_point node
 *
 * Since we use one shared mock row set for all intents, we include rows for
 * BOTH the entity itself and its related nodes, so the adapter can find the
 * right primary node for each intent.
 */
function fixtureRelationsToMockRows(fixture: Record<string, unknown>): Record<string, unknown>[] {
  const relations = fixture.relations as Record<string, unknown[]>
  const source = fixture.source as Record<string, unknown>
  const rows: Record<string, unknown>[] = []

  for (const bucket of Object.keys(relations)) {
    for (const row of relations[bucket] ?? []) {
      const r = row as Record<string, unknown>
      const protocolEdgeKind = String(r.edge_kind ?? "call_direct")
      const dbEdgeKind = PROTOCOL_TO_DB_EDGE_KIND[protocolEdgeKind] ?? "calls"

      // For each relation row, emit TWO mock rows:
      // 1. One with canonical_name = entity (for incoming-edge intents)
      // 2. One with canonical_name = related node (for outgoing-edge intents)
      // The adapter picks the right one based on the intent's query logic.

      const entityRow = {
        canonical_name: String(fixture.canonical_name),
        kind: fixture.kind,
        location: { filePath: String(source.file), line: Number(source.line) },
        file_path: String(source.file),
        line_number: Number(source.line),
        // Derive caller/callee from the most specific fields available in the fixture row
        caller: r.caller ?? r.api ?? r.registrar ?? r.owner ?? fixture.canonical_name,
        callee: r.callee ?? r.struct ?? r.callback ?? r.owned ?? fixture.canonical_name,
        registrar: r.registrar,
        callback: r.callback,
        api_name: r.api_name ?? r.api ?? fixture.canonical_name,
        struct_name: r.struct,
        timer_identifier_name: r.timer_identifier_name,
        edge_kind: dbEdgeKind,
        confidence: Number(r.confidence ?? 1.0),
        derivation: String(r.derivation ?? "clangd"),
        template: r.template,
        log_level: r.level,
        subsystem: r.subsystem,
        runtime_trigger: r.runtime_trigger,
        dispatch_chain: r.dispatch_chain,
      }
      rows.push(entityRow)

      // Also emit a row with canonical_name = callee for outgoing-edge intents
      const callee = r.callee
      if (callee && callee !== fixture.canonical_name) {
        rows.push({
          ...entityRow,
          canonical_name: String(callee),
          kind: "api", // callee is typically an API
        })
      }

      // For registration rows, also emit a row with canonical_name = registrar
      const registrar = r.registrar
      if (registrar && registrar !== fixture.canonical_name) {
        rows.push({
          ...entityRow,
          canonical_name: String(registrar),
          kind: "api",
        })
      }
    }
  }

  // Always include at least one row so the backend returns a hit
  if (rows.length === 0) {
    rows.push({
      canonical_name: String(fixture.canonical_name),
      kind: fixture.kind,
      location: { filePath: String(source.file), line: Number(source.line) },
      file_path: String(source.file),
      line_number: Number(source.line),
      caller: fixture.canonical_name,
      callee: fixture.canonical_name,
      edge_kind: "calls",
      confidence: 1.0,
      derivation: "clangd",
    })
  }

  return rows
}

function makeDeps(rows: Record<string, unknown>[]) {
  return {
    persistence: {
      dbLookup: {
        lookup: vi.fn(async (q: unknown) => {
          const req = q as { intent: string; snapshotId: number }
          return { hit: true, intent: req.intent, snapshotId: req.snapshotId, rows }
        }),
      },
      authoritativeStore: { persistEnrichment: vi.fn(async () => 0) },
      graphProjection: {
        syncFromAuthoritative: vi.fn(async () => ({ synced: true, nodesUpserted: 0, edgesUpserted: 0 })),
      },
    },
    clangdEnricher: {
      source: "clangd" as const,
      enrich: vi.fn(async () => ({ attempts: [{ source: "clangd" as const, status: "failed" as const }], persistedRows: 0 })),
    },
    cParserEnricher: {
      source: "c_parser" as const,
      enrich: vi.fn(async () => ({ attempts: [{ source: "c_parser" as const, status: "failed" as const }], persistedRows: 0 })),
    },
  }
}

async function runQuery(
  args: Record<string, unknown>,
  rows: Record<string, unknown>[],
): Promise<NodeProtocolResponse> {
  setIntelligenceDeps(makeDeps(rows) as never)
  const raw = await t.execute(args, client, tracker)
  const parsed = JSON.parse(raw) as { nodeProtocol?: NodeProtocolResponse } & NodeProtocolResponse
  return parsed.nodeProtocol ?? parsed
}

// ── Intent classification ─────────────────────────────────────────────────────
// Outgoing-edge intents: the primary node in the response is the CALLEE/target,
// not the entity itself. Skip entity identity checks for these.
const OUTGOING_EDGE_INTENTS = new Set([
  "what_api_calls",
  "show_dispatch_sites",
])

// Struct-accessor intents (struct-family only): the orchestrator transforms rows
// into legacy long-name format, stripping canonical_name/kind/loc. Skip identity
// and bucket checks; only verify status + items present.
const STRUCT_ACCESSOR_INTENTS = new Set([
  "where_struct_modified",
  "where_struct_initialized",
  "find_struct_readers",
  "find_struct_writers",
  "find_struct_owners",
])

// Timer-trigger intents: the primary node is the TIMER, not the triggered API.
const TIMER_TRIGGER_INTENTS = new Set([
  "find_api_timer_triggers",
])

interface Mismatch {
  entity: string
  family: string
  intent: string
  field: string
  expected: unknown
  actual: unknown
}

function reportMismatches(mismatches: Mismatch[]): string {
  if (mismatches.length === 0) return ""
  return mismatches
    .map((m) => `  [${m.family}/${m.entity}] intent=${m.intent} field=${m.field}: expected=${JSON.stringify(m.expected)} actual=${JSON.stringify(m.actual)}`)
    .join("\n")
}

// ── Layer 3: Backend reconciliation ──────────────────────────────────────────

afterEach(() => {
  setIntelligenceDeps(null as never)
})

describe("Layer 3 — Backend reconciliation", () => {
  const manifest = loadManifest()

  for (const family of SUPPORTED_FAMILIES) {
    const names: string[] = manifest.families[family] ?? []
    const intents = FAMILY_INTENTS[family]

    describe(`family: ${family}`, () => {
      for (const name of names) {
        describe(`entity: ${name}`, () => {
          const fixture = loadFixture(family, name)
          const mockRows = fixtureRelationsToMockRows(fixture)
          const contract = fixture.contract as Record<string, unknown>
          const source = fixture.source as Record<string, unknown>

          for (const intent of intents) {
            it(`intent: ${intent} — backend returns hit with correct identity`, async () => {
              const args: Record<string, unknown> = {
                intent,
                snapshotId: 1,
                apiName: fixture.canonical_name,
                structName: fixture.canonical_name,
                fieldName: "",
                traceId: "",
                pattern: "",
                logLevel: "DEBUG",
                srcApi: "",
                dstApi: "",
                depth: 2,
                limit: 50,
              }

              const response = await runQuery(args, mockRows)
              const mismatches: Mismatch[] = []

              // Status must be hit or enriched
              if (response.status !== "hit" && response.status !== "enriched") {
                mismatches.push({
                  entity: name, family, intent,
                  field: "status",
                  expected: "hit|enriched",
                  actual: response.status,
                })
              }

              // Must have at least one item
              if (!response.data?.items?.length) {
                mismatches.push({
                  entity: name, family, intent,
                  field: "data.items.length",
                  expected: ">0",
                  actual: 0,
                })
              } else {
                const allItems = response.data.items

                // Find the item that represents the entity itself.
                // For outgoing-edge intents, the entity may not be the first item.
                // For incoming-edge intents, the entity IS the primary node.
                const entityItem = allItems.find((it) => it.canonical_name === fixture.canonical_name)
                  ?? allItems[0]!

                // Identity checks: only for intents where the entity itself is the primary node.
                const skipIdentityCheck =
                  OUTGOING_EDGE_INTENTS.has(intent) ||
                  STRUCT_ACCESSOR_INTENTS.has(intent) ||
                  TIMER_TRIGGER_INTENTS.has(intent)

                if (!skipIdentityCheck && entityItem.canonical_name === fixture.canonical_name) {
                  // kind must match
                  if (entityItem.kind !== fixture.kind) {
                    mismatches.push({
                      entity: name, family, intent,
                      field: "kind",
                      expected: fixture.kind,
                      actual: entityItem.kind,
                    })
                  }

                  // kind_verbose must match
                  if (entityItem.kind_verbose !== fixture.kind_verbose) {
                    mismatches.push({
                      entity: name, family, intent,
                      field: "kind_verbose",
                      expected: fixture.kind_verbose,
                      actual: entityItem.kind_verbose,
                    })
                  }

                  // source location must match
                  if (entityItem.loc) {
                    if (entityItem.loc.file !== source.file) {
                      mismatches.push({
                        entity: name, family, intent,
                        field: "loc.file",
                        expected: source.file,
                        actual: entityItem.loc.file,
                      })
                    }
                    if (entityItem.loc.line !== source.line) {
                      mismatches.push({
                        entity: name, family, intent,
                        field: "loc.line",
                        expected: source.line,
                        actual: entityItem.loc.line,
                      })
                    }
                  }
                }

                // Check expected relation buckets for this intent are present.
                // The adapter creates one item per DB row, so the same entity may appear
                // multiple times in allItems with different relation buckets populated.
                // We must sum across ALL items with the entity's canonical_name.
                //
                // Exception: struct-accessor intents (where_struct_modified, etc.) use
                // a legacy row transformation that strips canonical_name/kind/loc.
                // For these intents, only verify status + items present (done above).
                const expectedBuckets = INTENT_EXPECTED_BUCKETS[intent] ?? []
                const fixtureRelations = fixture.relations as Record<string, unknown[]>

                if (!STRUCT_ACCESSOR_INTENTS.has(intent)) {
                  // Entity items: all items with canonical_name == entity
                  const entityItems = allItems.filter((it) => it.canonical_name === fixture.canonical_name)
                  // All items (for outgoing-edge intents where callee is the primary node)
                  const isOutgoing = OUTGOING_EDGE_INTENTS.has(intent) || TIMER_TRIGGER_INTENTS.has(intent)
                  const itemsToCheck = isOutgoing ? allItems : entityItems

                  for (const bucket of expectedBuckets) {
                    const fixtureHasData = (fixtureRelations[bucket] ?? []).length > 0
                    if (!fixtureHasData) continue // fixture doesn't claim this bucket — skip

                    const totalCount = itemsToCheck.reduce((sum, it) => {
                      const relKey = bucket as keyof typeof it.rel
                      return sum + (it.rel[relKey]?.length ?? 0)
                    }, 0)

                    if (totalCount === 0) {
                      mismatches.push({
                        entity: name, family, intent,
                        field: `rel.${bucket}`,
                        expected: `>0 (fixture has ${fixtureRelations[bucket]?.length})`,
                        actual: 0,
                      })
                    }
                  }

                  // Verify minimum_counts from contract — only for buckets this intent populates
                  const minCounts = contract.minimum_counts as Record<string, number>
                  const intentBuckets = new Set(INTENT_EXPECTED_BUCKETS[intent] ?? [])
                  for (const [bucket, minCount] of Object.entries(minCounts)) {
                    // Only enforce minimum_count for buckets this intent is expected to populate
                    if (!intentBuckets.has(bucket)) continue
                    const fixtureHasData = (fixtureRelations[bucket] ?? []).length > 0
                    if (!fixtureHasData) continue // fixture doesn't claim this bucket — skip

                    const totalCount = itemsToCheck.reduce((sum, it) => {
                      const relKey = bucket as keyof typeof it.rel
                      return sum + (it.rel[relKey]?.length ?? 0)
                    }, 0)

                    if (totalCount < minCount) {
                      mismatches.push({
                        entity: name, family, intent,
                        field: `rel.${bucket} (minimum_count)`,
                        expected: `>=${minCount}`,
                        actual: totalCount,
                      })
                    }
                  }
                }
              }

              const report = reportMismatches(mismatches)
              expect(mismatches.length, `Mismatches for ${family}/${name} intent=${intent}:\n${report}`).toBe(0)
            })
          }

          it("backend response protocol_version is 1.1", async () => {
            const args: Record<string, unknown> = {
              intent: intents[0],
              snapshotId: 1,
              apiName: fixture.canonical_name,
              structName: fixture.canonical_name,
              fieldName: "",
              traceId: "",
              pattern: "",
              logLevel: "DEBUG",
              srcApi: "",
              dstApi: "",
              depth: 2,
              limit: 50,
            }
            const response = await runQuery(args, mockRows)
            expect(response.protocol_version).toBe("1.1")
          })

          it("backend response has no errors array entries", async () => {
            const args: Record<string, unknown> = {
              intent: intents[0],
              snapshotId: 1,
              apiName: fixture.canonical_name,
              structName: fixture.canonical_name,
              fieldName: "",
              traceId: "",
              pattern: "",
              logLevel: "DEBUG",
              srcApi: "",
              dstApi: "",
              depth: 2,
              limit: 50,
            }
            const response = await runQuery(args, mockRows)
            expect(response.errors ?? []).toHaveLength(0)
          })

          it("all edge_kind values in response items are valid protocol kinds", async () => {
            const args: Record<string, unknown> = {
              intent: intents[0],
              snapshotId: 1,
              apiName: fixture.canonical_name,
              structName: fixture.canonical_name,
              fieldName: "",
              traceId: "",
              pattern: "",
              logLevel: "DEBUG",
              srcApi: "",
              dstApi: "",
              depth: 2,
              limit: 50,
            }
            const response = await runQuery(args, mockRows)
            const validKinds = new Set([
              "call_direct", "call_runtime", "register", "dispatch",
              "read", "write", "init", "mutate", "owner", "use",
              "inherit", "implement", "emit_log",
            ])
            for (const item of response.data?.items ?? []) {
              for (const bucket of Object.values(item.rel)) {
                for (const edge of bucket) {
                  expect(
                    validKinds.has(edge.edge_kind),
                    `Invalid edge_kind '${edge.edge_kind}' in response for ${family}/${name}`,
                  ).toBe(true)
                }
              }
            }
          })
        })
      }
    })
  }
})
