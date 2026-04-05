import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setIntelligenceDeps } from "../../../src/tools/index.js"
import type { NodeProtocolResponse } from "../../../src/intelligence/contracts/node-protocol.js"
import { tool, ctx } from "./test-kit.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const GROUND_TRUTH_PATH = join(__dirname, "../../fixtures/wlan-ground-truth.json")
const DEFAULT_WORKSPACE_ROOT = "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc"
const WLAN_WORKSPACE_ROOT = (process.env.WLAN_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT).trim()
const HAS_WLAN_WORKSPACE = WLAN_WORKSPACE_ROOT.length > 0 && existsSync(WLAN_WORKSPACE_ROOT)
const describeWithWorkspace = HAS_WLAN_WORKSPACE ? describe : describe.skip

interface SourceAnchor {
  label: string
  file: string
  line: number
  contains: string
}

interface NodeKindSpec {
  kind: NodeProtocolResponse["data"]["items"][number]["kind"]
  kind_verbose: NodeProtocolResponse["data"]["items"][number]["kind_verbose"]
  description: string
}

interface NodeKindProbe {
  name: string
  description: string
  intent: string
  apiName: string
  mockRows: Record<string, unknown>[]
  expect: {
    status: NodeProtocolResponse["status"]
    canonical_name: string
    kind: NodeProtocolResponse["data"]["items"][number]["kind"]
    kind_verbose: NodeProtocolResponse["data"]["items"][number]["kind_verbose"]
    loc_file: string
    loc_line: number
  }
  sourceAnchors: SourceAnchor[]
}

interface VerificationQueryCase {
  name: string
  intent: string
  apiName?: string
  structName?: string
  fieldName?: string
  logLevel?: "ERROR" | "WARN" | "INFO" | "DEBUG" | "VERBOSE" | "TRACE"
  srcApi?: string
  dstApi?: string
  traceId?: string
  pattern?: string
  feedbackIfMissing?: string
  mockRows: Record<string, unknown>[]
}

interface GraphContractPathPattern {
  name: string
  nodes: string[]
  description: string
}

interface GraphContract {
  primaryNode: string
  requiredRelationKinds: string[]
  requiredDirections: Array<"incoming" | "outgoing" | "bidirectional">
  requiredQueryCases: string[]
  requiredPathPatterns: GraphContractPathPattern[]
  minimumEvidencePerRelation: number
}

interface ApiGroundTruthEntry {
  api_name: string
  node_kind: "api"
  category: string
  source: {
    file_path: string
    line_number: number
  }
  relations: {
    who_calls: { callers: FixtureRow[] }
    who_calls_at_runtime: { callers: FixtureRow[] }
    what_api_calls: { callees: FixtureRow[] }
    hw_invokers: { blocks: FixtureRow[] }
    hw_targets: { blocks: FixtureRow[] }
    registrations: { registered_by: FixtureRow[] }
    dispatch_sites: { sites: FixtureRow[] }
    struct_reads: { fields: FixtureRow[] }
    struct_writes: { fields: FixtureRow[] }
    field_access_paths: { paths: FixtureRow[] }
    logs: { entries: FixtureRow[] }
    timer_triggers: { triggers: FixtureRow[] }
    other_relations: { rows: FixtureRow[] }
  }
  verification_contract: {
    required_sections: string[]
    minimum_counts: Record<string, number>
    feedback_if_missing: string
  }
  relation_type_lists: Record<string, FixtureRow[]>
}

interface CoverageExpectations {
  minimumVerificationTargets: number
  minimumQueryCases: number
  requiredCategories: string[]
  requiredQueryIntents: string[]
  requiredRelationKinds: string[]
  requiredQueryRowKinds: string[]
  requiredVerificationGraphNodeKinds: NodeKindSpec["kind"][]
}

interface VerificationTarget {
  name: string
  category: string
  goal: string
  definition: { file: string; line: number }
  coverageTags: string[]
  requiredNodeKinds: NodeKindSpec["kind"][]
  graphNodes: Array<{
    kind: NodeKindSpec["kind"]
    canonical_name: string
    source: { file: string; line: number }
  }>
  expectedDbArtifacts: {
    edgeKinds: string[]
    hasRuntimeCaller: boolean
    hasLogs: boolean
    hasTimerTrigger: boolean
  }
  sourceAnchors: SourceAnchor[]
  graphContract: GraphContract
  parserGapFeedback: string
}

interface GroundTruthFixture {
  workspace: string
  coverageExpectations: CoverageExpectations
  apiGroundTruthCoverage?: {
    api_count: number
    categories: string[]
    node_kinds: string[]
    relation_kinds: string[]
  }
  requiredNodeKinds: NodeKindSpec[]
  nodeKindProbes: NodeKindProbe[]
  verificationTargets: VerificationTarget[]
  apiGroundTruth: ApiGroundTruthEntry[]
}

