/**
 * rust-core/extractor.ts — Rust extractor plugin.
 *
 * Walks .rs files in a workspace, parses each one with tree-sitter
 * (rust grammar), and yields structural facts:
 *
 *   - SymbolFact (kind: 'module'): one per .rs file
 *   - SymbolFact: top-level functions, structs, enums, traits, type
 *     aliases, const/static, plus methods inside impl blocks
 *   - EdgeFact (kind: 'contains'): module → declared symbol, plus
 *     impl-type → method (after qualifying methods as `Type.method`)
 *   - EdgeFact (kind: 'imports'): from `use` declarations. Resolves
 *     `use crate::foo::Bar` → module:src/foo.rs#Bar when possible.
 *   - EdgeFact (kind: 'implements'): impl `Trait for Type` → emits
 *     an edge from Type to Trait
 *   - EdgeFact (kind: 'references_type'): function signature
 *     parameter and return types
 *   - EdgeFact (kind: 'calls'): call_expression sites attributed to
 *     the enclosing function/method via a scope stack
 *
 * No LSP server is required — tree-sitter-rust is the only runtime
 * dependency. The extractor uses ctx.workspace.walkFiles() and
 * ctx.treesitter.parseFile().
 *
 * Capabilities declared: symbols, types, direct-calls.
 *
 * appliesTo: matches workspaces that contain a Cargo.toml at the
 * root. Falls back to a shallow scan for any .rs file at depth 0 or
 * 1 so workspaces without a manifest still work.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, dirname } from "node:path"
import { defineExtractor } from "../../intelligence/extraction/contract.js"
import type {
  Capability,
  WorkspaceProbe,
} from "../../intelligence/extraction/contract.js"
import type { ExtractionContext } from "../../intelligence/extraction/context.js"
import type { Fact } from "../../intelligence/extraction/facts.js"
import type {
  TsNode,
} from "../../intelligence/extraction/services/treesitter-service.js"
import type { SymbolRow } from "../../intelligence/contracts/common.js"

const CAPABILITIES: Capability[] = ["symbols", "types", "direct-calls"]

const RUST_EXTENSIONS = [".rs"] as const

// Skip these directories during file walk
const SKIP_DIRS = new Set([
  "target",
  ".git",
  "node_modules",
  "vendor",
  ".cargo",
  ".cache",
  "tmp",
])

const rustCoreExtractor = defineExtractor({
  metadata: {
    name: "rust-core",
    version: "0.1.0",
    description:
      "Rust extractor: modules, structs, enums, traits, fns, methods, use imports, calls, type references. Uses tree-sitter, no LSP required.",
    capabilities: CAPABILITIES,
    appliesTo: (probe: WorkspaceProbe) => {
      const root = probe.workspaceRoot
      if (
        existsSync(join(root, "Cargo.toml")) ||
        existsSync(join(root, "Cargo.lock"))
      ) {
        return true
      }
      // Fallback: shallow scan
      return hasRustFilesShallow(root) || hasRustFilesShallow(join(root, "src"))
    },
  },

  async *extract(ctx) {
    const workspaceRoot = ctx.workspaceRoot

    const files = await ctx.workspace.walkFiles({
      extensions: RUST_EXTENSIONS,
      limit: 5000,
      skipDir: (name) => name.startsWith(".") || SKIP_DIRS.has(name),
    })
    ctx.metrics.count("rust.files-discovered", files.length)
    ctx.log.info("rust-core: discovered files", { count: files.length })

    for (const file of files) {
      if (ctx.signal.aborted) return

      const tStart = Date.now()
      const tree = await ctx.treesitter.parseFile(file, "rust")
      ctx.metrics.timing("rust.parseFile", Date.now() - tStart)
      if (!tree) {
        ctx.metrics.count("rust.parse-failed")
        continue
      }

      const moduleName = workspaceRelativePath(workspaceRoot, file)
      const moduleNodeName = `module:${moduleName}`

      // Module symbol — one per file. The endLine is the file's
      // total line count for size-based queries.
      const moduleEndLine = tree.rootNode.endPosition.row + 1
      yield ctx.symbol({
        payload: {
          kind: "module",
          name: moduleNodeName,
          qualifiedName: moduleNodeName,
          location: { filePath: file, line: 1, column: 1 },
          metadata: {
            language: "rust",
            modulePath: moduleName,
            endLine: moduleEndLine,
            lineCount: moduleEndLine,
          },
        },
      })

      yield* extractFromTree({
        ctx,
        tree,
        file,
        moduleNodeName,
        workspaceRoot,
      })
    }
  },
})

export default rustCoreExtractor

// ---------------------------------------------------------------------------
// Per-file walk
// ---------------------------------------------------------------------------

interface WalkArgs {
  ctx: ExtractionContext
  tree: { rootNode: TsNode }
  file: string
  moduleNodeName: string
  workspaceRoot: string
}

/**
 * Per-file resolver state. Built incrementally as the AST walk visits
 * use_declarations and top-level decls. Used to resolve call sites
 * and type references from a bare local name to a fully-qualified
 * module symbol.
 */
