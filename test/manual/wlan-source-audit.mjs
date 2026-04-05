#!/usr/bin/env node
/**
 * wlan-source-audit.mjs
 *
 * Validate the graph-oriented WLAN ground-truth fixture against a real WLAN workspace.
 * It checks three things:
 *   1. fixture sections exist and contain DB-comparable fields
 *   2. verification targets keep the expected runtime metadata
 *   3. all declared source anchors resolve against the audited workspace
 *
 * Usage:
 *   node test/manual/wlan-source-audit.mjs
 *   WLAN_WORKSPACE_ROOT=/path/to/wlan_proc node test/manual/wlan-source-audit.mjs
 */

import fs from "node:fs"
import path from "node:path"

const DEFAULT_WORKSPACE_ROOT =
  "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1/wlan_proc"

const FIXTURE_PATH = path.resolve("test/fixtures/wlan-ground-truth.json")
const workspaceRoot = (process.env.WLAN_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT).trim()

if (!fs.existsSync(FIXTURE_PATH)) {
  console.error(`Fixture not found: ${FIXTURE_PATH}`)
  process.exit(1)
}

if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
  console.error(`Workspace root not found: ${workspaceRoot}`)
  process.exit(1)
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"))
const coverageExpectations = fixture.coverageExpectations ?? null
const apiGroundTruthCoverage = fixture.apiGroundTruthCoverage ?? null
const nodeKindProbes = fixture.nodeKindProbes ?? []
const verificationTargets = fixture.verificationTargets ?? []
const apiGroundTruth = fixture.apiGroundTruth ?? []
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
]

if (!Array.isArray(nodeKindProbes)) {
  console.error("nodeKindProbes must be an array in test/fixtures/wlan-ground-truth.json")
  process.exit(1)
}

if (!Array.isArray(verificationTargets) || verificationTargets.length === 0) {
  console.error("No verificationTargets found in test/fixtures/wlan-ground-truth.json")
  process.exit(1)
}

if (!Array.isArray(apiGroundTruth) || apiGroundTruth.length === 0) {
  console.error("No apiGroundTruth found in test/fixtures/wlan-ground-truth.json")
  process.exit(1)
}

if (!apiGroundTruthCoverage || typeof apiGroundTruthCoverage !== "object") {
  console.error("No apiGroundTruthCoverage found in test/fixtures/wlan-ground-truth.json")
  process.exit(1)
}

const failures = []

function pushFailure(section, field, expected, actual) {
  failures.push({ section, field, expected, actual })
}

function readLine(file, line) {
  const absPath = path.join(workspaceRoot, file)
  if (!fs.existsSync(absPath)) {
    return { absPath, lineText: null }
  }

  const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/)
  return { absPath, lineText: lines[line - 1] ?? "" }
}

function getByPath(root, pathExpr) {
  return pathExpr.split(".").reduce((obj, key) => {
    if (!obj || typeof obj !== "object") return undefined
    return obj[key]
  }, root)
}

function queryCasesForApiEntry(entry) {
  const cases = []
  const pushRows = (rows, fallbackIntent, withLogLevel = false) => {
    for (const row of rows ?? []) {
      cases.push({
        name: String(row.query_case ?? `${fallbackIntent}:${row.canonical_name}`),
        intent: String(row.intent ?? fallbackIntent),
        apiName: String(row.query_api_name ?? entry.api_name),
        logLevel: withLogLevel ? (row.log_level ?? undefined) : undefined,
        feedbackIfMissing: String(row.feedback_if_missing ?? entry.verification_contract.feedback_if_missing),
        mockRows: [row],
      })
    }
  }

  pushRows(entry.relations?.who_calls?.callers, "who_calls_api")
  pushRows(entry.relations?.who_calls_at_runtime?.callers, "who_calls_api_at_runtime")
  pushRows(entry.relations?.hw_invokers?.blocks, "who_calls_api_at_runtime")
  pushRows(entry.relations?.what_api_calls?.callees, "what_api_calls")
  pushRows(entry.relations?.hw_targets?.blocks, "what_api_calls")
  pushRows(entry.relations?.registrations?.registered_by, "find_callback_registrars")
  pushRows(entry.relations?.dispatch_sites?.sites, "show_dispatch_sites")
  pushRows(entry.relations?.struct_reads?.fields, "find_api_struct_reads")
  pushRows(entry.relations?.struct_writes?.fields, "find_api_struct_writes")
  pushRows(entry.relations?.field_access_paths?.paths, "find_field_access_path")
  pushRows(entry.relations?.logs?.entries, "find_api_logs", true)
  pushRows(entry.relations?.timer_triggers?.triggers, "find_api_timer_triggers")
  pushRows(entry.relations?.other_relations?.rows, "who_calls_api")

  return cases
}