type FixtureRow = Record<string, unknown>
type NodeItem = NodeProtocolResponse["data"]["items"][number]
type RelationBucket = keyof NodeItem["rel"]

const groundTruth: GroundTruthFixture = JSON.parse(readFileSync(GROUND_TRUTH_PATH, "utf8"))
const t = tool("intelligence_query")
const { client, tracker } = ctx(t)

const KIND_VERBOSE_BY_KIND: Record<NodeKindSpec["kind"], NodeKindSpec["kind_verbose"]> = {
  api: "application_programming_interface",
  struct: "structure_type",
  union: "union_type",
  enum: "enumeration_type",
  typedef: "typedef_alias",
  class: "class_type",
  field: "structure_field",
  macro: "preprocessor_macro",
  global_var: "global_variable",
  param: "function_parameter",
  thread: "thread_context",
  signal: "signal_trigger",
  interrupt: "interrupt_source",
  timer: "timer_trigger",
  ring: "ring_endpoint",
  module: "module_boundary",
  hw_block: "hardware_execution_block",
  dispatch_table: "dispatch_table",
  message: "inter_thread_message",
  log_point: "log_emission_point",
  unknown: "unknown_entity",
}

const EDGE_KIND_VERBOSE_BY_KIND: Record<string, string> = {
  call_direct: "static_direct_calls",
  call_runtime: "runtime_invokes_api",
  register: "registers_callback_handler",
  dispatch: "dispatches_execution_to_api",
  read: "reads_structure_field",
  write: "writes_structure_field",
  init: "initializes_structure_state",
  mutate: "mutates_structure_state",
  owner: "owns_structure_entity",
  use: "uses_dependency_entity",
  inherit: "inherits_from_parent_type",
  implement: "implemented_by_concrete_type",
  emit_log: "emits_runtime_log_event",
}

const API_INTENTS = new Set([
  "who_calls_api",
  "who_calls_api_at_runtime",
  "why_api_invoked",
  "what_api_calls",
  "show_registration_chain",
  "show_dispatch_sites",
  "find_callback_registrars",
  "show_api_runtime_observations",
  "show_hot_call_paths",
  "find_api_timer_triggers",
  "find_api_logs",
  "find_api_logs_by_level",
  "find_api_struct_writes",
  "find_api_struct_reads",
])

const RELATION_TYPE_LIST_KEYS = [
  "call_direct",
  "call_runtime",
  "register",
  "dispatch",
  "read",
  "write",
  "init",
  "mutate",
  "owner",
  "use",
  "inherit",
  "implement",
  "emit_log",
] as const

afterEach(() => {
  setIntelligenceDeps(null as never)
})

