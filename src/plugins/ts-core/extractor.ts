/**
 * ts-core/extractor.ts — TypeScript / JavaScript extractor plugin.
 *
 * Walks .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs files in a workspace,
 * parses each one with tree-sitter (typescript or tsx grammar), and
 * yields:
 *
 *   - SymbolFact: one per top-level function, class, interface,
 *     type alias, namespace, plus class methods. Kind reflects the
 *     TS-shaped categories added in contracts/common.ts.
 *   - SymbolFact (kind: 'module'): one per file, canonical_name is
 *     the workspace-relative path. Anchors imports/contains edges.
 *   - EdgeFact (kind: 'contains'): module → declared symbol.
 *   - EdgeFact (kind: 'imports'): module → imported module.
 *     Resolution is path-based (relative + absolute), not LSP-based,
 *     so external npm packages show up as bare module names.
 *   - EdgeFact (kind: 'calls'): caller function → callee identifier.
 *     Resolution is intra-file: we record the syntactic name of the
 *     callee, not its declaration site.
 *   - EdgeFact (kind: 'extends' / 'implements'): class/interface
 *     inheritance edges by name.
 *
 * No LSP server is required. tree-sitter-typescript is the only
 * runtime dependency, and we use ctx.workspace.walkFiles for
 * traversal and ctx.ripgrep for fast filename pre-scans when needed.
 *
 * Capabilities declared: symbols, types, direct-calls.
 *
 * appliesTo: matches workspaces that contain a package.json or
 * tsconfig.json at the root. Plain JS projects without either still
 * work via the explicit `--plugin ts-core` selector.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, dirname, resolve as resolvePath } from "node:path"
import { defineExtractor } from "../../intelligence/extraction/contract.js"
import type {
  Capability,
  WorkspaceProbe,
} from "../../intelligence/extraction/contract.js"
import type { ExtractionContext } from "../../intelligence/extraction/context.js"
import type { Fact } from "../../intelligence/extraction/facts.js"
import type {
  TsNode,
  SupportedLanguage,
} from "../../intelligence/extraction/services/treesitter-service.js"
import type { SymbolRow } from "../../intelligence/contracts/common.js"

const CAPABILITIES: Capability[] = ["symbols", "types", "direct-calls"]

const TS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const

// Skip these directories during file walk — they generate noise and
// blow up the symbol count without adding signal.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".git",
  "coverage",
  ".vitest",
  "tmp",
])

const tsCoreExtractor = defineExtractor({
  metadata: {
    name: "ts-core",
    version: "0.1.0",
    description:
      "TypeScript / JavaScript extractor: modules, symbols, imports, calls, inheritance. Uses tree-sitter, no LSP required.",
    capabilities: CAPABILITIES,
    appliesTo: (probe: WorkspaceProbe) => {
      // Active when the workspace looks like a TS/JS project. The
      // common markers are package.json/tsconfig.json/etc., but we
      // also do a one-level filesystem scan as a fallback for source
      // snapshots that don't ship a manifest (e.g.
      // instructkr-claude-code, which is a security research mirror).
      const root = probe.workspaceRoot
      if (
        existsSync(join(root, "package.json")) ||
        existsSync(join(root, "tsconfig.json")) ||
        existsSync(join(root, "deno.json")) ||
        existsSync(join(root, "bun.lock")) ||
        existsSync(join(root, "bun.lockb"))
      ) {
        return true
      }
      // Fallback: shallow scan of root + ./src for any .ts/.tsx file.
      return hasTsFilesShallow(root) || hasTsFilesShallow(join(root, "src"))
    },
  },

  async *extract(ctx) {
    const workspaceRoot = ctx.workspaceRoot

    const files = await ctx.workspace.walkFiles({
      extensions: TS_EXTENSIONS,
      limit: 5000,
      skipDir: (name) => name.startsWith(".") || SKIP_DIRS.has(name),
    })
    ctx.metrics.count("ts.files-discovered", files.length)
    ctx.log.info("ts-core: discovered files", { count: files.length })

    for (const file of files) {
      if (ctx.signal.aborted) return
      const language: SupportedLanguage =
        ctx.treesitter.inferLanguage(file) === "tsx" ? "tsx" : "typescript"

      const tStart = Date.now()
      const tree = await ctx.treesitter.parseFile(file, language)
      ctx.metrics.timing("ts.parseFile", Date.now() - tStart)
      if (!tree) {
        ctx.metrics.count("ts.parse-failed")
        continue
      }

      const moduleName = workspaceRelativePath(workspaceRoot, file)
      const moduleNodeName = `module:${moduleName}`

      // Always emit a module symbol so imports + contains edges can
      // anchor to it even when no top-level declarations are found.
      // We set name = the full qualified id because the underlying
      // graph-rows.symbolNode() builder uses qualifiedName ?? name as
      // the canonical_name; setting both to the FQ id avoids collisions
      // when two files declare the same local symbol.
      yield ctx.symbol({
        payload: {
          kind: "module",
          name: moduleNodeName,
          qualifiedName: moduleNodeName,
          location: { filePath: file, line: 1, column: 1 },
          metadata: { language, modulePath: moduleName },
        },
      })

      yield* extractFromTree({
        ctx,
        tree,
        file,
        language,
        moduleNodeName,
        workspaceRoot,
      })
    }
  },
})

export default tsCoreExtractor

// ---------------------------------------------------------------------------
// Internal walk helpers
// ---------------------------------------------------------------------------

interface WalkArgs {
  ctx: ExtractionContext
  tree: { rootNode: TsNode }
  file: string
  language: SupportedLanguage
  moduleNodeName: string
  workspaceRoot: string
}

async function* extractFromTree(args: WalkArgs): AsyncGenerator<Fact> {
  const { ctx, tree, file, moduleNodeName, workspaceRoot } = args

  // Track function/method scopes so we can attribute call_expression
  // sites to their enclosing declaration.
  const scopeStack: Array<{ name: string; node: TsNode }> = []
  const seenSymbols = new Set<string>()

  // Walk the tree in document order so we can push/pop scope based on
  // node start/end positions. We use the iterative walkTree generator
  // and a parallel scope stack keyed by endIndex.

  function maybeEnterScope(node: TsNode): { name: string; kind: SymbolRow["kind"] } | null {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const nameNode = node.childForFieldName("name")
        if (nameNode) return { name: nameNode.text, kind: "function" }
        return null
      }
      case "method_definition": {
        const nameNode = node.childForFieldName("name")
        if (nameNode) return { name: nameNode.text, kind: "method" }
        return null
      }
      case "function_expression":
      case "arrow_function": {
        // Anonymous unless assigned to a variable; pick up the name
        // from a parent variable_declarator if present.
        const parent = node.parent
        if (parent && parent.type === "variable_declarator") {
          const id = parent.childForFieldName("name")
          if (id) return { name: id.text, kind: "function" }
        }
        if (parent && parent.type === "pair") {
          const key = parent.childForFieldName("key")
          if (key) return { name: key.text, kind: "function" }
        }
        return null
      }
      default:
        return null
    }
  }

  // ── Single recursive walk ────────────────────────────────────────────────

  async function* visit(node: TsNode): AsyncGenerator<Fact> {
    // Symbol declarations
    const declared = extractDeclaration(node)
    if (declared) {
      const { name, kind } = declared
      const canonicalName = `${moduleNodeName}#${name}`
      if (!seenSymbols.has(canonicalName)) {
        seenSymbols.add(canonicalName)
        yield ctx.symbol({
          payload: {
            kind,
            // graph-rows.symbolNode() uses qualifiedName ?? name as
            // canonical_name. We set BOTH to the FQ id so two files
            // declaring the same local symbol don't collide.
            name: canonicalName,
            qualifiedName: canonicalName,
            location: locationOf(file, node),
            metadata: { localName: name },
          },
        })
        // contains edge: module → symbol
        yield ctx.edge({
          payload: {
            edgeKind: "contains",
            srcSymbolName: moduleNodeName,
            dstSymbolName: canonicalName,
            confidence: 1,
            derivation: "clangd",
            sourceLocation: {
              sourceFilePath: file,
              sourceLineNumber: node.startPosition.row + 1,
            },
          },
        })

        // extends / implements edges
        if (kind === "class" || kind === "interface") {
          for (const inheritEdge of extractInheritanceEdges(
            node,
            canonicalName,
            file,
          )) {
            yield ctx.edge({ payload: inheritEdge })
          }
        }
      }
    }

    // Imports
    if (node.type === "import_statement") {
      const importEdge = extractImportEdge(node, moduleNodeName, file, workspaceRoot)
      if (importEdge) yield ctx.edge({ payload: importEdge })
    }

    // Scope management for call_expression attribution
    const enter = maybeEnterScope(node)
    if (enter) {
      const enclosingName = enter.name
      const fqName = `${moduleNodeName}#${enclosingName}`
      scopeStack.push({ name: fqName, node })
    }

    // Call expressions inside the current scope
    if (node.type === "call_expression") {
      const calleeName = extractCallee(node)
      if (calleeName) {
        const callerName = scopeStack.length
          ? scopeStack[scopeStack.length - 1].name
          : moduleNodeName // top-level call
        yield ctx.edge({
          payload: {
            edgeKind: "calls",
            srcSymbolName: callerName,
            dstSymbolName: calleeName,
            confidence: 0.8,
            derivation: "clangd",
            sourceLocation: {
              sourceFilePath: file,
              sourceLineNumber: node.startPosition.row + 1,
            },
            evidence: {
              sourceKind: "file_line",
              location: locationOf(file, node),
            },
          },
        })
      }
    }

    // Recurse into named children
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child) {
        yield* visit(child)
      }
    }

    if (enter) {
      scopeStack.pop()
    }
  }

  yield* visit(tree.rootNode)
}

// ---------------------------------------------------------------------------
// Per-node extractors
// ---------------------------------------------------------------------------

function extractDeclaration(
  node: TsNode,
): { name: string; kind: SymbolRow["kind"] } | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "function" } : null
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "class" } : null
    }
    case "interface_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "interface" } : null
    }
    case "type_alias_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "typedef" } : null
    }
    case "enum_declaration": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "enum" } : null
    }
    case "internal_module": // namespace X { ... }
    case "module": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "namespace" } : null
    }
    case "method_definition": {
      const name = node.childForFieldName("name")
      return name ? { name: name.text, kind: "method" } : null
    }
    case "lexical_declaration":
    case "variable_declaration": {
      // const foo = () => {} → record as function-typed export when
      // the initializer is an arrow_function or function_expression.
      const declarator = firstNamedChildOfType(node, "variable_declarator")
      if (!declarator) return null
      const nameNode = declarator.childForFieldName("name")
      const value = declarator.childForFieldName("value")
      if (!nameNode) return null
      if (
        value &&
        (value.type === "arrow_function" || value.type === "function_expression")
      ) {
        return { name: nameNode.text, kind: "function" }
      }
      return null
    }
    default:
      return null
  }
}

function extractCallee(callExpr: TsNode): string | null {
  const fn = callExpr.childForFieldName("function")
  if (!fn) return null
  // Identifier — straightforward `foo()`
  if (fn.type === "identifier") return fn.text
  // member_expression — `obj.method()` → `method` (lossy but useful)
  if (fn.type === "member_expression") {
    const property = fn.childForFieldName("property")
    if (property) return property.text
  }
  // Other forms (computed access, generic instantiation): use the
  // raw text up to the first paren.
  const text = fn.text
  if (text && text.length < 200) return text
  return null
}

function extractInheritanceEdges(
  classOrIface: TsNode,
  thisFqName: string,
  file: string,
): Array<{
  edgeKind: "extends" | "implements"
  srcSymbolName: string
  dstSymbolName: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  sourceLocation: { sourceFilePath: string; sourceLineNumber: number }
}> {
  const out: Array<{
    edgeKind: "extends" | "implements"
    srcSymbolName: string
    dstSymbolName: string
    confidence: number
    derivation: "clangd" | "llm" | "runtime" | "hybrid"
    sourceLocation: { sourceFilePath: string; sourceLineNumber: number }
  }> = []
  // class_heritage holds extends_clause and implements_clause children.
  // The TS grammar uses `identifier` (a value reference) for the parent
  // class in extends_clause but `type_identifier` (a type reference) for
  // implements_clause and interface heritage. We accept both.
  const seen = new Set<string>()
  const pushEdge = (
    kind: "extends" | "implements",
    target: string,
  ) => {
    const key = `${kind}:${target}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      edgeKind: kind,
      srcSymbolName: thisFqName,
      dstSymbolName: target,
      confidence: 1,
      derivation: "clangd",
      sourceLocation: {
        sourceFilePath: file,
        sourceLineNumber: classOrIface.startPosition.row + 1,
      },
    })
  }

  const heritage = firstNamedChildOfType(classOrIface, "class_heritage")
  if (heritage) {
    for (let i = 0; i < heritage.namedChildCount; i++) {
      const clause = heritage.namedChild(i)
      if (!clause) continue
      const kind: "extends" | "implements" =
        clause.type === "implements_clause" ? "implements" : "extends"
      for (const target of namedDescendantTexts(clause, "type_identifier")) {
        pushEdge(kind, target)
      }
      for (const target of namedDescendantTexts(clause, "identifier")) {
        pushEdge(kind, target)
      }
    }
  }
  // interface extends X, Y { ... } — extends_type_clause
  const extendsClause = firstNamedChildOfType(classOrIface, "extends_type_clause")
  if (extendsClause) {
    for (const target of namedDescendantTexts(extendsClause, "type_identifier")) {
      pushEdge("extends", target)
    }
    for (const target of namedDescendantTexts(extendsClause, "identifier")) {
      pushEdge("extends", target)
    }
  }
  return out
}

function extractImportEdge(
  importNode: TsNode,
  moduleNodeName: string,
  file: string,
  workspaceRoot: string,
): {
  edgeKind: "imports"
  srcSymbolName: string
  dstSymbolName: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  sourceLocation: { sourceFilePath: string; sourceLineNumber: number }
} | null {
  // import_statement → string (the source)
  let source: string | null = null
  for (let i = 0; i < importNode.namedChildCount; i++) {
    const child = importNode.namedChild(i)
    if (!child) continue
    if (child.type === "string") {
      // strip surrounding quotes
      source = child.text.replace(/^['"]|['"]$/g, "")
      break
    }
  }
  if (!source) return null

  // Resolve relative imports against the file's directory; bare
  // specifiers (npm packages) are kept as-is.
  let target: string
  if (source.startsWith("./") || source.startsWith("../")) {
    const abs = resolveImportPath(resolvePath(dirname(file), source))
    target = `module:${workspaceRelativePath(workspaceRoot, abs)}`
  } else if (source.startsWith("/")) {
    const abs = resolveImportPath(source)
    target = `module:${workspaceRelativePath(workspaceRoot, abs)}`
  } else {
    target = `module:${source}`
  }

  return {
    edgeKind: "imports",
    srcSymbolName: moduleNodeName,
    dstSymbolName: target,
    confidence: 1,
    derivation: "clangd",
    sourceLocation: {
      sourceFilePath: file,
      sourceLineNumber: importNode.startPosition.row + 1,
    },
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Shallow check: does this directory contain any .ts/.tsx/.js/.jsx
 * file at depth 0 or 1? Used by appliesTo() as a fallback for
 * workspaces that don't ship a package.json.
 */
