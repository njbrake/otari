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
import {
  bucketDurationMs,
  DAY_S,
  HOUR_S,
  YEAR_SPAN_S,
} from "@/shared/helpers/timeRange"

const MINUTE_MS = 60_000
const HOUR_MS = HOUR_S * 1000
const DAY_MS = DAY_S * 1000

export interface ChartBar {
  start: number
  end: number
  ok: number
  failed: number
}

/** A stretch of time picked on a chart, in epoch milliseconds. */
export type Span = { from: number; to: number }

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
  const from = window.start
    ? Date.parse(window.start)
    : now - YEAR_SPAN_S * 1000
  const to = window.end ? Date.parse(window.end) : now
  return fillBars(series, from, to, bucketDurationMs(grain))
}

/** How long each of a chart's bars is; they are all one length. */
export function barSpanMs(bars: readonly ChartBar[]): number {
  return bars.length ? bars[0].end - bars[0].start : 0
}

/** The tallest bar's height, never below one, so an empty chart scales against something. */
export function barMax(bars: readonly ChartBar[]): number {
  return Math.max(1, ...bars.map((bar) => bar.ok + bar.failed))
}

/** The bar under a pointer at `clientX`, over a plot of `count` equal columns. */
export function barIndexAt(
  clientX: number,
  box: { left: number; width: number } | undefined,
  count: number,
): number {
  if (!box || box.width === 0) return 0
  const at = Math.floor(((clientX - box.left) / box.width) * count)
  return Math.max(0, Math.min(count - 1, at))
}

/** One bar further along, held inside the chart: an arrow key's step. */
export function stepBar(index: number, delta: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index + delta))
}

/** The step an arrow key takes along the bars, or 0 for any other key. */
export function arrowDelta(key: string): number {
  return key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0
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
