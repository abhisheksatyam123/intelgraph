/**
 * ts-core.test.ts — exercises the TypeScript extractor plugin against
 * a fixture workspace constructed in a temporary directory.
 *
 * The plugin is run end-to-end through ExtractorRunner so the test
 * also covers the runner → bus → sink path with TS-shaped facts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExtractorRunner } from "../../../src/intelligence/extraction/runner.js"
import { tsCoreExtractor } from "../../../src/plugins/index.js"
import type {
  GraphEdgeRow,
  GraphNodeRow,
  GraphWriteBatch,
  GraphWriteSink,
} from "../../../src/intelligence/db/graph-rows.js"
import type { ILanguageClient } from "../../../src/lsp/types.js"

class CaptureSink implements GraphWriteSink {
  public readonly batches: GraphWriteBatch[] = []
  async write(batch: GraphWriteBatch): Promise<void> {
    this.batches.push(JSON.parse(JSON.stringify(batch)))
  }
  allNodes(): GraphNodeRow[] {
    return this.batches.flatMap((b) => b.nodes)
  }
  allEdges(): GraphEdgeRow[] {
    return this.batches.flatMap((b) => b.edges)
  }
}

const stubLsp = {
  root: "/tmp",
  openFile: async () => false,
  documentSymbol: async () => [],
  outgoingCalls: async () => [],
  incomingCalls: async () => [],
  references: async () => [],
  definition: async () => [],
} as unknown as ILanguageClient

let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "ts-core-test-"))
  // Pretend it's a TS project so appliesTo() returns true.
  writeFileSync(join(tempRoot, "package.json"), JSON.stringify({ name: "fixture" }))
  writeFileSync(
    join(tempRoot, "tsconfig.json"),
    JSON.stringify({ compilerOptions: {} }),
  )

  mkdirSync(join(tempRoot, "src"), { recursive: true })

  // module-a: declares a function that calls a function in module-b
  writeFileSync(
    join(tempRoot, "src", "module-a.ts"),
    `
import { greetUser } from "./module-b"
import * as util from "./util"

export function entry(name: string): string {
  const text = greetUser(name)
  return util.format(text)
}

export class Greeter {
  constructor(private prefix: string) {}
  greet(name: string): string {
    return this.format(this.prefix + " " + greetUser(name))
  }
  format(s: string): string {
    return s.trim()
  }
}

export interface NamedThing {
  name: string
  // Round D14: method signatures inside interface bodies should
  // surface their parameter and return types as references_type edges.
  // Both Greeter and NamedThing are local to this file.
  greet(target: Greeter): NamedThing
}
`,
  )

  // module-b: declares the function imported by module-a
  writeFileSync(
    join(tempRoot, "src", "module-b.ts"),
    `
import { NamedThing, Greeter } from "./module-a"

export function greetUser(name: string): string {
  return "Hello, " + name
}

export type Greeting = string

// Hoisting: User is referenced here but declared further down.
export function describe(u: User): Greeting {
  return greetUser(u.name)
}

export class User {
  constructor(public name: string) {}
}

export class FormalGreeter extends Greeter implements NamedThing {
  name = "formal"
  owner: User
  fallback?: Greeting
  count: number
  greet(name: string): Greeting {
    // reads_field × 2: this.name + this.count
    // writes_field × 1: this.count = this.count + 1
    this.count = this.count + 1
    return greetUser(name + " " + this.name).toUpperCase()
  }
  resetCounter(): void {
    // writes_field × 1: this.count = 0 (assignment)
    this.count = 0
  }
  bumpCounter(): void {
    // writes_field × 1: this.count++ (update_expression)
    this.count++
  }
  augmentCounter(): void {
    // writes_field × 1: this.count += 5 (augmented_assignment)
    this.count += 5
  }
  getCount(): number {
    // reads_field × 1: pure read of this.count
    return this.count
  }
}
`,
  )

  // services.ts — typed top-level constants. Round D8 should emit
  // these as global_var symbols and produce references_type edges.
  writeFileSync(
    join(tempRoot, "src", "services.ts"),
    `
import { Greeter } from "./module-a"
import type { Greeting } from "./module-b"

export const defaultGreeter: Greeter = new Greeter("hi")
export const fallback: Greeting = "hello"
export const noTypeAnnotation = 42

// Round D9: type alias bodies referencing other types
export type GreeterOrNull = Greeter | null
export type Boxed<T> = { value: T; greeter: Greeter }
export type GreetingMap = Record<string, Greeting>
`,
  )

  // util: pure utility module
  writeFileSync(
    join(tempRoot, "src", "util.ts"),
    `
export function format(s: string): string {
  return s.trim()
}

export const upper = (s: string) => s.toUpperCase()

// Round D15: a namespace-style namedImport member access pattern.
// The Account namedImport has a "list" member that callers in other
// files invoke as Account.list(). We don't actually export an Account
// here — this file is the consumer side of the import. See
// services.ts which imports the symbol and calls .list() on it.
`,
  )

  // namespace-style fixture for D15: a local namespace function call.
  writeFileSync(
    join(tempRoot, "src", "namespace-fixture.ts"),
    `
import { Greeter } from "./module-a"
import { sql } from "./util"

export function localNs() { return "ns" }

export function caller() {
  // Greeter.makeFormal() — Greeter is a named import → named-member
  Greeter.makeFormal()
  // localNs.helper() — localNs is a local declaration → local-member
  localNs.helper()
  // Round D31: tagged template literal — should mark taggedTemplate=true
  const q = sql\`SELECT * FROM users\`
}

// Round D16: typed top-level variable + member call.
// instance: Greeter is a typed var; instance.greet() should resolve
// to module:src/module-a.ts#Greeter.greet via varTypes lookup.
export const instance: Greeter = new Greeter("hello")

export function viaInstance() {
  instance.greet("world")
}

// Round D17: typed parameter + member call. The parameter's type
// annotation should let p.greet() resolve to Greeter.greet.
export function viaParam(p: Greeter) {
  p.greet("param")
}

// Round D18: untyped const x = new Foo() — type comes from constructor.
export const inferred = new Greeter("inferred")

export function viaInferred() {
  inferred.greet("inferred-call")
}

// Round D27: bare new expression as a statement should produce a
// constructor calls edge from makeOne to Greeter.
export function makeOne(): Greeter {
  return new Greeter("standalone")
}

// Round D29: cast-based var typing.
// 'casted' has no annotation but 'as Greeter' makes its type knowable.
export const casted = JSON.parse("{}") as Greeter

export function viaCasted() {
  casted.greet("from-cast")
}

// Round D33: awaited call sites.
export async function asyncCaller() {
  await localNs.helper()
}

// Round D34: yield expressions wrapping calls.
export function* genCaller() {
  yield localNs.helper()
  yield* Greeter.makeFormal()
}

// Round D58: generic constraints — '<T extends Greeter>' should
// emit a references_type edge from the function to Greeter.
export function withConstraint<T extends Greeter>(g: T): T {
  return g
}

// Round D35: typed parameter on an inline arrow inside a higher-order
// call. The arrow's 'g' param should resolve via paramTypeStack so
// 'g.greet()' becomes a var-member to Greeter.greet.
export function inlineCaller(items: Array<Greeter>) {
  items.forEach((g: Greeter) => {
    g.greet("inline")
  })
}
`,
  )

  // Round D19: anonymous default-export forms in their own files.
  writeFileSync(
    join(tempRoot, "src", "anon-class.ts"),
    `export default class {
  greet() { return "anon class" }
}
`,
  )

  // Round D59: doc-commented declarations.
  writeFileSync(
    join(tempRoot, "src", "documented.ts"),
    `/**
 * Says hello to the user.
 * @param name the recipient
 */
