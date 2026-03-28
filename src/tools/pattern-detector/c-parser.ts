/**
 * pattern-detector/c-parser.ts — C AST parser using web-tree-sitter.
 *
 * Uses web-tree-sitter (WASM) as the primary engine for accurate C parsing.
 * Falls back to the character-level recursive descent parser when tree-sitter
 * is not yet initialized or fails.
 *
 * Tree-sitter gives us:
 *   - Exact AST node types (call_expression, assignment_expression, etc.)
 *   - Precise start/end positions for every node
 *   - Correct handling of macros, multi-line calls, nested expressions
 *   - Parameter type information (type_identifier vs primitive_type)
 *   - Field names in struct/array access expressions
 */

import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FunctionCall {
  name: string
  nameLine: number
  nameCol: number
  args: string[]
  /** Absolute character offsets of each arg's first token (for LSP hover). */
  argOffsets?: number[]
  fullText: string
  nodeType: string
  /** Raw tree-sitter node (when available). */
  tsNode?: any
}

// ---------------------------------------------------------------------------
// Tree-sitter state
// ---------------------------------------------------------------------------

let _parser: any = null
let _language: any = null
let _initPromise: Promise<void> | null = null
let _initFailed = false

/**
 * Initialize the tree-sitter parser. Safe to call multiple times.
 * Falls back gracefully if WASM is unavailable.
 */
export async function initParser(): Promise<void> {
  if (_parser) return
  if (_initFailed) return
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    try {
      const { Parser, Language } = await import("web-tree-sitter")

      // Locate WASM files relative to this module
      const moduleDir = path.dirname(fileURLToPath(import.meta.url))
      const projectRoot = path.resolve(moduleDir, "../../..")
      const wasmBinaryPath = path.join(projectRoot, "node_modules/web-tree-sitter/web-tree-sitter.wasm")
      const langWasmPath = path.join(projectRoot, "node_modules/tree-sitter-c/tree-sitter-c.wasm")

      await Parser.init({
        wasmBinary: readFileSync(wasmBinaryPath),
      })

      _language = await Language.load(langWasmPath)
      _parser = new Parser()
      _parser.setLanguage(_language)
    } catch (err) {
      _initFailed = true
      // Tree-sitter unavailable — character-level fallback will be used
    }
  })()

  return _initPromise
}

export function isParserReady(): boolean {
  return _parser !== null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the enclosing function call at a given position in C source text.
 * Uses tree-sitter when available, falls back to character-level parser.
 */
export function findEnclosingCall(
  source: string,
  targetLine: number,
  targetCol: number,
): FunctionCall | null {
  if (_parser) {
    return tsEnclosingCall(source, targetLine, targetCol)
  }
  return charEnclosingCall(source, targetLine, targetCol)
}

/**
 * Find any enclosing construct (call or initializer).
 */
export function findEnclosingConstruct(
  source: string,
  targetLine: number,
  targetCol: number,
): FunctionCall | null {
  if (_parser) {
    return tsEnclosingConstruct(source, targetLine, targetCol)
  }
  return charEnclosingConstruct(source, targetLine, targetCol)
}

// ---------------------------------------------------------------------------
// Tree-sitter implementation
// ---------------------------------------------------------------------------

function tsEnclosingCall(
  source: string,
  targetLine: number,
  targetCol: number,
): FunctionCall | null {
  try {
    const tree = _parser.parse(source)
    const node = findCallAtPosition(tree.rootNode, targetLine, targetCol)
    if (!node) return null
    return tsNodeToFunctionCall(node, source)
  } catch {
    return charEnclosingCall(source, targetLine, targetCol)
  }
}

function tsEnclosingConstruct(
  source: string,
  targetLine: number,
  targetCol: number,
): FunctionCall | null {
  try {
    const tree = _parser.parse(source)

    // Try call_expression first
    const callNode = findCallAtPosition(tree.rootNode, targetLine, targetCol)
    if (callNode) return tsNodeToFunctionCall(callNode, source)

    // Try initializer_list
    const initNode = findInitializerAtPosition(tree.rootNode, targetLine, targetCol)
    if (initNode) return tsInitNodeToFunctionCall(initNode, source)

    return null
  } catch {
    return charEnclosingConstruct(source, targetLine, targetCol)
  }
}

/**
 * Find the innermost call_expression containing the given position.
 */
function findCallAtPosition(node: any, row: number, col: number): any {
  // Check if this node contains the position
  const s = node.startPosition, e = node.endPosition
  const contains = (s.row < row || (s.row === row && s.column <= col)) &&
                   (e.row > row || (e.row === row && e.column >= col))
  if (!contains) return null

  // Depth-first: find the innermost call_expression
  let best: any = null
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    const result = findCallAtPosition(child, row, col)
    if (result) {
      // Prefer the innermost (smallest) call_expression
      if (!best || nodeSize(result) < nodeSize(best)) {
        best = result
      }
    }
  }

  if (best) return best
  if (node.type === "call_expression") return node
  return null
}

