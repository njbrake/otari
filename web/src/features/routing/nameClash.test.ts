import { describe, expect, it } from "vitest"

import { nameClash } from "./nameClash"
import type { RoutingRow } from "./policyModel"

const SAM = "33333333-3333-3333-3333-333333333333"

function row(overrides: Partial<RoutingRow>): RoutingRow {
  return {
    name: "fast",
    spec: { select: [{ default: "openai:gpt-5" }] },
    source: "stored",
    user_id: null,
    workspace_id: "w",
    is_dynamic: false,
    created_at: null,
    updated_at: null,
    kind: "policy",
    ...overrides,
  } as RoutingRow
}

const WORKSPACE = { kind: "workspace" } as const
const SAM_SCOPE = { kind: "person", userId: SAM, isCaller: true } as const

describe("nameClash", () => {
  it("refuses an alias's name for anyone", () => {
    const rows = [row({ name: "legacy", kind: "alias" })]
    expect(nameClash("legacy", rows, WORKSPACE)).toBe(
      "legacy is an alias. Pick another name.",
    )
    expect(nameClash("legacy", rows, SAM_SCOPE)).toMatch(/is an alias/)
  })

  it("refuses a deployment or workspace policy's name for the workspace", () => {
    expect(
      nameClash("kimi", [row({ name: "kimi", source: "config" })], WORKSPACE),
    ).toMatch(/A deployment policy is already called "kimi"/)
    expect(nameClash("fast", [row({})], WORKSPACE)).toMatch(
      /This workspace already has a policy called "fast"/,
    )
  })

  it("lets a person take a shared name, which is how their version replaces it", () => {
    expect(nameClash("fast", [row({})], SAM_SCOPE)).toBe("")
    expect(
      nameClash("kimi", [row({ name: "kimi", source: "config" })], SAM_SCOPE),
    ).toBe("")
  })

  it("refuses a name the person already has a policy of", () => {
    expect(nameClash("fast", [row({ user_id: SAM })], SAM_SCOPE)).toMatch(
      /You already have a policy called "fast"/,
    )
    // Someone else's own policy is no clash.
    expect(nameClash("fast", [row({ user_id: "other" })], SAM_SCOPE)).toBe("")
  })

  it("keeps the page's own address free, and says nothing about a blank name", () => {
    expect(nameClash("new", [], WORKSPACE)).toMatch(/reserved/)
    expect(nameClash("  ", [row({})], WORKSPACE)).toBe("")
  })
})
