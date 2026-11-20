import { describe, expect, it } from "vitest"
import type { UsageGroupRow, UsageSummary } from "@/client"
import {
  personCutOf,
  splitRows,
  splitTotals,
} from "@/features/people/personBreakdown"
import { apiKey, usageTotals } from "@/tests/fixtures"

const row = (overrides: Partial<UsageGroupRow>): UsageGroupRow => ({
  key: null,
  cost: 0,
  tokens: 0,
  requests: 0,
  is_other: false,
  ...overrides,
})

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    start_date: "2026-11-01T00:00:00Z",
    end_date: "2026-11-20T00:00:00Z",
    bucket: "day",
    totals: usageTotals(),
    by_model: [],
    by_user: [],
    by_api_key: [],
    by_source: [],
    by_source_label: [],
    by_endpoint: [],
    by_provider: [],
    by_tool: [],
    by_tag: [],
    errors_by_status_code: [],
    series: [],
    ...overrides,
  }
}

describe("splitTotals", () => {
  it("puts budgeted and exempt spend side by side, with their sum", () => {
    expect(
      splitTotals(
        usageTotals({ cost: 12.5, request_count: 40 }),
        usageTotals({ cost: 30.25, request_count: 10 }),
      ),
    ).toEqual({
      budgeted: 12.5,
      exempt: 30.25,
      total: 42.75,
      requests: 50,
      exemptRequests: 10,
    })
  })

  it("is unknown until both halves are read", () => {
    expect(splitTotals(usageTotals(), undefined)).toBeUndefined()
    expect(splitTotals(undefined, usageTotals())).toBeUndefined()
  })
})

describe("splitRows", () => {
  it("joins a value's budgeted and exempt rows and sorts by their total", () => {
    const rows = splitRows(
      "providers",
      summary({
        by_provider: [
          row({ key: "openai", cost: 5, tokens: 100, requests: 2 }),
          row({ key: "anthropic", cost: 1, tokens: 50, requests: 1 }),
        ],
      }),
      summary({
        by_provider: [
          row({ key: "anthropic", cost: 9, tokens: 900, requests: 4 }),
        ],
      }),
      [],
    )
    expect(
      rows.map(({ id, budgeted, exempt, requests, tokens, filterValues }) => ({
        id,
        budgeted,
        exempt,
        requests,
        tokens,
        filterValues,
      })),
    ).toEqual([
      {
        id: "providers:anthropic",
        budgeted: 1,
        exempt: 9,
        requests: 5,
        tokens: 950,
        filterValues: ["anthropic"],
      },
      {
        id: "providers:openai",
        budgeted: 5,
        exempt: 0,
        requests: 2,
        tokens: 100,
        filterValues: ["openai"],
      },
    ])
  })

  it("counts a model's every id as one, and filters on all of them", () => {
    const [model] = splitRows(
      "models",
      summary({
        by_model: [
          row({
            key: "accounts/fireworks/models/glm-5p3",
            label: "GLM 5.3",
            model_group: "glm53",
            cost: 2,
            requests: 1,
          }),
        ],
      }),
      summary({
        by_model: [
          row({
            key: "zai-org/GLM-5.3",
            label: "GLM 5.3",
            model_group: "glm53",
            cost: 3,
            requests: 1,
          }),
        ],
      }),
      [],
    )
    expect(model).toMatchObject({
      name: "GLM 5.3",
      budgeted: 2,
      exempt: 3,
      filterValues: ["accounts/fireworks/models/glm-5p3", "zai-org/GLM-5.3"],
    })
  })

  it("names keys from the key list and marks the budget-exempt ones", () => {
    const keys = [
      apiKey({
        id: "k-sub",
        key_name: "claude-sub",
        exclude_from_budget: true,
      }),
      apiKey({ id: "k-ci", key_name: "ci-bot" }),
    ]
    const rows = splitRows(
      "keys",
      summary({
        by_api_key: [
          row({ key: "k-ci", cost: 4, requests: 3 }),
          row({ key: "k-gone", label: "old-key", cost: 1, requests: 1 }),
          row({ key: null, cost: 0.5, requests: 1 }),
        ],
      }),
      summary({ by_api_key: [row({ key: "k-sub", cost: 20, requests: 9 })] }),
      keys,
    )
    expect(
      rows.map(({ name, isExemptKey, filterValues }) => ({
        name,
        isExemptKey,
        filterValues,
      })),
    ).toEqual([
      { name: "claude-sub", isExemptKey: true, filterValues: ["k-sub"] },
      { name: "ci-bot", isExemptKey: false, filterValues: ["k-ci"] },
      { name: "old-key", isExemptKey: false, filterValues: ["k-gone"] },
      // Spend with no key has nothing to filter on, so it opens nothing.
      { name: "No key", isExemptKey: false, filterValues: [] },
    ])
  })

  it("keeps the fold last and leaves out values with nothing on them", () => {
    const rows = splitRows(
      "sources",
      summary({
        by_source: [
          row({ key: null, is_other: true, cost: 50, requests: 20 }),
          row({ key: "gateway", cost: 1, requests: 1 }),
          row({ key: "codex", cost: 0, requests: 0 }),
        ],
      }),
      summary({
        by_source: [row({ key: "claude_code", cost: 2, requests: 1 })],
      }),
      [],
    )
    expect(rows.map((one) => one.name)).toEqual([
      "Claude Code",
      "Gateway",
      "Other",
    ])
    expect(rows.at(-1)?.filterValues).toEqual([])
  })

  it("has no rows before either summary is read", () => {
    expect(splitRows("models", undefined, undefined, [])).toEqual([])
  })
})

describe("personCutOf", () => {
  it("reads a cut the URL names and opens on models otherwise", () => {
    expect(personCutOf("keys").dimension).toBe("api_key")
    expect(personCutOf("nonsense").value).toBe("models")
  })
})
