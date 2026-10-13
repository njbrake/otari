import type { LinkProps } from "@tanstack/react-router"
import type {
  OverviewAttentionItem,
  OverviewLimitRow,
  OverviewSummary,
  UsageSeriesPoint,
  UsageTotals,
  WorkspaceSpend,
} from "@/client"
import { scopeLabel } from "@/features/budgets/organizationBudget"
import type { Health } from "@/features/overview/overview"
import { BUDGET_WARN, tightestAllocation } from "@/features/overview/overview"
import {
  formatNumber,
  formatPct,
  formatUsd,
  formatUsdLimit,
  formatUtcDay,
  formatUtcMonthName,
} from "@/shared/helpers/format"
import type { Month } from "./overviewQuery"

const DAY_MS = 86_400_000

// ---------- the month's spend ----------

/**
 * Billed spend for each day of the month that has begun, from a daily series:
 * cost less what a subscription covered, since only billed spend counts toward
 * a budget. Days the series does not name spent nothing.
 */
export function billedByDay(
  series: readonly Pick<
    UsageSeriesPoint,
    "bucket_start" | "cost" | "imported_cost"
  >[],
  month: Month,
): number[] {
  const days = new Array<number>(month.elapsed).fill(0)
  for (const point of series) {
    const day = Math.floor(
      (Date.parse(point.bucket_start) - month.start.getTime()) / DAY_MS,
    )
    if (day >= 0 && day < days.length) {
      days[day] += Math.max(0, point.cost - (point.imported_cost ?? 0))
    }
  }
  return days
}

/** What a total billed: its cost less what a subscription covered. */
export function billedOf(totals: UsageTotals): number {
  return Math.max(0, totals.cost - (totals.imported_cost ?? 0))
}

