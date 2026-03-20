import { readFileSync, existsSync } from "fs"
import { execSync } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import type { LspClient } from "../lsp/index.js"

// ── LSP SymbolKind constants ──────────────────────────────────────────────────
export const SYMBOL_KIND_FUNCTION = 12
export const SYMBOL_KIND_VARIABLE = 13
export const SYMBOL_KIND_CONSTANT = 14

// ── Classification types ──────────────────────────────────────────────────────
export const INDIRECT_CALLER_CLASSIFICATIONS = {
  direct:                    "direct",
  registrationDispatchTable: "registration-dispatch-table",
  registrationCall:          "registration-call",
  registrationStruct:        "registration-struct",
  signalBasedNonFnptr:       "signal-based-non-fnptr",
} as const

export type IndirectCallerClassification =
  typeof INDIRECT_CALLER_CLASSIFICATIONS[keyof typeof INDIRECT_CALLER_CLASSIFICATIONS]

// ── LSP shape helpers ─────────────────────────────────────────────────────────
export interface LspPosition { line: number; character: number }
export interface LspRange    { start: LspPosition; end: LspPosition }

export interface CallHierarchyItemLike {
  name?:           string
  kind?:           number
  uri?:            string
  range?:          LspRange
  selectionRange?: LspRange
  detail?:         string
}

export interface IncomingCallLike {
  from?:       CallHierarchyItemLike
  caller?:     CallHierarchyItemLike   // alternate field name used by some LSP servers
  fromRanges?: LspRange[]
}

// ── Engine options ────────────────────────────────────────────────────────────
export interface IndirectCallersEngineOptions {
  maxNodes?: number   // safety cap on total results, default 15
}

// ── Ring trigger — the HW interrupt that fires a ring signal ──────────────────
// Found by searching for cmnos_irq_register(..., <signalId>) in the workspace.
export interface RingTrigger {
  interruptId:   string   // e.g. "A_INUM_TQM_STATUS_HI"
  file:          string   // absolute path to the file containing cmnos_irq_register call
  line:          number   // 1-based line number
  sourceContext: string   // the full cmnos_irq_register call line (trimmed)
}

// ── Result types ──────────────────────────────────────────────────────────────
export interface IndirectCallerNode {
  id:              string
  name:            string
  kind:            number | null
  uri:             string | null
  location:        string
  classification:  IndirectCallerClassification
  // For registration-call: the known registration API name (e.g. "offldmgr_register_data_offload")
  registrationApi: string | null
  // Source line(s) at the reference site — used for context display
  sourceContext:   string[]
  fromRanges:      LspRange[]
  // For ring-triggered handlers: the HW interrupt that fires the signal
  // Populated when registrationApi is a ring signal API and rg is available
  ringTrigger?:    RingTrigger | null
}

export interface IndirectCallerGraph {
  seed:  CallHierarchyItemLike | null
  nodes: IndirectCallerNode[]
}

// ── Symbol kind labels ────────────────────────────────────────────────────────
const SYMBOL_KIND_LABELS: Record<number, string> = {
  [SYMBOL_KIND_FUNCTION]: "Function",
  [SYMBOL_KIND_VARIABLE]: "Variable",
  [SYMBOL_KIND_CONSTANT]: "Constant",
}

