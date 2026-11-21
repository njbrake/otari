import { describe, expect, it } from "vitest"
import type { UsageGroupRow } from "@/client"
import {
  assignSlots,
  bucketStarts,
  draggedSpan,
  foldSeries,
  formatBucket,
  metricFromUrl,
  OTHER_COLOR,
  placeholderSeries,
} from "@/features/home/usageChartModel"
import { customWindow, windowOf } from "@/features/spend/period"

const at = (iso: string) => Date.parse(iso)

function group(key: string | null, cost: number, extra = {}): UsageGroupRow {
  return {
    key,
    label: null,
    cost,
    tokens: cost * 100,
    requests: Math.round(cost),
    is_other: false,
    charged_cost: 0,
    error_count: 0,
    ...extra,
  }
}

const DAY1 = "2026-11-01T00:00:00Z"
const DAY2 = "2026-11-02T00:00:00Z"
const STARTS = [at(DAY1), at(DAY2)]

function point(
  bucket_start: string,
  key: string | null,
  cost: number,
  is_other = false,
) {
  return {
    bucket_start,
    key,
    is_other,
    cost,
    tokens: cost * 100,
    requests: 1,
  }
}

describe("bucketStarts", () => {
  it("lists every UTC day of the window, empty ones included", () => {
    const window = customWindow(
      "2026-11-01T00:00:00Z",
      "2026-11-04T00:00:00Z",
      at("2026-11-20T00:00:00Z"),
    )!
    expect(window.bucket).toBe("day")
    expect(bucketStarts(window, at("2026-11-20T00:00:00Z"))).toEqual([
      at("2026-11-01T00:00:00Z"),
      at("2026-11-02T00:00:00Z"),
      at("2026-11-03T00:00:00Z"),
    ])
  })

  it("lists hours for a window of a day or two", () => {
    const now = at("2026-11-20T12:00:00Z")
    const window = customWindow(
      "2026-11-20T00:00:00Z",
      "2026-11-20T04:00:00Z",
      now,
    )!
    expect(window.bucket).toBe("hour")
    expect(bucketStarts(window, now)).toHaveLength(4)
  })

  it("runs an open window to now, from the UTC bucket its start falls in", () => {
    const now = at("2026-11-20T12:00:00Z")
    const window = {
      ...windowOf("7d", now),
      start: "2026-11-14T05:00:00.000Z",
      end: "",
    }
    expect(bucketStarts(window, now)[0]).toBe(at("2026-11-14T00:00:00Z"))
    expect(bucketStarts(window, now)).toHaveLength(7)
  })
})

describe("foldSeries", () => {
  const labelOf = (row: UsageGroupRow) => row.key ?? "Unknown"

  it("names the four largest groups by cost and stacks the rest as Other", () => {
    const data = {
      groups: [
        group("a", 50),
        group("b", 40),
        group("c", 30),
        group("d", 20),
        group("e", 10),
        group(null, 5, { is_other: true, charged_cost: 0, error_count: 0 }),
      ],
      points: [
        point(DAY1, "a", 50),
        point(DAY1, "e", 10),
        point(DAY2, "b", 40),
        point(DAY2, null, 5, true),
      ],
    }
    const folded = foldSeries({ data, starts: STARTS, metric: "cost", labelOf })
    expect(folded.series.map((one) => one.label)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "Other",
    ])
    expect(folded.series.at(-1)?.color).toBe(OTHER_COLOR)
    expect(folded.points).toEqual([
      { x: "2026-11-01T00:00:00.000Z", g0: 50, g1: 0, g2: 0, g3: 0, other: 10 },
      { x: "2026-11-02T00:00:00.000Z", g0: 0, g1: 40, g2: 0, g3: 0, other: 5 },
    ])
  })

  it("draws no Other when every group is named", () => {
    const data = {
      groups: [group("a", 2), group("b", 1)],
      points: [point(DAY1, "a", 2), point(DAY1, "b", 1)],
    }
    const folded = foldSeries({ data, starts: STARTS, metric: "cost", labelOf })
    expect(folded.series.map((one) => one.label)).toEqual(["a", "b"])
  })

  it("keeps each group's color whatever the metric drawn", () => {
    const data = {
      groups: [group("a", 50), group("b", 40)],
      points: [point(DAY1, "a", 50), point(DAY1, "b", 40)],
    }
    const byCost = foldSeries({ data, starts: STARTS, metric: "cost", labelOf })
    const byRequests = foldSeries({
      data,
      starts: STARTS,
      metric: "requests",
      labelOf,
    })
    expect(byRequests.series).toEqual(byCost.series)
    expect(byRequests.points[0]).toMatchObject({ g0: 1, g1: 1 })
    const byTokens = foldSeries({
      data,
      starts: STARTS,
      metric: "tokens",
      labelOf,
    })
    expect(byTokens.points[0]).toMatchObject({ g0: 5000, g1: 4000 })
  })

  it("keeps a real group with no key apart from the fold", () => {
    const data = {
      groups: [
        group(null, 3),
        group(null, 1, { is_other: true, charged_cost: 0, error_count: 0 }),
      ],
      points: [point(DAY1, null, 3), point(DAY1, null, 1, true)],
    }
    const folded = foldSeries({ data, starts: STARTS, metric: "cost", labelOf })
    expect(folded.series.map((one) => one.label)).toEqual(["Unknown", "Other"])
    expect(folded.points[0]).toMatchObject({ g0: 3, other: 1 })
  })
})

