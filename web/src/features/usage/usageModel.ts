import type {
  UsageBreakdownRankBy,
  UsageGroupedSeries,
  UsageRankBy,
  UsageRankOrder,
  UsageSeriesPoint,
  UsageSummary,
  UsageTotals,
} from "@/client"
import { describeSource, shortId } from "@/features/activity/activityModel"
import { userDisplay } from "@/features/users/userDisplay"
import type { UsageBreakdownRow } from "@/shared/api/usage"
import {
  formatDuration,
  formatMultiple,
  formatNumber,
  formatPct,
  formatTokens,
  formatUsd,
  formatUsdAxis,
  formatUtcMinute,
} from "@/shared/helpers/format"
import { USAGE_CHANNELS } from "@/shared/helpers/usageChannel"
import {
  DIMENSIONS,
  type DimensionKey,
  type SortKey,
  type TableSort,
} from "./usageQuery"

export type Metric = "cost" | "tokens" | "requests"

export const METRICS: { value: Metric; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
]

export function readMetric(value: string): Metric {
  return value === "tokens" || value === "requests" ? value : "cost"
}

/** What the server ranks the breakdown by: the metric on screen, cost without subscription being billed spend. */
export function rankByFor(
  metric: Metric,
  withSubscription: boolean,
): UsageRankBy {
  if (metric !== "cost") return metric
  return withSubscription ? "cost" : "billed"
}

/** How a figure in the metric reads in a table cell or a tooltip. */
export function valueFormatter(metric: Metric): (value: number) => string {
  return metric === "cost"
    ? formatUsd
    : metric === "tokens"
      ? formatTokens
      : formatNumber
}

// ---------- money ----------

/** What a row cost that counts toward limits: everything but subscription usage. */
export function billedOf(row: { cost: number; imported_cost?: number }) {
  return Math.max(0, row.cost - (row.imported_cost ?? 0))
}

/** A row's figure in the metric the chart draws. */
export function metricOf(
  row: {
    cost: number
    imported_cost?: number
    tokens: number
    requests: number
  },
  metric: Metric,
  withSubscription: boolean,
): number {
  if (metric === "tokens") return row.tokens
  if (metric === "requests") return row.requests
  return withSubscription ? row.cost : billedOf(row)
}

// ---------- growth ----------

/**
 * How a figure compares with the window before, said as a multiple once it
 * has doubled and as a percentage below that. Past ten times the previous
 * window is too small to measure against, so the previous figure itself is
 * shown. Undefined with nothing to compare against.
 */
export function describeGrowth(
  current: number,
  previous: number | undefined,
  windowLabel: string,
  formatValue: (value: number) => string,
): string | undefined {
  if (!previous) return undefined
  const ratio = current / previous
  if (ratio >= 10) return `prev ${windowLabel} ${formatValue(previous)}`
  if (ratio >= 2) return `${formatMultiple(ratio)} prev ${windowLabel}`
  const change = formatPct(Math.abs(ratio - 1), 0)
  return `${ratio >= 1 ? "↑" : "↓"} ${change} vs prev ${windowLabel}`
}

// ---------- naming a row ----------

const FIREWORKS = /accounts\/fireworks\/models\/(.+)$/
// A session id an agent mints, which its first eight characters tell apart;
// any other label is a name someone chose, and is shown whole.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RowName {
  label: string
  /** A quieter word set before the label: the provider a long path was cut to. */
  prefix?: string
  /** The full value, where the label shortens it. */
  title?: string
  /** A line under the name. */
  detail?: string
  isMono: boolean
  isNone: boolean
}

/** What naming a group needs: its key and the label the server gave it, and a session's span. */
export type NamedGroup = Pick<UsageBreakdownRow, "key"> &
  Partial<
    Pick<
      UsageBreakdownRow,
      "label" | "is_other" | "first_at" | "last_at" | "source" | "api_key_name"
    >
  >

interface NameContext {
  memberLabels: ReadonlyMap<string, string>
  ownUserId: string | undefined
  currentWorkspaceId: string | undefined
}

/** How a session reads: where it came from, when it started, and how long it ran. */
function describeSession(row: NamedGroup): string | undefined {
  const parts = [
    row.source && row.source !== "gateway"
      ? describeSource(row.source)
      : (row.api_key_name ?? undefined),
    row.first_at ? formatUtcMinute(row.first_at) : undefined,
    row.first_at && row.last_at
      ? formatDuration(Date.parse(row.last_at) - Date.parse(row.first_at))
      : undefined,
  ].filter((part) => part !== undefined)
  return parts.length ? parts.join(" · ") : undefined
}