// ── WLAN registration API set ─────────────────────────────────────────────────
// Derived from systematic exploration of WLAN.CNG.1.0-01880.3 codebase.
// Each entry is a function whose argument (at the documented position) is a
// function pointer that will be invoked indirectly at runtime.
//
// Category B: Thread message handlers (arg 1 is fn-ptr)
//   wlan_thread_msg_handler_register_dval_dptr1_dptr2  — 277+ sites
//   wlan_thread_msg_handler_register_var_len_buf        — 277+ sites
//
// Category B: Offload manager (arg 2 is fn-ptr; arg 4 for data variant)
//   offldmgr_register_nondata_offload / _offldmgr_register_nondata_offload
//   offldmgr_register_data_offload    / _offldmgr_register_data_offload
//   offldmgr_register_wmi_offload     / _offldmgr_register_wmi_offload
//   offldmgr_register_htt_offload     / _offldmgr_register_htt_offload
//
// Category B: WAL event handlers (arg 1 or 2 is fn-ptr)
//   wal_peer_register_event_handler    — 30+ sites
//   wal_vdev_register_event_handler    — 10+ sites
//   wal_phy_dev_register_event_handler — 15+ sites
//   wal_soc_register_event_handler
//
// Category B: Protocol/power callbacks
//   wlan_wow_register_notif_handler          — 30+ sites
//   wlan_roam_register_handoff_notify        — 8 sites
//   wlan_scan_sch_register_event_handler / _wlan_scan_sch_register_event_handler
//   wlan_thread_notify_register              — 13 sites
//   pcie_mission_register_callback           — 2 sites
//   wal_power_register_event_cb              — 2 sites
//   wlif_register_callback                   — 1 site
//
// Category B: Timer (A_INIT_TIMER macro expands to cmnos_timer_setfn)
//   cmnos_timer_setfn                        — 474+ sites
//
// Category B: WMI frame handlers
//   WMI_RegisterMgmtFrameHandler
//   WMI_RegisterBcnFrameHandler
//   WMI_RegisterMgmtPassByValueHandler
//
// Category C: HTC/HIF service registration (struct-based, registration fn is known)
//   HTC_RegisterService / _HTC_PipeRegisterService
//   HIF_register_callback / _HIF_CE_register_callback
//   MSIF_register_callback
//   wlan_mgmt_txrx_register_coex_ops
//
// Category B: Misc device/subsystem callbacks
//   wal_dev_reset_register_callback
//   wal_dfs_phyerr_register_event_handler
//   wal_hif_prio_register_event_handler
//   wal_rmc_register_event_handler
//   tdls_register_event_handler
//   _wal_disa_register_event_handler
export const WLAN_REGISTRATION_APIS = new Set<string>([
  // Thread message handlers
  "wlan_thread_msg_handler_register_dval_dptr1_dptr2",
  "wlan_thread_msg_handler_register_var_len_buf",
  // Offload manager (both macro and underlying function names)
  "offldmgr_register_nondata_offload",
  "_offldmgr_register_nondata_offload",
  "offldmgr_register_data_offload",
  "_offldmgr_register_data_offload",
  "offldmgr_register_wmi_offload",
  "_offldmgr_register_wmi_offload",
  "offldmgr_register_htt_offload",
  "_offldmgr_register_htt_offload",
  // WAL event handlers
  "wal_peer_register_event_handler",
  "wal_vdev_register_event_handler",
  "wal_phy_dev_register_event_handler",
  "wal_soc_register_event_handler",
  // Protocol / power callbacks
  "wlan_wow_register_notif_handler",
  "wlan_roam_register_handoff_notify",
  "wlan_scan_sch_register_event_handler",
  "_wlan_scan_sch_register_event_handler",
  "wlan_thread_notify_register",
  "pcie_mission_register_callback",
  "wal_power_register_event_cb",
  "wlif_register_callback",
  // Timer (A_INIT_TIMER macro expands to this)
  "cmnos_timer_setfn",
  // WMI frame handlers
  "WMI_RegisterMgmtFrameHandler",
  "WMI_RegisterBcnFrameHandler",
  "WMI_RegisterMgmtPassByValueHandler",
  // HTC / HIF service registration
  "HTC_RegisterService",
  "_HTC_PipeRegisterService",
  "HIF_register_callback",
  "_HIF_CE_register_callback",
  "MSIF_register_callback",
  "wlan_mgmt_txrx_register_coex_ops",
  // Misc device / subsystem callbacks
  "wal_dev_reset_register_callback",
  "wal_dfs_phyerr_register_event_handler",
  "wal_hif_prio_register_event_handler",
  "wal_rmc_register_event_handler",
  "tdls_register_event_handler",
  "_wal_disa_register_event_handler",
  // ── Ring-triggered handler registration (Category F) ─────────────────────
  // Ring interrupt → IST-context fn-ptr routing (arg 2 is fn-ptr)
  // cmnos_irq_register_dynamic(interrupt_id, irq_route_cb)
  "cmnos_irq_register_dynamic",
  // Ring signal → handler fn-ptr with DSR wrapper (arg 3 is fn-ptr)
  // wlan_thread_register_signal_wrapper expands to one of these two:
  //   production: wlan_thread_register_signal_wrapper_internal
  //   sim:        wlan_thread_register_signal_wrapper_sim
  "wlan_thread_register_signal_wrapper_internal",
  "wlan_thread_register_signal_wrapper_sim",
  // Ring signal → handler fn-ptr direct (arg 3 is fn-ptr)
  "wlan_thread_register_signal",
  // ISR stub attachment — A_ISR_ATTACH macro expands to cmnos_isr_attach
  // cmnos_isr_attach(inum, isr_fn, isr_detach, arg)  — arg 2 is fn-ptr
  "cmnos_isr_attach",
  // DSR bottom-half attachment — A_DSR_ATTACH macro expands to cmnos_dsr_attach
  // cmnos_dsr_attach(inum, handler_fn, arg)  — arg 2 is fn-ptr
  "cmnos_dsr_attach",
  // CE pipe callback (struct HIF_CALLBACK field assignment)
  "_HIF_CE_register_pipe_callback",
])