interface FileResolver {
  /** `use foo::Bar` → Bar → module:foo#Bar (or module:foo.rs#Bar) */
  namedImports: Map<string, string>
  /** Locally declared top-level symbols, populated as the walk progresses. */
  localSymbols: Set<string>
}

async function* extractFromTree(args: WalkArgs): AsyncGenerator<Fact> {
  const { ctx, tree, file, moduleNodeName, workspaceRoot } = args

  // Track function/method scopes for call attribution
  const scopeStack: Array<{ name: string; node: TsNode }> = []
  // Track enclosing impl block (struct/enum/trait name) so methods
  // can be qualified as `Type.method`
  const implStack: string[] = []
  const seenSymbols = new Set<string>()

  const resolver: FileResolver = {
    namedImports: new Map(),
    localSymbols: new Set(),
  }

  // Pre-pass: collect every top-level declaration name into the
  // resolver's localSymbols set BEFORE the recursive walk begins.
  // Mirrors the hoisting pre-pass in ts-core.
  prepopulateLocalSymbols(tree.rootNode, resolver)

  function maybeEnterScope(node: TsNode): { name: string; kind: SymbolRow["kind"] } | null {
    switch (node.type) {
      case "function_item":
      case "function_signature_item": {
        const id = node.childForFieldName("name")
          ?? firstNamedChildOfType(node, "identifier")
        if (id) {
          // Decide if this function lives inside an impl block (→ method)
          const parentKind = implStack.length > 0 ? "method" : "function"
          return { name: id.text, kind: parentKind }
        }
        return null
      }
      default:
        return null
    }
  }

  async function* visit(node: TsNode): AsyncGenerator<Fact> {
    // Use declarations → imports edges + populate the resolver
    if (node.type === "use_declaration") {
      for (const importEdge of extractUseImports(
        node,
        moduleNodeName,
        file,
        workspaceRoot,
      )) {
        yield ctx.edge({ payload: importEdge })
        // Populate the resolver from each named import
        populateResolverFromUse(node, resolver, file, workspaceRoot)
      }
    }

    // Symbol declarations — map AST kind to SymbolRow.kind
    const declared = extractDeclaration(node)
    if (declared) {
      const enclosingType = implStack.length > 0
        ? implStack[implStack.length - 1]
        : null
      // extractDeclaration returns "function" for function_item; the
      // visit() function upgrades to "method" when we're inside an
      // impl block. This matches ts-core's class-method qualification.
      const isMember =
        declared.kind === "function" && enclosingType !== null
      const kind: SymbolRow["kind"] = isMember ? "method" : declared.kind
      const name = declared.name
      const localName = isMember ? `${enclosingType}.${name}` : name
      const canonicalName = `${moduleNodeName}#${localName}`
      const containsSrc = isMember
        ? `${moduleNodeName}#${enclosingType}`
        : moduleNodeName

      if (!isMember) {
        resolver.localSymbols.add(name)
      }

      if (!seenSymbols.has(canonicalName)) {
        seenSymbols.add(canonicalName)

        const endLine = node.endPosition.row + 1
        const startLine = node.startPosition.row + 1
        const lineCount = endLine - startLine + 1
        const exported = !isMember && hasVisibilityModifier(node)
        const baseMeta: Record<string, unknown> = isMember
          ? { localName: name, owningType: enclosingType }
          : { localName: name }
        if (exported) baseMeta.exported = true

        yield ctx.symbol({
          payload: {
            kind,
            name: canonicalName,
            qualifiedName: canonicalName,
            location: locationOf(file, node),
            metadata: {
              ...baseMeta,
              endLine,
              lineCount,
            },
          },
        })

        // contains edge: module → symbol, OR type → method
        yield ctx.edge({
          payload: {
            edgeKind: "contains",
            srcSymbolName: containsSrc,
            dstSymbolName: canonicalName,
            confidence: 1,
            derivation: "clangd",
            sourceLocation: {
              sourceFilePath: file,
              sourceLineNumber: startLine,
            },
          },
        })

        // function/method type references on signature
        if (kind === "function" || kind === "method") {
          for (const ref of extractFunctionTypeReferences(
            node,
            canonicalName,
            resolver,
            moduleNodeName,
            file,
          )) {
            yield ctx.edge({ payload: ref })
          }
        }

        // struct/enum/trait field type references (existing
        // class-level rollup, kept for back-compat).
        if (kind === "struct" || kind === "enum" || kind === "interface") {
          for (const ref of extractFieldTypeReferences(
            node,
            canonicalName,
            resolver,
            moduleNodeName,
            file,
          )) {
            yield ctx.edge({ payload: ref })
          }
        }

        // Phase 3c: emit explicit field nodes + per-field
        // field_of_type edges + class-level aggregates rollup
        // for structs and traits. Enums are handled as variants
        // (phase 3d) in a separate block below.
        if (kind === "struct") {
          const aggregatedTargets = new Set<string>()
          for (const fieldDecl of extractRustFieldDeclarations(
            node,
            name,
            moduleNodeName,
          )) {
            if (seenSymbols.has(fieldDecl.canonicalName)) continue
            seenSymbols.add(fieldDecl.canonicalName)
            yield ctx.symbol({
              payload: {
                kind: "field",
                name: fieldDecl.canonicalName,
                qualifiedName: fieldDecl.canonicalName,
                location: { filePath: file, line: fieldDecl.line },
                metadata: {
                  localName: fieldDecl.localName,
                  owningClass: name,
                  declaredOn: "struct",
                  ...(fieldDecl.tupleIndex !== undefined
                    ? { tupleIndex: fieldDecl.tupleIndex }
                    : {}),
                },
              },
            })
            yield ctx.edge({
              payload: {
                edgeKind: "contains",
                srcSymbolName: canonicalName,
                dstSymbolName: fieldDecl.canonicalName,
                confidence: 1,
                derivation: "clangd",
                sourceLocation: {
                  sourceFilePath: file,
                  sourceLineNumber: fieldDecl.line,
                },
              },
            })
            for (const typeEdge of extractRustFieldTypeEdges(
              fieldDecl.typeNode,
              fieldDecl.canonicalName,
              fieldDecl.line,
              resolver,
              moduleNodeName,
              file,
            )) {
              yield ctx.edge({ payload: typeEdge })
              aggregatedTargets.add(typeEdge.dstSymbolName)
            }
          }
          // Phase 3b rollup: one aggregates edge per distinct target
          const declLine = node.startPosition.row + 1
          for (const target of aggregatedTargets) {
            yield ctx.edge({
              payload: {
                edgeKind: "aggregates",
                srcSymbolName: canonicalName,
                dstSymbolName: target,
                confidence: 0.95,
                derivation: "clangd",
                sourceLocation: {
                  sourceFilePath: file,
                  sourceLineNumber: declLine,
                },
                metadata: { resolved: true, rolledUpFrom: "field_of_type" },
              },
            })
          }
        }
      }
    }

    // impl block: handles two cases — `impl Type { ... }` (inherent
    // methods) and `impl Trait for Type { ... }` (trait
    // implementation). Push the implementing type onto implStack so
    // child function_items get qualified correctly.
    let implPushed = false
    let implementsEdge: TsNode | null = null
    let implTraitName: string | null = null
    let implTypeName: string | null = null
    if (node.type === "impl_item") {
      const info = parseImplHeader(node)
      if (info) {
        implTypeName = info.typeName
        implTraitName = info.traitName
        implStack.push(info.typeName)
        implPushed = true
        implementsEdge = node
      }
    }

    // Emit implements edge if this is a `impl Trait for Type` block
    if (implementsEdge && implTraitName && implTypeName) {
      const traitFq =
        resolveTypeName(implTraitName, resolver, moduleNodeName)?.name ??
        implTraitName
      yield ctx.edge({
        payload: {
          edgeKind: "implements",
          srcSymbolName: `${moduleNodeName}#${implTypeName}`,
          dstSymbolName: traitFq,
          confidence: 1,
          derivation: "clangd",
          sourceLocation: {
            sourceFilePath: file,
            sourceLineNumber: implementsEdge.startPosition.row + 1,
          },
          metadata: {
            resolved:
              resolveTypeName(implTraitName, resolver, moduleNodeName) !==
              null,
            targetName: implTraitName,
          },
        },
      })
    }

    // Function-scope tracking for call attribution
    const enter = maybeEnterScope(node)
    if (enter) {
      const enclosingType =
        enter.kind === "method" && implStack.length > 0
          ? implStack[implStack.length - 1]
          : null
      const localName = enclosingType
        ? `${enclosingType}.${enter.name}`
        : enter.name
      const fqName = `${moduleNodeName}#${localName}`
      scopeStack.push({ name: fqName, node })
    }

    // Call expressions inside the current scope
    if (node.type === "call_expression") {
      const callee = extractCallee(node, resolver, moduleNodeName)
      if (callee) {
        const callerName = scopeStack.length
          ? scopeStack[scopeStack.length - 1].name
          : moduleNodeName
        yield ctx.edge({
          payload: {
            edgeKind: "calls",
            srcSymbolName: callerName,
            dstSymbolName: callee.name,
            confidence: callee.resolved ? 0.95 : 0.7,
            derivation: "clangd",
            sourceLocation: {
              sourceFilePath: file,
              sourceLineNumber: node.startPosition.row + 1,
            },
            metadata: {
              resolved: callee.resolved,
              resolutionKind: callee.kind,
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
    if (implPushed) {
      implStack.pop()
    }
  }

  yield* visit(tree.rootNode)
}

// ---------------------------------------------------------------------------
// Per-node extractors
// ---------------------------------------------------------------------------

/**
 * Map a Rust AST node to a SymbolRow declaration if applicable.
 * Methods (function_items inside impl blocks) are reported as kind
 * 'method' here; the visit() function decides whether to qualify with
 * the enclosing type via the implStack.
 */
function extractDeclaration(
  node: TsNode,
): { name: string; kind: SymbolRow["kind"] } | null {
  switch (node.type) {
    case "function_item":
    case "function_signature_item": {
      const id =
        node.childForFieldName("name") ??
        firstNamedChildOfType(node, "identifier")
      if (!id) return null
      // The visit() function decides function vs method based on
      // implStack — we just return "function" here and the caller
      // upgrades to "method" when needed.
      return { name: id.text, kind: "function" }
    }
    case "struct_item": {
      const id = node.childForFieldName("name") ??
        firstNamedChildOfType(node, "type_identifier")
      return id ? { name: id.text, kind: "struct" } : null
    }
    case "enum_item": {
      const id = node.childForFieldName("name") ??
        firstNamedChildOfType(node, "type_identifier")
      return id ? { name: id.text, kind: "enum" } : null
    }
    case "trait_item": {
      const id = node.childForFieldName("name") ??
        firstNamedChildOfType(node, "type_identifier")
      // Rust traits map to "interface" in our schema
      return id ? { name: id.text, kind: "interface" } : null
    }
    case "type_item": {
      const id = node.childForFieldName("name") ??
        firstNamedChildOfType(node, "type_identifier")
      return id ? { name: id.text, kind: "typedef" } : null
    }
    case "mod_item": {
      const id = node.childForFieldName("name") ??
        firstNamedChildOfType(node, "identifier")
      return id ? { name: id.text, kind: "namespace" } : null
    }
    case "const_item":
    case "static_item": {
      const id = node.childForFieldName("name") ??
        firstNamedChildOfType(node, "identifier")
      return id ? { name: id.text, kind: "global_var" } : null
    }
    default:
      return null
  }
}

interface ImportEdgePayload {
  edgeKind: "imports"
  srcSymbolName: string
  dstSymbolName: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  sourceLocation: { sourceFilePath: string; sourceLineNumber: number }
  metadata?: Record<string, unknown>
}

/**
 * Walk a `use_declaration` and emit one or more imports edges. The
 * edges are emitted at the module-name level (Rust uses are
 * statement-scoped, not file-scoped, but for graph purposes they're
 * file-scoped dependencies just like TS imports).
 *
 * Path resolution:
 *   - `use crate::foo::Bar`        → module:crate::foo
 *   - `use std::collections::Map`  → module:std::collections (external)
 *   - `use super::Bar`             → resolved against the file's parent
 *
 * For now we keep paths in their textual form (with `::` separators)
 * rather than resolving to absolute file paths — Rust module
 * resolution is non-trivial (mod.rs vs <name>.rs vs lib.rs) and the
 * `::` form is what users actually search for.
 */
function* extractUseImports(
  useNode: TsNode,
  moduleNodeName: string,
  file: string,
  _workspaceRoot: string,
): Generator<ImportEdgePayload> {
  const path = useNode.text.replace(/^use\s+/, "").replace(/;\s*$/, "")
  // Strip any `as` aliases
  const cleanPath = path.split(" as ")[0].trim()

  // For `crate::foo::{A, B}`, emit one edge per item
  // For simple `crate::foo::Bar`, just one edge
  const items = expandUsePath(cleanPath)
  for (const item of items) {
    yield {
      edgeKind: "imports",
      srcSymbolName: moduleNodeName,
      dstSymbolName: `module:${item.modulePath}${item.name ? `#${item.name}` : ""}`,
      confidence: 1,
      derivation: "clangd",
      sourceLocation: {
        sourceFilePath: file,
        sourceLineNumber: useNode.startPosition.row + 1,
      },
      metadata: {
        importKind: "use",
        rawPath: item.raw,
      },
    }
  }
}

/**
 * Expand a `use` path into one or more (module, item) pairs.
 *
 *   "std::collections::HashMap"   → [{modulePath: "std::collections", name: "HashMap"}]
 *   "crate::foo::{Bar, Baz}"      → [{module: "crate::foo", name: "Bar"},
 *                                    {module: "crate::foo", name: "Baz"}]
 *   "self::*"                     → [{modulePath: "self", name: null}]
 *   "crate::foo"                  → [{modulePath: "crate", name: "foo"}]
 */
function expandUsePath(path: string): Array<{
  modulePath: string
  name: string | null
  raw: string
}> {
  // Handle the brace expansion: `crate::foo::{a, b}`
  const braceMatch = path.match(/^(.+)::\{([^}]*)\}$/)
  if (braceMatch) {
    const base = braceMatch[1]
    const items = braceMatch[2]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    return items.map((item) => {
      const cleanItem = item.split(" as ")[0].trim()
      return {
        modulePath: base,
        name: cleanItem === "self" ? null : cleanItem,
        raw: `${base}::${cleanItem}`,
      }
    })
  }
  // Handle the wildcard: `crate::foo::*`
  if (path.endsWith("::*")) {
    const base = path.slice(0, -3)
    return [{ modulePath: base, name: null, raw: path }]
  }
  // Simple `crate::foo::Bar` → split off the last segment as the name
  const lastSep = path.lastIndexOf("::")
  if (lastSep > 0) {
    return [
      {
        modulePath: path.slice(0, lastSep),
        name: path.slice(lastSep + 2),
        raw: path,
      },
    ]
  }
  // No separator at all — just `use foo;`. Treat the whole thing as
  // a bare module reference.
  return [{ modulePath: path, name: null, raw: path }]
}

/**
 * Populate the FileResolver's namedImports from a use_declaration so
 * subsequent call sites can resolve bare identifiers to FQ names.
 */
function populateResolverFromUse(
  useNode: TsNode,
  resolver: FileResolver,
  _file: string,
  _workspaceRoot: string,
): void {
  const path = useNode.text.replace(/^use\s+/, "").replace(/;\s*$/, "")
  const cleanPath = path.split(" as ")[0].trim()
  const items = expandUsePath(cleanPath)
  for (const item of items) {
    if (!item.name) continue
    // The local binding is the item name (or its alias)
    // We don't currently parse aliases — `use foo as Bar` would
    // bind both 'foo' and 'Bar' but we just take the source name.
    const dst = `module:${item.modulePath}#${item.name}`
    resolver.namedImports.set(item.name, dst)
  }
}

interface TypeRefEdgePayload {
  // Phase 3c widened edgeKind to include field_of_type so the same
  // payload shape covers both the class-level references_type rollup
  // (existing) and the per-field field_of_type emission (new).
  edgeKind: "references_type" | "field_of_type"
  srcSymbolName: string
  dstSymbolName: string
  confidence: number
  derivation: "clangd" | "llm" | "runtime" | "hybrid"
  sourceLocation: { sourceFilePath: string; sourceLineNumber: number }
  metadata: Record<string, unknown>
}

/**
 * Walk a struct's field_declaration_list and return one descriptor
 * per declared field. Handles both named-field structs
 * (`struct Foo { a: u32, b: String }`) and tuple structs
 * (`struct Foo(u32, String)`). For tuple structs, the field's local
 * name is the positional index (`Foo.0`, `Foo.1`).
 */
function extractRustFieldDeclarations(
  structItemNode: TsNode,
  structName: string,
  moduleNodeName: string,
): Array<{
  localName: string
  canonicalName: string
  line: number
  typeNode: TsNode
  tupleIndex?: number
}> {
  const out: Array<{
    localName: string
    canonicalName: string
    line: number
    typeNode: TsNode
    tupleIndex?: number
  }> = []

  // Named-field struct: field_declaration_list with field_declaration children
  const fieldList = firstNamedChildOfType(structItemNode, "field_declaration_list")
  if (fieldList) {
    for (let i = 0; i < fieldList.namedChildCount; i++) {
      const member = fieldList.namedChild(i)
      if (!member || member.type !== "field_declaration") continue
      const nameNode = member.childForFieldName("name")
      const typeNode = member.childForFieldName("type")
      if (!nameNode || !typeNode) continue
      const localName = `${structName}.${nameNode.text}`
      out.push({
        localName,
        canonicalName: `${moduleNodeName}#${localName}`,
        line: member.startPosition.row + 1,
        typeNode,
      })
    }
    return out
  }

  // Tuple struct: ordered_field_declaration_list with positional fields
  const tupleList = firstNamedChildOfType(
    structItemNode,
    "ordered_field_declaration_list",
  )
  if (tupleList) {
    let idx = 0
    for (let i = 0; i < tupleList.namedChildCount; i++) {
      const member = tupleList.namedChild(i)
      if (!member) continue
      // Each tuple field is an unnamed type expression. The first
      // type-bearing child IS the type. We support both the
      // direct-type form and the wrapped form.
      const typeNode =
        member.childForFieldName("type") ??
        (member.type !== "visibility_modifier" ? member : null)
      if (!typeNode) continue
      // The tupleList may include visibility_modifier nodes; skip them.
      if (typeNode.type === "visibility_modifier") continue
      const localName = `${structName}.${idx}`
      out.push({
        localName,
        canonicalName: `${moduleNodeName}#${localName}`,
        line: member.startPosition.row + 1,
        typeNode,
        tupleIndex: idx,
      })
      idx++
    }
  }
  return out
}

/**
 * Per-field type extraction with Rust-specific containment metadata.
 * Mirrors ts-core's extractFieldTypeEdges but with the wrapper
 * vocabulary Rust source actually uses:
 *
 *   - direct      bare type identifier:           a: Foo
 *   - ref         &T or &'a T:                    a: &'a Foo            ← containment=ref
 *   - ref_mut     &mut T or &'a mut T:            a: &'a mut Foo        ← containment=ref_mut
 *   - box         Box<T>:                         a: Box<Foo>
 *   - rc / arc    Rc<T> / Arc<T>:                 a: Rc<Foo>
 *   - vec         Vec<T>:                         a: Vec<Foo>
 *   - option      Option<T>:                      a: Option<Foo>
 *   - result      Result<T, E> (one edge per arm) a: Result<Foo, Err>
 *   - map         HashMap<K, V> / BTreeMap<K, V>  a: HashMap<u64, Foo>  ← containment=map, keyType=u64
 *   - set         HashSet<T> / BTreeSet<T>:       a: HashSet<Foo>
 *   - array       [T; N]:                         a: [Foo; 8]
 *   - slice       &[T] (already wrapped by ref):  a: &[Foo]             ← containment=ref.slice
 *   - dyn_trait   dyn Trait:                      a: Box<dyn Foo>       ← containment=box.dyn_trait
 *
 * Wrappers compose: `Vec<Option<Box<Foo>>>` → containment=vec.option.box
 *
 * Built-in primitive types (u8/u16/u32/u64/usize/i8/i16/i32/i64/isize/
 * f32/f64/bool/char/str) are dropped because they don't resolve
 * through the file resolver.
 */
function extractRustFieldTypeEdges(
  typeNode: TsNode,
  fieldFqName: string,
  fieldLine: number,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  const out: TypeRefEdgePayload[] = []
  const seen = new Set<string>()
  const rawText = typeNode.text

  const visit = (n: TsNode, accumulated: string[]): void => {
    switch (n.type) {
      case "primitive_type":
        // u8/i32/f64/bool/char/str/etc. — built-in, skip
        return

      case "type_identifier": {
        const name = n.text
        const resolved = resolveTypeName(name, resolver, moduleNodeName)
        if (!resolved) return
        const containment = accumulated.length > 0 ? accumulated.join(".") : "direct"
        const dstKey = resolved.name + "|" + containment
        if (seen.has(dstKey)) return
        seen.add(dstKey)
        out.push({
          edgeKind: "field_of_type",
          srcSymbolName: fieldFqName,
          dstSymbolName: resolved.name,
          confidence: 0.95,
          derivation: "clangd",
          sourceLocation: { sourceFilePath: file, sourceLineNumber: fieldLine },
          metadata: {
            resolved: true,
            resolutionKind: resolved.kind,
            containment,
            typeExpr: rawText,
          },
        })
        return
      }

      case "reference_type": {
        // &T or &'a T or &mut T or &'a mut T. Detect mut by looking
        // for a mutable_specifier child.
        let isMut = false
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c && c.type === "mutable_specifier") isMut = true
        }
        const wrapper = isMut ? "ref_mut" : "ref"
        // The pointee is the "type" field child (skip lifetime + mut)
        const pointee = n.childForFieldName("type")
        if (pointee) visit(pointee, [...accumulated, wrapper])
        return
      }

      case "pointer_type": {
        // *const T or *mut T
        let isMut = false
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c && c.type === "mutable_specifier") isMut = true
        }
        const wrapper = isMut ? "ptr_mut" : "ptr"
        const pointee = n.childForFieldName("type")
        if (pointee) visit(pointee, [...accumulated, wrapper])
        return
      }

      case "array_type": {
        // [T; N]
        const inner = n.childForFieldName("element") ?? n.namedChild(0)
        if (inner) visit(inner, [...accumulated, "array"])
        return
      }

      case "generic_type": {
        // Vec<T>, Box<T>, Rc<T>, Arc<T>, Option<T>, Result<T,E>,
        // HashMap<K,V>, BTreeMap<K,V>, HashSet<T>, BTreeSet<T>,
        // user-defined Foo<T>
        const typeNameNode = n.childForFieldName("type")
        const argsNode = n.childForFieldName("type_arguments")
        const wrapperName = typeNameNode ? typeNameNode.text : ""
        // The wrapper name may be a scoped path like
        // `std::collections::HashMap` — take the last segment.
        const lastSegment = wrapperName.split("::").pop() ?? wrapperName

        let wrapperKind: string | null = null
        let walkArgIndex = -1 // -1 means walk all type arguments
        let keyArgIndex = -1 // for Map: which arg is the key
        switch (lastSegment) {
          case "Vec":
            wrapperKind = "vec"
            break
          case "Box":
            wrapperKind = "box"
            break
          case "Rc":
            wrapperKind = "rc"
            break
          case "Arc":
            wrapperKind = "arc"
            break
          case "Option":
            wrapperKind = "option"
            break
          case "Result":
            wrapperKind = "result"
            // Walk both arms; both are interesting
            break
          case "HashMap":
          case "BTreeMap":
            wrapperKind = "map"
            walkArgIndex = 1
            keyArgIndex = 0
            break
          case "HashSet":
          case "BTreeSet":
            wrapperKind = "set"
            break
          case "Cell":
          case "RefCell":
          case "Mutex":
          case "RwLock":
            wrapperKind = "cell"
            break
        }

        if (!argsNode) {
          // Bare generic name — resolve as plain identifier
          if (typeNameNode && typeNameNode.type === "type_identifier") {
            visit(typeNameNode, accumulated)
          }
          return
        }

        if (wrapperKind) {
          const newAcc = [...accumulated, wrapperKind]
          // Map: extract key type as metadata, walk only the value
          let keyTypeText: string | null = null
          if (keyArgIndex >= 0) {
            const k = argsNode.namedChild(keyArgIndex)
            if (k) keyTypeText = k.text
          }
          if (walkArgIndex >= 0) {
            const target = argsNode.namedChild(walkArgIndex)
            if (target) {
              const before = out.length
              visit(target, newAcc)
              if (keyTypeText) {
                for (let i = before; i < out.length; i++) {
                  const meta = out[i].metadata as Record<string, unknown> | undefined
                  if (meta) meta.keyType = keyTypeText
                }
              }
            }
          } else {
            for (let i = 0; i < argsNode.namedChildCount; i++) {
              const c = argsNode.namedChild(i)
              if (c) visit(c, newAcc)
            }
          }
        } else {
          // User-defined generic Foo<T>: emit Foo as the primary
          // target, AND walk the type args at the same depth.
          if (typeNameNode && typeNameNode.type === "type_identifier") {
            visit(typeNameNode, accumulated)
          }
          for (let i = 0; i < argsNode.namedChildCount; i++) {
            const c = argsNode.namedChild(i)
            if (c) visit(c, accumulated)
          }
        }
        return
      }

      case "scoped_type_identifier": {
        // std::collections::HashMap or crate::module::Foo. The
        // last named child is the local type name; resolve that.
        let last: TsNode | null = null
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c && c.type === "type_identifier") last = c
        }
        if (last) visit(last, accumulated)
        return
      }

      case "tuple_type": {
        // (A, B, C) — walk each element
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c) visit(c, [...accumulated, "tuple"])
        }
        return
      }

      case "dynamic_type": {
        // dyn Trait — the trait IS the target
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c) visit(c, [...accumulated, "dyn_trait"])
        }
        return
      }

      default:
        // Catch-all: walk children defensively
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i)
          if (c) visit(c, accumulated)
        }
        return
    }
  }
  visit(typeNode, [])
  return out
}

