import { describe, expect, it } from "vitest"

import { group, urlOf } from "@/tests/activity"
import { valueFilterModel } from "./activityFilters"

const names = {
  totals: undefined,
  memberName: (userId: string | null) => `member ${userId}`,
}

describe("valueFilterModel", () => {
  it("reads a column's picks and exclusions off the keys it writes", () => {
    const model = valueFilterModel(
      urlOf("model=gpt-4o&exclude_model=o3"),
      "model",
      { ...names, groups: [] },
    )
    expect(model.title).toBe("Model")
    expect(model.picked).toEqual(["gpt-4o"])
    expect(model.excluded).toEqual(["o3"])
    expect(model.isMono).toBe(true)
  })

  it("toggles and excludes through the column's own keys", () => {
    const model = valueFilterModel(urlOf("user_id=alice"), "member", {
      ...names,
      groups: [],
    })
    expect(model.toggle("alice")).toEqual({ user_id: [] })
    expect(model.toggle("bob")).toEqual({ user_id: ["alice", "bob"] })
    expect(model.exclude("bob")).toEqual({
      exclude_user_id: ["bob"],
      user_id: [],
    })
  })

  it("names each value the way the column shows it, busiest first", () => {
    const groups = [
      group({ key: "key-2", label: null, requests: 1 }),
      group({ key: "key-1", label: "ci-runner", requests: 5 }),
      group({ key: null, label: null, requests: 9 }),
    ]
    expect(
      valueFilterModel(urlOf(""), "source", { ...names, groups }).options,
    ).toEqual([
      { value: "key-1", label: "ci-runner", count: 5 },
      { value: "key-2", label: "key-2…", count: 1 },
    ])
    expect(
      valueFilterModel(urlOf(""), "member", { ...names, groups }).options.map(
        (option) => option.label,
      ),
    ).toEqual(["member key-1", "member key-2"])
  })

  it("lists status as its three outcomes rather than from groups", () => {
    const model = valueFilterModel(urlOf(""), "status", {
      ...names,
      groups: undefined,
    })
    expect(model.options.map((option) => option.label)).toEqual([
      "Succeeded",
      "Failed",
      "Recovered",
    ])
    expect(model.isMono).toBe(false)
  })
})