// ── Internal helpers ──────────────────────────────────────────────────────────

function displayPath(uriOrPath: string, root: string): string {
  try {
    const abs = uriOrPath.startsWith("file://") ? fileURLToPath(uriOrPath) : uriOrPath
    return path.relative(root, abs)
  } catch {
    return uriOrPath
  }
}

function fmtLocation(item: CallHierarchyItemLike | null | undefined, root: string): string {
  if (!item) return "(unknown location)"
  const uri   = item.uri ?? ""
  const range = item.selectionRange ?? item.range
  const line  = range?.start?.line      != null ? range.start.line + 1      : "?"
  const col   = range?.start?.character != null ? range.start.character + 1 : "?"
  return `${displayPath(uri, root)}:${line}:${col}`
}

function normalizeIncomingCall(
  call: IncomingCallLike,
): { from: CallHierarchyItemLike; fromRanges: LspRange[] } | null {
  const from = call.from ?? call.caller
  if (!from) return null
  return { from, fromRanges: Array.isArray(call.fromRanges) ? [...call.fromRanges] : [] }
}

function compareRange(a: LspRange, b: LspRange): number {
  return (
    a.start.line - b.start.line ||
    a.start.character - b.start.character
  )
}

function sortIncomingCalls(calls: IncomingCallLike[]): IncomingCallLike[] {
  return [...calls].sort((left, right) => {
    const a = normalizeIncomingCall(left)
    const b = normalizeIncomingCall(right)
    if (!a && !b) return 0
    if (!a) return 1
    if (!b) return -1
    const uriCmp  = (a.from.uri ?? "").localeCompare(b.from.uri ?? "")
    if (uriCmp !== 0) return uriCmp
    const nameCmp = (a.from.name ?? "").localeCompare(b.from.name ?? "")
    if (nameCmp !== 0) return nameCmp
    if (a.fromRanges.length && b.fromRanges.length) return compareRange(a.fromRanges[0], b.fromRanges[0])
    return 0
  })
}

function isKnownRegistrationApi(name: string | undefined): boolean {
  return !!name && WLAN_REGISTRATION_APIS.has(name)
}

function readSourceContext(uri: string | undefined, ranges: LspRange[]): string[] {
  if (!uri || !ranges.length) return []
  try {
    const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri
    const lines    = readFileSync(filePath, "utf8").split(/\r?\n/)
    const unique   = [...new Set(ranges.map(r => r.start.line))].sort((a, b) => a - b)
    return unique.map(n => (lines[n] ?? "").trim())
  } catch {
    return []
  }
}

// Tier 3 helpers — all check the TARGET function name, not the enclosing function name.

/** Returns true when the target function is called directly on one of the context lines. */
function looksLikeDirectCall(targetName: string, contexts: string[]): boolean {
  if (!targetName) return false
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Match: targetName followed by optional whitespace then '('
  // Preceded by non-word char or start-of-line to avoid partial matches
  const pattern = new RegExp(`(?:^|[^\\w])${escaped}\\s*\\(`)
  return contexts.some(line => pattern.test(line))
}