/**
 * Walk a function/method's signature for parameter and return types.
 * Each `type_identifier` that resolves through the FileResolver
 * produces a references_type edge.
 */
function extractFunctionTypeReferences(
  fnNode: TsNode,
  thisFqName: string,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  const out: TypeRefEdgePayload[] = []
  const seen = new Set<string>()

  // Parameters
  const params = firstNamedChildOfType(fnNode, "parameters")
  if (params) {
    for (const typeName of namedDescendantTexts(params, "type_identifier")) {
      pushTypeRef(typeName, "param")
    }
  }

  // Return type — direct field child or `type_identifier` after `parameters`
  // The grammar uses different shapes; we just walk for type_identifiers
  // among the function's direct named children that AREN'T in
  // parameters/block.
  for (let i = 0; i < fnNode.namedChildCount; i++) {
    const child = fnNode.namedChild(i)
    if (!child) continue
    if (child.type === "parameters" || child.type === "block") continue
    if (child.type === "type_identifier") {
      pushTypeRef(child.text, "return")
    }
    // Generic return: `Result<Foo, Bar>` etc.
    if (
      child.type === "generic_type" ||
      child.type === "reference_type" ||
      child.type === "scoped_type_identifier" ||
      child.type === "tuple_type"
    ) {
      for (const typeName of namedDescendantTexts(child, "type_identifier")) {
        pushTypeRef(typeName, "return")
      }
    }
  }

  return out

  function pushTypeRef(typeName: string, where: string) {
    if (seen.has(typeName)) return
    const resolved = resolveTypeName(typeName, resolver, moduleNodeName)
    if (!resolved) return
    seen.add(typeName)
    out.push({
      edgeKind: "references_type",
      srcSymbolName: thisFqName,
      dstSymbolName: resolved.name,
      confidence: 0.95,
      derivation: "clangd",
      sourceLocation: {
        sourceFilePath: file,
        sourceLineNumber: fnNode.startPosition.row + 1,
      },
      metadata: {
        resolved: true,
        resolutionKind: resolved.kind,
        typeName,
        signaturePosition: where,
      },
    })
  }
}

