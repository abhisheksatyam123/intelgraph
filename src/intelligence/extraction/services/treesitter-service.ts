/**
 * treesitter-service.ts — TreeSitter service exposed via ctx.treesitter.
 *
 * Wraps the existing tree-sitter C parser at
 * src/tools/pattern-detector/c-parser.ts. Plugins use this to parse C source
 * and locate structural constructs without spinning up their own parser
 * instance or knowing about the WASM init dance.
 *
 * The service:
 *   - Triggers initParser() lazily on first use (and caches the failure
 *     state, so a parser that fails to init does not retry on every call).
 *   - Reads files on demand if the plugin doesn't already have the source.
 *   - Exposes the existing FunctionCall shape and helper functions
 *     (findEnclosingCall, findEnclosingConstruct) directly.
 *
 * Future extensions (deferred to later problems):
 *   - Pluggable grammar registry for non-C languages
 *   - Tree-sitter query API (s-expression patterns) for richer matching
 *   - Per-snapshot parser cache so the same file isn't reparsed
 */

import { readFileSync } from "fs"
import {
  type FunctionCall,
  findEnclosingCall as cFindEnclosingCall,
  findEnclosingConstruct as cFindEnclosingConstruct,
  initParser as cInitParser,
  isParserReady as cIsParserReady,
} from "../../../tools/pattern-detector/c-parser.js"

export type { FunctionCall }

// ---------------------------------------------------------------------------
// Public service interface
// ---------------------------------------------------------------------------

export interface TreeSitterService {
  /** Returns true once the WASM parser has loaded successfully. */
  isReady(): boolean

  /**
   * Ensure the parser is initialized. Idempotent. The service triggers this
   * automatically before any other call, so plugins generally don't need to
   * call it explicitly — but it's exposed for plugins that want to surface
   * an early "parser not available" warning.
   */
  ensureReady(): Promise<void>

  /**
   * Find the innermost call_expression containing a position. Returns null
   * when no call exists at that location, or when the parser is not ready
   * and the character-level fallback also finds nothing.
   */
  findEnclosingCall(
    source: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null>

  /**
   * Like findEnclosingCall but also matches initializer_list constructs
   * (e.g. designated initializers in struct literals where dispatch tables
   * are declared statically).
   */
  findEnclosingConstruct(
    source: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null>

  /**
   * Read a file and find the enclosing call at a position in one shot.
   * Convenience for the common pattern of "I have a (file, line, col) and I
   * want the surrounding call." Returns null if the file is unreadable.
   */
  findEnclosingCallAt(
    filePath: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class TreeSitterServiceImpl implements TreeSitterService {
  private initialized = false
  private initFailed = false
  private initPromise: Promise<void> | null = null

  isReady(): boolean {
    return cIsParserReady()
  }

  async ensureReady(): Promise<void> {
    if (this.initialized || this.initFailed) return
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      try {
        await cInitParser()
        this.initialized = true
      } catch {
        this.initFailed = true
      }
    })()
    return this.initPromise
  }

  async findEnclosingCall(
    source: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null> {
    await this.ensureReady()
    return cFindEnclosingCall(source, line, column)
  }

  async findEnclosingConstruct(
    source: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null> {
    await this.ensureReady()
    return cFindEnclosingConstruct(source, line, column)
  }

  async findEnclosingCallAt(
    filePath: string,
    line: number,
    column: number,
  ): Promise<FunctionCall | null> {
    let source: string
    try {
      source = readFileSync(filePath, "utf8")
    } catch {
      return null
    }
    return this.findEnclosingCall(source, line, column)
  }
}
