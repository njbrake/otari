import { describe, expect, it } from "vitest"

import { canonicalQuery, hasSpan, viewPatch } from "./observeViews"

describe("canonicalQuery", () => {
  it("orders keys the page's way and sorts each key's values", () => {
    expect(
      canonicalQuery("requests", "model=b&status=error&model=a&range=7d"),
    ).toBe("range=7d&status=error&model=a&model=b")
  })

  it("leaves out defaults, blanks and keys the page does not keep", () => {
    expect(
      canonicalQuery("sessions", {
        range: "24h",
        sort: "last_activity",
        order: "desc",
        q: " ",
        cost_gt: "0.4",
        page: "3",
        peek: "abc",
      }),
    ).toBe("")
    expect(canonicalQuery("requests", { cost_gt: "0.4", request: "r1" })).toBe(
      "cost_gt=0.4",
    )
  })

  it("reads a URL and a stored query alike", () => {
    expect(
      canonicalQuery("requests", { model: ["b", "a"], scope: "mine" }),
    ).toBe(canonicalQuery("requests", "scope=mine&model=a&model=b"))
  })
})

describe("viewPatch", () => {
  it("sets what the view names and clears every other filter and the reader's place", () => {
    const patch = viewPatch("status=error&model=a&model=b")
    expect(patch.status).toBe("error")
    expect(patch.model).toEqual(["a", "b"])
    expect(patch.cost_gt).toBe("")
    expect(patch.range).toBe("")
    expect(patch.start_date).toBe("")
    expect(patch.request).toBe("")
    expect(patch.peek).toBe("")
  })
})

describe("hasSpan", () => {
  it("is a window dragged on the chart", () => {
    expect(hasSpan({ start_date: "2026-11-01T00:00:00Z" })).toBe(true)
    expect(hasSpan({ range: "7d" })).toBe(false)
  })
})