/**
 * Walk a struct/enum/trait body for field type annotations and emit
 * references_type edges to each resolved type.
 */
function extractFieldTypeReferences(
  declNode: TsNode,
  thisFqName: string,
  resolver: FileResolver,
  moduleNodeName: string,
  file: string,
): Array<TypeRefEdgePayload> {
  const out: TypeRefEdgePayload[] = []
  const seen = new Set<string>()

  // Find the body — field_declaration_list (struct), enum_variant_list,
  // or declaration_list (trait)
  const body =
    firstNamedChildOfType(declNode, "field_declaration_list") ??
    firstNamedChildOfType(declNode, "enum_variant_list") ??
    firstNamedChildOfType(declNode, "declaration_list")
  if (!body) return out

  for (const typeName of namedDescendantTexts(body, "type_identifier")) {
    if (seen.has(typeName)) continue
    const resolved = resolveTypeName(typeName, resolver, moduleNodeName)
    if (!resolved) continue
    seen.add(typeName)
    out.push({
      edgeKind: "references_type",
      srcSymbolName: thisFqName,
      dstSymbolName: resolved.name,
      confidence: 0.95,
      derivation: "clangd",
      sourceLocation: {
        sourceFilePath: file,
        sourceLineNumber: body.startPosition.row + 1,
      },
      metadata: {
        resolved: true,
        resolutionKind: resolved.kind,
        typeName,
        fieldRef: true,
      },
    })
  }
  return out
}

