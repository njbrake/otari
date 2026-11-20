import type { UsageSeriesPoint } from "@/client"

/**
 * The calendar month Home's budget chart reads. Months are UTC, because the
 * budgets they are read against reset on the 1st in UTC (`aligned_window` on
 * the gateway) and the usage series buckets its days in UTC too, so a local
 * month would split a day's bar across two of them.
 */

const DAY_MS = 86_400_000

/** How far back the month picker reaches, this month included. */
export const MONTHS_OFFERED = 12

export interface Month {
  /** "2026-11". */
  key: string
  /** The month's first instant. */
  start: number
  /** The next month's first instant. */
  end: number
  /** How many days it has. */
  length: number
  /** Days of it that have begun: all of them once it is over, none before. */
  elapsed: number
  isCurrent: boolean
}

/** The UTC month starting at `year`/`monthIndex`, seen from `now`. */
export function monthAt(year: number, monthIndex: number, now: number): Month {
  const start = Date.UTC(year, monthIndex, 1)
  const end = Date.UTC(year, monthIndex + 1, 1)
  const length = Math.round((end - start) / DAY_MS)
  const isCurrent = now >= start && now < end
  const first = new Date(start)
  return {
    key: `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}`,
    start,
    end,
    length,
    elapsed: isCurrent ? new Date(now).getUTCDate() : now >= end ? length : 0,
    isCurrent,
  }
}

/** The months the picker offers, this one first. */
export function offeredMonths(now: number): Month[] {
  const at = new Date(now)
  return Array.from({ length: MONTHS_OFFERED }, (_, back) =>
    monthAt(at.getUTCFullYear(), at.getUTCMonth() - back, now),
  )
}

/** The month a URL's `month` names, if the picker offers it, else this one. */
export function monthFromUrl(value: string, now: number): Month {
  const months = offeredMonths(now)
  return months.find((month) => month.key === value) ?? months[0]
}

/**
 * Each day's spend for the days of `month` that have begun, from a daily
 * series: a day with no point spent nothing.
 */
export function dailyTotals(
  series: readonly Pick<UsageSeriesPoint, "bucket_start" | "cost">[],
  month: Month,
): number[] {
  const days = new Array<number>(month.elapsed).fill(0)
  for (const point of series) {
    const at = Date.parse(point.bucket_start)
    if (!Number.isFinite(at) || at < month.start || at >= month.end) continue
    const index = Math.floor((at - month.start) / DAY_MS)
    if (index < days.length) days[index] += point.cost
  }
  return days
}

/** Each day's total so far. */
export function runningTotal(values: readonly number[]): number[] {
  let sum = 0
  return values.map((value) => {
    sum += value
    return sum
  })
}

/**
 * The top of the chart's axis: the first 1, 2 or 5 step of a power of ten at
 * or above `peak`, so its midpoint tick is a round figure too.
 */
export function axisTop(peak: number): number {
  if (!(peak > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  return (
    ([1, 2, 5, 10].find((one) => peak <= one * magnitude + 1e-9) ?? 10) *
    magnitude
  )
}

// A pace needs this much of the month behind it, the longer of the two, so one
// early request does not set the month's course.
const PACE_MIN_MS = DAY_MS
const PACE_MIN_SHARE = 0.1

/** Whether the month is under way and has run long enough to project from. */
export function canProject(month: Month, now: number): boolean {
  const ran = now - month.start
  return (
    month.isCurrent &&
    ran >= Math.max(PACE_MIN_MS, (month.end - month.start) * PACE_MIN_SHARE)
  )
}

export interface Projection {
  /** The projected running total for each day after today; empty when none is drawn. */
  projected: number[]
  /** The month's end total: projected while it runs, actual otherwise. */
  end: number
  /** The 1-based day the running total passes `cap`, actual or projected. */
  crossDay: number | undefined
}

/**
 * Where the month is heading: each later day at this month's pace so far,
 * measured over the time it has run, and the day the running total passes
 * `cap`. Nothing is projected for a month that is over, or one too young.
 */
export function projectMonth(
  totals: readonly number[],
  month: Month,
  cap: number | undefined,
  now: number,
): Projection {
  const soFar = totals.at(-1) ?? 0
  const isProjected = canProject(month, now) && soFar > 0
  const rate = isProjected ? (soFar * DAY_MS) / (now - month.start) : 0
  const projected = isProjected
    ? Array.from(
        { length: month.length - month.elapsed },
        (_, index) => rate * (month.elapsed + index + 1),
      )
    : []
  const end = isProjected ? Math.max(soFar, rate * month.length) : soFar
  let crossDay: number | undefined
  if (cap !== undefined && end > cap) {
    const actual = totals.findIndex((total) => total > cap)
    crossDay =
      actual >= 0
        ? actual + 1
        : rate > 0
          ? Math.min(month.length, Math.floor(cap / rate) + 1)
          : undefined
  }
  return { projected, end, crossDay }
}

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
})

/** "Nov 19", for the 1-based `day` of a month. */
export function dayLabel(month: Month, day: number): string {
  return DAY_LABEL.format(month.start + (day - 1) * DAY_MS)
}

/** "November 2026", or "This month" for the one under way. */
export function monthName(month: Month): string {
  return month.isCurrent ? "This month" : MONTH_LABEL.format(month.start)
}

/** "November 2026" whatever the month. */
export function monthTitle(month: Month): string {
  return MONTH_LABEL.format(month.start)
}

/** The month as the usage API's bounds. */
export function monthRange(month: Month): {
  start_date: string
  end_date: string
} {
  return {
    start_date: new Date(month.start).toISOString(),
    end_date: new Date(month.end).toISOString(),
  }
}

/**
 * The amount a limit caps a calendar month at, or undefined for a limit that
 * resets on another cadence, which a month's running total cannot be read
 * against.
 */
export function monthlyCap(
  limit:
    | {
        max: number
        ceiling: { reset_alignment?: string | null }
      }
    | null
    | undefined,
): number | undefined {
  return limit?.ceiling.reset_alignment === "calendar_month"
    ? limit.max
    : undefined
}
