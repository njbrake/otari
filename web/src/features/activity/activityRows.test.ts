import { describe, expect, it } from "vitest"

import { entry, group } from "@/tests/activity"
import {
  describeGroup,
  groupFilters,
  keyNames,
  nestAttempts,
  showGroupPatch,
} from "./activityRows"

describe("nestAttempts", () => {
  it("puts a recovered attempt under the row that served its request", () => {
    const served = entry({ id: "s", request_group_id: "g", status: "success" })
    const failed = entry({ id: "f", request_group_id: "g", status: "absorbed" })
    const { rows, attempts } = nestAttempts([served, failed])
    expect(rows.map((row) => row.id)).toEqual(["s"])
    expect(attempts.get("g")?.map((row) => row.id)).toEqual(["f"])
  })

  it("leaves an attempt whose served row is not on the page standing alone", () => {
    const failed = entry({ id: "f", request_group_id: "g", status: "absorbed" })
    expect(nestAttempts([failed]).rows.map((row) => row.id)).toEqual(["f"])
  })
})

describe("groupFilters", () => {
  it("narrows to a group's value", () => {
    expect(groupFilters({}, "api_key", group({ key: "k" }))).toEqual({
      api_key_id: ["k"],
    })
    expect(groupFilters({}, "source_label", group({ key: "s" }))).toEqual({
      source_label: "s",
    })
  })

  it("finds the rows of a group with no value by that column being empty", () => {
    expect(groupFilters({}, "user", group({ key: null }))).toEqual({
      is_null: ["user_id"],
    })
  })
})

describe("describeGroup", () => {
  const name = (id: string | null) => (id ? `Name of ${id}` : "No member")

  it("titles a session and a key", () => {
    expect(describeGroup("session", group({ key: "abc" }), name)).toEqual({
      title: "Session abc",
      isMono: true,
    })
    expect(describeGroup("session", group({ key: null }), name).title).toBe(
      "No session",
    )
    expect(describeGroup("source", group({ label: "ci" }), name).title).toBe(
      "ci",
    )
  })

  it("names a member", () => {
    expect(describeGroup("member", group({ key: "u1" }), name).title).toBe(
      "Name of u1",
    )
  })
})

describe("showGroupPatch", () => {
  it("turns the group into a filter and the grouping off", () => {
    expect(showGroupPatch("model", "gpt-4o")).toEqual({
      model: ["gpt-4o"],
      group: "",
      page: "0",
    })
  })
})

describe("keyNames", () => {
  it("names keys from the rows and the key groups", () => {
    const names = keyNames(
      [entry({ api_key_id: "k1", api_key_name: "one" })],
      [group({ key: "k2", label: "two" })],
    )
    expect(Object.fromEntries(names)).toEqual({ k1: "one", k2: "two" })
  })
})