/**
 * Extract the callee from a call_expression and resolve via the
 * FileResolver if possible.
 *
 * Resolution order:
 *   1. Bare identifier `foo()` — look up in namedImports, then localSymbols
 *   2. Method call `self.foo()` — emit as bare local for now
 *   3. Static path `Type::foo()` — split and try to resolve Type
 *   4. Anything else — return raw text as bare
 */
function extractCallee(
  callExpr: TsNode,
  resolver: FileResolver,
  moduleNodeName: string,
): { name: string; resolved: boolean; kind: string } | null {
  const fn = callExpr.childForFieldName("function")
  if (!fn) return null

  // Bare identifier: `foo()`
  if (fn.type === "identifier") {
    const local = fn.text
    const named = resolver.namedImports.get(local)
    if (named) return { name: named, resolved: true, kind: "named-import" }
    if (resolver.localSymbols.has(local)) {
      return { name: `${moduleNodeName}#${local}`, resolved: true, kind: "local" }
    }
    return { name: local, resolved: false, kind: "bare" }
  }

  // Field call: `self.foo()` or `obj.foo()`
  if (fn.type === "field_expression") {
    const field = fn.childForFieldName("field")
    if (field) {
      return { name: field.text, resolved: false, kind: "member" }
    }
  }

  // Scoped call: `Type::foo()` or `mod::path::foo()`
  if (fn.type === "scoped_identifier") {
    // Last segment is the function name; everything before is the type/module path
    const segments = fn.text.split("::")
    if (segments.length >= 2) {
      const typeName = segments[segments.length - 2]
      const fnName = segments[segments.length - 1]
      const named = resolver.namedImports.get(typeName)
      if (named) {
        // named is like "module:foo#TypeName"
        return {
          name: `${named}.${fnName}`,
          resolved: true,
          kind: "scoped-named",
        }
      }
      if (resolver.localSymbols.has(typeName)) {
        return {
          name: `${moduleNodeName}#${typeName}.${fnName}`,
          resolved: true,
          kind: "scoped-local",
        }
      }
      return { name: fn.text, resolved: false, kind: "scoped-bare" }
    }
  }

  // Other forms: raw text
  const text = fn.text
  if (text && text.length < 200) return { name: text, resolved: false, kind: "raw" }
  return null
}