function auditSourceAnchors(section, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    pushFailure(section, "sourceAnchors", "non-empty array", anchors)
    return
  }

  for (const anchor of anchors) {
    const { absPath, lineText } = readLine(anchor.file, anchor.line)
    if (lineText === null) {
      pushFailure(section, `sourceAnchors:${anchor.label}:file`, absPath, "missing")
      continue
    }
    if (!lineText.includes(anchor.contains)) {
      pushFailure(
        section,
        `sourceAnchors:${anchor.label}:${anchor.file}:${anchor.line}`,
        anchor.contains,
        lineText,
      )
    }
  }
}

function verifyBaseComparableRow(section, row) {
  for (const field of ["kind", "canonical_name", "file_path", "line_number"]) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      pushFailure(section, `mockRow.${field}`, "present", undefined)
    }
  }
}

function verifyApiGroundTruthRow(section, row) {
  verifyBaseComparableRow(section, row)
  for (const field of ["intent", "query_case", "query_api_name", "feedback_if_missing", "confidence"]) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      pushFailure(section, `mockRow.${field}`, "present", undefined)
    }
  }
  if (Object.prototype.hasOwnProperty.call(row, "confidence")) {
    const value = Number(row.confidence)
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      pushFailure(section, "mockRow.confidence", "number in (0,1]", row.confidence)
    }
  }
}

function verifyComparableRow(section, intent, row) {
  verifyBaseComparableRow(section, row)

  if (intent === "show_registration_chain" || intent === "find_callback_registrars") {
    for (const field of ["registrar", "callback", "registration_api"]) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) {
        pushFailure(section, `mockRow.${field}`, "present", undefined)
      }
    }
    return
  }

  if (intent === "find_api_logs" || intent === "find_api_logs_by_level") {
    for (const field of ["api_name", "template"]) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) {
        pushFailure(section, `mockRow.${field}`, "present", undefined)
      }
    }
    return
  }

  for (const field of ["caller", "callee", "edge_kind", "derivation"]) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      pushFailure(section, `mockRow.${field}`, "present", undefined)
    }
  }
}

