import { describe, it, expect } from "vitest"
import { TOOLS, formatIncomingCalls } from "../../src/tools/index.js"

describe("indirect callers tool wiring", () => {
  it("registers lsp_indirect_callers alongside direct call hierarchy tools", () => {
    const names = TOOLS.map((tool) => tool.name)

    expect(names).toContain("lsp_indirect_callers")
    expect(names.indexOf("lsp_indirect_callers")).toBeGreaterThan(names.indexOf("lsp_incoming_calls"))
  })

  it("formats empty indirect caller results deterministically", () => {
    expect(formatIncomingCalls([], "/workspace")).toBe("No incoming calls.")
  })

  it("keeps the indirect callers tool schema deterministic", () => {
    const tool = TOOLS.find((entry) => entry.name === "lsp_indirect_callers")

    expect(tool).toBeDefined()
    expect(tool?.description).toMatch(/direct callers.*registration/i)
  })
})
