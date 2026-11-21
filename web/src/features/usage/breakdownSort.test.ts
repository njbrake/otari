import { describe, expect, it } from "vitest"
import {
  type BreakdownFigures,
  DEFAULT_SORT,
  sortFromUrl,
  sortRows,
  sortToUrl,
} from "@/features/usage/breakdownSort"

interface Row {
  name: string
  figures?: BreakdownFigures
  isFold?: boolean
}

const row = (
  name: string,
  figures: Partial<BreakdownFigures> = {},
  extra: Partial<Row> = {},
): Row => ({
  name,
  figures: {
    cost: 0,
    charged: 0,
    tokens: 0,
    requests: 0,
    failed: 0,
    p95: null,
    ...figures,
  },
  ...extra,
})

const names = (rows: Row[]) => rows.map((one) => one.name)

const sorted = (rows: Row[], key: string, order = "desc") =>
  names(
    sortRows(rows, sortFromUrl(key, order), {
      figuresOf: (one) => one.figures,
      nameOf: (one) => one.name,
      isLast: (one) => one.isFold ?? false,
    }),
  )

describe("sortFromUrl", () => {
  it("reads a figure and a direction, and falls back to spend, most first", () => {
    expect(sortFromUrl("p95", "asc")).toEqual({ key: "p95", order: "asc" })
    expect(sortFromUrl("failed", "")).toEqual({ key: "failed", order: "desc" })
    expect(sortFromUrl("nonsense", "asc")).toEqual(DEFAULT_SORT)
  })

  it("writes the default as nothing, so a plain link stays plain", () => {
    expect(sortToUrl(DEFAULT_SORT)).toEqual({ sort: "", order: "" })
    expect(sortToUrl({ key: "tokens", order: "asc" })).toEqual({
      sort: "tokens",
      order: "asc",
    })
  })
})

describe("sortRows", () => {
  const rows = [
    row("a", { cost: 3, charged: 1, failed: 1, p95: 200 }),
    row("b", { cost: 1, charged: 1, failed: 5, p95: null }),
    row("c", { cost: 2, charged: 2, failed: 1, p95: 900 }),
    row("Other", { cost: 50, failed: 50, p95: 5000 }, { isFold: true }),
  ]

  it("orders by the figure either way, ties by name, the fold always last", () => {
    expect(sorted(rows, "cost")).toEqual(["a", "c", "b", "Other"])
    expect(sorted(rows, "cost", "asc")).toEqual(["b", "c", "a", "Other"])
    expect(sorted(rows, "failed")).toEqual(["b", "a", "c", "Other"])
  })

  it("reads not charged as spend less what was charged", () => {
    expect(sorted(rows, "not_charged")).toEqual(["a", "b", "c", "Other"])
  })

  it("puts a row with no p95, or no figures yet, last whichever way it runs", () => {
    expect(sorted(rows, "p95")).toEqual(["c", "a", "b", "Other"])
    expect(sorted(rows, "p95", "asc")).toEqual(["a", "c", "b", "Other"])
    const unread = { name: "unread" }
    expect(sorted([unread, ...rows.slice(0, 2)], "cost", "asc")).toEqual([
      "b",
      "a",
      "unread",
    ])
  })
})