export function rowName(
  dimension: DimensionKey,
  row: NamedGroup,
  context: NameContext,
): RowName {
  const def = DIMENSIONS[dimension]
  if (row.is_other) {
    return { label: "Other", isMono: false, isNone: true }
  }
  if (row.key === null) {
    return {
      label: def.none?.label ?? "Unknown",
      detail: def.none?.hint,
      isMono: false,
      isNone: true,
    }
  }
  const key = row.key
  switch (dimension) {
    case "model": {
      const fireworks = FIREWORKS.exec(key)
      return fireworks
        ? {
            label: fireworks[1],
            prefix: "fireworks/",
            title: key,
            isMono: true,
            isNone: false,
          }
        : { label: key, isMono: true, isNone: false }
    }
    case "key":
      return {
        label: row.label ?? shortId(key),
        title: key,
        isMono: false,
        isNone: false,
      }
    case "session":
      return {
        label: UUID.test(key) ? key.slice(0, 8) : key,
        title: key,
        detail: describeSession(row),
        isMono: true,
        isNone: false,
      }
    case "channel": {
      const channel = Object.hasOwn(USAGE_CHANNELS, key)
        ? USAGE_CHANNELS[key as keyof typeof USAGE_CHANNELS]
        : undefined
      return channel
        ? {
            label: channel.label,
            detail: channel.hint,
            isMono: false,
            isNone: false,
          }
        : { label: key, isMono: true, isNone: false }
    }
    case "member": {
      const isYou = key === context.ownUserId
      const name = userDisplay(key, row.label, context.memberLabels)
      return {
        label: isYou ? "You" : name.label,
        title: name.id ?? key,
        isMono: false,
        isNone: false,
      }
    }
    case "workspace":
      return {
        label: row.label ?? shortId(key),
        detail: key === context.currentWorkspaceId ? "current" : undefined,
        isMono: false,
        isNone: false,
      }
    default:
      return { label: key, isMono: def.isMono ?? false, isNone: false }
  }
}

/** A name as one line reads it, its cut-down prefix included. */
export function nameText(name: RowName): string {
  return `${name.prefix ?? ""}${name.label}`
}

/** Whether every dollar of a row is subscription usage: worth a tag of its own. */
export function isSubscriptionOnly(row: UsageBreakdownRow): boolean {
  return row.imported_cost > 0 && billedOf(row) === 0
}

// ---------- the chart ----------

const SERIES_COLORS = [
  "var(--color-chart-cat-1)",
  "var(--color-chart-cat-2)",
  "var(--color-chart-cat-3)",
  "var(--color-chart-cat-4)",
]
const OTHER_COLOR = "var(--color-chart-cat-other)"

export interface FoldedSeries {
  /** The stacked groups, in the server's order, then Other where there is any. */
  series: { key: string; label: string; color: string }[]
  /** Each bucket's start, and every series' figure in it. */
  points: { start: number; values: Record<string, number> }[]
  /** A row's color, which the chart repeats: the fold is never a group's. */
  colorOf: (row: Pick<UsageBreakdownRow, "key" | "is_other">) => string
}

const otherKey = "other"
const groupKey = (key: string | null) => `g:${key ?? ""}`

/**
 * The server's groups, already ranked by the metric on screen, restacked as
 * the page draws them: the first four, then everything else, the server's own
 * fold included, as Other.
 */
export function foldSeries(
  grouped: UsageGroupedSeries | undefined,
  metric: Metric,
  withSubscription: boolean,
  nameOf: (group: NamedGroup) => string,
): FoldedSeries {
  const top = (grouped?.groups ?? [])
    .filter((group) => !group.is_other)
    .slice(0, SERIES_COLORS.length)
  const colors = new Map(
    top.map((group, index) => [groupKey(group.key), SERIES_COLORS[index]]),
  )
  const byStart = new Map<number, Record<string, number>>()
  let hasOther = false
  for (const point of grouped?.points ?? []) {
    const start = Date.parse(point.bucket_start)
    const values = byStart.get(start) ?? {}
    const id = groupKey(point.key)
    const slot = !point.is_other && colors.has(id) ? id : otherKey
    const value = metricOf(point, metric, withSubscription)
    if (slot === otherKey && value > 0) hasOther = true
    values[slot] = (values[slot] ?? 0) + value
    byStart.set(start, values)
  }
  return {
    series: [
      ...top.map((group) => ({
        key: groupKey(group.key),
        label: nameOf(group),
        color: colors.get(groupKey(group.key)) as string,
      })),
      ...(hasOther
        ? [{ key: otherKey, label: "Other", color: OTHER_COLOR }]
        : []),
    ],
    points: [...byStart]
      .sort(([a], [b]) => a - b)
      .map(([start, values]) => ({ start, values })),
    colorOf: (row) =>
      row.is_other
        ? OTHER_COLOR
        : (colors.get(groupKey(row.key)) ?? OTHER_COLOR),
  }
}