function makeDeps(rows: FixtureRow[]) {
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

async function runQuery(args: Record<string, unknown>, rows: FixtureRow[]): Promise<NodeProtocolResponse> {
  setIntelligenceDeps(makeDeps(rows) as never)
  const raw = await t.execute(args, client, tracker)
  const parsed = JSON.parse(raw) as { nodeProtocol?: NodeProtocolResponse } & NodeProtocolResponse
  // The intelligence_query tool now emits LegacyFlatResponse which wraps
  // NodeProtocolResponse under the `nodeProtocol` key.  Fall back to
  // treating the root as NodeProtocolResponse for forward compat.
  return parsed.nodeProtocol ?? parsed
}

function rawKindToProtocolKind(raw: unknown): NodeItem["kind"] {
  const normalized = String(raw ?? "unknown").toLowerCase().replace(/[\s-]+/g, "_")
  if (normalized === "function" || normalized === "api") return "api"
  if (normalized === "struct") return "struct"
  if (normalized === "union") return "union"
  if (normalized === "enum") return "enum"
  if (normalized === "typedef") return "typedef"
  if (normalized === "class") return "class"
  if (normalized === "field") return "field"
  if (normalized === "macro") return "macro"
  if (normalized === "global_var" || normalized === "global" || normalized === "globalvar") return "global_var"
  if (normalized === "param" || normalized === "parameter") return "param"
  if (normalized === "thread") return "thread"
  if (normalized === "signal") return "signal"
  if (normalized === "interrupt" || normalized === "irq" || normalized === "isr") return "interrupt"
  if (normalized === "timer") return "timer"
  if (normalized === "ring") return "ring"
  if (normalized === "module") return "module"
  if (normalized === "hw_block" || normalized === "hardware_block" || normalized === "hwblock") return "hw_block"
  if (normalized === "dispatch_table") return "dispatch_table"
  if (normalized === "message" || normalized === "message_queue" || normalized === "thread_message" || normalized === "message_function") return "message"
  if (normalized === "log_point" || normalized === "log") return "log_point"
  return "unknown"
}

function edgeKindFromRow(row: FixtureRow): string {
  const raw = String(row.edge_kind ?? "").toLowerCase()
  const derivation = String(row.derivation ?? "").toLowerCase()
  if (raw === "registers_callback") return "register"
  if (raw === "dispatches_to") return "dispatch"
  if (raw === "reads_field") return "read"
  if (raw === "writes_field") return "write"
  if (raw === "logs_event") return "emit_log"
  if (raw === "operates_on_struct") return "use"
  if (raw === "runtime_calls" || raw === "indirect_calls") return "call_runtime"
  if (raw === "calls" || raw === "api_call" || raw === "direct_call") {
    return derivation === "runtime" ? "call_runtime" : "call_direct"
  }
  return "call_runtime"
}

function relationKindFromQueryCase(intent: string, row: FixtureRow): string {
  if (intent === "show_registration_chain" || intent === "find_callback_registrars") return "register"
  if (intent === "find_api_logs" || intent === "find_api_logs_by_level") return "emit_log"
  return edgeKindFromRow(row)
}

function relationDirectionsFromQueryCase(targetName: string, queryCase: VerificationQueryCase, row: FixtureRow): Set<"incoming" | "outgoing" | "bidirectional"> {
  const dirs = new Set<"incoming" | "outgoing" | "bidirectional">()
  if (queryCase.intent === "show_registration_chain" || queryCase.intent === "find_callback_registrars") {
    const registrar = String(row.registrar ?? "")
    const callback = String(row.callback ?? "")
    if (callback === targetName) dirs.add("incoming")
    if (registrar === targetName) dirs.add("outgoing")
    return dirs
  }

  if (queryCase.intent === "find_api_logs" || queryCase.intent === "find_api_logs_by_level") {
    if (String(row.api_name ?? "") === targetName) dirs.add("outgoing")
    return dirs
  }

  const caller = String(row.caller ?? "")
  const callee = String(row.callee ?? "")
  if (caller === targetName && callee === targetName) {
    dirs.add("bidirectional")
    return dirs
  }
  if (callee === targetName) dirs.add("incoming")
  if (caller === targetName) dirs.add("outgoing")
  return dirs
}

function rowKey(row: FixtureRow): string {
  return `${String(row.canonical_name)}::${String(row.file_path)}::${Number(row.line_number)}`
}

function itemKey(item: NodeItem): string {
  return `${item.canonical_name}::${item.loc?.file ?? "unknown"}::${item.loc?.line ?? 0}`
}

function getByPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((obj, key) => {
    if (!obj || typeof obj !== "object") return undefined
    return (obj as Record<string, unknown>)[key]
  }, root)
}

function queryCasesForTarget(targetName: string): VerificationQueryCase[] {
  const entry = groundTruth.apiGroundTruth.find((api) => api.api_name === targetName)
  if (!entry) return []
  const map = new Map<string, VerificationQueryCase>()

  const pushRows = (rows: FixtureRow[], fallbackIntent: VerificationQueryCase["intent"], getLogLevel = false) => {
    for (const row of rows) {
      const intent = String(row.intent ?? fallbackIntent) as VerificationQueryCase["intent"]
      const logLevel = getLogLevel ? (row.log_level as VerificationQueryCase["logLevel"] | undefined) : undefined
      const name = String(row.query_case ?? `${intent}:${String(row.canonical_name)}`)
      const key = `${name}::${intent}::${String(row.query_api_name ?? targetName)}::${logLevel ?? ""}`
      if (!map.has(key)) {
        const canonicalName = String(row.canonical_name ?? "")
        const [structNameFromCanonical, fieldNameFromCanonical] = canonicalName.includes(".")
          ? canonicalName.split(".", 2)
          : [undefined, undefined]
        map.set(key, {
          name,
          intent,
          apiName: String(row.query_api_name ?? targetName),
          structName: intent === "find_field_access_path"
            ? String(row.struct_name ?? structNameFromCanonical ?? "")
            : undefined,
          fieldName: intent === "find_field_access_path"
            ? String(row.field_name ?? fieldNameFromCanonical ?? "")
            : undefined,
          logLevel,
          feedbackIfMissing: String(row.feedback_if_missing ?? entry.verification_contract.feedback_if_missing),
          mockRows: [],
        })
      }
      map.get(key)?.mockRows.push(row)
    }
  }

  pushRows(entry.relations.who_calls.callers, "who_calls_api")
  pushRows(entry.relations.who_calls_at_runtime.callers, "who_calls_api_at_runtime")
  pushRows(entry.relations.hw_invokers.blocks, "who_calls_api_at_runtime")
  pushRows(entry.relations.what_api_calls.callees, "what_api_calls")
  pushRows(entry.relations.hw_targets.blocks, "what_api_calls")
  pushRows(entry.relations.registrations.registered_by, "find_callback_registrars")
  pushRows(entry.relations.dispatch_sites.sites, "show_dispatch_sites")
  pushRows(entry.relations.struct_reads.fields, "find_api_struct_reads")
  pushRows(entry.relations.struct_writes.fields, "find_api_struct_writes")
  pushRows(entry.relations.field_access_paths.paths, "find_field_access_path")
  pushRows(entry.relations.logs.entries, "find_api_logs", true)
  pushRows(entry.relations.timer_triggers.triggers, "find_api_timer_triggers")
  pushRows(entry.relations.other_relations.rows, "who_calls_api")

  return [...map.values()]
}

