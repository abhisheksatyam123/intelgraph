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
    return greetUser(name).toUpperCase()
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

export function localNs() { return "ns" }

export function caller() {
  // Greeter.makeFormal() — Greeter is a named import → named-member
  Greeter.makeFormal()
  // localNs.helper() — localNs is a local declaration → local-member
  localNs.helper()
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
})
