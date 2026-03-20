import { readFileSync } from "fs"
import { describe, it, expect } from "vitest"

describe("full-suite e2e coverage source", () => {
  const filePath = new URL("../e2e/full-suite.test.mjs", import.meta.url)
  const source = readFileSync(filePath, "utf8")

  it("expects the indirect callers tool to be registered", () => {
    expect(source).toContain('"lsp_indirect_callers"')
  })

  it("contains focused indirect caller assertions", () => {
    expect(source).toContain('lsp_indirect_callers — returns stable call-shape output')
    expect(source).toContain('registration line metadata')
    expect(source).toContain('indirect relationship markers')
  })
})
