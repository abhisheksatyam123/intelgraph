export interface SourceLocation {
  filePath: string
  line: number
  column?: number
}

export interface EvidenceRef {
  sourceKind: "file_line" | "clangd_response" | "log_line" | "runtime_parser"
  location?: SourceLocation
  raw?: Record<string, unknown>
}

export interface SnapshotMeta {
  workspaceRoot: string
  sourceRevision?: string
  compileDbHash: string
  parserVersion: string
  metadata?: Record<string, unknown>
}

export interface SnapshotRef {
  snapshotId: number
  createdAt: string
  status: "building" | "ready" | "failed"
}

export type EdgeKind =
  | "calls"
  | "indirect_calls"
  | "registers_callback"
  | "dispatches_to"
  | "reads_field"
  | "writes_field"
  | "uses_macro"
  | "logs_event"
  | "operates_on_struct"

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "VERBOSE" | "TRACE" | "UNKNOWN"

export interface LogRow {
  /** API/function that emits this log. */
  apiName: string
  /** Log level extracted from the log macro (AR_DEBUG_PRINTF, WLAN_LOGD, etc.). */
  level: LogLevel
  /** Raw log format string (may contain %s, %d, etc.). */
  template: string
  /** Subsystem tag extracted from the log call (e.g. "BPF", "WMI", "HIF"). */
  subsystem?: string
  /** Source location of the log call. */
  location?: SourceLocation
  /** Confidence that this log is associated with the API. */
  confidence: number
  /** Evidence reference. */
  evidence?: EvidenceRef
}

export interface SymbolRow {
  kind: "function" | "struct" | "union" | "enum" | "typedef" | "macro" | "global_var" | "field" | "param"
  name: string
  qualifiedName?: string
  signature?: string
  linkage?: "static" | "extern" | "none"
  location?: SourceLocation
  metadata?: Record<string, unknown>
}

export interface TypeRow {
  kind: "builtin" | "pointer" | "array" | "function_proto" | "struct" | "union" | "enum" | "typedef"
  spelling: string
  sizeBits?: number
  alignBits?: number
  symbolName?: string
}

export interface AggregateFieldRow {
  aggregateSymbolName: string
  name: string
  ordinal: number
  typeSpelling: string
  bitOffset?: number
  bitWidth?: number
  isBitfield?: boolean
}

export interface EdgeRow {
  edgeKind: EdgeKind
  srcSymbolName?: string
  dstSymbolName?: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  evidence?: EvidenceRef
  metadata?: Record<string, unknown>
}

export interface RuntimeCallerRow {
  targetApi: string
  runtimeTrigger: string
  dispatchChain: string[]
  immediateInvoker: string
  dispatchSite: SourceLocation
  confidence: number
  evidence?: EvidenceRef
}

export interface IngestReport {
  snapshotId: number
  inserted: {
    symbols: number
    types: number
    fields: number
    edges: number
    runtimeCallers: number
    logs: number
  }
  warnings: string[]
}

export interface GraphNode {
  id: string
  symbol: string
  kind: string
}

export interface GraphEdge {
  id: string
  kind: EdgeKind
  src: string
  dst: string
  confidence: number
  derivation: string
}

export interface CallerGraph {
  snapshotId: number
  apiName: string
  depth: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface CalleeGraph {
  snapshotId: number
  apiName: string
  depth: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface Provenance {
  edgeId: string
  evidence: EvidenceRef[]
}
