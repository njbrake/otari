/**
 * The request-volume bars above the log, from the summary's series.
 *
 * The server returns only the buckets that had traffic, so the bars are laid
 * out here over the whole window and the series is dropped into them: an empty
 * stretch reads as empty rather than being closed up. A point's `requests`
 * includes its `errors`, so a bar's succeeded part is the difference.
 */

import type { UsageBucket, UsageSeriesPoint } from "@/client"
import {
  formatUtcDay,
  formatUtcTime,
  formatUtcWeekdayHour,
} from "@/shared/helpers/format"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export interface ChartBar {
  start: number
  end: number
  ok: number
  failed: number
}

/** A stretch of time picked on a chart, in epoch milliseconds. */
export type Span = { from: number; to: number }

// The desk has room for a bar per server bucket, so each window reads at the
// finest grain that keeps its bar count sensible: 12 for an hour, 288 for a
// day, 168 for a week, 30 for a month, a year of days for everything.
export const DESKTOP_GRAIN: Record<string, UsageBucket> = {
  "1h": "5min",
  "24h": "5min",
  "7d": "hour",
  "30d": "day",
  all: "day",
}

/** The finest grain that still lays out a window of this length within the server's bucket ceiling. */
export function grainForSpan(spanMs: number): UsageBucket {
  if (spanMs <= DAY_MS) return "5min"
  if (spanMs <= 14 * DAY_MS) return "hour"
  return "day"
}

// A phone has room for 12 to 15 bars a thumb can hit, so each window gets a
// round bar size (a Time chip reads "14:00–16:00", never "14:07–15:43"),
// built from the finest server grain that divides it.
export const PHONE_BARS: Record<
  string,
  { grain: UsageBucket; barMs: number; count: number }
> = {
  "1h": { grain: "5min", barMs: 5 * MINUTE_MS, count: 12 },
  "24h": { grain: "hour", barMs: 2 * HOUR_MS, count: 12 },
  "7d": { grain: "hour", barMs: 12 * HOUR_MS, count: 14 },
  "30d": { grain: "day", barMs: 2 * DAY_MS, count: 15 },
}

/** Bars of `barMs` covering [from, to), with the series summed into them. */
export function fillBars(
  series: readonly UsageSeriesPoint[],
  from: number,
  to: number,
  barMs: number,
): ChartBar[] {
  const lo = Math.floor(from / barMs) * barMs
  const hi = Math.max(lo + barMs, Math.ceil(to / barMs) * barMs)
  const bars: ChartBar[] = Array.from(
    { length: Math.round((hi - lo) / barMs) },
    (_, index) => {
      const start = lo + index * barMs
      return { start, end: start + barMs, ok: 0, failed: 0 }
    },
  )
  for (const point of series) {
    const index = Math.floor((Date.parse(point.bucket_start) - lo) / barMs)
    const bar = bars[index]
    if (!bar) continue
    const failed = point.errors ?? 0
    bar.failed += failed
    bar.ok += Math.max(0, point.requests - failed)
  }
  return bars
}

const GRAIN_MS: Record<UsageBucket, number> = {
  "5min": 5 * MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS,
}

/**
 * The desk's bars: one per server bucket across the window, up to now when it
 * is open-ended. An unbounded window is drawn over the year its series covers.
 */
export function windowBars(
  series: readonly UsageSeriesPoint[],
  window: { start?: string; end?: string },
  grain: UsageBucket,
  now: number,
): ChartBar[] {
  const from = window.start ? Date.parse(window.start) : now - 365 * DAY_MS
  const to = window.end ? Date.parse(window.end) : now
  return fillBars(series, from, to, GRAIN_MS[grain])
}

/**
 * How a phone draws a window. "All" has no round size of its own, so a link
 * carrying it draws the last month, the widest window a phone offers.
 */
export function phoneBarSpec(windowKey: string) {
  return PHONE_BARS[windowKey] ?? PHONE_BARS["30d"]
}

/**
 * The phone's bars for a window: `count` of them, the last one holding now.
 * Summed here from the server's buckets because its grains stop at hours and
 * days, not 2h, 12h or 2d; at most 15 bars from one bounded series.
 */
export function phoneBars(
  series: readonly UsageSeriesPoint[],
  windowKey: string,
  now: number,
): ChartBar[] {
  const spec = phoneBarSpec(windowKey)
  const hi = Math.ceil(now / spec.barMs) * spec.barMs
  return fillBars(series, hi - spec.count * spec.barMs, hi, spec.barMs)
}

/** How long one bar is, for the chart's caption: "5 min", "2-hour", "2-day". */
export function describeBar(barMs: number, compound = false): string {
  const [amount, unit] =
    barMs >= DAY_MS
      ? [barMs / DAY_MS, "day"]
      : barMs >= HOUR_MS
        ? [barMs / HOUR_MS, "hour"]
        : [barMs / MINUTE_MS, "min"]
  return compound ? `${amount}-${unit}` : `${amount} ${unit}`
}

/**
 * An instant as a bar of this length names it: the time of day for bars
 * shorter than half a day, the weekday and hour for half-day bars, the date for
 * day bars.
 */
export function formatBarTime(ms: number, barMs: number): string {
  if (barMs >= DAY_MS) return formatUtcDay(ms)
  if (barMs >= 12 * HOUR_MS) return formatUtcWeekdayHour(ms)
  return formatUtcTime(ms)
}

/** A stretch of the window as its bars name it: "14:00–16:00". */
export function describeSpan(from: number, to: number, barMs: number): string {
  return `${formatBarTime(from, barMs)}–${formatBarTime(to, barMs)}`
}
