import { describe, expect, it } from "vitest"
import { computeBackoffDelayMs, isTransientLlmError } from "../../src/tools/reason-engine/llm-advisor.js"

describe("llm advisor backoff helpers", () => {
  it("classifies common transient provider/network errors", () => {
    expect(isTransientLlmError("Rate limit exceeded for model")).toBe(true)
    expect(isTransientLlmError("HTTP 429 Too Many Requests")).toBe(true)
    expect(isTransientLlmError("ETIMEDOUT while connecting")).toBe(true)
    expect(isTransientLlmError("ECONNRESET by peer")).toBe(true)
    expect(isTransientLlmError("Model not available for this client")).toBe(false)
  })

  it("computes bounded exponential backoff", () => {
    expect(computeBackoffDelayMs(1, 500, 4000)).toBe(500)
    expect(computeBackoffDelayMs(2, 500, 4000)).toBe(1000)
    expect(computeBackoffDelayMs(3, 500, 4000)).toBe(2000)
    expect(computeBackoffDelayMs(4, 500, 4000)).toBe(4000)
    expect(computeBackoffDelayMs(5, 500, 4000)).toBe(4000)
  })
})