/** Returns true when the context looks like a QuRT/RTOS signal-based registration. */
function looksLikeSignalMediation(contexts: string[]): boolean {
  return contexts.some(line => /\bsignal\b|\binterrupt\b|\bqurt\b/i.test(line))
}

/** Returns true when the context looks like a struct field assignment or initializer. */
function looksLikeStructRegistration(contexts: string[]): boolean {
  return contexts.some(line => /\.[A-Za-z_]\w*\s*=/.test(line))
}

// ── Ring signal API set ───────────────────────────────────────────────────────
// These are the registration APIs that connect a thread signal to a ring handler.
// When one of these is found as a registration-call, we search for the matching
// cmnos_irq_register(..., <signalId>) call to find the HW ring interrupt source.
const RING_SIGNAL_APIS = new Set<string>([
  "wlan_thread_register_signal_wrapper_internal",
  "wlan_thread_register_signal_wrapper_sim",
  "wlan_thread_register_signal",
])

// These are the direct IST/ISR/DSR registration APIs — the interrupt ID is
// already on the same source line as the registration, no rg search needed.
const RING_DIRECT_APIS = new Set<string>([
  "cmnos_irq_register_dynamic",
  "cmnos_isr_attach",
  "cmnos_dsr_attach",
])

/** Check if rg (ripgrep) is available on PATH. Cached after first check. */
let _rgAvailable: boolean | null = null
function isRgAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable
  try {
    execSync("rg --version", { stdio: "pipe" })
    _rgAvailable = true
  } catch {
    _rgAvailable = false
  }
  return _rgAvailable
}

/**
 * Extract the signal ID from a ring signal registration source line.
 * e.g. "wlan_thread_register_signal_wrapper(ctxt, WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR, handler, ...)"
 * → "WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR"
 */
function extractSignalId(contexts: string[]): string | null {
  for (const line of contexts) {
    const m = line.match(/\b(WLAN_THREAD_SIG_\w+|CMNOS_THREAD_SIG_\w+|WLAN_TQM_SIG_\w+)\b/)
    if (m) return m[1]
  }
  return null
}

/**
 * Extract the interrupt ID from a direct IST/ISR/DSR registration source line.
 * e.g. "cmnos_irq_register_dynamic(A_INUM_WMAC0_RX_SIFS, wlan_thread_isr_rx_sifs)"
 * → "A_INUM_WMAC0_RX_SIFS"
 */
function extractInterruptId(contexts: string[]): string | null {
  for (const line of contexts) {
    const m = line.match(/\b(A_INUM_\w+)\b/)
    if (m) return m[1]
  }
  return null
}

/**
 * Find the HW ring interrupt that fires a given signal ID.
 *
 * Searches the workspace for:
 *   cmnos_irq_register(<A_INUM_*>, ..., <signalId>)
 *
 * Uses rg (ripgrep) as a soft dependency. Returns null if rg is unavailable
 * or no match is found.
 *
 * @param signalId  e.g. "WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR"
 * @param root      workspace root to search
 */