function readWorkspaceLine(file: string, line: number): string {
  const absPath = join(WLAN_WORKSPACE_ROOT, file)
  const lines = readFileSync(absPath, "utf8").split(/\r?\n/)
  return lines[line - 1] ?? ""
}

function verifyBaseComparableRow(row: FixtureRow) {
  expect(typeof row.kind).toBe("string")
  expect(typeof row.canonical_name).toBe("string")
  expect(typeof row.file_path).toBe("string")
  expect(typeof row.line_number).toBe("number")
}

function verifyApiGroundTruthRow(row: FixtureRow) {
  verifyBaseComparableRow(row)
  expect(typeof row.intent).toBe("string")
  expect(typeof row.query_case).toBe("string")
  expect(typeof row.query_api_name).toBe("string")
  expect(typeof row.feedback_if_missing).toBe("string")
  expect(typeof row.confidence).toBe("number")
  expect(Number(row.confidence)).toBeGreaterThan(0)
  expect(Number(row.confidence)).toBeLessThanOrEqual(1)
}

function verifyComparableRow(intent: string, row: FixtureRow) {
  verifyBaseComparableRow(row)
  if (intent === "show_registration_chain" || intent === "find_callback_registrars") {
    expect(typeof row.registrar).toBe("string")
    expect(typeof row.callback).toBe("string")
    expect(typeof row.registration_api).toBe("string")
    return
  }

  if (intent === "find_api_logs" || intent === "find_api_logs_by_level") {
    expect(typeof row.api_name).toBe("string")
    expect(typeof row.template).toBe("string")
    return
  }

  expect(typeof row.caller).toBe("string")
  expect(typeof row.callee).toBe("string")
  expect(typeof row.edge_kind).toBe("string")
  expect(typeof row.derivation).toBe("string")
}

function buildArgs(targetName: string, queryCase: VerificationQueryCase): Record<string, unknown> {
  const apiName = queryCase.apiName ?? targetName
  const args: Record<string, unknown> = {
    intent: queryCase.intent,
    snapshotId: 42,
  }
  if (API_INTENTS.has(queryCase.intent)) {
    args.apiName = apiName
  }
  if (queryCase.structName) args.structName = queryCase.structName
  if (queryCase.fieldName) args.fieldName = queryCase.fieldName
  if (queryCase.logLevel) args.logLevel = queryCase.logLevel
  if (queryCase.srcApi) args.srcApi = queryCase.srcApi
  if (queryCase.dstApi) args.dstApi = queryCase.dstApi
  if (queryCase.traceId) args.traceId = queryCase.traceId
  if (queryCase.pattern) args.pattern = queryCase.pattern
  return args
}

