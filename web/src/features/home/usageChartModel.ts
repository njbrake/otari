import type {
  UsageGroupedSeries,
  UsageGroupRow,
  UsageSeriesPoint,
} from "@/client"
import type { SeriesDef, StackedPoint } from "@/design-system/metrics/charts"
import type { SpendWindow } from "@/features/spend/period"
import {
  formatCount,
  formatTokens,
  formatUsd,
  formatUsdCompact,
} from "@/shared/helpers/format"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** How many groups the chart names; the rest stack as Other. */
export const NAMED_GROUPS = 4

export type Metric = "cost" | "tokens" | "requests"

export const METRICS: { value: Metric; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
]

export function metricFromUrl(value: string): Metric {
  return METRICS.find((one) => one.value === value)?.value ?? "cost"
}

/** How a value of the metric reads in the tooltip. */
export function formatMetric(metric: Metric, value: number): string {
  return metric === "cost"
    ? formatUsd(value)
    : metric === "tokens"
      ? formatTokens(value)
      : formatCount(value)
}

/** How the metric reads on the axis, where the room is a few characters. */
export function formatMetricAxis(metric: Metric, value: number): string {
  return metric === "cost"
    ? formatUsdCompact(value)
    : metric === "tokens"
      ? formatTokens(value)
      : formatCount(value)
}

/** The fixed categorical slots, in order: the first group by cost takes the first. */
const SLOTS = [
  "var(--color-chart-cat-1)",
  "var(--color-chart-cat-2)",
  "var(--color-chart-cat-3)",
  "var(--color-chart-cat-4)",
]
export const OTHER_COLOR = "var(--color-chart-cat-other)"

const OTHER_KEY = "other"

/**
 * The start of every bucket in the window, empty ones included, as the
 * series names them: UTC days, or UTC hours. The usage series buckets in UTC,
 * so a window starting at a local midnight starts in the UTC day that holds it.
 */
export function bucketStarts(window: SpendWindow, now: number): number[] {
  const step = window.bucket === "hour" ? HOUR_MS : DAY_MS
  const from = Date.parse(window.start)
  const to = window.end ? Date.parse(window.end) : now
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
  const first = from - (from % step)
  const starts: number[] = []
  // Bounded: a window is at most six months of days or two days of hours.
  for (let at = first; at < to && starts.length < 400; at += step) {
    starts.push(at)
  }
  return starts
}

/** The series key a point or group carries in the chart's data. */
function seriesKey(index: number): string {
  return `g${index}`
}

export interface FoldedChart {
  series: SeriesDef[]
  points: StackedPoint[]
}

/**
 * The window's buckets stacked from its `NAMED_GROUPS` largest groups by cost
 * and one Other for the rest, in the metric asked for. The ranking stays by
 * cost whichever metric is drawn, so a group keeps its color when the metric
 * changes: color follows the entity, never its rank in the current view.
 */
export function foldSeries({
  data,
  starts,
  metric,
  labelOf,
}: {
  data: Pick<UsageGroupedSeries, "groups" | "points">
  starts: readonly number[]
  metric: Metric
  /** A group's name in the legend, from its row. */
  labelOf: (group: UsageGroupRow) => string
}): FoldedChart {
  const named = data.groups
    .filter((group) => !group.is_other)
    .slice(0, NAMED_GROUPS)
  const indexOf = new Map(named.map((group, index) => [group.key, index]))
  const hasOther =
    data.groups.length > named.length ||
    data.points.some((point) => point.is_other)
  const series: SeriesDef[] = named.map((group, index) => ({
    key: seriesKey(index),
    label: labelOf(group),
    color: SLOTS[index],
  }))
  if (hasOther) {
    series.push({ key: OTHER_KEY, label: "Other", color: OTHER_COLOR })
  }
  const empty = () =>
    Object.fromEntries(series.map((one) => [one.key, 0])) as Record<
      string,
      number
    >
  const byStart = new Map(starts.map((start) => [start, empty()]))
  for (const point of data.points) {
    const at = Date.parse(point.bucket_start)
    const cell = byStart.get(at)
    if (!cell) continue
    const index = point.is_other ? undefined : indexOf.get(point.key)
    const key = index === undefined ? OTHER_KEY : seriesKey(index)
    if (key in cell) cell[key] += point[metric]
  }
  return {
    series,
    points: starts.map((start) => ({
      x: new Date(start).toISOString(),
      ...(byStart.get(start) ?? empty()),
    })),
  }
}

/**
 * Grey bars of the window's totals alone, from the ungrouped series, while
 * the breakdown's own series loads: the chart keeps its shape rather than
 * blanking under a control the reader just pressed.
 */
export function placeholderSeries({
  totals,
  starts,
  metric,
}: {
  totals: readonly Pick<
    UsageSeriesPoint,
    "bucket_start" | "cost" | "tokens" | "requests"
  >[]
  starts: readonly number[]
  metric: Metric
}): FoldedChart {
  const values = new Map<number, number>()
  for (const point of totals) {
    const value = point[metric]
    const at = Date.parse(point.bucket_start)
    values.set(at, (values.get(at) ?? 0) + value)
  }
  return {
    series: [{ key: "all", label: "All", color: OTHER_COLOR }],
    points: starts.map((start) => ({
      x: new Date(start).toISOString(),
      all: values.get(start) ?? 0,
    })),
  }
}

/**
 * The window a drag across buckets `lo` to `hi` selects: from the first one's
 * start to the end of the last, as ISO bounds.
 */
export function draggedSpan(
  starts: readonly number[],
  bucket: SpendWindow["bucket"],
  lo: number,
  hi: number,
): { start: string; end: string } | undefined {
  const first = starts[Math.min(lo, hi)]
  const last = starts[Math.max(lo, hi)]
  if (first === undefined || last === undefined) return undefined
  const step = bucket === "hour" ? HOUR_MS : DAY_MS
  return {
    start: new Date(first).toISOString(),
    end: new Date(last + step).toISOString(),
  }
}

const DAY_TICK = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})
const HOUR_TICK = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  timeZone: "UTC",
})

/** A bucket's name under its bar: "Nov 3" for a day, "3 PM" for an hour, in UTC. */
export function formatBucket(
  bucket: SpendWindow["bucket"],
  iso: string,
): string {
  const at = Date.parse(iso)
  return bucket === "hour" ? HOUR_TICK.format(at) : DAY_TICK.format(at)
}