function mapRelationKind(intent, row) {
  const raw = String(row.edge_kind ?? "").toLowerCase()
  const derivation = String(row.derivation ?? "").toLowerCase()

  if (intent === "show_registration_chain" || intent === "find_callback_registrars") return "register"
  if (intent === "find_api_logs" || intent === "find_api_logs_by_level") return "emit_log"
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

function mapRelationDirections(targetName, queryCase, row) {
  const directions = new Set()
  if (queryCase.intent === "show_registration_chain" || queryCase.intent === "find_callback_registrars") {
    const registrar = String(row.registrar ?? "")
    const callback = String(row.callback ?? "")
    if (callback === targetName) directions.add("incoming")
    if (registrar === targetName) directions.add("outgoing")
    return directions
  }
  if (queryCase.intent === "find_api_logs" || queryCase.intent === "find_api_logs_by_level") {
    if (String(row.api_name ?? "") === targetName) directions.add("outgoing")
    return directions
  }
  const caller = String(row.caller ?? "")
  const callee = String(row.callee ?? "")
  if (caller === targetName && callee === targetName) {
    directions.add("bidirectional")
    return directions
  }
  if (callee === targetName) directions.add("incoming")
  if (caller === targetName) directions.add("outgoing")
  return directions
}

for (const target of verificationTargets) {
  const section = `verificationTarget:${target.name}`

  if (!Array.isArray(target.requiredNodeKinds) || target.requiredNodeKinds.length === 0) {
    pushFailure(section, "requiredNodeKinds", "non-empty array", target.requiredNodeKinds)
  }
  if (!Array.isArray(target.graphNodes) || target.graphNodes.length === 0) {
    pushFailure(section, "graphNodes", "non-empty array", target.graphNodes)
  }
  const apiEntry = apiGroundTruth.find((entry) => entry.api_name === target.name)
  const queryCases = apiEntry ? queryCasesForApiEntry(apiEntry) : []
  if (queryCases.length === 0) {
    pushFailure(section, "apiGroundTruth.queryCases", "non-empty derived set", queryCases)
    continue
  }
  if (typeof target.parserGapFeedback !== "string" || target.parserGapFeedback.trim().length === 0) {
    pushFailure(section, "parserGapFeedback", "non-empty string", target.parserGapFeedback)
  }
  if (!target.graphContract || typeof target.graphContract !== "object") {
    pushFailure(section, "graphContract", "present", target.graphContract)
  }

  const graphKinds = new Set((target.graphNodes ?? []).map((node) => node.kind))
  const graphNames = new Set((target.graphNodes ?? []).map((node) => node.canonical_name))
  for (const kind of target.requiredNodeKinds ?? []) {
    if (!graphKinds.has(kind)) {
      pushFailure(section, `graphNodes.kind:${kind}`, "present", [...graphKinds])
    }
  }

  if (target.graphContract) {
    if (target.graphContract.primaryNode !== target.name) {
      pushFailure(section, "graphContract.primaryNode", target.name, target.graphContract.primaryNode)
    }
    if (!Array.isArray(target.graphContract.requiredRelationKinds) || target.graphContract.requiredRelationKinds.length === 0) {
      pushFailure(section, "graphContract.requiredRelationKinds", "non-empty array", target.graphContract.requiredRelationKinds)
    }
    if (!Array.isArray(target.graphContract.requiredDirections) || target.graphContract.requiredDirections.length === 0) {
      pushFailure(section, "graphContract.requiredDirections", "non-empty array", target.graphContract.requiredDirections)
    }
    if (!Array.isArray(target.graphContract.requiredQueryCases) || target.graphContract.requiredQueryCases.length === 0) {
      pushFailure(section, "graphContract.requiredQueryCases", "non-empty array", target.graphContract.requiredQueryCases)
    }
    if (!Array.isArray(target.graphContract.requiredPathPatterns) || target.graphContract.requiredPathPatterns.length === 0) {
      pushFailure(section, "graphContract.requiredPathPatterns", "non-empty array", target.graphContract.requiredPathPatterns)
    }
    if (typeof target.graphContract.minimumEvidencePerRelation !== "number" || target.graphContract.minimumEvidencePerRelation < 1) {
      pushFailure(section, "graphContract.minimumEvidencePerRelation", "number >= 1", target.graphContract.minimumEvidencePerRelation)
    }
    for (const queryName of target.graphContract.requiredQueryCases ?? []) {
      if (!queryCases.some((queryCase) => queryCase.name === queryName)) {
        pushFailure(section, `graphContract.requiredQueryCases:${queryName}`, "present in derived query cases", "missing")
      }
    }
    for (const pattern of target.graphContract.requiredPathPatterns ?? []) {
      if (typeof pattern.name !== "string" || pattern.name.trim().length === 0) {
        pushFailure(section, "graphContract.requiredPathPatterns.name", "non-empty string", pattern?.name)
      }
      if (typeof pattern.description !== "string" || pattern.description.trim().length === 0) {
        pushFailure(section, "graphContract.requiredPathPatterns.description", "non-empty string", pattern?.description)
      }
      if (!Array.isArray(pattern.nodes) || pattern.nodes.length < 2) {
        pushFailure(section, "graphContract.requiredPathPatterns.nodes", "array length >= 2", pattern?.nodes)
      }
      for (const nodeName of pattern.nodes ?? []) {
        if (!graphNames.has(nodeName)) {
          pushFailure(section, `graphContract.requiredPathPatterns.nodes:${nodeName}`, "present in graphNodes", "missing")
        }
      }
    }
  }

  if (!target.definition || typeof target.definition.file !== "string" || typeof target.definition.line !== "number") {
    pushFailure(section, "definition", "file + line", target.definition)
  } else {
    const { absPath, lineText } = readLine(target.definition.file, target.definition.line)
    if (lineText === null) {
      pushFailure(section, "definition.file", absPath, "missing")
    } else if (lineText.trim().length === 0) {
      pushFailure(section, `definition:${target.definition.file}:${target.definition.line}`, "non-empty line", lineText)
    }
  }

  for (const node of target.graphNodes ?? []) {
    if (!node.source || typeof node.source.file !== "string" || typeof node.source.line !== "number") {
      pushFailure(section, `graphNode:${node.canonical_name}:source`, "file + line", node.source)
      continue
    }
    const { absPath, lineText } = readLine(node.source.file, node.source.line)
    if (lineText === null) {
      pushFailure(section, `graphNode:${node.canonical_name}:file`, absPath, "missing")
    } else if (lineText.trim().length === 0) {
      pushFailure(section, `graphNode:${node.canonical_name}:${node.source.file}:${node.source.line}`, "non-empty line", lineText)
    }
  }

  auditSourceAnchors(section, target.sourceAnchors)

  for (const queryCase of queryCases) {
    const caseSection = `${section}:queryCase:${queryCase.name}`
    if (typeof queryCase.feedbackIfMissing !== "string" || queryCase.feedbackIfMissing.trim().length === 0) {
      pushFailure(caseSection, "feedbackIfMissing", "non-empty string", queryCase.feedbackIfMissing)
    }
    if (!Array.isArray(queryCase.mockRows) || queryCase.mockRows.length === 0) {
      pushFailure(caseSection, "mockRows", "non-empty array", queryCase.mockRows)
      continue
    }
    for (const row of queryCase.mockRows) {
      verifyComparableRow(caseSection, queryCase.intent, row)
    }
  }

  if (target.graphContract) {
    const relationKinds = new Set()
    const directions = new Set()
    const evidenceCountByRelation = new Map()
    for (const queryCase of queryCases) {
      for (const row of queryCase.mockRows ?? []) {
        const relationKind = mapRelationKind(queryCase.intent, row)
        relationKinds.add(relationKind)
        evidenceCountByRelation.set(relationKind, (evidenceCountByRelation.get(relationKind) ?? 0) + 1)
        for (const direction of mapRelationDirections(target.name, queryCase, row)) {
          directions.add(direction)
        }
      }
    }

    for (const relationKind of target.graphContract.requiredRelationKinds ?? []) {
      if (!relationKinds.has(relationKind)) {
        pushFailure(section, `graphContract.requiredRelationKinds:${relationKind}`, "present in query rows", [...relationKinds])
      }
      const count = evidenceCountByRelation.get(relationKind) ?? 0
      if (count < target.graphContract.minimumEvidencePerRelation) {
        pushFailure(
          section,
          `graphContract.minimumEvidencePerRelation:${relationKind}`,
          `>= ${target.graphContract.minimumEvidencePerRelation}`,
          count,
        )
      }
    }
    for (const direction of target.graphContract.requiredDirections ?? []) {
      if (!directions.has(direction)) {
        pushFailure(section, `graphContract.requiredDirections:${direction}`, "present in query rows", [...directions])
      }
    }
  }
}

if (apiGroundTruth.length !== verificationTargets.length) {
  pushFailure("apiGroundTruth", "entryCount", verificationTargets.length, apiGroundTruth.length)
}

const targetByName = new Map(verificationTargets.map((target) => [target.name, target]))
for (const entry of apiGroundTruth) {
  const section = `apiGroundTruth:${entry.api_name}`
  const target = targetByName.get(entry.api_name)
  if (!target) {
    pushFailure(section, "api_name", "must match verification target", entry.api_name)
    continue
  }
  if (entry.node_kind !== "api") {
    pushFailure(section, "node_kind", "api", entry.node_kind)
  }
  if (!entry.source || typeof entry.source.file_path !== "string" || typeof entry.source.line_number !== "number") {
    pushFailure(section, "source", "file_path + line_number", entry.source)
  }
  if (!entry.relations || typeof entry.relations !== "object") {
    pushFailure(section, "relations", "object", entry.relations)
    continue
  }
  if (!entry.verification_contract || typeof entry.verification_contract !== "object") {
    pushFailure(section, "verification_contract", "object", entry.verification_contract)
    continue
  }
  if (!entry.relation_type_lists || typeof entry.relation_type_lists !== "object") {
    pushFailure(section, "relation_type_lists", "object", entry.relation_type_lists)
    continue
  }
  if (!Array.isArray(entry.verification_contract.required_sections)) {
    pushFailure(section, "verification_contract.required_sections", "array", entry.verification_contract.required_sections)
  }
  if (typeof entry.verification_contract.minimum_counts !== "object" || entry.verification_contract.minimum_counts === null) {
    pushFailure(section, "verification_contract.minimum_counts", "object", entry.verification_contract.minimum_counts)
  }
  if (typeof entry.verification_contract.feedback_if_missing !== "string" || entry.verification_contract.feedback_if_missing.trim().length === 0) {
    pushFailure(section, "verification_contract.feedback_if_missing", "non-empty string", entry.verification_contract.feedback_if_missing)
  }

  const consolidatedRows = [
    ...(entry.relations.who_calls?.callers ?? []),
    ...(entry.relations.who_calls_at_runtime?.callers ?? []),
    ...(entry.relations.what_api_calls?.callees ?? []),
    ...(entry.relations.hw_invokers?.blocks ?? []),
    ...(entry.relations.hw_targets?.blocks ?? []),
    ...(entry.relations.registrations?.registered_by ?? []),
    ...(entry.relations.dispatch_sites?.sites ?? []),
    ...(entry.relations.struct_reads?.fields ?? []),
    ...(entry.relations.struct_writes?.fields ?? []),
    ...(entry.relations.field_access_paths?.paths ?? []),
    ...(entry.relations.logs?.entries ?? []),
    ...(entry.relations.timer_triggers?.triggers ?? []),
    ...(entry.relations.other_relations?.rows ?? []),
  ]

  const targetRowCount = queryCasesForApiEntry(entry).reduce((count, queryCase) => count + (queryCase.mockRows?.length ?? 0), 0)
  if (consolidatedRows.length < targetRowCount) {
    pushFailure(section, "relations.totalRows", `>= ${targetRowCount}`, consolidatedRows.length)
  }

  for (const row of consolidatedRows) {
    verifyApiGroundTruthRow(section, row)
  }

  const flattenedRelationTypeRows = RELATION_TYPE_LIST_KEYS.flatMap(
    (key) => entry.relation_type_lists?.[key] ?? [],
  )
  if (flattenedRelationTypeRows.length < consolidatedRows.length) {
    pushFailure(
      section,
      "relation_type_lists.totalRows",
      `>= ${consolidatedRows.length}`,
      flattenedRelationTypeRows.length,
    )
  }
  for (const key of RELATION_TYPE_LIST_KEYS) {
    if (!Array.isArray(entry.relation_type_lists?.[key])) {
      pushFailure(section, `relation_type_lists.${key}`, "array", entry.relation_type_lists?.[key])
    }
  }
  const allowedRelationKinds = new Set(RELATION_TYPE_LIST_KEYS)
  for (const row of flattenedRelationTypeRows) {
    verifyApiGroundTruthRow(section, row)
    if (typeof row.relation_kind !== "string" || !allowedRelationKinds.has(row.relation_kind)) {
      pushFailure(section, "relation_type_lists.row.relation_kind", `one of ${RELATION_TYPE_LIST_KEYS.join(",")}`, row.relation_kind)
    }
    if (typeof row.src_name !== "string") {
      pushFailure(section, "relation_type_lists.row.src_name", "string", row.src_name)
    }
    if (typeof row.dst_name !== "string") {
      pushFailure(section, "relation_type_lists.row.dst_name", "string", row.dst_name)
    }
  }

  for (const pathExpr of entry.verification_contract.required_sections ?? []) {
    const value = getByPath(entry.relations, pathExpr)
    if (!Array.isArray(value)) {
      pushFailure(section, `verification_contract.required_sections:${pathExpr}`, "array", value)
      continue
    }
    const min = Number(entry.verification_contract.minimum_counts?.[pathExpr] ?? 0)
    if (value.length < min) {
      pushFailure(section, `verification_contract.minimum_counts:${pathExpr}`, `>= ${min}`, value.length)
    }
  }
}

if (coverageExpectations) {
  const categories = new Set(verificationTargets.map((target) => target.category))
  const intents = new Set()
  const relationKinds = new Set()
  const rowKinds = new Set()
  const graphNodeKinds = new Set()
  const queryCaseCount = apiGroundTruth.reduce((count, entry) => count + queryCasesForApiEntry(entry).length, 0)

  for (const target of verificationTargets) {
    const entry = apiGroundTruth.find((api) => api.api_name === target.name)
    const queryCases = entry ? queryCasesForApiEntry(entry) : []
    for (const node of target.graphNodes ?? []) {
      graphNodeKinds.add(node.kind)
    }
    for (const queryCase of queryCases) {
      intents.add(queryCase.intent)
      for (const row of queryCase.mockRows ?? []) {
        rowKinds.add(String(row.kind))
        relationKinds.add(mapRelationKind(queryCase.intent, row))
      }
    }
  }

  if (verificationTargets.length < (coverageExpectations.minimumVerificationTargets ?? 0)) {
    pushFailure("coverageExpectations", "minimumVerificationTargets", coverageExpectations.minimumVerificationTargets, verificationTargets.length)
  }
  if (queryCaseCount < (coverageExpectations.minimumQueryCases ?? 0)) {
    pushFailure("coverageExpectations", "minimumQueryCases", coverageExpectations.minimumQueryCases, queryCaseCount)
  }
  for (const category of coverageExpectations.requiredCategories ?? []) {
    if (!categories.has(category)) {
      pushFailure("coverageExpectations", `requiredCategories:${category}`, "present", [...categories])
    }
  }
  for (const intent of coverageExpectations.requiredQueryIntents ?? []) {
    if (!intents.has(intent)) {
      pushFailure("coverageExpectations", `requiredQueryIntents:${intent}`, "present", [...intents])
    }
  }
  for (const relationKind of coverageExpectations.requiredRelationKinds ?? []) {
    if (!relationKinds.has(relationKind)) {
      pushFailure("coverageExpectations", `requiredRelationKinds:${relationKind}`, "present", [...relationKinds])
    }
  }
  for (const rowKind of coverageExpectations.requiredQueryRowKinds ?? []) {
    if (!rowKinds.has(rowKind)) {
      pushFailure("coverageExpectations", `requiredQueryRowKinds:${rowKind}`, "present", [...rowKinds])
    }
  }
  for (const graphNodeKind of coverageExpectations.requiredVerificationGraphNodeKinds ?? []) {
    if (!graphNodeKinds.has(graphNodeKind)) {
      pushFailure("coverageExpectations", `requiredVerificationGraphNodeKinds:${graphNodeKind}`, "present", [...graphNodeKinds])
    }
  }
}

if (apiGroundTruthCoverage) {
  if (Number(apiGroundTruthCoverage.api_count ?? 0) !== apiGroundTruth.length) {
    pushFailure("apiGroundTruthCoverage", "api_count", apiGroundTruth.length, apiGroundTruthCoverage.api_count)
  }
  const categories = new Set(apiGroundTruth.map((entry) => entry.category))
  for (const category of coverageExpectations?.requiredCategories ?? []) {
    if (!categories.has(category)) {
      pushFailure("apiGroundTruthCoverage", `category:${category}`, "present in apiGroundTruth", [...categories])
    }
    if (!(apiGroundTruthCoverage.categories ?? []).includes(category)) {
      pushFailure("apiGroundTruthCoverage", `categories:${category}`, "present", apiGroundTruthCoverage.categories)
    }
  }

  const requiredKinds = new Set((fixture.requiredNodeKinds ?? []).map((entry) => entry.kind))
  const apiGroundTruthKinds = new Set()
  for (const entry of apiGroundTruth) {
    const rows = [
      ...(entry.relations?.who_calls?.callers ?? []),
      ...(entry.relations?.who_calls_at_runtime?.callers ?? []),
      ...(entry.relations?.what_api_calls?.callees ?? []),
      ...(entry.relations?.hw_invokers?.blocks ?? []),
      ...(entry.relations?.hw_targets?.blocks ?? []),
      ...(entry.relations?.registrations?.registered_by ?? []),
      ...(entry.relations?.dispatch_sites?.sites ?? []),
      ...(entry.relations?.struct_reads?.fields ?? []),
      ...(entry.relations?.struct_writes?.fields ?? []),
      ...(entry.relations?.field_access_paths?.paths ?? []),
      ...(entry.relations?.logs?.entries ?? []),
      ...(entry.relations?.timer_triggers?.triggers ?? []),
      ...(entry.relations?.other_relations?.rows ?? []),
    ]
    for (const row of rows) {
      const rawKind = String(row.kind ?? "").toLowerCase()
      apiGroundTruthKinds.add(rawKind === "function" ? "api" : rawKind)
    }
  }

  for (const kind of requiredKinds) {
    if (!apiGroundTruthKinds.has(kind)) {
      pushFailure("apiGroundTruthCoverage", `requiredNodeKinds:${kind}`, "present in apiGroundTruth rows", [...apiGroundTruthKinds])
    }
    if (!(apiGroundTruthCoverage.node_kinds ?? []).includes(kind)) {
      pushFailure("apiGroundTruthCoverage", `node_kinds:${kind}`, "present", apiGroundTruthCoverage.node_kinds)
    }
  }
}

if (failures.length > 0) {
  console.error("WLAN source audit failed.")
  console.error(JSON.stringify({
    workspaceRoot,
    fixture: FIXTURE_PATH,
    nodeKindProbeCount: nodeKindProbes.length,
    verificationTargetCount: verificationTargets.length,
    failureCount: failures.length,
    failures,
  }, null, 2))
  process.exit(1)
}

console.log("WLAN source audit passed.")
console.log(`Workspace:            ${workspaceRoot}`)
console.log(`Fixture:              ${FIXTURE_PATH}`)
console.log(`Node kind probes:     ${nodeKindProbes.length}`)
console.log(`Verification targets: ${verificationTargets.length}`)
console.log(`API ground truth:     ${apiGroundTruth.length}`)
