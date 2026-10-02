import { describe, expect, it } from "vitest"

import type { UsageSeriesPoint } from "@/client"
import {
  arrowDelta,
  barIndexAt,
  barMax,
  barSpanMs,
  describeBar,
  fillBars,
  phoneBars,
  stepBar,
  windowBars,
} from "./chartBars"

const HOUR = 3_600_000

function point(iso: string, requests: number, errors = 0): UsageSeriesPoint {
  return {
    bucket_start: iso,
    requests,
    errors,
    cost: 0,
    tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  }
}

describe("fillBars", () => {
  it("lays bars over the whole span, empty where there was no traffic", () => {
    const from = Date.parse("2026-01-15T00:00:00Z")
    const bars = fillBars(
      [point("2026-01-15T02:00:00Z", 3, 1)],
      from,
      from + 4 * HOUR,
      HOUR,
    )
    expect(bars.map((bar) => [bar.ok, bar.failed])).toEqual([
      [0, 0],
      [0, 0],
      [2, 1],
      [0, 0],
    ])
  })

  it("sums finer buckets into a coarser bar", () => {
    const from = Date.parse("2026-01-15T00:00:00Z")
    const bars = fillBars(
      [point("2026-01-15T00:00:00Z", 1), point("2026-01-15T01:00:00Z", 2, 2)],
      from,
      from + 2 * HOUR,
      2 * HOUR,
    )
    expect(bars).toEqual([
      { start: from, end: from + 2 * HOUR, ok: 1, failed: 2 },
    ])
  })

  it("drops a point outside the span rather than folding it into an edge bar", () => {
    const from = Date.parse("2026-01-15T00:00:00Z")
    const bars = fillBars(
      [point("2026-01-14T23:00:00Z", 5)],
      from,
      from + HOUR,
      HOUR,
    )
    expect(bars[0].ok).toBe(0)
  })
})

describe("phoneBars", () => {
  it("draws round bars ending at the one that holds now", () => {
    const now = Date.parse("2026-01-15T13:10:00Z")
    const bars = phoneBars([], "24h", now)
    expect(bars).toHaveLength(12)
    expect(new Date(bars.at(-1)?.end ?? 0).toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    )
    expect(new Date(bars[0].start).toISOString()).toBe(
      "2026-01-14T14:00:00.000Z",
    )
  })

  it("gives each window its own bar size", () => {
    const now = Date.parse("2026-01-15T13:10:00Z")
    expect(phoneBars([], "1h", now)).toHaveLength(12)
    expect(phoneBars([], "7d", now)).toHaveLength(14)
    expect(phoneBars([], "30d", now)).toHaveLength(15)
  })
})

describe("windowBars", () => {
  it("lays a 5-minute grain at five minutes a bar", () => {
    const now = Date.parse("2026-01-15T12:00:00Z")
    const bars = windowBars([], { start: "2026-01-15T11:00:00Z" }, "5min", now)
    expect(barSpanMs(bars)).toBe(5 * 60_000)
  })

  it("runs a bar per bucket to now for an open-ended window", () => {
    const now = Date.parse("2026-01-15T12:00:00Z")
    const bars = windowBars([], { start: "2026-01-15T11:00:00Z" }, "5min", now)
    expect(bars).toHaveLength(12)
  })
})

describe("describeBar", () => {
  it("names a bar's length", () => {
    expect(describeBar(5 * 60_000)).toBe("5 min")
    expect(describeBar(2 * HOUR, true)).toBe("2-hour")
    expect(describeBar(48 * HOUR, true)).toBe("2-day")
  })
})

describe("bar geometry", () => {
  const from = Date.parse("2026-01-15T00:00:00Z")
  const bars = fillBars(
    [point("2026-01-15T01:00:00Z", 4, 1)],
    from,
    from + 3 * HOUR,
    HOUR,
  )

  it("reads the bars' length and the tallest bar off the bars", () => {
    expect(barSpanMs(bars)).toBe(HOUR)
    expect(barMax(bars)).toBe(4)
  })

  it("scales an empty chart against one and gives it no length", () => {
    expect(barSpanMs([])).toBe(0)
    expect(barMax([])).toBe(1)
  })

  it("finds the bar under a pointer, held inside the plot", () => {
    const box = { left: 100, width: 300 }
    expect(barIndexAt(150, box, 3)).toBe(0)
    expect(barIndexAt(250, box, 3)).toBe(1)
    expect(barIndexAt(50, box, 3)).toBe(0)
    expect(barIndexAt(999, box, 3)).toBe(2)
    expect(barIndexAt(250, { left: 0, width: 0 }, 3)).toBe(0)
    expect(barIndexAt(250, undefined, 3)).toBe(0)
  })

  it("steps along the bars with the arrow keys, stopping at either end", () => {
    expect(arrowDelta("ArrowLeft")).toBe(-1)
    expect(arrowDelta("ArrowRight")).toBe(1)
    expect(arrowDelta("Enter")).toBe(0)
    expect(stepBar(0, -1, 3)).toBe(0)
    expect(stepBar(1, 1, 3)).toBe(2)
    expect(stepBar(2, 1, 3)).toBe(2)
  })
})