/**
 * Find the innermost initializer_list containing the given position.
 */
function findInitializerAtPosition(node: any, row: number, col: number): any {
  const s = node.startPosition, e = node.endPosition
  const contains = (s.row < row || (s.row === row && s.column <= col)) &&
                   (e.row > row || (e.row === row && e.column >= col))
  if (!contains) return null

  for (let i = 0; i < node.childCount; i++) {
    const result = findInitializerAtPosition(node.child(i), row, col)
    if (result) return result
  }

  if (node.type === "initializer_list") return node
  return null
}

function nodeSize(node: any): number {
  const s = node.startPosition, e = node.endPosition
  return (e.row - s.row) * 10000 + (e.column - s.column)
}

/**
 * Convert a tree-sitter call_expression node to FunctionCall.
 */
function tsNodeToFunctionCall(node: any, source: string): FunctionCall | null {
  const fnNode = node.childForFieldName("function")
  if (!fnNode) return null

  const name = fnNode.text
  if (!name || !/^[a-zA-Z_]/.test(name)) return null

  const argListNode = node.childForFieldName("arguments")
  const args: string[] = []
  const argOffsets: number[] = []

  if (argListNode) {
    for (let i = 0; i < argListNode.childCount; i++) {
      const child = argListNode.child(i)
      if (child.type !== "," && child.type !== "(" && child.type !== ")") {
        args.push(child.text.trim())
        // Compute absolute offset for this arg's start position
        const offset = lineColToOffset(source, child.startPosition.row, child.startPosition.column)
        argOffsets.push(offset)
      }
    }
  }

  return {
    name,
    nameLine: fnNode.startPosition.row,
    nameCol: fnNode.startPosition.column,
    args,
    argOffsets,
    fullText: node.text,
    nodeType: "call_expression",
    tsNode: node,
  }
}

/**
 * Convert a tree-sitter initializer_list node to FunctionCall.
 */
function tsInitNodeToFunctionCall(node: any, source: string): FunctionCall | null {
  const args: string[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child.type !== "," && child.type !== "{" && child.type !== "}") {
      args.push(child.text.trim())
    }
  }

  return {
    name: "(initializer)",
    nameLine: node.startPosition.row,
    nameCol: node.startPosition.column,
    args,
    fullText: node.text,
    nodeType: "initializer_list",
    tsNode: node,
  }
}

// ---------------------------------------------------------------------------
// Tree-sitter AST analysis utilities (exported for auto-classifier)
// ---------------------------------------------------------------------------

/**
 * Parse C source and return the tree-sitter root node.
 * Returns null if tree-sitter is not initialized.
 */
export function parseSource(source: string): any | null {
  if (!_parser) return null
  try {
    return _parser.parse(source).rootNode
  } catch {
    return null
  }
}

/**
 * Find all nodes of a given type in the AST.
 */
export function findAllNodes(root: any, type: string): any[] {
  const results: any[] = []
  walkAst(root, (node) => {
    if (node.type === type) results.push(node)
  })
  return results
}

/**
 * Walk the AST depth-first, calling visitor on each node.
 */
export function walkAst(node: any, visitor: (n: any) => void): void {
  visitor(node)
  for (let i = 0; i < node.childCount; i++) {
    walkAst(node.child(i), visitor)
  }
}

/**
 * Find all assignment_expression nodes where the RHS matches a given identifier.
 * Returns { fieldName, containerExpr, line, isStailq } for each match.
 */
export function findStoreAssignments(
  root: any,
  source: string,
  rhsName: string | null,
): Array<{
  fieldName: string
  containerExpr: string
  line: number
  isStailq: boolean
  evidence: string
}> {
  const results: any[] = []
  const lines = source.split(/\r?\n/)

  const assignments = findAllNodes(root, "assignment_expression")
  for (const assign of assignments) {
    const left = assign.childForFieldName("left")
    const right = assign.childForFieldName("right")
    if (!left || !right) continue

    // Filter by RHS if callbackParamName is provided
    if (rhsName && right.text.trim() !== rhsName) continue

    let fieldName: string | null = null
    let containerExpr: string = left.text

    // field_expression: entry->field or entry.field
    if (left.type === "field_expression") {
      fieldName = left.childForFieldName("field")?.text ?? null
    }
    // subscript_expression with field: table[key].field — the left is field_expression
    // already handled above since field_expression wraps subscript_expression

    if (!fieldName) continue

    // Check if a STAILQ_INSERT follows within the next 10 lines
    const assignLine = assign.startPosition.row
    const isStailq = lines
      .slice(assignLine + 1, Math.min(assignLine + 10, lines.length))
      .some((l) => /STAILQ_INSERT|TAILQ_INSERT|LIST_INSERT|SLIST_INSERT/i.test(l))

    results.push({
      fieldName,
      containerExpr,
      line: assignLine,
      isStailq,
      evidence: assign.text.trim().slice(0, 200),
    })
  }

  return results
}