/** The cost of the UTC day `now` falls on, from a daily series. */
export function costOnDay(
  series: readonly Pick<UsageSeriesPoint, "bucket_start" | "cost">[],
  now: Date,
): number {
  const today = now.toISOString().slice(0, 10)
  return (
    series.find((point) => point.bucket_start.slice(0, 10) === today)?.cost ?? 0
  )
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
 * The top of the budget chart's axis: the first 1, 2 or 5 step of a power of
 * ten at or above `peak`, so its midpoint tick is a round figure too.
 */
export function budgetAxisTop(peak: number): number {
  if (peak <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  return (
    ([1, 2, 5, 10].find((one) => peak <= one * magnitude) ?? 10) * magnitude
  )
}

// A pace needs this much of a period behind it, the longer of the two, as
// the server's own projection does (PACE_MIN_ELAPSED, PACE_MIN_SHARE).
const PACE_MIN_ELAPSED_MS = DAY_MS
const PACE_MIN_SHARE = 0.1

/** Whether `elapsed` of a period `length` long is enough run to project from. */
function hasRunToProject(elapsed: number, length: number): boolean {
  return elapsed >= Math.max(PACE_MIN_ELAPSED_MS, length * PACE_MIN_SHARE)
}

/** Whether a running month has had enough of itself to project from by `now`. */
export function canProjectMonth(month: Month, now: number): boolean {
  return (
    month.isCurrent &&
    hasRunToProject(
      now - month.start.getTime(),
      month.end.getTime() - month.start.getTime(),
    )
  )
}

/**
 * Where the month is heading: each later day at this month's pace so far,
 * measured over the exact time it has run, and the day the running total
 * passes `cap`, actual or projected. The pace and the crossing are the Budget
 * tile's and the server's: nothing is projected until the month has run as
 * long as they wait for, nor once it is over.
 */
export function projectMonth(
  totals: readonly number[],
  month: Month,
  cap: number | undefined,
  now: number,
): {
  /** The projected total for each day after today; empty when none is drawn. */
  projected: number[]
  /** The month's end total: projected while it runs, actual otherwise. */
  end: number
  /** The 1-based day the total passes the cap, if it does. */
  crossDay: number | undefined
} {
  const soFar = totals.at(-1) ?? 0
  const isProjected = canProjectMonth(month, now)
  // Spend per day over the time the month has actually run.
  const rate = isProjected
    ? (soFar * DAY_MS) / (now - month.start.getTime())
    : 0
  const projected = isProjected
    ? Array.from(
        { length: month.length - month.elapsed },
        (_, index) => rate * (month.elapsed + index + 1),
      )
    : []
  const end = isProjected ? rate * month.length : soFar
  let crossDay: number | undefined
  if (cap !== undefined && cap > 0 && end > cap) {
    const actual = totals.findIndex((total) => total > cap)
    // The day holding the instant the pace reaches the cap, which is the day
    // the server's crossing date names.
    crossDay = actual >= 0 ? actual + 1 : Math.floor(cap / rate) + 1
  }
  return { projected, end, crossDay }
}

/** "Oct 19", for the 1-based `day` of a month. */
export function dayLabel(month: Month, day: number): string {
  return formatUtcDay(month.start.getTime() + (day - 1) * DAY_MS)
}

/**
 * "Oct 1 – 12, 2026 UTC" for the days a month has had, spaced around the dash
 * as Usage's window caption is (`formatWindowLabel`).
 */
export function describeMonthSoFar(month: Month): string {
  const year = month.start.getUTCFullYear()
  const first = dayLabel(month, 1)
  return month.elapsed > 1
    ? `${first} – ${month.elapsed}, ${year} UTC`
    : `${first}, ${year} UTC`
}

// ---------- the budget ----------

export interface BudgetState {
  status: Exclude<Health, "neutral">
  word: string
}

/**
 * How a budget stands this month: over or near it, at risk when the month's
 * pace passes it, or on track. A month that has ended gets none, since the
 * only budget stored is today's.
 */
export function budgetState(
  fraction: number,
  { pacePasses }: { pacePasses: boolean },
): BudgetState {
  if (fraction >= 1) return { status: "alert", word: "Over budget" }
  if (pacePasses) return { status: "warn", word: "At risk" }
  if (fraction >= BUDGET_WARN) return { status: "warn", word: "Near limit" }
  return { status: "ok", word: "On track" }
}

/**
 * Where a period's settled spend is heading by its end, at its pace so far, or
 * undefined where the period has no end, nothing has settled, or too little of
 * it has passed to project from.
 */
export function paceFor(
  settled: number,
  period: { start?: string | null; end?: string | null },
  now: number,
): { total: number; end: string } | undefined {
  if (!period.start || !period.end || !(settled > 0)) return undefined
  const start = Date.parse(period.start)
  const end = Date.parse(period.end)
  const elapsed = now - start
  if (!(end > start) || !hasRunToProject(elapsed, end - start)) {
    return undefined
  }
  return { total: (settled * (end - start)) / elapsed, end: period.end }
}

/** The last day a period covers, its end being the first instant after it. */
export function lastDayOf(periodEnd: string): string {
  return formatUtcDay(Date.parse(periodEnd) - 1)
}

/** What the Budget tile shows. */
export type BudgetView =
  | {
      kind: "budget"
      label: string
      fraction: number
      used: number
      cap: number
      /** None for a month that has ended: today's budget is no verdict on it. */
      severity?: BudgetState
      /** Under the figure: what was spent of what. */
      subline: string
      /** Under the meter: the pace, or what the month is measured against. */
      line: string
      /** Whether the line warns: the pace passes the budget. */
      isWarning: boolean
    }
  | {
      kind: "none"
      label: string
      /** What was billed, where the reader may see it. */
      used: number | undefined
      subline: string
      note: string
      /** The way to set one, for someone who may. */
      action?: { text: string; to: "/budgets" }
    }
  | {
      kind: "unknown"
      label: string
      subline: string
      line?: string
    }

/**
 * The Budget tile for a scope and month. The workspace's budget at You and
 * Workspace (the reader's share beside it at You), the tightest spend ceiling
 * across the organization. A past month is read against today's budget, the
 * only one there is.
 */
export function budgetView({
  scope,
  month,
  now,
  isManager,
  canSetBudgets,
  spend,
  ownBilled,
  workspaceBilled,
  billed,
  tightest,
  ceilingCount,
  serverPace,
  settledSpent,
}: {
  scope: "you" | "workspace" | "organization"
  month: Month
  now: number
  isManager: boolean
  canSetBudgets: boolean
  /** The workspace budget: null where none is set, undefined while unknown. */
  spend:
    | {
        max_budget: number | null
        spent: number
        period_start: string | null
        period_end: string | null
      }
    | null
    | undefined
  /** The reader's own billed spend this month, at You. */
  ownBilled: number | undefined
  /** The workspace's billed spend this month, where the reader may see it. */
  workspaceBilled: number | undefined
  /** The scope's billed spend this month. */
  billed: number | undefined
  /** The tightest capped ceiling, across the organization. */
  tightest:
    | { name: string; spent: number; allocated: number; pct: number }
    | undefined
  /** How many ceilings there are; null while unknown or hidden. */
  ceilingCount: number | null
  /** The server's word that the budget's pace passes it, and when. */
  serverPace?: { at: string | null }
  /**
   * The budget period's settled spend, where it is known: the month's billed
   * spend, for a budget whose period is this calendar month.
   */
  settledSpent?: number
}): BudgetView {
  const inMonth = month.isCurrent
    ? "this month"
    : `in ${formatUtcMonthName(month.start.getTime())}`
  const lastDay = dayLabel(month, month.length)
  const yours =
    scope === "you" && ownBilled !== undefined
      ? ` · yours ${formatUsd(ownBilled)}`
      : ""
  const paceLine = (used: number | undefined) => {
    if (used === undefined) return "no data"
    if (!month.isCurrent) return "month total"
    const pace = paceFor(
      used,
      { start: month.start.toISOString(), end: month.end.toISOString() },
      now,
    )
    return pace
      ? `On pace for ${formatUsdLimit(Math.round(pace.total))} by ${lastDay}`
      : "so far this month"
  }

  if (scope === "organization") {
    if (tightest) {
      return {
        kind: "budget",
        label: "Tightest budget",
        fraction: tightest.pct,
        used: tightest.spent,
        cap: tightest.allocated,
        severity: month.isCurrent
          ? budgetState(tightest.pct, { pacePasses: false })
          : undefined,
        subline: `${formatUsd(tightest.spent)} of ${formatUsdLimit(tightest.allocated)}`,
        line: `${tightest.name}${/ceiling$/i.test(tightest.name) ? "" : " ceiling"}${
          month.isCurrent ? "" : " · today's cap"
        }`,
        isWarning: false,
      }
    }
    if (ceilingCount === null) {
      return { kind: "unknown", label: "Tightest budget", subline: "no data" }
    }
    return {
      kind: "none",
      label: `Org billed ${inMonth}`,
      used: billed,
      subline: paceLine(billed),
      note:
        ceilingCount === 0 ? "No spend ceilings set" : "No ceiling caps spend",
      action: canSetBudgets
        ? { text: "Set a ceiling", to: "/budgets" }
        : undefined,
    }
  }

  if (spend === undefined) {
    return { kind: "unknown", label: "Workspace budget", subline: "no data" }
  }
  if (spend === null || spend.max_budget === null) {
    const used = isManager ? workspaceBilled : billed
    return {
      kind: "none",
      label: isManager ? `Workspace billed ${inMonth}` : `Billed ${inMonth}`,
      used,
      subline: paceLine(used),
      note: `No workspace budget set${isManager ? yours : ""}`,
      action: canSetBudgets
        ? { text: "Set a budget", to: "/budgets" }
        : undefined,
    }
  }

  const cap = spend.max_budget
  if (month.isCurrent) {
    // The pace is the settled spend's, as the server projects it; the budget's
    // own figure counts holds still in flight, so it is not a rate.
    const pace =
      settledSpent !== undefined
        ? paceFor(
            settledSpent,
            { start: spend.period_start, end: spend.period_end },
            now,
          )
        : undefined
    const fraction = cap > 0 ? spend.spent / cap : spend.spent > 0 ? 1 : 0
    // At risk exactly when the server says the pace passes the budget.
    const pacePasses = serverPace !== undefined
    return {
      kind: "budget",
      label: "Workspace budget",
      fraction,
      used: spend.spent,
      cap,
      severity: budgetState(fraction, { pacePasses }),
      subline: `${formatUsd(spend.spent)} of ${formatUsdLimit(cap)}`,
      line: `${
        pace
          ? `On pace for ${formatUsdLimit(Math.round(pace.total))} by ${lastDayOf(pace.end)}`
          : serverPace?.at
            ? `On pace to pass it ~${formatUtcDay(serverPace.at)}`
            : spend.period_end
              ? `Resets ${formatUtcDay(spend.period_end)}`
              : "No reset date"
      }${yours}`,
      isWarning: pacePasses && fraction < 1,
    }
  }
  if (workspaceBilled === undefined) {
    return {
      kind: "unknown",
      label: "Workspace budget",
      subline: `${formatUsdLimit(cap)} budget`,
      line: `Workspace spend by month is for managers${yours}`,
    }
  }
  const fraction = cap > 0 ? workspaceBilled / cap : workspaceBilled > 0 ? 1 : 0
  return {
    kind: "budget",
    label: "Workspace budget",
    fraction,
    used: workspaceBilled,
    cap,
    subline: `${formatUsd(workspaceBilled)} of today's ${formatUsdLimit(cap)}`,
    line: `Measured against today's budget${yours}`,
    isWarning: false,
  }
}

/**
 * The Budget tile from what the page read. The workspace's billed spend is the
 * scope's own at Workspace, and its separate read beside a manager's at You.
 * The tightest ceiling is named after the limit row it caps where the rail
 * lists one, else after what it caps. The server's pace item for this
 * workspace says whether the budget is at risk, and the month's billed spend
 * is the settled spend to pace from only where the budget's period is this
 * calendar month.
 */
export function readBudget({
  scope,
  month,
  now,
  isManager,
  canSetBudgets,
  workspaceId,
  organizationName,
  totals,
  workspaceTotals,
  spend,
  overview,
}: {
  scope: "you" | "workspace" | "organization"
  month: Month
  now: number
  /** Whether the reader manages the workspace, as the server read them. */
  isManager: boolean
  canSetBudgets: boolean
  /** The workspace on screen; "" for none. */
  workspaceId: string
  organizationName: string
  /** The scope's usage this month, once read. */
  totals: UsageTotals | undefined
  /** The workspace's own usage this month, read beside a manager's at You. */
  workspaceTotals: UsageTotals | undefined
  /** The workspace budget: null where none is set, undefined while unknown. */
  spend:
    | Pick<
        WorkspaceSpend,
        "max_budget" | "spent" | "period_start" | "period_end"
      >
    | null
    | undefined
  overview:
    | Pick<OverviewSummary, "attention" | "ceilings" | "limits">
    | undefined
}): BudgetView {
  const billed = totals ? billedOf(totals) : undefined
  const workspaceBilled =
    scope === "workspace"
      ? billed
      : workspaceTotals
        ? billedOf(workspaceTotals)
        : undefined
  const tightest = tightestAllocation(
    overview?.ceilings,
    (worst) =>
      overview?.limits.rows.find((row) => row.id === worst.scope_id)?.name ??
      (worst.scope_type
        ? scopeLabel(
            { scope_type: worst.scope_type, scope_id: worst.scope_id ?? "" },
            { organizationName, workspaces: [] },
          )
        : worst.budget_id),
  )
  const pace = overview?.attention.find(
    (item) => item.kind === "budget_pace" && item.subject_id === workspaceId,
  )
  const periodIsMonth =
    spend?.period_start != null &&
    spend.period_end != null &&
    Date.parse(spend.period_start) === month.start.getTime() &&
    Date.parse(spend.period_end) === month.end.getTime()
  return budgetView({
    scope,
    month,
    now,
    isManager,
    canSetBudgets,
    // A null `spent` is a figure this caller may not read: unknown, not zero.
    spend:
      spend?.spent === null
        ? undefined
        : spend && { ...spend, spent: spend.spent },
    ownBilled: scope === "you" ? billed : undefined,
    workspaceBilled,
    billed,
    tightest,
    ceilingCount: overview ? (overview.ceilings?.total_count ?? null) : null,
    serverPace: pace ? { at: pace.at ?? null } : undefined,
    settledSpent: periodIsMonth ? workspaceBilled : undefined,
  })
}

/**
 * The comparison under the total: the same days of the month before while a
 * month runs ("Sep 1 – 12", spaced as `describeMonthSoFar` is), the whole
 * month before once it is over ("August").
 */
export function comparisonLabel(before: {
  start: Date
  end: Date
  isWholeMonth: boolean
}): string {
  if (before.isWholeMonth) return formatUtcMonthName(before.start.getTime())
  // The days the window reaches into, the last of them part of a day.
  const days = Math.ceil(
    (before.end.getTime() - before.start.getTime()) / DAY_MS,
  )
  const first = formatUtcDay(before.start.getTime())
  return days > 1 ? `${first} – ${days}` : first
}

// ---------- needs attention ----------

// How many unreachable providers one item names before counting the rest.
const PROVIDERS_NAMED = 2

/** "fireworks, groq +1": the first `most` names, then how many more. */
function namedUpTo(names: readonly string[], most: number): string {
  const rest = names.length - most
  return `${names.slice(0, most).join(", ")}${rest > 0 ? ` +${rest}` : ""}`
}

/**
 * The server's items with every unreachable provider folded into one, where
 * the first of them stood, naming the first two and counting the rest.
 */
export function groupAttention(
  items: readonly OverviewAttentionItem[],
): OverviewAttentionItem[] {
  const providers = items.filter((item) => item.kind === "provider_unreachable")
  if (providers.length < 2) return [...items]
  const merged: OverviewAttentionItem = {
    ...providers[0],
    subject_id: null,
    subject_name: namedUpTo(
      providers.map((item) => item.subject_name ?? "unnamed"),
      PROVIDERS_NAMED,
    ),
    count: providers.length,
  }
  return items.flatMap((item) =>
    item === providers[0]
      ? [merged]
      : item.kind === "provider_unreachable"
        ? []
        : [item],
  )
}

/**
 * What tells one attention item from another across refreshes: its kind and
 * what it is about. The folded provider item has no subject, and is the only
 * one of its kind.
 */
export function attentionKey(
  item: Pick<OverviewAttentionItem, "kind" | "subject_id">,
): string {
  return `${item.kind}:${item.subject_id ?? ""}`
}

export interface AttentionLine {
  text: string
  to?: LinkProps["to"]
  search?: LinkProps["search"]
}

/**
 * One attention item as the line says it and the place it is fixed. A budget
 * item about the workspace on screen is "Workspace … its budget"; about
 * another (a ceiling across the organization) it names that workspace. A
 * provider problem has no page to go to where this deployment serves none, and
 * a budget none where the reader may not open Budgets.
 */
export function describeAttention(
  item: OverviewAttentionItem,
  {
    servesProviders,
    canManageBudgets,
    workspaceId,
    failuresSearch,
  }: {
    servesProviders: boolean
    /** Whether the reader may open Budgets, which only managers reach. */
    canManageBudgets: boolean
    /** The workspace on screen. */
    workspaceId: string | undefined
    /** Activity's search for the month's failed requests, where it has one. */
    failuresSearch: LinkProps["search"] | undefined
  },
): AttentionLine {
  const pct = formatPct(item.fraction ?? 0, 0)
  const limit = item.limit != null ? ` ${formatUsdLimit(item.limit)}` : ""
  const key = item.subject_name ?? "A key"
  const isThisWorkspace =
    item.subject_id !== null && item.subject_id === workspaceId
  const budgets = canManageBudgets ? { to: "/budgets" as const } : {}
  const budget = isThisWorkspace
    ? { who: "Workspace", what: "budget" }
    : { who: item.subject_name ?? "A workspace", what: "ceiling" }
  switch (item.kind) {
    case "provider_unreachable": {
      const count = item.count ?? 1
      return {
        text: `${formatNumber(count)} provider${count === 1 ? "" : "s"} unreachable${
          item.subject_name ? `: ${item.subject_name}` : ""
        }`,
        ...(servesProviders ? { to: "/providers" as const } : {}),
      }
    }
    case "key_near_limit":
      return { text: `${key} at ${pct} of its${limit} limit`, to: "/keys" }
    case "key_over_limit":
      return { text: `${key} over its${limit} limit`, to: "/keys" }
    case "key_expiring":
      return {
        text: item.at
          ? `${key} expires ${formatUtcDay(item.at)}`
          : `${key} expires soon`,
        to: "/keys",
      }
    case "budget_near":
      return {
        text: `${budget.who} at ${pct} of its ${budget.what}`,
        ...budgets,
      }
    case "budget_over":
      return { text: `${budget.who} over its ${budget.what}`, ...budgets }
    case "budget_pace":
      return {
        text: `${budget.who} on pace to pass its ${budget.what}${
          item.at ? ` ~${formatUtcDay(item.at)}` : ""
        }`,
        ...budgets,
      }
    case "error_rate":
      // Activity reads one workspace, so across the organization there is no
      // search to give and the item is said without a link.
      return failuresSearch
        ? {
            text: `Error rate ${formatPct(item.fraction ?? 0)}`,
            to: "/activity",
            search: failuresSearch,
          }
        : { text: `Error rate ${formatPct(item.fraction ?? 0)}` }
  }
}

// ---------- limits ----------

/**
 * How full a limit is, by what its ceiling counts in its own period (the
 * figure the gate enforces), 0 when none caps it.
 */
export function limitFraction(row: OverviewLimitRow): number {
  return row.limit && row.limit > 0
    ? (row.limit_spent ?? row.spent) / row.limit
    : 0
}

/** Whole days until `iso` from `now`, rounded up; 0 or less once it has passed. */
export function daysUntil(iso: string, now: number): number {
  return Math.ceil((Date.parse(iso) - now) / DAY_MS)
}