function expectedRelation(
  targetName: string,
  queryCase: VerificationQueryCase,
  row: FixtureRow,
): {
  bucket: RelationBucket
  aliasBucket: RelationBucket
  edgeKind: string
  srcName: string
  dstName: string
  registerCall?: string
} {
  const apiName = queryCase.apiName ?? targetName

  if (queryCase.intent === "find_api_logs" || queryCase.intent === "find_api_logs_by_level") {
    return {
      bucket: "logs",
      aliasBucket: "log_emission_relationships",
      edgeKind: "emit_log",
      srcName: String(row.api_name ?? apiName),
      dstName: String(row.canonical_name),
    }
  }

  if (queryCase.intent === "show_registration_chain" || queryCase.intent === "find_callback_registrars") {
    return {
      bucket: "registrations_out",
      aliasBucket: "outgoing_registration_relationships",
      edgeKind: "register",
      srcName: String(row.registrar ?? row.canonical_name),
      dstName: String(row.callback ?? apiName),
      registerCall: String(row.registration_api ?? ""),
    }
  }

  const edgeKind = edgeKindFromRow(row)
  if (edgeKind === "read" || edgeKind === "write" || edgeKind === "init" || edgeKind === "mutate") {
    return {
      bucket: "structures",
      aliasBucket: "structure_access_relationships",
      edgeKind,
      srcName: String(row.caller ?? apiName),
      dstName: String(row.callee ?? row.canonical_name),
    }
  }
  if (edgeKind === "use") {
    return {
      bucket: "uses",
      aliasBucket: "usage_relationships",
      edgeKind,
      srcName: String(row.caller ?? apiName),
      dstName: String(row.callee ?? row.canonical_name),
    }
  }
  if (edgeKind === "owner") {
    return {
      bucket: "owns",
      aliasBucket: "ownership_relationships",
      edgeKind,
      srcName: String(row.caller ?? apiName),
      dstName: String(row.callee ?? row.canonical_name),
    }
  }
  if (edgeKind === "inherit") {
    return {
      bucket: "inherits_from",
      aliasBucket: "inheritance_parent_relationships",
      edgeKind,
      srcName: String(row.caller ?? apiName),
      dstName: String(row.callee ?? row.canonical_name),
    }
  }
  if (edgeKind === "implement") {
    return {
      bucket: "implemented_by",
      aliasBucket: "implementation_child_relationships",
      edgeKind,
      srcName: String(row.caller ?? apiName),
      dstName: String(row.callee ?? row.canonical_name),
    }
  }
  if (queryCase.intent === "what_api_calls") {
    return {
      bucket: edgeKind === "call_direct" ? "calls_in_direct" : "calls_in_runtime",
      aliasBucket: edgeKind === "call_direct" ? "incoming_static_call_relationships" : "incoming_runtime_call_relationships",
      edgeKind,
      srcName: String(row.caller ?? apiName),
      dstName: String(row.callee ?? row.canonical_name),
    }
  }

  return {
    bucket: "calls_out",
    aliasBucket: "outgoing_call_relationships",
    edgeKind,
    srcName: String(row.caller ?? row.canonical_name),
    dstName: String(row.callee ?? apiName),
  }
}

function assertEdge(item: NodeItem, queryCase: VerificationQueryCase, row: FixtureRow, expected: ReturnType<typeof expectedRelation>) {
  const bucket = item.rel[expected.bucket]
  expect(bucket).toHaveLength(1)
  const edge = bucket[0]
  expect(edge.edge_kind).toBe(expected.edgeKind)
  expect(edge.edge_kind_verbose).toBe(EDGE_KIND_VERBOSE_BY_KIND[expected.edgeKind])
  expect(edge.src_name).toBe(expected.srcName)
  expect(edge.dst_name).toBe(expected.dstName)
  expect(edge.evidence[0]?.loc.file).toBe(String(row.file_path))
  expect(edge.evidence[0]?.loc.line).toBe(Number(row.line_number))
  expect(item.rel[expected.aliasBucket]).toHaveLength(1)
  expect(item.rel[expected.aliasBucket][0]?.edge_id).toBe(edge.edge_id)

  if (queryCase.intent === "show_registration_chain" || queryCase.intent === "find_callback_registrars") {
    expect(edge.registration?.register_call).toBe(expected.registerCall)
    expect(edge.registration?.registrar_api).toBe(expected.srcName)
    expect(edge.registration?.context_owner).toBe(expected.dstName)
  }

  if (queryCase.intent === "show_dispatch_sites") {
    expect(edge.dispatch?.dispatch_site?.file).toBe(String(row.file_path))
    expect(edge.dispatch?.dispatch_site?.line).toBe(Number(row.line_number))
  }

  if (queryCase.intent === "find_api_logs" || queryCase.intent === "find_api_logs_by_level") {
    expect(item.facets.log_point?.template).toBe(String(row.template))
  }
}

