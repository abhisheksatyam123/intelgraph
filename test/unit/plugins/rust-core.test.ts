/**
 * rust-core.test.ts — exercises the Rust extractor plugin against
 * a small fixture workspace constructed in a temporary directory.
 *
 * Plugin is run end-to-end through ExtractorRunner, mirroring the
 * ts-core test harness.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExtractorRunner } from "../../../src/intelligence/extraction/runner.js"
import { rustCoreExtractor } from "../../../src/plugins/index.js"
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
  tempRoot = mkdtempSync(join(tmpdir(), "rust-core-test-"))
  // appliesTo wants Cargo.toml
  writeFileSync(
    join(tempRoot, "Cargo.toml"),
    `[package]
name = "fixture"
version = "0.1.0"
edition = "2021"
`,
  )
  mkdirSync(join(tempRoot, "src"), { recursive: true })

  writeFileSync(
    join(tempRoot, "src", "lib.rs"),
    `use crate::greeter::Greeter;
use std::collections::HashMap;

pub fn greet_default(name: &str) -> String {
    let g = Greeter::new("hello".to_string());
    g.greet(name)
}

pub type GreeterMap = HashMap<String, Greeter>;
`,
  )

  writeFileSync(
    join(tempRoot, "src", "greeter.rs"),
    `use crate::traits::Sayable;

pub struct Greeter {
    prefix: String,
}

impl Greeter {
    pub fn new(prefix: String) -> Self {
        Self { prefix }
    }

    pub fn greet(&self, name: &str) -> String {
        format!("{} {}", self.prefix, name)
    }
}

impl Sayable for Greeter {
    fn say(&self) -> String {
        self.greet("world")
    }
}

pub enum Status {
    Active,
    Inactive(u32),
}
`,
  )

  writeFileSync(
    join(tempRoot, "src", "traits.rs"),
    `pub trait Sayable {
    fn say(&self) -> String;
}

pub trait Identifiable {
    fn id(&self) -> u32;
}
`,
  )
})

afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})

describe("rust-core plugin — appliesTo", () => {
  it("matches workspaces with Cargo.toml", () => {
    expect(
      rustCoreExtractor.metadata.appliesTo?.({
        workspaceRoot: tempRoot,
        hasCompileCommands: false,
      }),
    ).toBe(true)
  })

  it("does not match workspaces without rust markers", () => {
    expect(
      rustCoreExtractor.metadata.appliesTo?.({
        workspaceRoot: "/tmp/not-a-real-rust-project-xyz",
        hasCompileCommands: false,
      }),
    ).toBe(false)
  })
})

describe("rust-core plugin — extraction", () => {
  it("emits a module symbol per .rs file", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const modules = sink.allNodes().filter((n) => n.kind === "module")
    const names = new Set(modules.map((n) => n.canonical_name))
    expect(names.size).toBeGreaterThanOrEqual(3)
    expect([...names].some((n) => n.endsWith("src/lib.rs"))).toBe(true)
    expect([...names].some((n) => n.endsWith("src/greeter.rs"))).toBe(true)
    expect([...names].some((n) => n.endsWith("src/traits.rs"))).toBe(true)
  })

  it("emits struct symbols with the correct kind", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const structs = sink.allNodes().filter((n) => n.kind === "struct")
    const names = new Set(
      structs.map((n) => String(n.canonical_name).split("#")[1]),
    )
    expect(names.has("Greeter")).toBe(true)
  })

  it("emits trait symbols as kind=interface", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const traits = sink.allNodes().filter((n) => n.kind === "interface")
    const names = new Set(
      traits.map((n) => String(n.canonical_name).split("#")[1]),
    )
    expect(names.has("Sayable")).toBe(true)
    expect(names.has("Identifiable")).toBe(true)
  })

  it("emits enum symbols", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const enums = sink.allNodes().filter((n) => n.kind === "enum")
    const names = new Set(
      enums.map((n) => String(n.canonical_name).split("#")[1]),
    )
    expect(names.has("Status")).toBe(true)
  })

  it("emits methods qualified as Type.method inside impl blocks", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const methods = sink.allNodes().filter((n) => n.kind === "method")
    const localNames = new Set(
      methods.map((n) => String(n.canonical_name).split("#")[1]),
    )
    expect(localNames.has("Greeter.new")).toBe(true)
    expect(localNames.has("Greeter.greet")).toBe(true)
    expect(localNames.has("Greeter.say")).toBe(true)
  })

  it("emits contains edges anchored at the impl type for methods", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const containsEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "contains")
    const greeterContainsGreet = containsEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("#Greeter") &&
        String(e.dst_node_id).endsWith("#Greeter.greet"),
    )
    expect(greeterContainsGreet).toBeDefined()
  })

  it("emits imports edges from use declarations", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const importEdges = sink.allEdges().filter((e) => e.edge_kind === "imports")
    expect(importEdges.length).toBeGreaterThan(0)

    // lib.rs has `use crate::greeter::Greeter` and `use std::collections::HashMap`
    const fromLib = importEdges.filter((e) =>
      String(e.src_node_id).includes("src/lib.rs"),
    )
    const dsts = new Set(fromLib.map((e) => String(e.dst_node_id)))
    expect(
      [...dsts].some((d) => d.includes("crate::greeter") && d.endsWith("#Greeter")),
    ).toBe(true)
    expect(
      [...dsts].some((d) => d.includes("std::collections") && d.endsWith("#HashMap")),
    ).toBe(true)
  })

  it("emits implements edges for trait implementations", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const implementsEdges = sink
      .allEdges()
      .filter((e) => e.edge_kind === "implements")
    // Greeter implements Sayable
    const greeterSayable = implementsEdges.find(
      (e) =>
        String(e.src_node_id).endsWith("greeter.rs#Greeter") &&
        String(e.dst_node_id).includes("Sayable"),
    )
    expect(greeterSayable).toBeDefined()
  })

  it("emits call edges from caller function to callee", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const callEdges = sink.allEdges().filter((e) => e.edge_kind === "calls")
    // greet_default calls Greeter::new(...)
    const fromGreetDefault = callEdges.filter((e) =>
      String(e.src_node_id).endsWith("lib.rs#greet_default"),
    )
    expect(fromGreetDefault.length).toBeGreaterThan(0)
  })

  it("tracks pub visibility as exported flag", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()

    const greeter = sink
      .allNodes()
      .find(
        (n) =>
          n.kind === "struct" &&
          String(n.canonical_name).endsWith("greeter.rs#Greeter"),
      )
    const meta =
      ((greeter?.payload as Record<string, unknown> | undefined)
        ?.metadata as Record<string, unknown> | undefined) ?? {}
    expect(meta.exported).toBe(true)
  })

  it("auto-tags every emitted fact with producedBy=rust-core", async () => {
    const sink = new CaptureSink()
    const runner = new ExtractorRunner({
      snapshotId: 1,
      workspaceRoot: tempRoot,
      lsp: stubLsp,
      sink,
      plugins: [rustCoreExtractor],
    })
    await runner.run()
    const node = sink.allNodes()[0]
    const provenance = (node.payload as Record<string, unknown>)._provenance as
      | { producedBy?: string[] }
      | undefined
    expect(provenance?.producedBy).toContain("rust-core")
  })
})