function hasTsFilesShallow(dir: string): boolean {
  if (!existsSync(dir)) return false
  let st
  try {
    st = statSync(dir)
  } catch {
    return false
  }
  if (!st.isDirectory()) return false
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    const name = entry.name
    if (entry.isFile()) {
      if (
        name.endsWith(".ts") ||
        name.endsWith(".tsx") ||
        name.endsWith(".mts") ||
        name.endsWith(".cts") ||
        name.endsWith(".js") ||
        name.endsWith(".jsx") ||
        name.endsWith(".mjs") ||
        name.endsWith(".cjs")
      ) {
        return true
      }
    } else if (entry.isDirectory() && !name.startsWith(".") && !SKIP_DIRS.has(name)) {
      // One level deep — check immediate file children only.
      try {
        const subEntries = readdirSync(join(dir, name), { withFileTypes: true })
        for (const sub of subEntries) {
          if (sub.isFile()) {
            const subName = sub.name
            if (
              subName.endsWith(".ts") ||
              subName.endsWith(".tsx") ||
              subName.endsWith(".mts") ||
              subName.endsWith(".cts") ||
              subName.endsWith(".js") ||
              subName.endsWith(".jsx")
            ) {
              return true
            }
          }
        }
      } catch {
        // unreadable subdir, ignore
      }
    }
  }
  return false
}