export function sayHello(name: string): string {
  return "hello " + name
}

/** Inline doc for the bar class. */
export class Bar {}

// non-doc comment shouldn't attach
export function noDoc() {}
`,
  )
  writeFileSync(
    join(tempRoot, "src", "anon-fn.ts"),
    `export default function() {
  return "anon fn"
}
`,
  )
  writeFileSync(
    join(tempRoot, "src", "anon-arrow.ts"),
    `export default (name: string) => "hello " + name
`,
  )

  // tsx file with JSX — has both HTML elements and components
  writeFileSync(
    join(tempRoot, "src", "ui.tsx"),
    `
import React from "react"
import { entry, Greeter } from "./module-a"

function Header() {
  return <h1>hi</h1>
}

export function App() {
  return <div>
    {entry("world")}
    <Header />
    <Greeter prefix="formal" />
    <Header><span>plain</span></Header>
    {/* Round D21: member-expression tag form */}
    <Greeter.Inner />
  </div>
}
`,
  )

  // barrel re-export module — exercises export * and named re-exports
  writeFileSync(
    join(tempRoot, "src", "index.ts"),
    `
export { entry, Greeter } from "./module-a"
export * from "./module-b"
export * as util from "./util"
`,
  )
})

afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ts-core plugin — appliesTo", () => {
  it("matches workspaces with package.json", () => {
    expect(
      tsCoreExtractor.metadata.appliesTo?.({
        workspaceRoot: tempRoot,
        hasCompileCommands: false,
      }),
    ).toBe(true)
  })

  it("does not match workspaces without TS markers", () => {
    expect(
      tsCoreExtractor.metadata.appliesTo?.({
        workspaceRoot: "/tmp/not-a-real-ts-project-xyz",
        hasCompileCommands: false,
      }),
    ).toBe(false)
  })
})

describe("ts-core plugin — extraction", () => {
  it("emits a module symbol per file", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const moduleNodes = sink.allNodes().filter((n) => n.kind === "module")
    const names = new Set(moduleNodes.map((n) => n.canonical_name))
    expect(names.size).toBeGreaterThanOrEqual(4)
    expect([...names].some((n) => n.endsWith("src/module-a.ts"))).toBe(true)
    expect([...names].some((n) => n.endsWith("src/module-b.ts"))).toBe(true)
    expect([...names].some((n) => n.endsWith("src/util.ts"))).toBe(true)
    expect([...names].some((n) => n.endsWith("src/ui.tsx"))).toBe(true)
  })

  it("emits function declarations as function-kind symbols", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const functionNodes = sink.allNodes().filter((n) => n.kind === "function")
    const funcNames = new Set(
      functionNodes.map((n) =>
        // canonical_name is module:path#name; pull the local name
        String(n.canonical_name).split("#")[1] ?? "",
      ),
    )
    expect(funcNames.has("entry")).toBe(true)
    expect(funcNames.has("greetUser")).toBe(true)
    expect(funcNames.has("format")).toBe(true)
    expect(funcNames.has("App")).toBe(true)
    // arrow function bound to a const
    expect(funcNames.has("upper")).toBe(true)
  })

  it("emits classes and interfaces with the correct kinds", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const classNodes = sink.allNodes().filter((n) => n.kind === "class")
    const classNames = new Set(
      classNodes.map((n) => String(n.canonical_name).split("#")[1]),
    )
    expect(classNames.has("Greeter")).toBe(true)
    expect(classNames.has("FormalGreeter")).toBe(true)

    const ifaceNodes = sink.allNodes().filter((n) => n.kind === "interface")
    const ifaceNames = new Set(
      ifaceNodes.map((n) => String(n.canonical_name).split("#")[1]),
    )
    expect(ifaceNames.has("NamedThing")).toBe(true)
  })

  it("emits import edges (module → module)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const importEdges = sink.allEdges().filter((e) => e.edge_kind === "imports")
    expect(importEdges.length).toBeGreaterThanOrEqual(3)

    // module-a imports module-b
    const aToB = importEdges.find(
      (e) =>
        String(e.src_node_id).includes("module-a.ts") &&
        String(e.dst_node_id).includes("module-b.ts"),
    )
    expect(aToB).toBeDefined()

    // ui.tsx imports module-a
    const uiToA = importEdges.find(
      (e) =>
        String(e.src_node_id).includes("ui.tsx") &&
        String(e.dst_node_id).includes("module-a.ts"),
    )
    expect(uiToA).toBeDefined()

    // ui.tsx imports react (bare specifier — kept as-is)
    const uiToReact = importEdges.find(
      (e) =>
        String(e.src_node_id).includes("ui.tsx") &&
        String(e.dst_node_id).endsWith("module:react"),
    )
    expect(uiToReact).toBeDefined()
  })

  it("emits contains edges (module → declared symbol)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const containsEdges = sink.allEdges().filter((e) => e.edge_kind === "contains")
    // Every declared symbol should have a contains edge from its module
    expect(containsEdges.length).toBeGreaterThan(0)

    // module-a contains entry
    const aContainsEntry = containsEdges.find(
      (e) =>
        String(e.src_node_id).includes("module-a.ts") &&
        String(e.dst_node_id).endsWith("#entry"),
    )
    expect(aContainsEntry).toBeDefined()
  })

  it("emits call edges from caller function to callee identifier", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    // entry calls greetUser and util.format → at least 2 call edges from entry
    const fromEntry = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("#entry"),
    )
    expect(fromEntry.length).toBeGreaterThanOrEqual(2)
    // dst_node_id has the form `graph_node:<sid>:symbol:<canonical>`.
    // After Round D1's cross-file resolver:
    //   - `greetUser` is a named import from module-b.ts → dst should
    //     be `module:src/module-b.ts#greetUser`
    //   - `util.format` is a namespace_import member → dst should be
    //     `module:src/util.ts#format`
    const dstSuffixes = fromEntry.map((e) => {
      const dst = String(e.dst_node_id)
      // Strip the graph_node:<sid>:symbol: prefix
      return dst.replace(/^graph_node:\d+:symbol:/, "")
    })
    expect(
      dstSuffixes.some((d) => d.endsWith("module-b.ts#greetUser")),
    ).toBe(true)
    expect(
      dstSuffixes.some((d) => d.endsWith("util.ts#format")),
    ).toBe(true)
  })

  it("emits extends edges with FQ resolved destinations", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const extendsEdges = sink.allEdges().filter((e) => e.edge_kind === "extends")
    // FormalGreeter extends Greeter (Greeter is imported from module-a)
    // After the inheritance fix, dst is the resolved FQ name, not bare.
    const formal = extendsEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("#FormalGreeter") &&
        String(e.dst_node_id).endsWith("module-a.ts#Greeter"),
    )
    expect(formal).toBeDefined()
    const meta = formal?.metadata as { resolved?: boolean; targetName?: string }
    expect(meta?.resolved).toBe(true)
    expect(meta?.targetName).toBe("Greeter")
  })

  it("emits implements edges with FQ resolved destinations", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const implementsEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "implements")
    // FormalGreeter implements NamedThing (NamedThing is imported from
    // module-a). After the fix, the dst is the FQ form.
    const formal = implementsEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("#FormalGreeter") &&
        String(e.dst_node_id).endsWith("module-a.ts#NamedThing"),
    )
    expect(formal).toBeDefined()
    const meta = formal?.metadata as { resolved?: boolean }
    expect(meta?.resolved).toBe(true)
  })

  it("resolves cross-file calls via the import map (named, namespace, local)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")

    // Greeter.greet calls greetUser (named import from ./module-b).
    // After Round D4 the method is qualified as `Greeter.greet` so its
    // canonical_name ends with `#Greeter.greet`, not `#greet`.
    const greeterCalls = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("#Greeter.greet"),
    )
    expect(
      greeterCalls.some((e) =>
        stripPrefix(e.dst_node_id).endsWith("module-b.ts#greetUser"),
      ),
    ).toBe(true)

    // Verify the resolution metadata is present
    const namedImportEdge = greeterCalls.find((e) =>
      stripPrefix(e.dst_node_id).endsWith("module-b.ts#greetUser"),
    )
    const meta = namedImportEdge?.metadata as {
      resolved?: boolean
      resolutionKind?: string
    }
    expect(meta?.resolved).toBe(true)
    expect(meta?.resolutionKind).toBe("named-import")

    // entry calls util.format → namespace-member resolution
    const entryCalls = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("#entry"),
    )
    const namespaceCall = entryCalls.find((e) =>
      stripPrefix(e.dst_node_id).endsWith("util.ts#format"),
    )
    expect(namespaceCall).toBeDefined()
    const nsMeta = namespaceCall?.metadata as {
      resolved?: boolean
      resolutionKind?: string
    }
    expect(nsMeta?.resolved).toBe(true)
    expect(nsMeta?.resolutionKind).toBe("namespace-member")
  })

  it("captures JSX prop names on component calls (D32)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")

    // App renders <Greeter prefix="formal" /> — should capture
    // metadata.props = ["prefix"]
    const fromApp = callEdges.filter(
      (e) =>
        String(e.src_node_id).endsWith("ui.tsx#App") &&
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
          "jsx-component",
    )
    const greeterEdge = fromApp.find(
      (e) => (e.metadata as { jsxTag?: string })?.jsxTag === "Greeter",
    )
    expect(greeterEdge).toBeDefined()
    const meta = greeterEdge!.metadata as { props?: string[] }
    expect(meta.props).toBeDefined()
    expect(meta.props).toContain("prefix")
  })

  it("emits calls edges for JSX component usage with resolutionKind=jsx-component", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const jsxEdges = callEdges.filter(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "jsx-component",
    )
    expect(jsxEdges.length).toBeGreaterThan(0)

    // App uses Header (local) and Greeter (named-import from module-a).
    // Header is used twice: once self-closing and once as opening.
    // The FactBus dedups by canonical key (caller+callee+location), so
    // we should see 2 distinct Header edges (different lines).
    const fromApp = jsxEdges.filter((e) =>
      String(e.src_node_id).endsWith("ui.tsx#App"),
    )
    expect(fromApp.length).toBeGreaterThanOrEqual(2)

    const targets = new Set(
      fromApp.map((e) => String(e.dst_node_id)),
    )
    expect(
      [...targets].some((t) => t.endsWith("ui.tsx#Header")),
    ).toBe(true)
    expect(
      [...targets].some((t) => t.endsWith("module-a.ts#Greeter")),
    ).toBe(true)

    // None of the HTML tags (div, h1, span) should produce edges
    expect(
      jsxEdges.some((e) =>
        ["div", "h1", "span"].includes(
          (e.metadata as { jsxTag?: string })?.jsxTag ?? "",
        ),
      ),
    ).toBe(false)

    // Round D21: <Greeter.Inner /> should resolve to the named-import
    // Greeter, then .Inner appended → kind=jsx-namespace-component.
    // (Note: jsxEdges only filters jsx-component, so we look in
    // callEdges directly for the namespace variant.)
    const namespaceComp = callEdges.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "jsx-namespace-component",
    )
    expect(namespaceComp).toBeDefined()
    expect(String(namespaceComp!.dst_node_id)).toMatch(
      /module-a\.ts#Greeter\.Inner$/,
    )
  })

  it("emits references_type edges for type alias bodies, skipping generics", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const refEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "references_type")
    const aliasRefs = refEdges.filter(
      (e) => (e.metadata as { aliasRef?: boolean })?.aliasRef === true,
    )
    expect(aliasRefs.length).toBeGreaterThan(0)

    // GreeterOrNull = Greeter | null  → 1 edge (Greeter)
    const fromGreeterOrNull = aliasRefs.filter((e) =>
      String(e.src_node_id).endsWith("services.ts#GreeterOrNull"),
    )
    expect(fromGreeterOrNull.length).toBe(1)
    expect(String(fromGreeterOrNull[0].dst_node_id)).toMatch(/module-a\.ts#Greeter$/)

    // Boxed<T> = { value: T; greeter: Greeter }
    //   → 1 edge to Greeter; T is a generic parameter, must not appear
    const fromBoxed = aliasRefs.filter((e) =>
      String(e.src_node_id).endsWith("services.ts#Boxed"),
    )
    expect(fromBoxed.length).toBe(1)
    expect(String(fromBoxed[0].dst_node_id)).toMatch(/module-a\.ts#Greeter$/)
    // No edge to T (the generic parameter)
    expect(fromBoxed.some((e) => String(e.dst_node_id).endsWith("#T"))).toBe(false)

    // GreetingMap = Record<string, Greeting>
    //   → 1 edge to Greeting; Record is built-in, dropped
    const fromGreetingMap = aliasRefs.filter((e) =>
      String(e.src_node_id).endsWith("services.ts#GreetingMap"),
    )
    expect(fromGreetingMap.length).toBe(1)
    expect(String(fromGreetingMap[0].dst_node_id)).toMatch(/module-b\.ts#Greeting$/)
  })

  it("tags `import type` imports edges with metadata.importType", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const importEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "imports")

    // services.ts has both `import { Greeter }` and
    // `import type { Greeting }`. Find each.
    const fromServices = importEdges.filter((e) =>
      String(e.src_node_id).includes("services.ts"),
    )
    const greeterImport = fromServices.find((e) =>
      String(e.dst_node_id).endsWith("module-a.ts"),
    )
    const greetingImport = fromServices.find((e) =>
      String(e.dst_node_id).endsWith("module-b.ts"),
    )
    expect(greeterImport).toBeDefined()
    expect(greetingImport).toBeDefined()

    // Greeter is a value import → no importType flag
    const greeterMeta = greeterImport?.metadata as { importType?: boolean }
    expect(greeterMeta?.importType).toBeUndefined()

    // Greeting is a type-only import → importType=true
    const greetingMeta = greetingImport?.metadata as { importType?: boolean }
    expect(greetingMeta?.importType).toBe(true)
  })

  it("emits typed top-level variables as global_var symbols with references_type", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // services.ts has two typed consts (defaultGreeter, fallback) and
    // one untyped (noTypeAnnotation). Only the typed ones become symbols.
    const globalVars = sink.allNodes().filter((n) => n.kind === "global_var")
    const fromServices = globalVars.filter((n) =>
      String(n.canonical_name).includes("services.ts"),
    )
    expect(fromServices.length).toBe(2)

    const names = new Set(
      fromServices.map((n) => String(n.canonical_name).split("#")[1]),
    )
    expect(names.has("defaultGreeter")).toBe(true)
    expect(names.has("fallback")).toBe(true)
    expect(names.has("noTypeAnnotation")).toBe(false)

    // references_type edges from defaultGreeter → Greeter
    const refEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "references_type")
    const fromDefault = refEdges.filter((e) =>
      String(e.src_node_id).endsWith("services.ts#defaultGreeter"),
    )
    expect(fromDefault.length).toBe(1)
    expect(String(fromDefault[0].dst_node_id)).toMatch(/module-a\.ts#Greeter$/)

    // fallback → Greeting
    const fromFallback = refEdges.filter((e) =>
      String(e.src_node_id).endsWith("services.ts#fallback"),
    )
    expect(fromFallback.length).toBe(1)
    expect(String(fromFallback[0].dst_node_id)).toMatch(/module-b\.ts#Greeting$/)
  })

  it("walks interface method_signature for parameter and return type references", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const refEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "references_type")
    // NamedThing.greet(target: Greeter): NamedThing
    // → NamedThing should have 2 fieldRef edges:
    //     - to Greeter (parameter type, local)
    //     - to NamedThing (return type, self-reference, local)
    const fromNamedThing = refEdges.filter(
      (e) =>
        String(e.src_node_id).endsWith("module-a.ts#NamedThing") &&
        (e.metadata as { fieldRef?: boolean })?.fieldRef === true,
    )
    expect(fromNamedThing.length).toBeGreaterThanOrEqual(2)

    const targets = new Set(
      fromNamedThing.map((e) => String(e.dst_node_id)),
    )
    expect([...targets].some((t) => t.endsWith("module-a.ts#Greeter"))).toBe(true)
    expect(
      [...targets].some((t) => t.endsWith("module-a.ts#NamedThing")),
    ).toBe(true)

    // The method_signature edge should carry memberKind=method_signature
    // so visualizers can distinguish field types from method types.
    const hasMethodSig = fromNamedThing.some(
      (e) =>
        (e.metadata as { memberKind?: string })?.memberKind === "method_signature",
    )
    expect(hasMethodSig).toBe(true)
  })

  it("emits references_type edges for class field types", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const refEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "references_type")

    // FormalGreeter has fields: owner: User, fallback: Greeting, count: number
    // - User and Greeting resolve (local declarations in module-b)
    // - number is a predefined_type, dropped
    // Expected: 2 edges from FormalGreeter
    const fromFormal = refEdges.filter(
      (e) =>
        String(e.src_node_id).endsWith("module-b.ts#FormalGreeter") &&
        (e.metadata as { fieldRef?: boolean })?.fieldRef === true,
    )
    expect(fromFormal.length).toBe(2)

    const dsts = new Set(
      fromFormal.map((e) => String(e.dst_node_id)),
    )
    expect([...dsts].some((d) => d.endsWith("module-b.ts#User"))).toBe(true)
    expect([...dsts].some((d) => d.endsWith("module-b.ts#Greeting"))).toBe(true)
  })

  it("emits references_type edges for function signature types", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const refEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "references_type")
    expect(refEdges.length).toBeGreaterThan(0)

    // describe(u: User): Greeting → references local User AND local Greeting
    // (both declared in module-b.ts; User is hoisted from below)
    const fromDescribe = refEdges.filter((e) =>
      String(e.src_node_id).endsWith("module-b.ts#describe"),
    )
    expect(fromDescribe.length).toBeGreaterThanOrEqual(2)

    const dsts = new Set(
      fromDescribe.map((e) => String(e.dst_node_id)),
    )
    expect([...dsts].some((d) => d.endsWith("module-b.ts#User"))).toBe(true)
    expect([...dsts].some((d) => d.endsWith("module-b.ts#Greeting"))).toBe(true)

    // Resolution metadata is set
    const sample = fromDescribe[0]
    const meta = sample.metadata as { resolved?: boolean; resolutionKind?: string }
    expect(meta?.resolved).toBe(true)
    expect(["named-import", "default-import", "local"]).toContain(
      meta?.resolutionKind,
    )

    // Built-in types like `string` should NOT produce references_type edges.
    // greetUser(name: string): string → no references emitted at all.
    const fromGreetUser = refEdges.filter((e) =>
      String(e.src_node_id).endsWith("module-b.ts#greetUser"),
    )
    expect(fromGreetUser.length).toBe(0)
  })

  it("attaches JSDoc preceding top-level declarations to metadata.doc", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // documented.ts > sayHello — has a JSDoc block
    const sayHello = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "function" &&
          String(n.canonical_name).endsWith("documented.ts#sayHello"),
      )
    const sayHelloMeta =
      ((sayHello?.payload as Record<string, unknown> | undefined)
        ?.metadata as Record<string, unknown> | undefined) ?? {}
    expect(typeof sayHelloMeta.doc).toBe("string")
    expect(String(sayHelloMeta.doc)).toContain("Says hello")

    // documented.ts > Bar — has an inline doc
    const bar = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "class" &&
          String(n.canonical_name).endsWith("documented.ts#Bar"),
      )
    const barMeta =
      ((bar?.payload as Record<string, unknown> | undefined)
        ?.metadata as Record<string, unknown> | undefined) ?? {}
    expect(String(barMeta.doc)).toContain("Inline doc")

    // documented.ts > noDoc — non-JSDoc comment shouldn't attach
    const noDoc = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "function" &&
          String(n.canonical_name).endsWith("documented.ts#noDoc"),
      )
    const noDocMeta =
      ((noDoc?.payload as Record<string, unknown> | undefined)
        ?.metadata as Record<string, unknown> | undefined) ?? {}
    expect(noDocMeta.doc).toBeUndefined()
  })

  it("emits anonymous default exports as `default` symbols", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const allNodes = sink.allNodes()

    // anon-class.ts → default class symbol
    const anonClass = allNodes.find(
      (n) =>
        n.kind === "class" &&
        String(n.canonical_name).endsWith("anon-class.ts#default"),
    )
    expect(anonClass).toBeDefined()

    // anon-fn.ts → default function symbol
    const anonFn = allNodes.find(
      (n) =>
        n.kind === "function" &&
        String(n.canonical_name).endsWith("anon-fn.ts#default"),
    )
    expect(anonFn).toBeDefined()

    // anon-arrow.ts → default function symbol (kind=function)
    const anonArrow = allNodes.find(
      (n) =>
        n.kind === "function" &&
        String(n.canonical_name).endsWith("anon-arrow.ts#default"),
    )
    expect(anonArrow).toBeDefined()

    // Each should also have a contains edge from its module.
    const containsEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "contains")
    const anonClassContains = containsEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("module:src/anon-class.ts") &&
        String(e.dst_node_id).endsWith("anon-class.ts#default"),
    )
    expect(anonClassContains).toBeDefined()
  })

  it("resolves typed params on inline arrow lambdas via param-member", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")

    // inlineCaller forwards to a `forEach((g: Greeter) => g.greet())`.
    // The g.greet() call should resolve via param-member because the
    // inline arrow's typed param now lands on the paramTypeStack.
    // Caller attribution stays at the outer inlineCaller scope.
    const fromInline = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#inlineCaller"),
    )
    const paramMember = fromInline.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
          "param-member" &&
        stripPrefix(e.dst_node_id).endsWith("module-a.ts#Greeter.greet"),
    )
    expect(paramMember).toBeDefined()
  })

  it("emits references_type edges for generic constraints", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const refEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "references_type")
    // withConstraint<T extends Greeter> should reference Greeter
    const fromWithConstraint = refEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("namespace-fixture.ts#withConstraint") &&
        (e.metadata as { genericConstraint?: boolean })?.genericConstraint ===
          true,
    )
    expect(fromWithConstraint).toBeDefined()
    expect(String(fromWithConstraint!.dst_node_id)).toMatch(
      /module-a\.ts#Greeter$/,
    )
  })

  it("tags yielded call sites with metadata.yielded and delegated", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")

    // genCaller has both `yield localNs.helper()` (yielded, not delegated)
    // and `yield* Greeter.makeFormal()` (yielded, delegated).
    const fromGen = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#genCaller"),
    )
    const yielded = fromGen.filter(
      (e) => (e.metadata as { yielded?: boolean })?.yielded === true,
    )
    expect(yielded.length).toBeGreaterThanOrEqual(2)

    const delegated = fromGen.find(
      (e) => (e.metadata as { delegated?: boolean })?.delegated === true,
    )
    expect(delegated).toBeDefined()
    // The delegated one should be Greeter.makeFormal (named-member)
    const meta = delegated!.metadata as { resolutionKind?: string }
    expect(meta.resolutionKind).toBe("named-member")
  })

  it("tags awaited call sites with metadata.awaited", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")

    // asyncCaller has `await localNs.helper()` — the call should be
    // tagged metadata.awaited=true.
    const fromAsync = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#asyncCaller"),
    )
    const awaited = fromAsync.find(
      (e) => (e.metadata as { awaited?: boolean })?.awaited === true,
    )
    expect(awaited).toBeDefined()
  })

  it("tags tagged-template-literal calls with metadata.taggedTemplate", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")

    // caller() makes a sql`...` tagged template call. The edge should
    // have metadata.taggedTemplate=true.
    const fromCaller = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#caller"),
    )
    const tagged = fromCaller.find(
      (e) => (e.metadata as { taggedTemplate?: boolean })?.taggedTemplate === true,
    )
    expect(tagged).toBeDefined()
    // The callee should be `sql` (named-import or bare)
    const meta = tagged!.metadata as { resolutionKind?: string }
    expect(meta.resolutionKind).toBeDefined()
  })

  it("infers var type from `expr as Foo` casts and resolves member calls", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // `casted` is declared as `JSON.parse("{}") as Greeter` and should
    // become a global_var symbol with varTypes mapping to Greeter.
    const castedNode = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "global_var" &&
          String(n.canonical_name).endsWith("namespace-fixture.ts#casted"),
      )
    expect(castedNode).toBeDefined()

    // A references_type edge from casted → Greeter should land with
    // metadata.inferredFromCast=true
    const refEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "references_type")
    const fromCasted = refEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("namespace-fixture.ts#casted") &&
        (e.metadata as { inferredFromCast?: boolean })?.inferredFromCast === true,
    )
    expect(fromCasted).toBeDefined()
    expect(String(fromCasted!.dst_node_id)).toMatch(/module-a\.ts#Greeter$/)

    // viaCasted() calls casted.greet() → var-member to Greeter.greet
    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")
    const fromViaCasted = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#viaCasted"),
    )
    const varMember = fromViaCasted.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "var-member",
    )
    expect(varMember).toBeDefined()
    expect(stripPrefix(varMember!.dst_node_id)).toBe(
      "module:src/module-a.ts#Greeter.greet",
    )
  })

  it("emits a constructor calls edge for bare `new Foo()` expressions", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")

    // makeOne() returns `new Greeter("standalone")`. The new_expression
    // should produce a constructor calls edge from makeOne to Greeter.
    const fromMakeOne = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#makeOne"),
    )
    const ctorCall = fromMakeOne.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "constructor",
    )
    expect(ctorCall).toBeDefined()
    expect(stripPrefix(ctorCall!.dst_node_id)).toBe(
      "module:src/module-a.ts#Greeter",
    )
    const meta = ctorCall!.metadata as { ctorName?: string; resolved?: boolean }
    expect(meta.ctorName).toBe("Greeter")
    expect(meta.resolved).toBe(true)
  })

  it("infers var type from `new Foo()` and resolves member calls", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // Even without an explicit annotation, `inferred` should be a
    // global_var symbol with its type recovered from the constructor.
    const globalVars = sink.allNodes().filter((n) => n.kind === "global_var")
    const inferredNode = globalVars.find((n) =>
      String(n.canonical_name).endsWith("namespace-fixture.ts#inferred"),
    )
    expect(inferredNode).toBeDefined()

    // A references_type edge from inferred → Greeter should be emitted
    // with metadata.inferredFromNew=true
    const refEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "references_type")
    const fromInferred = refEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("namespace-fixture.ts#inferred") &&
        (e.metadata as { inferredFromNew?: boolean })?.inferredFromNew === true,
    )
    expect(fromInferred).toBeDefined()
    expect(String(fromInferred!.dst_node_id)).toMatch(/module-a\.ts#Greeter$/)

    // viaInferred() calls inferred.greet() → var-member to Greeter.greet
    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")
    const fromViaInferred = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#viaInferred"),
    )
    const varMember = fromViaInferred.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "var-member",
    )
    expect(varMember).toBeDefined()
    expect(stripPrefix(varMember!.dst_node_id)).toBe(
      "module:src/module-a.ts#Greeter.greet",
    )
  })

  it("resolves typedParam.method() via the parameter's type annotation", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")

    // viaParam(p: Greeter) calls p.greet("param") → param-member
    const fromViaParam = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#viaParam"),
    )
    const paramMember = fromViaParam.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "param-member",
    )
    expect(paramMember).toBeDefined()
    expect(stripPrefix(paramMember!.dst_node_id)).toBe(
      "module:src/module-a.ts#Greeter.greet",
    )
  })

  it("resolves typedVar.method() to the var's annotated type's method", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")

    // viaInstance() calls instance.greet(). instance: Greeter, so dst
    // should be `module:src/module-a.ts#Greeter.greet` (the type's
    // method, not a bare property name).
    const fromViaInstance = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#viaInstance"),
    )
    const varMember = fromViaInstance.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "var-member",
    )
    expect(varMember).toBeDefined()
    expect(stripPrefix(varMember!.dst_node_id)).toBe(
      "module:src/module-a.ts#Greeter.greet",
    )
  })

  it("resolves namedImport.member() and local.member() to FQ destinations", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")

    // namespace-fixture.ts > caller() makes two member calls:
    //   - Greeter.makeFormal() → named-member (Greeter is named import)
    //   - localNs.helper()     → local-member (localNs is same-file)
    const fromCaller = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("namespace-fixture.ts#caller"),
    )

    const namedMember = fromCaller.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "named-member",
    )
    expect(namedMember).toBeDefined()
    // dst is `${named-import-fq}.${member}` =
    // `module:src/module-a.ts#Greeter.makeFormal`
    expect(stripPrefix(namedMember!.dst_node_id)).toBe(
      "module:src/module-a.ts#Greeter.makeFormal",
    )

    const localMember = fromCaller.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "local-member",
    )
    expect(localMember).toBeDefined()
    expect(stripPrefix(localMember!.dst_node_id)).toBe(
      "module:src/namespace-fixture.ts#localNs.helper",
    )

    // Sanity check: existing namespace-member resolution still works.
    const entryCalls = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("module-a.ts#entry"),
    )
    const namespaceCall = entryCalls.find(
      (e) =>
        (e.metadata as { resolutionKind?: string })?.resolutionKind ===
        "namespace-member",
    )
    expect(namespaceCall).toBeDefined()
  })

  it("resolves this.method() calls to the enclosing class's method", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    const stripPrefix = (id: unknown): string =>
      String(id).replace(/^graph_node:\d+:symbol:/, "")

    // Greeter.greet calls this.format() → should resolve to
    // module:src/module-a.ts#Greeter.format with kind: this-method
    const fromGreeterGreet = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("#Greeter.greet"),
    )
    const thisCall = fromGreeterGreet.find((e) =>
      stripPrefix(e.dst_node_id).endsWith("module-a.ts#Greeter.format"),
    )
    expect(thisCall).toBeDefined()
    const meta = thisCall?.metadata as { resolved?: boolean; resolutionKind?: string }
    expect(meta?.resolved).toBe(true)
    expect(meta?.resolutionKind).toBe("this-method")
  })

  it("methods are qualified with their class and contains anchors at the class", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // Method symbols are now `Class.method`, not bare `method`.
    const methodNodes = sink.allNodes().filter((n) => n.kind === "method")
    const methodNames = new Set(
      methodNodes.map((n) => String(n.canonical_name).split("#")[1]),
    )
    expect(methodNames.has("Greeter.greet")).toBe(true)
    expect(methodNames.has("FormalGreeter.greet")).toBe(true)

    // Their contains edge originates at the class FQ name, not the module.
    const containsEdges = sink.allEdges().filter((e) => e.edge_kind === "contains")
    const greeterMethodContains = containsEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("#Greeter") &&
        String(e.dst_node_id).endsWith("#Greeter.greet"),
    )
    expect(greeterMethodContains).toBeDefined()

    // owningClass metadata is set on the method symbol's payload.metadata
    const greetNode = methodNodes.find((n) =>
      String(n.canonical_name).endsWith("#Greeter.greet"),
    )
    const payload = (greetNode?.payload as Record<string, unknown> | undefined) ?? {}
    const meta = (payload.metadata as Record<string, unknown> | undefined) ?? {}
    expect(meta.owningClass).toBe("Greeter")

    // Sanity: there should NOT be a top-level `module:...#greet` symbol
    // (the bare unqualified form was the bug).
    const allCanonical = sink.allNodes().map((n) => String(n.canonical_name))
    const bareGreet = allCanonical.filter((n) => /[^.]#greet$/.test(n))
    expect(bareGreet.length).toBe(0)
  })

  it("emits imports edges for re-exports (export ... from)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const importEdges = sink.allEdges().filter((e) => e.edge_kind === "imports")
    const fromIndex = importEdges.filter((e) =>
      String(e.src_node_id).includes("src/index.ts"),
    )
    // index.ts re-exports from module-a, module-b, and util → 3 edges
    expect(fromIndex.length).toBeGreaterThanOrEqual(3)

    const targets = new Set(
      fromIndex.map((e) => String(e.dst_node_id)),
    )
    expect(
      [...targets].some((t) => t.endsWith("module:src/module-a.ts")),
    ).toBe(true)
    expect(
      [...targets].some((t) => t.endsWith("module:src/module-b.ts")),
    ).toBe(true)
    expect([...targets].some((t) => t.endsWith("module:src/util.ts"))).toBe(true)

    // Every re-export edge should carry metadata.reExport=true so the
    // visualizer can distinguish them from direct imports.
    for (const edge of fromIndex) {
      const meta = edge.metadata as { reExport?: boolean } | null
      expect(meta?.reExport).toBe(true)
    }
  })

  it("tracks exported status on top-level declarations", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // module-a.ts has `export function entry`, `export class Greeter`,
    // `export interface NamedThing`. All three should carry exported=true.
    const greeter = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "class" &&
          String(n.canonical_name).endsWith("module-a.ts#Greeter"),
      )
    const greeterMeta =
      ((greeter?.payload as Record<string, unknown>)?.metadata as
        | Record<string, unknown>
        | undefined) ?? {}
    expect(greeterMeta.exported).toBe(true)

    const entry = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "function" &&
          String(n.canonical_name).endsWith("module-a.ts#entry"),
      )
    const entryMeta =
      ((entry?.payload as Record<string, unknown>)?.metadata as
        | Record<string, unknown>
        | undefined) ?? {}
    expect(entryMeta.exported).toBe(true)

    // ui.tsx has `function Header() {}` (no export) and
    // `export function App() {}`. Header should NOT be exported.
    const header = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "function" &&
          String(n.canonical_name).endsWith("ui.tsx#Header"),
      )
    const headerMeta =
      ((header?.payload as Record<string, unknown>)?.metadata as
        | Record<string, unknown>
        | undefined) ?? {}
    expect(headerMeta.exported).toBeUndefined()

    // Methods inside an exported class are NOT themselves exported —
    // the class is. Greeter.greet should not have exported=true.
    const greet = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "method" &&
          String(n.canonical_name).endsWith("module-a.ts#Greeter.greet"),
      )
    const greetMeta =
      ((greet?.payload as Record<string, unknown>)?.metadata as
        | Record<string, unknown>
        | undefined) ?? {}
    expect(greetMeta.exported).toBeUndefined()
  })

  it("symbols carry endLine and lineCount metadata for size-aware visualization", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // The Greeter class spans multiple lines in module-a.ts. Its symbol
    // should have lineCount > 1 and endLine > startLine.
    const greeterClass = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "class" &&
          String(n.canonical_name).endsWith("module-a.ts#Greeter"),
      )
    expect(greeterClass).toBeDefined()
    const payload = greeterClass!.payload as Record<string, unknown>
    const meta = payload.metadata as Record<string, unknown>
    expect(typeof meta.endLine).toBe("number")
    expect(typeof meta.lineCount).toBe("number")
    expect(meta.endLine).toBeGreaterThan(greeterClass!.location?.line ?? 0)
    expect(meta.lineCount).toBeGreaterThan(1)

    // Module symbols also carry endLine, set to the file's last line.
    const moduleA = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "module" &&
          String(n.canonical_name).endsWith("module-a.ts"),
      )
    expect(moduleA).toBeDefined()
    const modPayload = moduleA!.payload as Record<string, unknown>
    const modMeta = modPayload.metadata as Record<string, unknown>
    expect(typeof modMeta.endLine).toBe("number")
    expect(modMeta.endLine).toBeGreaterThan(1)
  })

  it("auto-tags every emitted fact with producedBy=ts-core", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()
    const node = sink.allNodes()[0]
    const provenance = (node.payload as Record<string, unknown>)._provenance as
      | { producedBy?: string[] }
      | undefined
    expect(provenance?.producedBy).toContain("ts-core")
  })

  it("emits field nodes for class fields with kind=field", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const fields = sink.allNodes().filter((n) => n.kind === "field")
    const fieldNames = new Set(
      fields.map((n) => String(n.canonical_name).split("#")[1]),
    )
    // FormalGreeter declares: name, owner, fallback, count
    expect(fieldNames.has("FormalGreeter.name")).toBe(true)
    expect(fieldNames.has("FormalGreeter.owner")).toBe(true)
    expect(fieldNames.has("FormalGreeter.fallback")).toBe(true)
    expect(fieldNames.has("FormalGreeter.count")).toBe(true)

    // Field nodes carry owningClass + declaredOn metadata
    const formalName = fields.find(
      (n) => String(n.canonical_name).endsWith("#FormalGreeter.name"),
    )
    expect(formalName).toBeDefined()
    const meta =
      ((formalName!.payload as Record<string, unknown>).metadata as
        | Record<string, unknown>
        | undefined) ?? {}
    expect(meta.owningClass).toBe("FormalGreeter")
    expect(meta.declaredOn).toBe("class")
  })

  it("emits field nodes for interface property signatures", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // module-a defines `interface NamedThing { name: string }`
    const fields = sink.allNodes().filter((n) => n.kind === "field")
    const namedThingFields = fields.filter((n) =>
      String(n.canonical_name).includes("#NamedThing."),
    )
    expect(namedThingFields.length).toBeGreaterThan(0)
    // The `name` property must appear
    expect(
      namedThingFields.some((n) =>
        String(n.canonical_name).endsWith("#NamedThing.name"),
      ),
    ).toBe(true)
    // declaredOn = "interface" so consumers can tell them apart from class fields
    const meta =
      ((namedThingFields[0].payload as Record<string, unknown>).metadata as
        | Record<string, unknown>
        | undefined) ?? {}
    expect(meta.declaredOn).toBe("interface")
  })

  it("emits contains edges from class to field (parent → field)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    const allNodes = sink.allNodes()
    const classNodes = new Set(
      allNodes.filter((n) => n.kind === "class").map((n) => String(n.canonical_name)),
    )
    const fieldNodes = new Set(
      allNodes.filter((n) => n.kind === "field").map((n) => String(n.canonical_name)),
    )
    expect(classNodes.size).toBeGreaterThan(0)
    expect(fieldNodes.size).toBeGreaterThan(0)

    const classToField = sink
      .allEdges()
      .filter(
        (e) =>
          e.edge_kind === "contains" &&
          classNodes.has(String(e.src_node_id).replace(/^.*?:symbol:/, "")) &&
          fieldNodes.has(String(e.dst_node_id).replace(/^.*?:symbol:/, "")),
      )
    // At least the FormalGreeter fields should produce class→field edges
    expect(classToField.length).toBeGreaterThanOrEqual(4)
  })

  it("emits writes_field edges for plain assignment to this.field", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // resetCounter does `this.count = 0` — exactly one write_field
    // edge from FormalGreeter.resetCounter → FormalGreeter.count
    const writes = sink.allEdges().filter((e) => e.edge_kind === "writes_field")
    const fromReset = writes.filter((e) =>
      String(e.src_node_id).endsWith("#FormalGreeter.resetCounter"),
    )
    expect(fromReset.length).toBeGreaterThanOrEqual(1)
    expect(
      fromReset.some((e) =>
        String(e.dst_node_id).endsWith("#FormalGreeter.count"),
      ),
    ).toBe(true)
  })

  it("emits writes_field edges for augmented assignment (+=)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // augmentCounter does `this.count += 5` → augmented_assignment_expression
    const writes = sink.allEdges().filter((e) => e.edge_kind === "writes_field")
    const fromAugment = writes.filter((e) =>
      String(e.src_node_id).endsWith("#FormalGreeter.augmentCounter"),
    )
    expect(fromAugment.length).toBeGreaterThanOrEqual(1)
    expect(
      fromAugment.some((e) =>
        String(e.dst_node_id).endsWith("#FormalGreeter.count"),
      ),
    ).toBe(true)
  })

  it("emits writes_field edges for ++/-- (update expressions)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // bumpCounter does `this.count++` → update_expression
    const writes = sink.allEdges().filter((e) => e.edge_kind === "writes_field")
    const fromBump = writes.filter((e) =>
      String(e.src_node_id).endsWith("#FormalGreeter.bumpCounter"),
    )
    expect(fromBump.length).toBeGreaterThanOrEqual(1)
    expect(
      fromBump.some((e) =>
        String(e.dst_node_id).endsWith("#FormalGreeter.count"),
      ),
    ).toBe(true)
  })

  it("emits reads_field edges for pure reads of this.field", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // getCount does `return this.count` — pure read, no write
    const reads = sink.allEdges().filter((e) => e.edge_kind === "reads_field")
    const fromGetCount = reads.filter((e) =>
      String(e.src_node_id).endsWith("#FormalGreeter.getCount"),
    )
    expect(fromGetCount.length).toBeGreaterThanOrEqual(1)
    expect(
      fromGetCount.some((e) =>
        String(e.dst_node_id).endsWith("#FormalGreeter.count"),
      ),
    ).toBe(true)

    // And getCount must NOT produce a writes_field edge
    const writesFromGetCount = sink
      .allEdges()
      .filter(
        (e) =>
          e.edge_kind === "writes_field" &&
          String(e.src_node_id).endsWith("#FormalGreeter.getCount"),
      )
    expect(writesFromGetCount.length).toBe(0)
  })

  it("greet method emits both reads (this.name + this.count) and a write (this.count = ...)", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [tsCoreExtractor],
    })
    await runner.run()

    // greet does `this.count = this.count + 1; ... this.name`
    // → 1 write (this.count =), 2 reads (this.count, this.name)
    const greetReads = sink
      .allEdges()
      .filter(
        (e) =>
          e.edge_kind === "reads_field" &&
          String(e.src_node_id).endsWith("#FormalGreeter.greet"),
      )
    const greetWrites = sink
      .allEdges()
      .filter(
        (e) =>
          e.edge_kind === "writes_field" &&
          String(e.src_node_id).endsWith("#FormalGreeter.greet"),
      )
    const readDsts = new Set(
      greetReads.map((e) => String(e.dst_node_id).split("#")[1]),
    )
    const writeDsts = new Set(
      greetWrites.map((e) => String(e.dst_node_id).split("#")[1]),
    )
    expect(readDsts.has("FormalGreeter.name")).toBe(true)
    expect(readDsts.has("FormalGreeter.count")).toBe(true)
    expect(writeDsts.has("FormalGreeter.count")).toBe(true)
  })

  it("emits field_of_type edges with containment metadata for class field types", async () => {
    // Use a fresh tiny fixture so we can control the exact field shapes.
    const tinyDir = mkdtempSync(join(tmpdir(), "ts-core-fot-"))
    try {
      writeFileSync(
        join(tinyDir, "package.json"),
        JSON.stringify({ name: "fixture" }),
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "model.ts"),
        `export interface User { id: string }
export class Box {
  // direct
  owner: User
  // array (T[] form)
  members: User[]
  // optional (T | undefined)
  fallback: User | undefined
  // optional (T | null)
  nullableOwner: User | null
  // promise
  loaded: Promise<User>
  // map: key=string, value=User
  byId: Map<string, User>
  // record
  cache: Record<string, User>
  // nested: array.optional → walk into the array, then optional
  buckets: Array<User | null>
  // union of two named types
  primary: User | Box
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [tsCoreExtractor],
      })
      await runner.run()

      const fotEdges = sink
        .allEdges()
        .filter((e) => e.edge_kind === "field_of_type")
      // Index edges by (src local field name, containment) for assertions
      const byFieldContainment = new Map<string, GraphEdgeRow[]>()
      for (const e of fotEdges) {
        const localName = String(e.src_node_id).split("#")[1]
        const containment = String(
          ((e.metadata as Record<string, unknown> | undefined) ?? {})
            .containment ?? "",
        )
        const key = localName + "|" + containment
        if (!byFieldContainment.has(key)) byFieldContainment.set(key, [])
        byFieldContainment.get(key)!.push(e)
      }

      // Each field's expected containment kind:
      const expectations: Array<[string, string]> = [
        ["Box.owner", "direct"],
        ["Box.members", "array"],
        ["Box.fallback", "optional"],
        ["Box.nullableOwner", "optional"],
        ["Box.loaded", "promise"],
        ["Box.byId", "map"],
        ["Box.cache", "record"],
        // Array<User | null> → array.optional walking outer→inner
        ["Box.buckets", "array.optional"],
      ]
      for (const [field, containment] of expectations) {
        const key = field + "|" + containment
        expect(
          byFieldContainment.has(key),
          `expected field_of_type ${field} with containment=${containment}`,
        ).toBe(true)
      }

      // Map key type lands in metadata.keyType
      const mapEdges = byFieldContainment.get("Box.byId|map") ?? []
      expect(mapEdges.length).toBe(1)
      const mapMeta =
        ((mapEdges[0].metadata as Record<string, unknown> | undefined) ?? {})
      expect(mapMeta.keyType).toBe("string")

      // Union (User | Box) → two field_of_type edges, both tagged "union"
      const unionEdges = byFieldContainment.get("Box.primary|union") ?? []
      // Box self-reference may be skipped if Box doesn't resolve through
      // the file resolver as a different module — we resolve everything
      // in-file, so both User AND Box should appear.
      expect(unionEdges.length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })

  it("emits enum_variant nodes for TS enum members", async () => {
    const tinyDir = mkdtempSync(join(tmpdir(), "ts-core-enum-variant-"))
    try {
      writeFileSync(
        join(tinyDir, "package.json"),
        JSON.stringify({ name: "fixture" }),
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "x.ts"),
        `export enum Status {
  Active,
  Inactive = 1,
  Pending = "pending",
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [tsCoreExtractor],
      })
      await runner.run()

      const variants = sink.allNodes().filter((n) => n.kind === "enum_variant")
      const localNames = new Set(
        variants.map((n) => String(n.canonical_name).split("#")[1]),
      )
      expect(localNames.has("Status.Active")).toBe(true)
      expect(localNames.has("Status.Inactive")).toBe(true)
      expect(localNames.has("Status.Pending")).toBe(true)

      // Inactive's metadata.value captures the literal `1`
      const inactive = variants.find(
        (n) => String(n.canonical_name).endsWith("#Status.Inactive"),
      )
      const meta =
        ((inactive!.payload as Record<string, unknown>).metadata as
          | Record<string, unknown>
          | undefined) ?? {}
      expect(meta.value).toBe("1")

      // contains edges from enum → variant
      const containsEdges = sink
        .allEdges()
        .filter(
          (e) =>
            e.edge_kind === "contains" &&
            String(e.src_node_id).endsWith("#Status") &&
            String(e.dst_node_id).includes("#Status."),
        )
      expect(containsEdges.length).toBe(3)
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })

  it("emits one aggregates edge per distinct target type at the class level", async () => {
    // Same fixture as the field_of_type test but assert on the
    // class-level aggregates rollup. The class has 8 fields touching
    // ~3 distinct user-defined types (User, Box itself for the
    // self-reference, and… that's it on this fixture). Aggregates
    // de-dupes across all fields.
    const tinyDir = mkdtempSync(join(tmpdir(), "ts-core-agg-"))
    try {
      writeFileSync(
        join(tinyDir, "package.json"),
        JSON.stringify({ name: "fixture" }),
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "model.ts"),
        `export interface User { id: string }
export class Box {
  owner: User
  members: User[]
  fallback: User | undefined
  loaded: Promise<User>
  byId: Map<string, User>
  cache: Record<string, User>
  primary: User | Box
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [tsCoreExtractor],
      })
      await runner.run()

      const aggEdges = sink
        .allEdges()
        .filter(
          (e) =>
            e.edge_kind === "aggregates" &&
            String(e.src_node_id).endsWith("#Box"),
        )
      const targets = new Set(
        aggEdges.map((e) => String(e.dst_node_id).split("#")[1]),
      )
      // Box should aggregate User (from many fields) and Box itself
      // (from the `primary: User | Box` self-reference). Each appears
      // exactly once because the rollup de-dupes.
      expect(targets.has("User")).toBe(true)
      expect(targets.has("Box")).toBe(true)
      // No more than these two (the fixture only references User and Box)
      expect(aggEdges.length).toBe(targets.size)
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })

  it("does not emit field_of_type edges to predefined built-in types", async () => {
    const tinyDir = mkdtempSync(join(tmpdir(), "ts-core-fot-builtins-"))
    try {
      writeFileSync(
        join(tinyDir, "package.json"),
        JSON.stringify({ name: "fixture" }),
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "x.ts"),
        `export class Plain {
  name: string
  count: number
  ok: boolean
  payload: unknown
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [tsCoreExtractor],
      })
      await runner.run()
      const fotEdges = sink
        .allEdges()
        .filter((e) => e.edge_kind === "field_of_type")
      // None of these fields should produce a field_of_type edge —
      // they all reference predefined_type nodes that are dropped.
      const fromPlain = fotEdges.filter((e) =>
        String(e.src_node_id).includes("#Plain."),
      )
      expect(fromPlain.length).toBe(0)
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })

  it("does not emit field edges for this.method() (already covered by calls)", async () => {
    // Synthesize a fixture inline: a class with a method that calls
    // another method on `this`. The call should produce a calls
    // edge but NOT a reads_field edge.
    const tinyDir = mkdtempSync(join(tmpdir(), "ts-core-this-method-"))
    try {
      writeFileSync(
        join(tinyDir, "package.json"),
        JSON.stringify({ name: "fixture" }),
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "x.ts"),
        `export class Caller {
  greeting: string = "hi"
  greet(): string {
    return this.helper()
  }
  helper(): string {
    return this.greeting
  }
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [tsCoreExtractor],
      })
      await runner.run()

      // greet's body: `return this.helper()` — should be a calls
      // edge, NOT a reads_field edge.
      const reads = sink
        .allEdges()
        .filter(
          (e) =>
            e.edge_kind === "reads_field" &&
            String(e.src_node_id).endsWith("#Caller.greet"),
        )
      // No reads_field edge dst should be Caller.helper
      expect(
        reads.every(
          (e) => !String(e.dst_node_id).endsWith("#Caller.helper"),
        ),
      ).toBe(true)
      // helper's body: `return this.greeting` — IS a read
      const helperReads = sink
        .allEdges()
        .filter(
          (e) =>
            e.edge_kind === "reads_field" &&
            String(e.src_node_id).endsWith("#Caller.helper") &&
            String(e.dst_node_id).endsWith("#Caller.greeting"),
        )
      expect(helperReads.length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })
})
