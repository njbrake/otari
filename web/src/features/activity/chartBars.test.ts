import { describe, expect, it } from "vitest"

import type { UsageSeriesPoint } from "@/client"
import { describeBar, fillBars, phoneBars, windowBars } from "./chartBars"

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
