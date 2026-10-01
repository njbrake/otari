import { describe, expect, it } from "vitest"

import {
  activityColumns,
  laneWidthRem,
  tableMinWidthRem,
} from "./activityColumns"

describe("activityColumns", () => {
  it("shows Member and Policy only where they say something", () => {
    expect(
      activityColumns({
        isCompact: false,
        showsMembers: false,
        showsPolicies: false,
      }),
    ).toEqual([
      "time",
      "model",
      "source",
      "tokens",
      "cost",
      "latency",
      "status",
    ])
    expect(
      activityColumns({
        isCompact: false,
        showsMembers: true,
        showsPolicies: true,
      }),
    ).toEqual([
      "time",
      "member",
      "model",
      "policy",
      "source",
      "tokens",
      "cost",
      "latency",
      "status",
    ])
  })

  it("narrows to what picks a row out while a request is open", () => {
    expect(
      activityColumns({
        isCompact: true,
        showsMembers: true,
        showsPolicies: true,
      }),
    ).toEqual(["time", "member", "model", "cost", "status"])
  })
})

describe("lane widths", () => {
  it("leaves Model without a width, to take what the rest leave", () => {
    expect(laneWidthRem("model")).toBeUndefined()
    expect(laneWidthRem("time")).toBe(6)
  })

  it("sums the lanes into the table's floor, with Model wider beside an open request", () => {
    const compact = ["time", "model", "cost", "status"] as const
    expect(tableMinWidthRem([...compact], false)).toBe(6 + 11.5 + 7 + 9)
    expect(tableMinWidthRem([...compact], true)).toBe(6 + 17.5 + 7 + 9)
  })
})
