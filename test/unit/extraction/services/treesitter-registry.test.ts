/**
 * treesitter-registry.test.ts — exercises the multi-language tree-sitter
 * registry against real grammar WASM files.
 *
 * The registry returns null on failure (missing WASM, init timeout)
 * rather than throwing, so each test case wraps the call in an
 * "if grammar is loadable" guard. The grammars used in CI are:
 *   - tree-sitter-c (already in deps)
 *   - tree-sitter-typescript (added for the ts-core plugin)
 *
 * If the grammars cannot load on the test host, the registry tests skip
 * via parser-availability checks rather than failing the suite.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  _resetForTests,
  findDescendant,
  inferLanguageFromExtension,
  parseSource,
  walkTree,
  type TsNode,
} from "../../../../src/intelligence/extraction/services/treesitter-registry.js"

beforeEach(() => {
  _resetForTests()
})

afterAll(() => {
  _resetForTests()
})

describe("treesitter-registry — language inference", () => {
  it("recognizes C extensions", () => {
    expect(inferLanguageFromExtension("/x.c")).toBe("c")
    expect(inferLanguageFromExtension("/x.h")).toBe("c")
  })

  it("recognizes TypeScript extensions", () => {
    expect(inferLanguageFromExtension("/x.ts")).toBe("typescript")
    expect(inferLanguageFromExtension("/x.mts")).toBe("typescript")
    expect(inferLanguageFromExtension("/x.cts")).toBe("typescript")
  })

  it("recognizes JavaScript as the typescript grammar", () => {
    // The TS grammar is a superset of JS for our purposes; we route
    // .js/.mjs/.cjs to "typescript" rather than maintaining a second
    // grammar.
    expect(inferLanguageFromExtension("/x.js")).toBe("typescript")
    expect(inferLanguageFromExtension("/x.mjs")).toBe("typescript")
    expect(inferLanguageFromExtension("/x.cjs")).toBe("typescript")
  })

  it("recognizes TSX/JSX as the tsx grammar", () => {
    expect(inferLanguageFromExtension("/x.tsx")).toBe("tsx")
    expect(inferLanguageFromExtension("/x.jsx")).toBe("tsx")
  })

  it("returns null for unsupported extensions", () => {
    expect(inferLanguageFromExtension("/x.py")).toBeNull()
    expect(inferLanguageFromExtension("/x.rs")).toBeNull()
    expect(inferLanguageFromExtension("/x")).toBeNull()
  })

  it("is case-insensitive on the extension", () => {
    expect(inferLanguageFromExtension("/X.TS")).toBe("typescript")
    expect(inferLanguageFromExtension("/X.TSX")).toBe("tsx")
  })
})

describe("treesitter-registry — parseSource (typescript)", () => {
  it("typescript grammar is actually loadable on this host", async () => {
    // Strict: if this fails, the soft skips below would silently mask
    // the rest of the test suite. Better to fail loudly here so we
    // know to install or fix tree-sitter-typescript.
    const tree = await parseSource("typescript", `const x = 1`)
    expect(tree).not.toBeNull()
    expect(tree?.rootNode.type).toBe("program")
  })

  it("parses a typescript source string and returns a tree", async () => {
    const tree = await parseSource(
      "typescript",
      `
        export function greet(name: string): string {
          return "hello " + name
        }
      `,
    )
    if (!tree) {
      // Grammar not loadable on this host — record as a soft skip.
      console.warn("[registry-test] tree-sitter-typescript not loadable; skipping")
      return
    }
    expect(tree.rootNode).toBeDefined()
    expect(tree.rootNode.type).toBe("program")
  })

  it("walkTree visits nested nodes", async () => {
    const tree = await parseSource(
      "typescript",
      `function foo() { bar(); }`,
    )
    if (!tree) return
    const types: string[] = []
    for (const node of walkTree(tree.rootNode)) {
      types.push(node.type)
    }
    expect(types).toContain("function_declaration")
    expect(types).toContain("call_expression")
  })

  it("findDescendant locates the first matching node", async () => {
    const tree = await parseSource(
      "typescript",
      `class Foo { bar(): number { return 1 } }`,
    )
    if (!tree) return
    const cls = findDescendant(
      tree.rootNode,
      (n) => n.type === "class_declaration",
    )
    expect(cls).not.toBeNull()
    if (cls) {
      const name = findDescendant(cls, (n) => n.type === "type_identifier")
      expect(name?.text).toBe("Foo")
    }
  })

  it("identifies imports", async () => {
    const tree = await parseSource(
      "typescript",
      `
        import { foo } from "./bar"
        import * as x from "node:fs"
      `,
    )
    if (!tree) return
    const imports: TsNode[] = []
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === "import_statement") imports.push(node)
    }
    expect(imports.length).toBe(2)
  })

  it("identifies exports", async () => {
    const tree = await parseSource(
      "typescript",
      `
        export function foo() {}
        export const bar = 1
        export class Baz {}
      `,
    )
    if (!tree) return
    const exports: TsNode[] = []
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === "export_statement") exports.push(node)
    }
    expect(exports.length).toBe(3)
  })
})

describe("treesitter-registry — parseSource (tsx)", () => {
  it("parses JSX/TSX source", async () => {
    const tree = await parseSource(
      "tsx",
      `
        import React from "react"
        export function App() {
          return <div className="foo">hello</div>
        }
      `,
    )
    if (!tree) return
    expect(tree.rootNode.type).toBe("program")
    let foundJsx = false
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === "jsx_element" || node.type === "jsx_self_closing_element") {
        foundJsx = true
        break
      }
    }
    expect(foundJsx).toBe(true)
  })
})

describe("treesitter-registry — parseSource (c)", () => {
  it("parses C source via the same registry", async () => {
    const tree = await parseSource(
      "c",
      `int main(void) { return 0; }`,
    )
    if (!tree) return
    expect(tree.rootNode.type).toBe("translation_unit")
    let foundFunc = false
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === "function_definition") {
        foundFunc = true
        break
      }
    }
    expect(foundFunc).toBe(true)
  })
})
