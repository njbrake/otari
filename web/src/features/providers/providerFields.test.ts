import { describe, expect, it } from "vitest"
import { supportsSessionAffinity } from "./providerFields"

describe("supportsSessionAffinity", () => {
  it("accepts openai and anthropic instances, including the -compatible forms", () => {
    expect(supportsSessionAffinity("openai", null)).toBe(true)
    expect(supportsSessionAffinity("anthropic", undefined)).toBe(true)
    expect(supportsSessionAffinity("baseten", "openai-compatible")).toBe(true)
    expect(supportsSessionAffinity("baseten", "openai_compatible")).toBe(true)
    expect(supportsSessionAffinity("lab", "anthropic-compatible")).toBe(true)
  })

  it("lets a provider type override what the instance name suggests", () => {
    expect(supportsSessionAffinity("openai", "gemini")).toBe(false)
  })

  it("refuses everything else, including names that are not providers", () => {
    expect(supportsSessionAffinity("gemini", null)).toBe(false)
    expect(supportsSessionAffinity("baseten", "bedrock")).toBe(false)
    expect(supportsSessionAffinity("constructor", null)).toBe(false)
    expect(supportsSessionAffinity("", null)).toBe(false)
  })
})