/**
 * Extract parameter names from a function definition at the given line.
 * Returns array of { name, typeText, isFnPtrTypedef } for each parameter.
 *
 * A fn-ptr typedef parameter has typeNodeType === "type_identifier" and
 * declNodeType === "identifier" — this is the key discriminator in WLAN C code.
 */
export function extractFunctionParams(
  root: any,
  defLine: number,
): Array<{ name: string; typeText: string; isFnPtrTypedef: boolean }> {
  const results: any[] = []

  const funcDefs = findAllNodes(root, "function_definition")
  for (const fn of funcDefs) {
    // Find the function definition closest to defLine
    if (Math.abs(fn.startPosition.row - defLine) > 5) continue

    const decl = fn.childForFieldName("declarator")
    if (!decl) continue

    const paramDecls = findAllNodes(decl, "parameter_declaration")
    for (const param of paramDecls) {
      const typeNode = param.childForFieldName("type")
      const declNode = param.childForFieldName("declarator")

      const typeText = typeNode?.text ?? ""
      const name = declNode?.text ?? ""

      // fn-ptr typedef: type is type_identifier (e.g. data_fn_t, handler_fn_t)
      // and declarator is a plain identifier (not pointer_declarator)
      const isFnPtrTypedef = typeNode?.type === "type_identifier" &&
                              declNode?.type === "identifier" &&
                              !["void", "int", "char", "unsigned", "signed", "long", "short", "float", "double"].includes(typeText)

      results.push({ name, typeText, isFnPtrTypedef })
    }
    break // use first matching function definition
  }

  return results
}

/**
 * Find all call_expression nodes in the AST that match a given function name.
 */
export function findCallsByName(root: any, fnName: string): any[] {
  const results: any[] = []
  const calls = findAllNodes(root, "call_expression")
  for (const call of calls) {
    const fn = call.childForFieldName("function")
    if (fn?.text === fnName) results.push(call)
  }
  return results
}

/**
 * Check if a source line contains a fn-ptr call for a given field name.
 * Patterns: "->fieldName(", ".fieldName(", "fieldName("
 */
