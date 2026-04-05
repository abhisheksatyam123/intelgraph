export type {
  AggregateFieldRow,
  CalleeGraph,
  CallerGraph,
  EdgeKind,
  EdgeRow,
  EvidenceRef,
  GraphEdge,
  GraphNode,
  IngestReport,
  Provenance,
  RuntimeCallerRow,
  RuntimeGraphNodeKind,
  RuntimeGraphParticipantRow,
  SnapshotMeta,
  SnapshotRef,
  SourceLocation,
  SymbolRow,
  TypeRow,
} from "./common.js"

export type { DbTxContext, IDbFoundation, ISnapshotIngestWriter } from "./db-foundation.js"

export type {
  EdgeBatch,
  ExtractionBatches,
  ExtractionInput,
  IExtractionAdapter,
  SymbolBatch,
  TypeBatch,
} from "./extraction-adapter.js"

export type {
  IIndirectCallerIngestion,
  LinkReport,
  RuntimeCallerBatch,
  RuntimeCallerInput,
} from "./indirect-caller-ingestion.js"

export type { IQueryService, QueryOptions } from "./query-service.js"

export {
  DEFAULT_FALLBACK_POLICY,
  decideOrchestrationAction,
  QUERY_INTENTS,
  parseQueryIntent,
  shouldRunLlmFallback,
  validateQueryRequest,
  validateResponseShape,
} from "./orchestrator.js"

export type {
  AuthoritativeSnapshotRepository,
  CParserEnricher,
  ClangdEnricher,
  DbLookupRepository,
  DeterministicEnricherSource,
  EnricherContext,
  EnrichmentResult,
  FallbackPolicy,
  GraphProjectionRepository,
  LlmEnricher,
  LookupResult,
  NormalizedQueryResponse,
  OrchestrationAction,
  OrchestrationState,
  PersistenceContracts,
  QueryIntent,
  QueryRequest,
} from "./orchestrator.js"

export { nodeResponseSchema } from "./node-protocol.js"
export type { NodeProtocolResponse } from "./node-protocol.js"
