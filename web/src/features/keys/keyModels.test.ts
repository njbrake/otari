import { describe, expect, it } from "vitest"

import { entryReaches, summarizeKeyModels } from "./keyModels"

const CATALOG = [
  "anthropic:claude-sonnet-5",
  "anthropic:claude-haiku-5",
  "fireworks:kimi-k3",
  "fireworks:qwen3-coder",
  "fireworks:deepseek-v4",
  "openai:gpt-5",
]

describe("entryReaches", () => {
  it("reads a wildcard, a prefix and an exact entry the way the gateway does", () => {
    expect(entryReaches("anthropic:*", "anthropic:claude-haiku-5")).toBe(true)
    expect(entryReaches("fireworks:qwen*", "fireworks:qwen3-coder")).toBe(true)
    expect(entryReaches("fireworks:qwen*", "fireworks:kimi-k3")).toBe(false)
    expect(entryReaches("openai:gpt-5", "openai:gpt-5")).toBe(true)
    expect(entryReaches("openai:gpt-5", "anthropic:gpt-5")).toBe(false)
  })
})

describe("summarizeKeyModels", () => {
  it("says a key with no list inherits and one with an empty list reaches nothing", () => {
    expect(summarizeKeyModels(undefined, CATALOG)).toEqual({ kind: "all" })
    expect(summarizeKeyModels([], CATALOG)).toEqual({ kind: "none" })
  })

  it("names the providers in list order and counts what each reaches", () => {
    const summary = summarizeKeyModels(
      ["fireworks:qwen*", "anthropic:*", "fireworks:kimi-k3"],
      CATALOG,
    )
    expect(summary).toEqual({
      kind: "selected",
      providers: ["fireworks", "anthropic"],
      counts: new Map([
        ["fireworks", 2],
        ["anthropic", 2],
      ]),
      total: 4,
    })
  })

  it("gives no count until the catalog has loaded", () => {
    expect(summarizeKeyModels(["openai:*"], undefined)).toEqual({
      kind: "selected",
      providers: ["openai"],
      counts: new Map(),
      total: undefined,
    })
  })
})