describe(`WLAN graph ground truth — ${groundTruth.workspace}`, () => {
  it("defines consolidated single-entry API fixtures", () => {
    expect(Array.isArray(groundTruth.apiGroundTruth)).toBe(true)
    expect(groundTruth.apiGroundTruth.length).toBe(groundTruth.verificationTargets.length)
    const targetNames = new Set(groundTruth.verificationTargets.map((target) => target.name))
    for (const entry of groundTruth.apiGroundTruth) {
      expect(entry.node_kind).toBe("api")
      expect(targetNames.has(entry.api_name)).toBe(true)
      expect(typeof entry.source.file_path).toBe("string")
      expect(typeof entry.source.line_number).toBe("number")
      expect(Array.isArray(entry.verification_contract.required_sections)).toBe(true)
      expect(typeof entry.verification_contract.feedback_if_missing).toBe("string")
      expect(entry.verification_contract.feedback_if_missing.length).toBeGreaterThan(0)
      expect(entry.relation_type_lists).toBeDefined()
      for (const relationKey of RELATION_TYPE_LIST_KEYS) {
        expect(Array.isArray(entry.relation_type_lists[relationKey])).toBe(true)
      }
    }
  })

  it("keeps API ground-truth diversity coverage explicit", () => {
    expect(groundTruth.apiGroundTruthCoverage).toBeDefined()
    if (!groundTruth.apiGroundTruthCoverage) return
    expect(groundTruth.apiGroundTruthCoverage.api_count).toBe(groundTruth.apiGroundTruth.length)

    const categories = new Set(groundTruth.apiGroundTruth.map((entry) => entry.category))
    for (const category of groundTruth.coverageExpectations.requiredCategories) {
      expect(categories.has(category)).toBe(true)
      expect(groundTruth.apiGroundTruthCoverage.categories.includes(category)).toBe(true)
    }

    const relationKinds = new Set<string>()
    for (const entry of groundTruth.apiGroundTruth) {
      for (const rows of [
        ...entry.relations.who_calls.callers,
        ...entry.relations.who_calls_at_runtime.callers,
        ...entry.relations.what_api_calls.callees,
        ...entry.relations.registrations.registered_by,
        ...entry.relations.dispatch_sites.sites,
        ...entry.relations.struct_reads.fields,
        ...entry.relations.struct_writes.fields,
        ...entry.relations.logs.entries,
      ]) {
        const intent = String(rows.intent ?? "who_calls_api")
        relationKinds.add(relationKindFromQueryCase(intent, rows))
      }
    }
    for (const relationKind of groundTruth.coverageExpectations.requiredRelationKinds) {
      expect(relationKinds.has(relationKind)).toBe(true)
      expect(groundTruth.apiGroundTruthCoverage.relation_kinds.includes(relationKind)).toBe(true)
    }

    const requiredKinds = new Set(groundTruth.requiredNodeKinds.map((entry) => entry.kind))
    const apiGroundTruthKinds = new Set<string>()
    for (const entry of groundTruth.apiGroundTruth) {
      const rows: FixtureRow[] = [
        ...entry.relations.who_calls.callers,
        ...entry.relations.who_calls_at_runtime.callers,
        ...entry.relations.what_api_calls.callees,
        ...entry.relations.hw_invokers.blocks,
        ...entry.relations.hw_targets.blocks,
        ...entry.relations.registrations.registered_by,
        ...entry.relations.dispatch_sites.sites,
        ...entry.relations.struct_reads.fields,
        ...entry.relations.struct_writes.fields,
        ...entry.relations.field_access_paths.paths,
        ...entry.relations.logs.entries,
        ...entry.relations.timer_triggers.triggers,
        ...entry.relations.other_relations.rows,
      ]
      for (const row of rows) {
        const rawKind = String(row.kind).toLowerCase()
        apiGroundTruthKinds.add(rawKind === "function" ? "api" : rawKind)
      }
    }

    for (const requiredKind of requiredKinds) {
      expect(apiGroundTruthKinds.has(requiredKind)).toBe(true)
      expect(groundTruth.apiGroundTruthCoverage.node_kinds.includes(requiredKind)).toBe(true)
    }
  })

  it("defines a non-empty required node taxonomy", () => {
    expect(groundTruth.requiredNodeKinds.length).toBeGreaterThan(0)
    const requiredKinds = new Set(groundTruth.requiredNodeKinds.map((entry) => entry.kind))
    expect(requiredKinds.size).toBeGreaterThan(0)
  })

  it("keeps verification targets aligned with required node kinds and graph nodes", () => {
    const requiredKinds = new Set(groundTruth.requiredNodeKinds.map((entry) => entry.kind))
    for (const target of groundTruth.verificationTargets) {
      const queryCases = queryCasesForTarget(target.name)
      expect(target.goal.length).toBeGreaterThan(0)
      expect(target.coverageTags.length).toBeGreaterThan(0)
      expect(target.graphNodes.length).toBeGreaterThan(0)
      expect(queryCases.length).toBeGreaterThan(0)
      expect(target.graphContract).toBeDefined()
      expect(target.graphContract.primaryNode).toBe(target.name)
      expect(target.graphContract.requiredRelationKinds.length).toBeGreaterThan(0)
      expect(target.graphContract.requiredDirections.length).toBeGreaterThan(0)
      expect(target.graphContract.requiredQueryCases.length).toBeGreaterThan(0)
      expect(target.graphContract.requiredPathPatterns.length).toBeGreaterThan(0)
      expect(target.graphContract.minimumEvidencePerRelation).toBeGreaterThan(0)
      expect(target.sourceAnchors.length).toBeGreaterThan(0)
      expect(target.parserGapFeedback.length).toBeGreaterThan(0)
      const graphKinds = new Set(target.graphNodes.map((node) => node.kind))
      const graphNames = new Set(target.graphNodes.map((node) => node.canonical_name))
      for (const kind of target.requiredNodeKinds) {
        expect(requiredKinds.has(kind)).toBe(true)
        expect(graphKinds.has(kind)).toBe(true)
      }
      for (const queryName of target.graphContract.requiredQueryCases) {
        expect(queryCases.some((queryCase) => queryCase.name === queryName)).toBe(true)
      }
      for (const pattern of target.graphContract.requiredPathPatterns) {
        expect(pattern.name.length).toBeGreaterThan(0)
        expect(pattern.description.length).toBeGreaterThan(0)
        expect(pattern.nodes.length).toBeGreaterThanOrEqual(2)
        for (const nodeName of pattern.nodes) {
          expect(graphNames.has(nodeName)).toBe(true)
        }
      }
    }
  })

  it("stores DB-comparable fields for every verification row", () => {
    for (const target of groundTruth.verificationTargets) {
      for (const queryCase of queryCasesForTarget(target.name)) {
        expect(queryCase.feedbackIfMissing?.length ?? 0).toBeGreaterThan(0)
        for (const row of queryCase.mockRows) {
          verifyComparableRow(queryCase.intent, row)
        }
      }
    }
  })

  it("enforces diversity coverage expectations", () => {
    const targetCount = groundTruth.verificationTargets.length
    const queryCaseCount = groundTruth.verificationTargets.reduce((count, target) => count + queryCasesForTarget(target.name).length, 0)
    const categories = new Set(groundTruth.verificationTargets.map((target) => target.category))
    const intents = new Set<string>()
    const relationKinds = new Set<string>()
    const rowKinds = new Set<string>()
    const graphNodeKinds = new Set<NodeKindSpec["kind"]>()

    for (const target of groundTruth.verificationTargets) {
      const queryCases = queryCasesForTarget(target.name)
      for (const node of target.graphNodes) {
        graphNodeKinds.add(node.kind)
      }
      for (const queryCase of queryCases) {
        intents.add(queryCase.intent)
        for (const row of queryCase.mockRows) {
          rowKinds.add(String(row.kind))
          relationKinds.add(relationKindFromQueryCase(queryCase.intent, row))
        }
      }
    }

    expect(targetCount).toBeGreaterThanOrEqual(groundTruth.coverageExpectations.minimumVerificationTargets)
    expect(queryCaseCount).toBeGreaterThanOrEqual(groundTruth.coverageExpectations.minimumQueryCases)

    for (const category of groundTruth.coverageExpectations.requiredCategories) {
      expect(categories.has(category)).toBe(true)
    }
    for (const intent of groundTruth.coverageExpectations.requiredQueryIntents) {
      expect(intents.has(intent)).toBe(true)
    }
    for (const relationKind of groundTruth.coverageExpectations.requiredRelationKinds) {
      expect(relationKinds.has(relationKind)).toBe(true)
    }
    for (const rowKind of groundTruth.coverageExpectations.requiredQueryRowKinds) {
      expect(rowKinds.has(rowKind)).toBe(true)
    }
    for (const graphNodeKind of groundTruth.coverageExpectations.requiredVerificationGraphNodeKinds) {
      expect(graphNodeKinds.has(graphNodeKind)).toBe(true)
    }
  })

  it("enforces per-target graph contracts from query-case rows", () => {
    for (const target of groundTruth.verificationTargets) {
      const relationKinds = new Set<string>()
      const directions = new Set<"incoming" | "outgoing" | "bidirectional">()
      const evidenceCountByRelation = new Map<string, number>()

      for (const queryCase of queryCasesForTarget(target.name)) {
        for (const row of queryCase.mockRows) {
          const relationKind = relationKindFromQueryCase(queryCase.intent, row)
          relationKinds.add(relationKind)
          evidenceCountByRelation.set(relationKind, (evidenceCountByRelation.get(relationKind) ?? 0) + 1)
          for (const direction of relationDirectionsFromQueryCase(target.name, queryCase, row)) {
            directions.add(direction)
          }
        }
      }

      for (const expectedRelation of target.graphContract.requiredRelationKinds) {
        expect(relationKinds.has(expectedRelation)).toBe(true)
        const count = evidenceCountByRelation.get(expectedRelation) ?? 0
        expect(count).toBeGreaterThanOrEqual(target.graphContract.minimumEvidencePerRelation)
      }
      for (const expectedDirection of target.graphContract.requiredDirections) {
        expect(directions.has(expectedDirection)).toBe(true)
      }
    }
  })

  it("keeps consolidated API entries aligned with query-case data", () => {
    const entryByApi = new Map(groundTruth.apiGroundTruth.map((entry) => [entry.api_name, entry]))
    for (const target of groundTruth.verificationTargets) {
      const entry = entryByApi.get(target.name)
      expect(entry).toBeDefined()
      if (!entry) continue

      const queryRows = queryCasesForTarget(target.name).flatMap((queryCase) => queryCase.mockRows)
      const consolidatedRows: FixtureRow[] = [
        ...entry.relations.who_calls.callers,
        ...entry.relations.who_calls_at_runtime.callers,
        ...entry.relations.what_api_calls.callees,
        ...entry.relations.hw_invokers.blocks,
        ...entry.relations.hw_targets.blocks,
        ...entry.relations.registrations.registered_by,
        ...entry.relations.dispatch_sites.sites,
        ...entry.relations.struct_reads.fields,
        ...entry.relations.struct_writes.fields,
        ...entry.relations.field_access_paths.paths,
        ...entry.relations.logs.entries,
        ...entry.relations.timer_triggers.triggers,
        ...entry.relations.other_relations.rows,
      ]
      expect(consolidatedRows.length).toBeGreaterThanOrEqual(queryRows.length)

      for (const row of consolidatedRows) {
        verifyApiGroundTruthRow(row)
      }

      for (const path of entry.verification_contract.required_sections) {
        const value = getByPath(entry.relations, path)
        expect(Array.isArray(value), `${entry.api_name} missing required section ${path}`).toBe(true)
        const min = entry.verification_contract.minimum_counts[path] ?? 0
        expect((value as unknown[]).length).toBeGreaterThanOrEqual(min)
      }
    }
  })

  it("keeps relation-type lists DB-comparable and aligned", () => {
    const allowed = new Set<string>(RELATION_TYPE_LIST_KEYS)
    for (const entry of groundTruth.apiGroundTruth) {
      const relationLists = entry.relation_type_lists
      const flattened = RELATION_TYPE_LIST_KEYS.flatMap((key) => relationLists[key] ?? [])
      const consolidatedRows: FixtureRow[] = [
        ...entry.relations.who_calls.callers,
        ...entry.relations.who_calls_at_runtime.callers,
        ...entry.relations.what_api_calls.callees,
        ...entry.relations.hw_invokers.blocks,
        ...entry.relations.hw_targets.blocks,
        ...entry.relations.registrations.registered_by,
        ...entry.relations.dispatch_sites.sites,
        ...entry.relations.struct_reads.fields,
        ...entry.relations.struct_writes.fields,
        ...entry.relations.field_access_paths.paths,
        ...entry.relations.logs.entries,
        ...entry.relations.timer_triggers.triggers,
        ...entry.relations.other_relations.rows,
      ]
      expect(flattened.length).toBeGreaterThanOrEqual(consolidatedRows.length)
      for (const row of flattened) {
        verifyApiGroundTruthRow(row)
        expect(typeof row.relation_kind).toBe("string")
        expect(allowed.has(String(row.relation_kind))).toBe(true)
        expect(typeof row.src_name).toBe("string")
        expect(typeof row.dst_name).toBe("string")
      }
    }
  })
})