export function findRingTrigger(signalId: string, root: string): RingTrigger | null {
  if (!signalId || !root || !isRgAvailable()) return null
  try {
    // Search for lines containing the signal ID
    const escaped = signalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const output = execSync(
      `rg --json -n "${escaped}" "${root}" --glob "*.{c,h}" --max-count 30`,
      { stdio: "pipe", timeout: 10000 },
    ).toString()

    // Collect all matches with their file paths and line numbers
    const matches: Array<{ file: string; line: number; text: string }> = []
    for (const rawLine of output.split("\n")) {
      if (!rawLine.trim()) continue
      let parsed: any
      try { parsed = JSON.parse(rawLine) } catch { continue }
      if (parsed.type !== "match") continue
      matches.push({
        file:  parsed.data?.path?.text ?? "",
        line:  parsed.data?.line_number ?? 0,
        text:  (parsed.data?.lines?.text ?? "").trim(),
      })
    }

    // For each match, check if the signal ID line or the line before it
    // contains cmnos_irq_register with an A_INUM_* interrupt ID.
    // The call is often split across two lines:
    //   cmnos_irq_register(A_INUM_TQM_STATUS_HI,   me,       ← line N
    //           WLAN_THREAD_SIG_TQM_HIPRI_STATUS_HW_INTR);   ← line N+1
    for (const match of matches) {
      const { file, line, text } = match

      // Case 1: signal ID and cmnos_irq_register on the same line
      if ((text.includes("cmnos_irq_register(") || text.includes("cmnos_irq_register (")) &&
          text.includes(signalId)) {
        const inumMatch = text.match(/\b(A_INUM_\w+)\b/)
        if (inumMatch) {
          return { interruptId: inumMatch[1], file, line, sourceContext: text }
        }
      }

      // Case 2: signal ID is on this line, cmnos_irq_register is on the previous line
      // Read the previous line from the file
      if (file) {
        try {
          const fileLines = readFileSync(file, "utf8").split(/\r?\n/)
          const prevLine  = (fileLines[line - 2] ?? "").trim()  // line is 1-based, array is 0-based
          if (prevLine.includes("cmnos_irq_register(") || prevLine.includes("cmnos_irq_register (")) {
            // A_INUM_* may be on the current line (continuation) or the previous line
            const inumMatch = text.match(/\b(A_INUM_\w+)\b/) ?? prevLine.match(/\b(A_INUM_\w+)\b/)
            if (inumMatch) {
              return {
                interruptId:   inumMatch[1],
                file,
                line:          line - 1,   // point to the cmnos_irq_register line
                sourceContext: `${prevLine} ${text}`.replace(/\\\s*$/, "").trim(),
              }
            }
          }
        } catch {
          // file read failed — skip
        }
      }
    }
  } catch {
    // rg failed or timed out — degrade gracefully
  }
  return null
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Classify one incoming-call edge returned by clangd.
 *
 * @param call       Raw CallHierarchyIncomingCall from clangd
 * @param targetName Name of the function being queried (from prepareCallHierarchy)
 *
 * Tier 1 — from.kind check (O(1), no I/O):
 *   kind==13 (Variable) or 14 (Constant) → dispatch table / static initializer
 *
 * Tier 2 — Registration API name check (O(1), Set lookup):
 *   from.name ∈ WLAN_REGISTRATION_APIS → registration call
 *
 * Tier 3 — Source text check (one readFileSync, one line per fromRange):
 *   targetName( on the line → direct call
 *   signal/interrupt/qurt   → signal-based non-fnptr
 *   .field =                → struct registration
 *   fallback                → registration-call (conservative)
 */
export function classifyIncomingCall(
  call: IncomingCallLike,
  targetName: string,
): IndirectCallerClassification {
  const normalized = normalizeIncomingCall(call)
  if (!normalized) return INDIRECT_CALLER_CLASSIFICATIONS.direct

  const { from, fromRanges } = normalized

  // Tier 1: static initializer / dispatch table
  if (from.kind === SYMBOL_KIND_VARIABLE || from.kind === SYMBOL_KIND_CONSTANT) {
    return INDIRECT_CALLER_CLASSIFICATIONS.registrationDispatchTable
  }

  // Tier 2: known registration API
  if (isKnownRegistrationApi(from.name)) {
    return INDIRECT_CALLER_CLASSIFICATIONS.registrationCall
  }

  // Tier 3: read source at reference site
  const contexts = readSourceContext(from.uri, fromRanges)

  if (looksLikeDirectCall(targetName, contexts)) {
    return INDIRECT_CALLER_CLASSIFICATIONS.direct
  }
  if (looksLikeSignalMediation(contexts)) {
    return INDIRECT_CALLER_CLASSIFICATIONS.signalBasedNonFnptr
  }
  if (looksLikeStructRegistration(contexts)) {
    return INDIRECT_CALLER_CLASSIFICATIONS.registrationStruct
  }

  // Conservative fallback: treat as registration-call rather than silently
  // misclassifying an unknown registration pattern as a direct call.
  return INDIRECT_CALLER_CLASSIFICATIONS.registrationCall
}

// ── Node builder ──────────────────────────────────────────────────────────────

function toNode(
  from: CallHierarchyItemLike,
  fromRanges: LspRange[],
  root: string,
  targetName: string,
): IndirectCallerNode {
  const classification = classifyIncomingCall({ from, fromRanges }, targetName)
  const firstRange     = fromRanges[0]
  const sourceContext  = readSourceContext(from.uri, fromRanges)
  return {
    id:             `${from.uri ?? ""}:${from.name ?? ""}:${firstRange?.start.line ?? -1}:${firstRange?.start.character ?? -1}`,
    name:           from.name ?? "(unknown)",
    kind:           from.kind ?? null,
    uri:            from.uri ?? null,
    location:       fmtLocation(from, root),
    classification,
    registrationApi: isKnownRegistrationApi(from.name) ? (from.name ?? null) : null,
    sourceContext,
    fromRanges,
    ringTrigger:    undefined,   // populated by engine after node creation
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

/**
 * Flat single-pass indirect caller engine.
 *
 * Performs exactly ONE prepareCallHierarchy + ONE incomingCalls query.
 * Each result is classified and returned as a flat node.
 * No recursion. No BFS. Registration endpoints are terminal.
 *
 * For ring-triggered handlers (wlan_thread_register_signal_wrapper, etc.),
 * the engine additionally searches for the matching cmnos_irq_register call
 * using rg to find the HW ring interrupt that fires the signal.
 *
 * Design rationale: a registration endpoint (dispatch table entry, callback
 * registration, timer) IS the answer — it identifies the event source that
 * will invoke the target at runtime. Recursing into who calls the registrar
 * answers a different question ("who initialises this subsystem?") and
 * produces unbounded output.
 */
export class IndirectCallersEngine {
  private readonly client:  LspClient
  private readonly maxNodes: number

  constructor(client: LspClient, options: IndirectCallersEngineOptions = {}) {
    this.client   = client
    this.maxNodes = options.maxNodes ?? 15
  }

  async run(filePath: string, line: number, character: number): Promise<IndirectCallerGraph> {
    // Step 1: resolve the target symbol name
    const seedItems = await this.client.prepareCallHierarchy(filePath, line, character)
    const seed      = seedItems[0] ?? null
    if (!seed) return { seed: null, nodes: [] }

    const targetName = seed.name ?? ""

    // Step 2: get all incoming references in one query
    const raw      = await this.client.incomingCalls(filePath, line, character)
    const incoming = sortIncomingCalls(raw)

    // Step 3: classify each reference — flat, no recursion
    const seen  = new Set<string>()
    const nodes: IndirectCallerNode[] = []

    for (const call of incoming) {
      if (nodes.length >= this.maxNodes) break
      const normalized = normalizeIncomingCall(call)
      if (!normalized) continue

      const node = toNode(normalized.from, normalized.fromRanges, this.client.root, targetName)
      if (seen.has(node.id)) continue
      seen.add(node.id)

      // Step 4: for ring signal APIs, find the HW interrupt that fires the signal
      if (node.classification === "registration-call" && node.registrationApi) {
        if (RING_SIGNAL_APIS.has(node.registrationApi)) {
          // Extract signal ID from source context, then search for cmnos_irq_register
          const signalId = extractSignalId(node.sourceContext)
          node.ringTrigger = signalId
            ? findRingTrigger(signalId, this.client.root)
            : null
        } else if (RING_DIRECT_APIS.has(node.registrationApi)) {
          // Interrupt ID is already on the registration line — extract directly
          const inumId = extractInterruptId(node.sourceContext)
          if (inumId) {
            // Synthesize a RingTrigger from the registration line itself
            node.ringTrigger = {
              interruptId:   inumId,
              file:          node.uri ?? "",
              line:          (node.fromRanges[0]?.start.line ?? 0) + 1,
              sourceContext: node.sourceContext[0] ?? "",
            }
          }
        }
      }

      nodes.push(node)
    }

    return { seed, nodes }
  }
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/** Extract a WMI CMD_ID or thread func_id from a dispatch-table source line. */
function extractEventLabel(contexts: string[]): string | null {
  for (const line of contexts) {
    // WMI command ID: WMI_*_CMDID
    const wmiMatch = line.match(/\b(WMI_\w+_CMDID)\b/)
    if (wmiMatch) return wmiMatch[1]
    // Thread func ID: WLAN_THREAD_COMM_FUNC_*
    const threadMatch = line.match(/\b(WLAN_THREAD_COMM_FUNC_\w+)\b/)
    if (threadMatch) return threadMatch[1]
    // HTC service ID: *_SERVICE_ID or *_SVC_ID
    const htcMatch = line.match(/\b(\w+_SERVICE_ID|\w+_SVC_ID)\b/)
    if (htcMatch) return htcMatch[1]
    // Ring signal ID: WLAN_THREAD_SIG_* / CMNOS_THREAD_SIG_* / WLAN_TQM_SIG_*
    const sigMatch = line.match(/\b(WLAN_THREAD_SIG_\w+|CMNOS_THREAD_SIG_\w+|WLAN_TQM_SIG_\w+)\b/)
    if (sigMatch) return sigMatch[1]
    // Hardware interrupt ID: A_INUM_*
    const inumMatch = line.match(/\b(A_INUM_\w+)\b/)
    if (inumMatch) return inumMatch[1]
  }
  return null
}

/**
 * Format the indirect caller graph as a flat grouped plain-text output.
 *
 * Groups nodes by classification:
 *   Direct callers
 *   Dispatch-table registrations  (event source identified by CMD_ID / func_id)
 *   Registration-call registrations
 *   Struct registrations
 *   Signal-based registrations
 *
 * @param graph  Result from IndirectCallersEngine.run()
 * @param root   Workspace root for relative path display
 */
export function formatIndirectCallers(graph: IndirectCallerGraph, root?: string): string {
  if (!graph.seed) return "No callers found — symbol not resolved by clangd."
  const seedName = graph.seed.name ?? "(unknown)"
  if (!graph.nodes.length) return `Callers of ${seedName}:\n  (none found)`

  const effectiveRoot = root ?? ""

  const direct    = graph.nodes.filter(n => n.classification === "direct")
  const dispTable = graph.nodes.filter(n => n.classification === "registration-dispatch-table")
  const regCall   = graph.nodes.filter(n => n.classification === "registration-call")
  const regStruct = graph.nodes.filter(n => n.classification === "registration-struct")
  const signal    = graph.nodes.filter(n => n.classification === "signal-based-non-fnptr")

  const parts: string[] = []

  // Header
  const counts: string[] = []
  if (direct.length)    counts.push(`${direct.length} direct`)
  if (dispTable.length) counts.push(`${dispTable.length} dispatch-table`)
  if (regCall.length)   counts.push(`${regCall.length} registration-call`)
  if (regStruct.length) counts.push(`${regStruct.length} struct-reg`)
  if (signal.length)    counts.push(`${signal.length} signal`)
  parts.push(`Callers of ${seedName}  (${graph.nodes.length} total: ${counts.join(", ")})`)

  // ── Direct callers ──────────────────────────────────────────────────────────
  if (direct.length) {
    parts.push(`\nDirect callers (${direct.length}):`)
    for (const n of direct) {
      const kind = n.kind != null ? SYMBOL_KIND_LABELS[n.kind] ?? `Kind(${n.kind})` : "?"
      const loc  = effectiveRoot && n.uri ? fmtLocation({ uri: n.uri, selectionRange: n.fromRanges[0] ? { start: n.fromRanges[0].start, end: n.fromRanges[0].start } : undefined }, effectiveRoot) : n.location
      parts.push(`  <- [${kind}] ${n.name}  at ${loc}`)
    }
  }

  // ── Dispatch-table registrations ────────────────────────────────────────────
  if (dispTable.length) {
    parts.push(`\nDispatch-table registrations (${dispTable.length}):`)
    for (const n of dispTable) {
      const kind  = n.kind != null ? SYMBOL_KIND_LABELS[n.kind] ?? `Kind(${n.kind})` : "?"
      const loc   = effectiveRoot && n.uri ? fmtLocation({ uri: n.uri, selectionRange: n.fromRanges[0] ? { start: n.fromRanges[0].start, end: n.fromRanges[0].start } : undefined }, effectiveRoot) : n.location
      const event = extractEventLabel(n.sourceContext)
      parts.push(`  <- [${kind}] ${n.name}  at ${loc}`)
      if (event) parts.push(`     event: ${event}`)
      else if (n.sourceContext[0]) parts.push(`     context: ${n.sourceContext[0]}`)
    }
  }

  // ── Registration-call registrations ─────────────────────────────────────────
  if (regCall.length) {
    parts.push(`\nRegistration-call registrations (${regCall.length}):`)
    for (const n of regCall) {
      const kind = n.kind != null ? SYMBOL_KIND_LABELS[n.kind] ?? `Kind(${n.kind})` : "?"
      const loc  = effectiveRoot && n.uri ? fmtLocation({ uri: n.uri, selectionRange: n.fromRanges[0] ? { start: n.fromRanges[0].start, end: n.fromRanges[0].start } : undefined }, effectiveRoot) : n.location
      parts.push(`  <- [${kind}] ${n.name}  at ${loc}`)
      if (n.registrationApi) parts.push(`     via: ${n.registrationApi}`)

      // Show signal ID for ring signal registrations
      const signalId = n.registrationApi && RING_SIGNAL_APIS.has(n.registrationApi)
        ? extractSignalId(n.sourceContext)
        : null
      if (signalId) parts.push(`     signal: ${signalId}`)

      // Show ring trigger (HW interrupt source) if found
      if (n.ringTrigger) {
        const trigLoc = effectiveRoot
          ? `${displayPath(n.ringTrigger.file, effectiveRoot)}:${n.ringTrigger.line}`
          : `${n.ringTrigger.file}:${n.ringTrigger.line}`
        parts.push(`     triggered by: ${n.ringTrigger.interruptId}  at ${trigLoc}`)
        parts.push(`                   [HW ring interrupt → signal → this handler]`)
      } else if (n.ringTrigger === null && signalId) {
        // rg ran but found no match, or rg unavailable
        parts.push(`     triggered by: [search cmnos_irq_register(..., ${signalId}) to find HW ring]`)
      } else if (!signalId && !n.registrationApi) {
        if (n.sourceContext[0]) parts.push(`     context: ${n.sourceContext[0]}`)
      }
    }
  }

  // ── Struct registrations ────────────────────────────────────────────────────
  if (regStruct.length) {
    parts.push(`\nStruct registrations (${regStruct.length}):`)
    for (const n of regStruct) {
      const kind = n.kind != null ? SYMBOL_KIND_LABELS[n.kind] ?? `Kind(${n.kind})` : "?"
      const loc  = effectiveRoot && n.uri ? fmtLocation({ uri: n.uri, selectionRange: n.fromRanges[0] ? { start: n.fromRanges[0].start, end: n.fromRanges[0].start } : undefined }, effectiveRoot) : n.location
      parts.push(`  <- [${kind}] ${n.name}  at ${loc}`)
      if (n.sourceContext[0]) parts.push(`     context: ${n.sourceContext[0]}`)
    }
  }

  // ── Signal-based registrations ──────────────────────────────────────────────
  if (signal.length) {
    parts.push(`\nSignal-based registrations (${signal.length}):`)
    for (const n of signal) {
      const kind = n.kind != null ? SYMBOL_KIND_LABELS[n.kind] ?? `Kind(${n.kind})` : "?"
      const loc  = effectiveRoot && n.uri ? fmtLocation({ uri: n.uri, selectionRange: n.fromRanges[0] ? { start: n.fromRanges[0].start, end: n.fromRanges[0].start } : undefined }, effectiveRoot) : n.location
      parts.push(`  <- [${kind}] ${n.name}  at ${loc}`)
      if (n.sourceContext[0]) parts.push(`     context: ${n.sourceContext[0]}`)
    }
  }

  return parts.join("\n")
}
