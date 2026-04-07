/**
 * context.ts — the ExtractionContext interface.
 *
 * The `ctx` object passed to every plugin invocation. It exposes the parsing
 * services (LSP, tree-sitter, ripgrep, workspace) plus typed fact builders
 * that emit into the FactBus.
 *
 * Step 1 of the plugin infrastructure rollout (see
 * /home/abhi/.claude/plans/zippy-mapping-flurry.md) introduces only the
 * **interface** here. The concrete class implementation lands in Step 4
 * once the FactBus and services exist. Splitting the interface from the
 * implementation lets the contract type-check on its own and lets later
 * steps land incrementally.
 *
 * Why an interface and not a class shape directly: an interface lets the
 * runner construct different ctx instances for different plugins (each
 * with its own extractorName for provenance) without subclassing. Later
 * problems (Problem 4 in particular) may also stub a `ReadOnlyContext` for
 * library-mode embedding.
 */

import type {
  AggregateFieldFactInput,
  EdgeFactInput,
  EvidenceFactInput,
  ObservationFactInput,
  SymbolFactInput,
  TypeFactInput,
} from "./facts.js"
import type {
  AggregateFieldFact,
  EdgeFact,
  EvidenceFact,
  ObservationFact,
  SymbolFact,
  TypeFact,
} from "./facts.js"
import type { SourceLocation } from "../contracts/common.js"
import type {
  LspService,
  TreeSitterService,
  RipgrepService,
  WorkspaceService,
} from "./services/index.js"

// Re-export the service interfaces so consumers of context.ts get the
// whole ctx surface from one import.
export type { LspService, TreeSitterService, RipgrepService, WorkspaceService }

// ---------------------------------------------------------------------------
// Operational helpers exposed on ctx
// ---------------------------------------------------------------------------

/**
 * A small in-snapshot key/value cache. Lifetime is one snapshot — when the
 * runner finishes the snapshot the cache is dropped. Plugins use it to
 * memoize expensive operations (e.g. "I already parsed this file") so the
 * core does not have to thread shared caches between plugins.
 */
export interface KeyedCache {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  has(key: string): boolean
  /**
   * Convenience: get if present, else compute, store, and return. The
   * compute function is called at most once per key per snapshot.
   */
  getOrCompute<T>(key: string, compute: () => Promise<T> | T): Promise<T>
}

/**
 * Per-plugin logger. Tags every message with the extractor name so the
 * aggregated runner report shows where messages came from.
 */
export interface PluginLogger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

/**
 * Per-plugin metrics sink. Counters and timings are aggregated by the
 * runner into the per-snapshot IngestReport.
 */
export interface PluginMetrics {
  count(name: string, n?: number): void
  timing(name: string, ms: number): void
}

// ---------------------------------------------------------------------------
// ExtractionContext — what plugins receive
// ---------------------------------------------------------------------------

/**
 * The object passed to every plugin's extract() generator. Plugins use this
 * to:
 *  - access parsing services (LSP, tree-sitter, ripgrep, workspace)
 *  - build typed facts via ctx.symbol/edge/evidence/observation
 *  - cache work within a snapshot
 *  - log and emit metrics
 *  - check for cancellation via ctx.signal
 *
 * Plugins should treat the ctx as read-only apart from calling its methods.
 * They must not stash references to it across snapshots — the runner builds
 * a fresh ctx per (plugin, snapshot) pair.
 */
export interface ExtractionContext {
  // --- Identity ---

  /** Snapshot the bus will write facts into. */
  readonly snapshotId: number
  /** Workspace root the plugin is operating on. */
  readonly workspaceRoot: string
  /**
   * Name of the plugin this ctx belongs to. Used for auto-provenance on
   * every emitted fact. Read-only.
   */
  readonly extractorName: string

  // --- Parsing services (full surface lands in Step 2) ---

  readonly lsp: LspService
  readonly treesitter: TreeSitterService
  readonly ripgrep: RipgrepService
  readonly workspace: WorkspaceService

  // --- Fact builders (auto-tag with producedBy = [extractorName]) ---

  /**
   * Build and enqueue a SymbolFact into the FactBus. Returns the constructed
   * fact for plugin convenience (e.g. when the plugin wants to attach
   * evidence to it later by canonical key).
   */
  symbol(input: SymbolFactInput): SymbolFact

  /** Build and enqueue a TypeFact. */
  type(input: TypeFactInput): TypeFact

  /** Build and enqueue an AggregateFieldFact. */
  aggregateField(input: AggregateFieldFactInput): AggregateFieldFact

  /** Build and enqueue an EdgeFact. */
  edge(input: EdgeFactInput): EdgeFact

  /** Build and enqueue an EvidenceFact attached to an existing fact. */
  evidence(input: EvidenceFactInput): EvidenceFact

  /** Build and enqueue an ObservationFact. */
  observation(input: ObservationFactInput): ObservationFact

  /**
   * Convenience for constructing a SourceLocation. Centralized so plugins
   * never have to remember the field naming (filePath vs file vs path,
   * line vs lineNumber, etc.).
   */
  location(filePath: string, line: number, column?: number): SourceLocation

  // --- Operational helpers ---

  readonly cache: KeyedCache
  readonly log: PluginLogger
  readonly metrics: PluginMetrics
  readonly signal: AbortSignal
}
