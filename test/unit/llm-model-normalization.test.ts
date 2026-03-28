import { describe, expect, it } from "vitest"
import { normalizeModelIdForOpenAICompatible } from "../../src/tools/reason-engine/llm-advisor.js"

describe("LLM model id normalization", () => {
  it("strips provider prefix for OpenCode-style model ids", () => {
    expect(normalizeModelIdForOpenAICompatible("qpilot/anthropic::claude-4-6-sonnet")).toBe(
      "anthropic::claude-4-6-sonnet",
    )
  })

  it("keeps already provider-scoped ids unchanged", () => {
    expect(normalizeModelIdForOpenAICompatible("anthropic::claude-4-6-sonnet")).toBe(
      "anthropic::claude-4-6-sonnet",
    )
  })

  it("handles alternate provider prefixes", () => {
    expect(normalizeModelIdForOpenAICompatible("qgenie/azure::gpt-5.3-codex")).toBe(
      "azure::gpt-5.3-codex",
    )
  })
})
