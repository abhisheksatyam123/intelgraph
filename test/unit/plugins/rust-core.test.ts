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

  it("emits field nodes for struct fields with kind=field", async () => {
    // Use a fresh fixture so we control the field shapes precisely.
    const tinyDir = mkdtempSync(join(tmpdir(), "rust-core-field-"))
    try {
      writeFileSync(
        join(tinyDir, "Cargo.toml"),
        `[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n`,
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "lib.rs"),
        `pub struct User {
    pub id: u64,
    pub name: String,
}
pub struct Box1 {
    // direct
    pub owner: User,
    // vec
    pub members: Vec<User>,
    // option
    pub fallback: Option<User>,
    // box
    pub boxed: Box<User>,
    // rc + arc
    pub shared: std::rc::Rc<User>,
    pub atomic: std::sync::Arc<User>,
    // map (key=u64, value=User)
    pub by_id: std::collections::HashMap<u64, User>,
    // set
    pub tags: std::collections::HashSet<User>,
    // ref
    pub borrowed: &'static User,
    // composed: Vec<Option<User>>
    pub buckets: Vec<Option<User>>,
    // recursive
    pub next: Option<Box<Box1>>,
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [rustCoreExtractor],
      })
      await runner.run()

      // Field nodes
      const fields = sink.allNodes().filter((n) => n.kind === "field")
      const fieldNames = new Set(
        fields.map((n) => String(n.canonical_name).split("#")[1]),
      )
      const expected = [
        "Box1.owner",
        "Box1.members",
        "Box1.fallback",
        "Box1.boxed",
        "Box1.shared",
        "Box1.atomic",
        "Box1.by_id",
        "Box1.tags",
        "Box1.borrowed",
        "Box1.buckets",
        "Box1.next",
      ]
      for (const name of expected) {
        expect(fieldNames.has(name)).toBe(true)
      }

      // contains edges from struct → field
      const containsToField = sink
        .allEdges()
        .filter(
          (e) =>
            e.edge_kind === "contains" &&
            String(e.src_node_id).endsWith("#Box1") &&
            String(e.dst_node_id).includes("#Box1."),
        )
      expect(containsToField.length).toBe(expected.length)
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })

  it("emits field_of_type edges with rust-specific containment vocabulary", async () => {
    const tinyDir = mkdtempSync(join(tmpdir(), "rust-core-fot-"))
    try {
      writeFileSync(
        join(tinyDir, "Cargo.toml"),
        `[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n`,
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "lib.rs"),
        `pub struct User { pub id: u64 }
pub struct Box1 {
    pub owner: User,
    pub members: Vec<User>,
    pub fallback: Option<User>,
    pub boxed: Box<User>,
    pub by_id: std::collections::HashMap<u64, User>,
    pub borrowed: &'static User,
    pub buckets: Vec<Option<User>>,
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [rustCoreExtractor],
      })
      await runner.run()

      const fotEdges = sink
        .allEdges()
        .filter((e) => e.edge_kind === "field_of_type")

      // Index by (field local name, containment)
      const byKey = new Map<string, GraphEdgeRow[]>()
      for (const e of fotEdges) {
        const localName = String(e.src_node_id).split("#")[1]
        const containment = String(
          ((e.metadata as Record<string, unknown> | undefined) ?? {})
            .containment ?? "",
        )
        const key = localName + "|" + containment
        if (!byKey.has(key)) byKey.set(key, [])
        byKey.get(key)!.push(e)
      }

      const expectations: Array<[string, string]> = [
        ["Box1.owner", "direct"],
        ["Box1.members", "vec"],
        ["Box1.fallback", "option"],
        ["Box1.boxed", "box"],
        ["Box1.by_id", "map"],
        ["Box1.borrowed", "ref"],
        ["Box1.buckets", "vec.option"],
      ]
      for (const [field, containment] of expectations) {
        expect(
          byKey.has(field + "|" + containment),
          `expected field_of_type ${field} containment=${containment}`,
        ).toBe(true)
      }

      // HashMap key type lands in metadata.keyType
      const mapEdges = byKey.get("Box1.by_id|map") ?? []
      expect(mapEdges.length).toBe(1)
      const mapMeta =
        ((mapEdges[0].metadata as Record<string, unknown> | undefined) ?? {})
      // The key may be "u64" (primitive) — we still record it as text
      expect(mapMeta.keyType).toBe("u64")
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })

  it("does not emit field_of_type edges for primitive-only fields", async () => {
    const tinyDir = mkdtempSync(join(tmpdir(), "rust-core-prim-"))
    try {
      writeFileSync(
        join(tinyDir, "Cargo.toml"),
        `[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n`,
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "lib.rs"),
        `pub struct Plain {
    pub n: u64,
    pub flag: bool,
    pub name: String,
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [rustCoreExtractor],
      })
      await runner.run()

      const fotEdges = sink
        .allEdges()
        .filter(
          (e) =>
            e.edge_kind === "field_of_type" &&
            String(e.src_node_id).includes("#Plain."),
        )
      // u64 / bool are primitive_type → skipped. String is a
      // type_identifier but doesn't resolve through the resolver
      // (it's not a workspace symbol), so it's also dropped.
      expect(fotEdges.length).toBe(0)
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })

  it("emits aggregates rollup edges for struct with multiple field types", async () => {
    const tinyDir = mkdtempSync(join(tmpdir(), "rust-core-agg-"))
    try {
      writeFileSync(
        join(tinyDir, "Cargo.toml"),
        `[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n`,
      )
      mkdirSync(join(tinyDir, "src"), { recursive: true })
      writeFileSync(
        join(tinyDir, "src", "lib.rs"),
        `pub struct User { pub id: u64 }
pub struct Box1 {
    pub a: User,
    pub b: Vec<User>,
    pub c: Option<User>,
    pub d: Option<Box<Box1>>,
}
`,
      )
      const sink = new CaptureSink()
      const runner = new ExtractorRunner({
        snapshotId: 1,
        workspaceRoot: tinyDir,
        lsp: stubLsp,
        sink,
        plugins: [rustCoreExtractor],
      })
      await runner.run()

      const aggEdges = sink
        .allEdges()
        .filter(
          (e) =>
            e.edge_kind === "aggregates" &&
            String(e.src_node_id).endsWith("#Box1"),
        )
      const targets = new Set(
        aggEdges.map((e) => String(e.dst_node_id).split("#")[1]),
      )
      // Box1 should aggregate User (from a, b, c) and Box1 (self-ref via d)
      expect(targets.has("User")).toBe(true)
      expect(targets.has("Box1")).toBe(true)
      // Each appears exactly once because the rollup de-dupes
      expect(aggEdges.length).toBe(targets.size)
    } finally {
      rmSync(tinyDir, { recursive: true, force: true })
    }
  })
})
