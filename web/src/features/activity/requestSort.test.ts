import { describe, expect, it } from "vitest"

import { NEWEST_FIRST } from "@/shared/api/usage"
import {
  boundsWindow,
  nextSort,
  readSort,
  readSortChoice,
  sortChoices,
  sortDescriptorFor,
  sortUrl,
} from "./requestSort"

describe("nextSort", () => {
  it("cycles a column through its first order, the reverse, then back to newest first", () => {
    const first = nextSort(NEWEST_FIRST, "cost")
    expect(first).toEqual({ sort: "cost", order: "desc" })
    const reversed = nextSort(first, "cost")
    expect(reversed).toEqual({ sort: "cost", order: "asc" })
    expect(nextSort(reversed, "cost")).toEqual(NEWEST_FIRST)
  })

  it("starts names A to Z and sizes largest first", () => {
    expect(nextSort(NEWEST_FIRST, "user")).toEqual({
      sort: "user",
      order: "asc",
    })
    expect(nextSort(NEWEST_FIRST, "api_key")).toEqual({
      sort: "source",
      order: "asc",
    })
    expect(nextSort(NEWEST_FIRST, "latency")).toEqual({
      sort: "latency",
      order: "desc",
    })
  })

  it("toggles time between oldest first and the default", () => {
    const oldest = nextSort(NEWEST_FIRST, "time")
    expect(oldest).toEqual({ sort: "timestamp", order: "asc" })
    expect(nextSort(oldest, "time")).toEqual(NEWEST_FIRST)
  })

  it("starts another column over at its first order", () => {
    expect(nextSort({ sort: "cost", order: "asc" }, "model")).toEqual({
      sort: "model",
      order: "asc",
    })
  })

  it("leaves a column it cannot sort alone", () => {
    const current = { sort: "cost", order: "desc" } as const
    expect(nextSort(current, "tools")).toBe(current)
  })
})

describe("the URL form of an order", () => {
  it("drops both keys for the default and reads anything unknown as it", () => {
    expect(sortUrl(NEWEST_FIRST)).toEqual({ sort: "", order: "" })
    expect(readSort("", "")).toEqual(NEWEST_FIRST)
    expect(readSort("error_message", "asc")).toEqual(NEWEST_FIRST)
    expect(readSort("cost", "sideways")).toEqual({
      sort: "cost",
      order: "desc",
    })
    expect(sortUrl({ sort: "cost", order: "asc" })).toEqual({
      sort: "cost",
      order: "asc",
    })
  })

  it("marks the header it orders by, time descending by default", () => {
    expect(sortDescriptorFor(NEWEST_FIRST)).toEqual({
      column: "time",
      direction: "descending",
    })
    expect(sortDescriptorFor({ sort: "source", order: "asc" })).toEqual({
      column: "api_key",
      direction: "ascending",
    })
  })
})

describe("sortChoices", () => {
  it("offers newest first, oldest first, and both orders of every other column", () => {
    const choices = sortChoices()
    expect(choices[0]).toEqual({
      value: "timestamp:desc",
      label: "Newest first",
    })
    expect(choices.map((choice) => choice.label)).toEqual(
      expect.arrayContaining([
        "Oldest first",
        "Cost, highest first",
        "Cost, lowest first",
        "Model, A to Z",
        "Failures first",
        "Total time, longest first",
      ]),
    )
    expect(new Set(choices.map((choice) => choice.value)).size).toBe(
      choices.length,
    )
    expect(readSortChoice("latency:asc")).toEqual({
      sort: "latency",
      order: "asc",
    })
  })
})

describe("boundsWindow", () => {
  it("is false only for newest first with no search or an id search", () => {
    expect(boundsWindow(NEWEST_FIRST, "")).toBe(false)
    expect(boundsWindow(NEWEST_FIRST, "  ")).toBe(false)
    expect(
      boundsWindow(NEWEST_FIRST, "3F2504E0-4F89-11D3-9A0C-0305E82C3301"),
    ).toBe(false)
    expect(boundsWindow(NEWEST_FIRST, "sonnet")).toBe(true)
    expect(boundsWindow({ sort: "cost", order: "desc" }, "")).toBe(true)
    expect(boundsWindow({ sort: "timestamp", order: "asc" }, "")).toBe(false)
  })
})