export function isCallSiteForField(lineText: string, fieldName: string): boolean {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:->|\\.)${escaped}\\s*\\(|\\b${escaped}\\s*\\(`).test(lineText)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineColToOffset(source: string, line: number, col: number): number {
  const lines = source.split(/\r?\n/)
  let pos = 0
  for (let i = 0; i < line && i < lines.length; i++) {
    pos += lines[i].length + 1
  }
  return pos + col
}

// ---------------------------------------------------------------------------
// Character-level fallback parser (original implementation)
// ---------------------------------------------------------------------------

export function splitArguments(text: string): string[] {
  const args: string[] = []
  let depth = 0
  let start = 0
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipStringForward(text, i); continue }
    if (ch === '/' && text[i + 1] === '/') { i = skipLineCommentForward(text, i); continue }
    if (ch === '/' && text[i + 1] === '*') { i = skipBlockCommentForward(text, i); continue }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      const arg = text.slice(start, i)
      if (arg.trim().length > 0 || args.length > 0) args.push(arg)
      start = i + 1
    }
    i++
  }
  const last = text.slice(start)
  if (last.trim().length > 0 || args.length > 0) args.push(last)
  return args
}

function charEnclosingCall(source: string, targetLine: number, targetCol: number): FunctionCall | null {
  const lines = source.split(/\r?\n/)
  const absPos = charLineColToOffset(lines, targetLine, targetCol)
  if (absPos < 0) return null
  const parenPos = findEnclosingOpenParen(source, absPos)
  if (parenPos < 0) return null
  const nameEnd = skipWhitespaceBackward(source, parenPos)
  if (nameEnd < 0) return null
  const nameStart = scanIdentifierBackward(source, nameEnd)
  if (nameStart < 0) return null
  const name = source.slice(nameStart, nameEnd + 1)
  if (!/^[a-zA-Z_]/.test(name)) return null
  const closePos = findMatchingCloseParen(source, parenPos)
  if (closePos < 0) return null
  const argsText = source.slice(parenPos + 1, closePos)
  const args = splitArguments(argsText)
  const [nameLine, nameCol] = charOffsetToLineCol(lines, nameStart)
  return { name, nameLine, nameCol, args, fullText: source.slice(nameStart, closePos + 1), nodeType: "call_expression" }
}

function charEnclosingConstruct(source: string, targetLine: number, targetCol: number): FunctionCall | null {
  const call = charEnclosingCall(source, targetLine, targetCol)
  if (call) return call
  const lines = source.split(/\r?\n/)
  const absPos = charLineColToOffset(lines, targetLine, targetCol)
  if (absPos < 0) return null
  const bracePos = findEnclosingOpenBrace(source, absPos)
  if (bracePos < 0) return null
  const closeBrace = findMatchingCloseBrace(source, bracePos)
  if (closeBrace < 0) return null
  const initText = source.slice(bracePos + 1, closeBrace)
  const args = splitArguments(initText)
  const [line, col] = charOffsetToLineCol(lines, bracePos)
  return { name: "(initializer)", nameLine: line, nameCol: col, args: args.map((a) => a.trim()), fullText: source.slice(bracePos, closeBrace + 1), nodeType: "initializer_list" }
}

function charLineColToOffset(lines: string[], line: number, col: number): number {
  if (line < 0 || line >= lines.length) return -1
  let pos = 0
  for (let i = 0; i < line; i++) pos += lines[i].length + 1
  return pos + col
}

function charOffsetToLineCol(lines: string[], offset: number): [number, number] {
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    if (pos + lines[i].length >= offset) return [i, offset - pos]
    pos += lines[i].length + 1
  }
  return [lines.length - 1, 0]
}

export function findEnclosingOpenParen(source: string, from: number): number {
  let depth = 0
  let i = from - 1
  while (i >= 0) {
    const ch = source[i]
    if (ch === '/' && source[i - 1] === '/') { while (i >= 0 && source[i] !== '\n') i--; continue }
    if (ch === '*' && i > 0 && source[i - 1] === '/') { i -= 2; while (i >= 1) { if (source[i - 1] === '/' && source[i] === '*') { i -= 2; break } i-- } continue }
    if (ch === '"' || ch === "'") { const q = ch; i--; while (i >= 0) { if (source[i] === '\\') { i -= 2; continue } if (source[i] === q) { i--; break } i-- } continue }
    if (ch === ')' || ch === ']') depth++
    else if (ch === '(' || ch === '[') {
      if (depth === 0) {
        let nameEnd = i - 1
        while (nameEnd >= 0 && /\s/.test(source[nameEnd])) nameEnd--
        if (nameEnd >= 0 && /[a-zA-Z0-9_.:]/.test(source[nameEnd])) return i
      } else depth--
    }
    i--
  }
  return -1
}

function findEnclosingOpenBrace(source: string, from: number): number {
  let depth = 0, i = from - 1
  while (i >= 0) {
    const ch = source[i]
    if (ch === '"' || ch === "'") { i = skipStringBackward(source, i); continue }
    if (ch === '}' || ch === ')') depth++
    else if (ch === '{' || ch === '(') { if (depth === 0) return i; depth-- }
    i--
  }
  return -1
}

function findMatchingCloseParen(source: string, from: number): number {
  let depth = 0
  for (let i = from + 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'") { i = skipStringForward(source, i); continue }
    if (ch === '/' && source[i + 1] === '/') { i = skipLineCommentForward(source, i); continue }
    if (ch === '/' && source[i + 1] === '*') { i = skipBlockCommentForward(source, i); continue }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') { if (depth === 0) return i; depth-- }
  }
  return -1
}

function findMatchingCloseBrace(source: string, from: number): number {
  let depth = 0
  for (let i = from + 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'") { i = skipStringForward(source, i); continue }
    if (ch === '{') depth++
    else if (ch === '}') { if (depth === 0) return i; depth-- }
  }
  return -1
}

function skipWhitespaceBackward(source: string, from: number): number {
  let i = from - 1
  while (i >= 0 && /\s/.test(source[i])) i--
  return i
}

function scanIdentifierBackward(source: string, from: number): number {
  let i = from
  while (i >= 0 && /[a-zA-Z0-9_.:]/.test(source[i])) i--
  return i + 1
}

function skipStringForward(source: string, from: number): number {
  const quote = source[from]; let i = from + 1
  while (i < source.length) { if (source[i] === '\\') { i += 2; continue } if (source[i] === quote) return i + 1; i++ }
  return source.length
}

function skipStringBackward(source: string, from: number): number {
  const quote = source[from]; let i = from - 1
  while (i >= 0) { if (source[i] === quote) { let b = 0, j = i - 1; while (j >= 0 && source[j] === '\\') { b++; j-- } if (b % 2 === 0) return i } i-- }
  return 0
}

function skipLineCommentForward(source: string, from: number): number {
  let i = from; while (i < source.length && source[i] !== '\n') i++; return i
}

function skipBlockCommentForward(source: string, from: number): number {
  let i = from + 2; while (i < source.length - 1) { if (source[i] === '*' && source[i + 1] === '/') return i + 1; i++ } return source.length - 1
}
