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
    return this.prefix + " " + greetUser(name)
  }
}

export interface NamedThing {
  name: string
}
`,
  )

  // module-b: declares the function imported by module-a
  writeFileSync(
    join(tempRoot, "src", "module-b.ts"),
    `
export function greetUser(name: string): string {
  return "Hello, " + name
}

export type Greeting = string

export class FormalGreeter extends Greeter implements NamedThing {
  name = "formal"
  greet(name: string) {
    return greetUser(name).toUpperCase()
  }
}
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
`,
  )

  // tsx file with JSX
  writeFileSync(
    join(tempRoot, "src", "ui.tsx"),
    `
import React from "react"
import { entry } from "./module-a"

export function App() {
  return <div>{entry("world")}</div>
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

  it("emits extends edges for class inheritance", async () => {
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
    // FormalGreeter extends Greeter
    const formal = extendsEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("#FormalGreeter") &&
        String(e.dst_node_id).endsWith(":Greeter"),
    )
    expect(formal).toBeDefined()
  })

  it("emits implements edges for interface implementation", async () => {
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
    const formal = implementsEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("#FormalGreeter") &&
        String(e.dst_node_id).endsWith(":NamedThing"),
    )
    expect(formal).toBeDefined()
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