/**
 * Parse an `impl_item` header to figure out whether it's an inherent
 * impl (`impl Type`) or a trait impl (`impl Trait for Type`).
 *
 * The grammar shape:
 *   impl_item
 *     ├─ type_identifier (Type)             ← inherent impl
 *     └─ declaration_list
 *
 *   impl_item
 *     ├─ type_identifier (Trait)            ← first
 *     ├─ type_identifier (Type)             ← second
 *     └─ declaration_list
 */
function parseImplHeader(
  implNode: TsNode,
): { typeName: string; traitName: string | null } | null {
  const types: string[] = []
  for (let i = 0; i < implNode.namedChildCount; i++) {
    const child = implNode.namedChild(i)
    if (!child) continue
    if (
      child.type === "type_identifier" ||
      child.type === "scoped_type_identifier" ||
      child.type === "generic_type"
    ) {
      // For generic_type / scoped_type_identifier, take the leftmost
      // type_identifier descendant as the name
      const id = firstNamedChildOfType(child, "type_identifier") ?? child
      types.push(id.text.split("<")[0])
    }
  }
  if (types.length === 0) return null
  if (types.length === 1) {
    return { typeName: types[0], traitName: null }
  }
  // `impl Trait for Type` → first is trait, second is type
  return { typeName: types[1], traitName: types[0] }
}

