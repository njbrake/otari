import { describe, expect, it } from "vitest"
import type { UsageLogGroup } from "@/client"
import {
  describeGroup,
  describeGroupSpan,
  describeTopModels,
  groupFilters,
  groupOptions,
  readGroupBy,
  showGroupSearch,
} from "./requestGroups"

const group = (overrides: Partial<UsageLogGroup> = {}): UsageLogGroup => ({
  key: "k1",
  label: null,
  requests: 12,
  errors: 1,
  cost: 0.5,
  tokens: 1200,
  latency_ms: 800,
  first_at: "2026-11-20T10:00:00Z",
  last_at: "2026-11-20T11:00:00Z",
  top_models: [],
  model_count: 0,
  ...overrides,
})

describe("readGroupBy", () => {
  it("reads the groupings it knows and nothing else", () => {
    expect(readGroupBy("api_key")).toBe("api_key")
    expect(readGroupBy("source_label")).toBe("source_label")
    expect(readGroupBy("")).toBeUndefined()
    expect(readGroupBy("status")).toBeUndefined()
  })
})

describe("groupOptions", () => {
  it("leads with no grouping and offers a person only where the list spans several", () => {
    expect(groupOptions(true).map((option) => option.value)).toEqual([
      "",
      "api_key",
      "source_label",
      "model",
      "user",
    ])
    expect(groupOptions(false).map((option) => option.value)).not.toContain(
      "user",
    )
  })
})

describe("groupFilters", () => {
  it("narrows the filters to one group's value", () => {
    expect(groupFilters({ status: "error" }, "api_key", "k1")).toEqual({
      status: "error",
      api_key_id: ["k1"],
    })
    expect(groupFilters({}, "source_label", "s1")).toEqual({
      source_label: "s1",
    })
    expect(groupFilters({}, "user", "ada")).toEqual({ user_id: ["ada"] })
    expect(groupFilters({}, "model", "gpt-4o")).toEqual({ model: ["gpt-4o"] })
  })

  it("finds the rows with no value by that column being empty", () => {
    expect(groupFilters({ is_null: ["user"] }, "api_key", null)).toEqual({
      is_null: ["user", "api_key"],
    })
    expect(groupFilters({}, "source_label", null)).toEqual({
      is_null: ["session"],
    })
  })
})

describe("showGroupSearch", () => {
  it("writes the funnel's key, turns the grouping off and starts over", () => {
    expect(
      showGroupSearch(
        { group: "api_key", page: "3", request: "r1", range: "7d" },
        "api_key",
        "k1",
      ),
    ).toEqual({ range: "7d", api_key_id: ["k1"] })
    expect(
      showGroupSearch({ group: "user", exclude_user_id: "ada" }, "user", "ada"),
    ).toEqual({ user_id: ["ada"] })
    expect(
      showGroupSearch({ group: "source_label" }, "source_label", "s1"),
    ).toEqual({ source_label: "s1" })
  })

  it("narrows a filter of several values to the group's own", () => {
    expect(
      showGroupSearch(
        { group: "api_key", api_key_id: ["k1", "k2"] },
        "api_key",
        "k1",
      ),
    ).toEqual({ api_key_id: ["k1"] })
    expect(
      showGroupSearch(
        { group: "model", model: ["gpt-4o", "claude"] },
        "model",
        "claude",
      ),
    ).toEqual({ model: ["claude"] })
  })

  it("filters to the empty column for the group with no value", () => {
    expect(showGroupSearch({ group: "api_key" }, "api_key", null)).toEqual({
      is_null: ["api_key"],
    })
    expect(
      showGroupSearch({ group: "source_label" }, "source_label", null),
    ).toEqual({ is_null: ["session"] })
  })
})

describe("describeGroup", () => {
  const roster = new Map([["ada", "Ada Lovelace"]])

  it("names a group by what its column holds", () => {
    expect(
      describeGroup("api_key", group({ label: "laptop" }), roster),
    ).toEqual({ title: "laptop", isMono: false })
    expect(describeGroup("api_key", group({ key: null }), roster).title).toBe(
      "No API key",
    )
    expect(describeGroup("source_label", group({ key: "s1" }), roster)).toEqual(
      { title: "s1", isMono: true },
    )
    expect(
      describeGroup("user", group({ key: "ada", label: "ada-alias" }), roster)
        .title,
    ).toBe("Ada Lovelace")
    expect(describeGroup("model", group({ key: "gpt-4o" }), roster)).toEqual({
      title: "gpt-4o",
      isMono: true,
    })
  })
})

describe("describeTopModels", () => {
  it("names two and counts every other model the group ran on", () => {
    const top_models = ["a", "b", "c"].map((model) => ({ model, requests: 1 }))
    expect(describeTopModels({ top_models, model_count: 3 })).toBe("a, b +1")
    // The read names three; a group that ran on seven counts the other five.
    expect(describeTopModels({ top_models, model_count: 7 })).toBe("a, b +5")
    expect(
      describeTopModels({ top_models: top_models.slice(0, 1), model_count: 1 }),
    ).toBe("a")
    expect(describeTopModels({ top_models: [], model_count: 0 })).toBe("")
  })
})

describe("describeGroupSpan", () => {
  it("gives the day only once the span leaves today", () => {
    const now = new Date("2026-11-20T12:00:00")
    const today = describeGroupSpan(
      "2026-11-20T09:00:00",
      "2026-11-20T10:30:00",
      now,
    )
    expect(today).toContain("–")
    expect(today).not.toMatch(/Nov/)
    expect(
      describeGroupSpan("2026-11-18T09:00:00", "2026-11-20T10:30:00", now),
    ).toMatch(/Nov 18.*–.*Nov 20/)
    expect(
      describeGroupSpan("2026-11-20T09:00:00", "2026-11-20T09:00:00", now),
    ).not.toContain("–")
  })
})
