import { describe, expect, it } from "vitest"

import { entry } from "@/tests/activity"
import {
  applyCellFilter,
  groupsWithEarlierAttempts,
  nestRecoveredAttempts,
} from "./cellFilters"

describe("applyCellFilter", () => {
  it("adds the value to the column's own list, back on the first page with nothing open", () => {
    expect(
      applyCellFilter(
        { model: "claude", page: "3", request: "r1", range: "7d" },
        "model",
        "gpt-4o",
        "include",
      ),
    ).toEqual({ model: ["claude", "gpt-4o"], range: "7d" })
  })

  it("moves a value between only and exclude rather than holding it in both", () => {
    const excluded = applyCellFilter(
      { user_id: ["ada", "bob"] },
      "user",
      "ada",
      "exclude",
    )
    expect(excluded).toEqual({ user_id: ["bob"], exclude_user_id: ["ada"] })
    expect(applyCellFilter(excluded, "user", "ada", "include")).toEqual({
      user_id: ["bob", "ada"],
    })
  })

  it("writes the keys each column's funnel writes", () => {
    expect(applyCellFilter({}, "policy", "fast", "exclude")).toEqual({
      exclude_policy_name: ["fast"],
    })
    expect(applyCellFilter({}, "api_key", "k1", "include")).toEqual({
      api_key_id: ["k1"],
    })
    expect(
      applyCellFilter({ status: "error" }, "status", "incomplete", "include"),
    ).toEqual({
      status: ["error", "incomplete"],
    })
  })

  it("keeps the rows with an empty cell, and cannot leave them out", () => {
    expect(
      applyCellFilter({ is_null: "session" }, "user", null, "include"),
    ).toEqual({
      is_null: ["session", "user"],
    })
    expect(applyCellFilter({}, "api_key", null, "include")).toEqual({
      is_null: ["api_key"],
    })
    expect(applyCellFilter({}, "policy", null, "include")).toEqual({
      routed: "false",
    })
    expect(applyCellFilter({ page: "2" }, "user", null, "exclude")).toEqual({})
    expect(applyCellFilter({}, "model", null, "include")).toEqual({})
  })
})

describe("nestRecoveredAttempts", () => {
  const served = entry({
    id: "served",
    request_group_id: "g1",
    attempt_position: 3,
  })
  const plain = entry({ id: "plain", request_group_id: "g2" })
  const first = entry({
    id: "first",
    status: "absorbed",
    request_group_id: "g1",
    attempt_position: 1,
  })
  const second = entry({
    id: "second",
    status: "absorbed",
    request_group_id: "g1",
    attempt_position: 2,
  })

  it("lists each request's recovered attempts under it, latest first", () => {
    const { rows, nested } = nestRecoveredAttempts(
      [served, plain],
      [first, served, second],
    )
    expect(rows.map((row) => row.id)).toEqual([
      "served",
      "second",
      "first",
      "plain",
    ])
    expect([...nested].sort()).toEqual(["first", "second"])
  })

  it("leaves a row already on the page where it is", () => {
    const { rows, nested } = nestRecoveredAttempts(
      [served, first],
      [first, second, served],
    )
    expect(rows.map((row) => row.id)).toEqual(["served", "second", "first"])
    expect([...nested]).toEqual(["second"])
  })

  it("looks up only the requests that had an earlier attempt", () => {
    expect(groupsWithEarlierAttempts([served, plain, first])).toEqual(["g1"])
  })
})