/**
 * Resolve a bare type identifier through the FileResolver. Mirrors
 * the same helper in ts-core but with rust's narrower set of
 * resolution paths.
 */
function resolveTypeName(
  name: string,
  resolver: FileResolver,
  moduleNodeName: string,
): { name: string; kind: string } | null {
  const named = resolver.namedImports.get(name)
  if (named) return { name: named, kind: "named-import" }
  if (resolver.localSymbols.has(name)) {
    return { name: `${moduleNodeName}#${name}`, kind: "local" }
  }
  return null
}

/**
 * Pre-populate localSymbols from top-level declarations so type
 * references work even when a function is declared before the type
 * it references later in the file.
 */
function prepopulateLocalSymbols(
  rootNode: TsNode,
  resolver: FileResolver,
): void {
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const child = rootNode.namedChild(i)
    if (!child) continue
    const declared = extractDeclaration(child)
    if (declared) {
      resolver.localSymbols.add(declared.name)
    }
  }
}

/**
 * A struct/enum/trait/etc. is "exported" in Rust when it has a
 * visibility_modifier child (typically `pub` or `pub(crate)`).
 */
function hasVisibilityModifier(node: TsNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child && child.type === "visibility_modifier") return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function hasRustFilesShallow(dir: string): boolean {
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
    if (entry.isFile() && entry.name.endsWith(".rs")) return true
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !SKIP_DIRS.has(entry.name)
    ) {
      try {
        const subEntries = readdirSync(join(dir, entry.name), {
          withFileTypes: true,
        })
        for (const sub of subEntries) {
          if (sub.isFile() && sub.name.endsWith(".rs")) return true
        }
      } catch {
        // ignore
      }
    }
  }
  return false
}

function workspaceRelativePath(workspaceRoot: string, file: string): string {
  const rel = relative(workspaceRoot, file)
  return rel.replace(/\\/g, "/").replace(/^\.\//, "")
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