/**
 * The axis top at or above `value` that splits into four round steps (1, 2 or
 * 5 times a power of ten, and never below `minStep`), so every tick reads as a
 * whole figure: $10, $20, $30. An empty chart scales against one step.
 */
export function niceCeiling(value: number, minStep = 0): number {
  const quarter = Math.max(value / 4, minStep)
  if (quarter <= 0) return 4 * Math.max(minStep, 0.25)
  const magnitude = 10 ** Math.floor(Math.log10(quarter))
  const step =
    [1, 2, 5, 10].map((one) => one * magnitude).find((v) => v >= quarter) ??
    quarter
  return Math.max(step, minStep) * 4
}

/**
 * The y-axis for the metric on screen: its top, and how a tick reads, at the
 * precision its steps need. Tokens and requests count in whole steps.
 */
export function axisScale(
  max: number,
  metric: Metric,
): { top: number; format: (value: number) => string } {
  if (metric === "cost") {
    const top = niceCeiling(max)
    const step = top / 4
    return { top, format: (value) => formatUsdAxis(value, step) }
  }
  const top = niceCeiling(max, 1)
  return {
    top,
    format: metric === "tokens" ? formatTokens : formatNumber,
  }
}

// ---------- the share card ----------

/**
 * What the share card shows: what the chart shows. With subscription usage
 * left out, every cost on it, totals, series and per model, is the billed one.
 */
export function shareFigures(
  summary: UsageSummary,
  modelRows: readonly UsageBreakdownRow[],
  withSubscription: boolean,
): {
  totals: UsageTotals
  series: UsageSeriesPoint[]
  modelRows: UsageBreakdownRow[]
} {
  if (withSubscription) {
    return {
      totals: summary.totals,
      series: summary.series,
      modelRows: [...modelRows],
    }
  }
  return {
    totals: { ...summary.totals, cost: billedOf(summary.totals) },
    series: summary.series.map((point) => ({
      ...point,
      cost: billedOf(point),
    })),
    modelRows: modelRows.map((row) => ({ ...row, cost: billedOf(row) })),
  }
}

// ---------- the table's order ----------

/**
 * What the server ranks the breakdown by for the table's sort, so the top N it
 * keeps are the top N of that column rather than of the share. `value` is the
 * metric on screen, as the chart ranks it. The server orders `name` by its own
 * label, or the key where it has none, so where the page names a row otherwise
 * (a member by attribution label, "You"; a channel by its description) A to Z
 * can read slightly out of order. Not re-sorted here: these are only the top N.
 */
export function breakdownRankFor(
  sort: TableSort,
  metric: Metric,
  withSubscription: boolean,
): { by: UsageBreakdownRankBy; order: UsageRankOrder } {
  const by: Record<SortKey, UsageBreakdownRankBy> = {
    value: rankByFor(metric, withSubscription),
    name: "name",
    requests: "requests",
    tokens: "tokens",
    billed: "billed",
    subscription: "imported",
    failed: "errors",
    p95: "p95",
  }
  return { by: by[sort.key], order: sort.order }
}

/**
 * The server's rows in the server's order, except that the rows with no value
 * ("No session", "Direct") and the fold always come last: they explain the rest
 * rather than rank among them. A stable partition, so it reorders nothing else.
 */
export function placeUnranked(
  rows: readonly UsageBreakdownRow[],
): UsageBreakdownRow[] {
  return [
    ...rows.filter((row) => !row.is_other && row.key !== null),
    ...rows.filter((row) => !row.is_other && row.key === null),
    ...rows.filter((row) => row.is_other),
  ]
}

/** The order a column sorts in first: names A to Z, figures largest first. */
function firstOrder(key: SortKey): "asc" | "desc" {
  return key === "name" ? "asc" : "desc"
}

/** A header's next sort: its first order, the other, then back to the share. */
export function nextSort(current: TableSort, key: SortKey): TableSort {
  const first = firstOrder(key)
  if (current.key !== key) return { key, order: first }
  if (current.order === first) {
    return { key, order: first === "asc" ? "desc" : "asc" }
  }
  return { key: "value", order: "desc" }
}