function workspaceRelativePath(workspaceRoot: string, file: string): string {
  const rel = relative(workspaceRoot, file)
  // Normalize separators and strip leading "./"
  return rel.replace(/\\/g, "/").replace(/^\.\//, "")
}

/**
 * Probe a relative import path for the actual TS/JS file. Mirrors the
 * tsc/Node module resolver in a small subset:
 *   - exact path with one of [.ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs]
 *   - <path>/index with the same extension list
 * Falls back to the input unchanged if nothing matches (e.g. an
 * unresolved relative import to a missing file).
 */
function resolveImportPath(basePath: string): string {
  const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
  for (const ext of exts) {
    const p = basePath + ext
    if (existsSync(p)) return p
  }
  for (const ext of exts) {
    const p = join(basePath, "index" + ext)
    if (existsSync(p)) return p
  }
  return basePath
}

function locationOf(
  file: string,
  node: TsNode,
): { filePath: string; line: number; column: number } {
  return {
    filePath: file,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  }
}

function firstNamedChildOfType(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child && child.type === type) return child
  }
  return null
}

function namedDescendantTexts(node: TsNode, type: string): string[] {
  const out: string[] = []
  const stack: TsNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i)
      if (!child) continue
      if (child.type === type) {
        out.push(child.text)
      }
      stack.push(child)
    }
  }
  return out
}
