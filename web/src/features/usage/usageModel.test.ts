import { describe, expect, it } from "vitest"

import type { UsageGroupedSeries } from "@/client"
import { breakdownRow } from "@/tests/usage"
import {
  axisScale,
  breakdownRankFor,
  foldSeries,
  niceCeiling,
  placeUnranked,
  totalSeries,
} from "./usageModel"
import type { SortKey } from "./usageQuery"

const DAY = "2026-09-30T00:00:00Z"

function grouped(
  groups: { key: string | null; is_other?: boolean; cost: number }[],
): UsageGroupedSeries {
  return {
    start_date: "2026-09-01T00:00:00Z",
    end_date: "2026-10-01T00:00:00Z",
    bucket: "day",
    group_by: "model",
    groups: groups.map((group) =>
      breakdownRow({ key: group.key, is_other: group.is_other ?? false }),
    ),
    points: groups.map((group) => ({
      bucket_start: DAY,
      key: group.key,
      is_other: group.is_other ?? false,
      cost: group.cost,
      imported_cost: 0,
      tokens: 0,
      requests: 0,
    })),
  }
}

const label = (group: { key: string | null }) => group.key ?? "none"

describe("foldSeries", () => {
  it("stacks the server's first four groups in its order and folds the rest into Other", () => {
    const folded = foldSeries(
      grouped([
        // Not the largest first: the server ranked these, and its order stands.
        { key: "a", cost: 1 },
        { key: "b", cost: 50 },
        { key: "c", cost: 3 },
        { key: "d", cost: 4 },
        { key: "e", cost: 5 },
        { key: null, is_other: true, cost: 6 },
      ]),
      "cost",
      true,
      label,
    )
    expect(folded.series.map((series) => series.label)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "Other",
    ])
    const [point] = folded.points
    expect(point.values.other).toBe(11)
    expect(Object.values(point.values).reduce((sum, v) => sum + v, 0)).toBe(69)
  })

  it("colors the fold, and a row past the stack, as Other, never as a group", () => {
    const folded = foldSeries(
      grouped([
        { key: "a", cost: 1 },
        { key: null, is_other: true, cost: 2 },
      ]),
      "cost",
      true,
      label,
    )
    const other = folded.series.find((series) => series.key === "other")
    expect(folded.colorOf({ key: null, is_other: true })).toBe(other?.color)
    expect(folded.colorOf({ key: "zzz", is_other: false })).toBe(other?.color)
    expect(folded.colorOf({ key: "a", is_other: false })).not.toBe(other?.color)
  })

  it("draws nothing for an Other with nothing in it", () => {
    const folded = foldSeries(
      grouped([
        { key: "a", cost: 1 },
        { key: null, is_other: true, cost: 0 },
      ]),
      "cost",
      true,
      label,
    )
    expect(folded.series.map((series) => series.label)).toEqual(["a"])
  })
})

describe("breakdownRankFor", () => {
  it("ranks the share by the metric on screen, as the chart does", () => {
    const share = { key: "value", order: "desc" } as const
    expect(breakdownRankFor(share, "cost", true)).toEqual({
      by: "cost",
      order: "desc",
    })
    expect(breakdownRankFor(share, "cost", false).by).toBe("billed")
    expect(breakdownRankFor(share, "tokens", false).by).toBe("tokens")
  })

  it("maps each column to the server's ranking, in the order picked", () => {
    const rank = (key: SortKey) =>
      breakdownRankFor({ key, order: "asc" }, "cost", true)
    expect(rank("name")).toEqual({ by: "name", order: "asc" })
    expect(rank("requests").by).toBe("requests")
    expect(rank("tokens").by).toBe("tokens")
    expect(rank("billed").by).toBe("billed")
    expect(rank("subscription").by).toBe("imported")
    expect(rank("failed").by).toBe("errors")
    expect(rank("p95").by).toBe("p95")
  })
})

describe("placeUnranked", () => {
  it("keeps the server's order, with the no-value row and the fold last", () => {
    const rows = [
      breakdownRow({ key: "other", is_other: true, cost: 999 }),
      breakdownRow({ key: null, cost: 900 }),
      breakdownRow({ key: "small", cost: 1 }),
      breakdownRow({ key: "big", cost: 50 }),
    ]
    expect(placeUnranked(rows).map((row) => row.key)).toEqual([
      "small",
      "big",
      null,
      "other",
    ])
  })
})

describe("niceCeiling", () => {
  it("rounds up to four steps of 1, 2 or 5 times a power of ten", () => {
    expect(niceCeiling(1185)).toBe(2000)
    expect(niceCeiling(0.03)).toBe(0.04)
    expect(niceCeiling(0.18)).toBe(0.2)
  })

  it("never steps below the minimum, so counts climb in whole steps", () => {
    expect(niceCeiling(1, 1)).toBe(4)
    expect(niceCeiling(9, 1)).toBe(20)
  })

  it("gives an empty chart an axis", () => {
    expect(niceCeiling(0)).toBe(1)
    expect(niceCeiling(0, 1)).toBe(4)
  })
})

describe("axisScale", () => {
  const ticks = (max: number, metric: "cost" | "tokens" | "requests") => {
    const axis = axisScale(max, metric)
    return [1, 2, 3, 4].map((n) => axis.format((axis.top * n) / 4))
  }

  it("prints cents where the steps are cents", () => {
    expect(ticks(0.03, "cost")).toEqual(["$0.01", "$0.02", "$0.03", "$0.04"])
    expect(ticks(0.18, "cost")).toEqual(["$0.05", "$0.10", "$0.15", "$0.20"])
  })

  it("prints whole dollars where the steps are dollars", () => {
    expect(ticks(1185, "cost")).toEqual(["$500", "$1K", "$1.5K", "$2K"])
  })

  it("gives an empty chart a readable axis", () => {
    expect(ticks(0, "cost")).toEqual(["$0.25", "$0.50", "$0.75", "$1.00"])
    expect(ticks(0, "requests")).toEqual(["1", "2", "3", "4"])
  })

  it("counts one request in whole requests", () => {
    expect(ticks(1, "requests")).toEqual(["1", "2", "3", "4"])
  })
})

describe("totalSeries", () => {
  const point = {
    bucket_start: DAY,
    cost: 3,
    imported_cost: 1,
    input_tokens: 70,
    output_tokens: 30,
    // The raw total, which the groups do not use.
    tokens: 999,
    cache_read_tokens: 40,
    cache_write_tokens: 0,
    requests: 5,
    errors: 0,
  }

  it("draws the window's totals as one series, in the figure the groups will use", () => {
    expect(totalSeries([point], "cost", true).points).toEqual([
      { start: Date.parse(DAY), values: { total: 3 } },
    ])
    // Billed only, without the subscription's share.
    expect(totalSeries([point], "cost", false).points[0].values.total).toBe(2)
    // Billed input plus output, which is what a grouped point's tokens are.
    expect(totalSeries([point], "tokens", true).points[0].values.total).toBe(
      100,
    )
    expect(totalSeries([point], "requests", true).series).toEqual([
      expect.objectContaining({ key: "total", label: "All usage" }),
    ])
  })
})