describe("placeholderSeries", () => {
  it("stands the window's totals in as one grey series", () => {
    const folded = placeholderSeries({
      totals: [{ bucket_start: DAY2, cost: 4, tokens: 10, requests: 2 }],
      starts: STARTS,
      metric: "requests",
    })
    expect(folded.series).toEqual([
      { key: "all", label: "All", color: OTHER_COLOR },
    ])
    expect(folded.points.map((one) => one.all)).toEqual([0, 2])
  })
})

describe("draggedSpan", () => {
  const starts = [at(DAY1), at(DAY2), at("2026-11-03T00:00:00Z")]
  it("runs from the first bucket's start to the end of the last, either way dragged", () => {
    const span = {
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-11-03T00:00:00.000Z",
    }
    expect(draggedSpan(starts, "day", 0, 1)).toEqual(span)
    expect(draggedSpan(starts, "day", 1, 0)).toEqual(span)
  })
  it("ends an hour on for an hourly chart", () => {
    expect(draggedSpan(starts, "hour", 2, 2)?.end).toBe(
      "2026-11-03T01:00:00.000Z",
    )
  })
  it("selects nothing past the buckets", () => {
    expect(draggedSpan(starts, "day", 0, 9)).toBeUndefined()
  })
})

describe("labels", () => {
  it("names a bucket by its UTC day or hour", () => {
    expect(formatBucket("day", DAY2)).toBe("Nov 2")
    expect(formatBucket("hour", "2026-11-02T15:00:00Z")).toBe("3 PM")
  })
  it("reads an unknown metric as cost", () => {
    expect(metricFromUrl("tokens")).toBe("tokens")
    expect(metricFromUrl("bogus")).toBe("cost")
  })
})

describe("assignSlots", () => {
  it("gives each group the slot of its rank on the page", () => {
    expect(assignSlots(["c", "a", "b"], ["a", "b", "c"])).toEqual([2, 0, 1])
  })
  it("gives a group the page did not rank the first slot left free", () => {
    expect(assignSlots(["x", "b", "y"], ["a", "b", "c", "d"])).toEqual([
      0, 1, 2,
    ])
    expect(assignSlots(["d", "z"], ["a", "b", "c", "d"])).toEqual([3, 0])
  })
  it("keeps colors when a narrower window ranks the groups the other way", () => {
    const data = {
      groups: [group("b", 5), group("a", 1)],
      points: [point(DAY1, "b", 5), point(DAY1, "a", 1)],
    }
    const folded = foldSeries({
      data,
      starts: STARTS,
      metric: "cost",
      labelOf: (row) => row.key ?? "",
      order: ["a", "b"],
    })
    expect(
      Object.fromEntries(folded.series.map((one) => [one.label, one.color])),
    ).toEqual({
      a: "var(--color-chart-cat-1)",
      b: "var(--color-chart-cat-2)",
    })
  })
})