describe("verification targets", () => {
  for (const target of groundTruth.verificationTargets) {
    for (const queryCase of queryCasesForTarget(target.name)) {
      it(`${target.name} :: ${queryCase.name}`, async () => {
        const response = await runQuery(buildArgs(target.name, queryCase), queryCase.mockRows)

        expect(response.status).toBe("hit")
        expect(response.intent).toBe(queryCase.intent)
        expect(response.data.items).toHaveLength(queryCase.mockRows.length)
        expect(response.meta.total_estimate).toBe(queryCase.mockRows.length)

        const itemsByKey = new Map(response.data.items.map((item) => [itemKey(item), item]))
        for (const row of queryCase.mockRows) {
          const item = itemsByKey.get(rowKey(row))
          expect(item, queryCase.feedbackIfMissing ?? `${queryCase.name} is missing its expected item`).toBeDefined()
          if (!item) continue

          const expectedKind = rawKindToProtocolKind(row.kind)
          expect(item.kind).toBe(expectedKind)
          expect(item.kind_verbose).toBe(KIND_VERBOSE_BY_KIND[expectedKind])
          expect(item.canonical_name).toBe(String(row.canonical_name))
          expect(item.loc?.file).toBe(String(row.file_path))
          expect(item.loc?.line).toBe(Number(row.line_number))

          const relation = expectedRelation(target.name, queryCase, row)
          assertEdge(item, queryCase, row, relation)
        }
      })
    }
  }
})

describeWithWorkspace("source-backed anchors", () => {
  for (const target of groundTruth.verificationTargets) {
    it(`target anchors :: ${target.name}`, () => {
      const definitionLine = readWorkspaceLine(target.definition.file, target.definition.line)
      expect(definitionLine.trim().length, `${target.name} definition line missing`).toBeGreaterThan(0)

      for (const node of target.graphNodes) {
        const graphLine = readWorkspaceLine(node.source.file, node.source.line)
        expect(graphLine.trim().length, `${target.name} graph node ${node.canonical_name} missing source line`).toBeGreaterThan(0)
      }

      for (const anchor of target.sourceAnchors) {
        const line = readWorkspaceLine(anchor.file, anchor.line)
        expect(line, `${target.name} :: ${anchor.label}`).toContain(anchor.contains)
      }
    })
  }
})
