import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { InlineList } from "@/design-system/layout/InlineList"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import { BudgetChart } from "@/features/home/BudgetChart"
import {
  budgetLine,
  canProject,
  dailyTotals,
  dayLabel,
  monthFromUrl,
  monthName,
  monthRange,
  offeredMonths,
  projectMonth,
  runningTotal,
} from "@/features/home/budgetMonth"
import { NO_BREAKDOWNS, useUsageSummary } from "@/shared/api/usage"
import { formatUsd } from "@/shared/helpers/format"

/**
 * Home's month against its budget: the charged running total for a calendar
 * month (UTC, as budgets reset), the month picker over this one and the eleven
 * before it, and a line under the title that says where the month stands. It
 * complements the figures above it, which read the page's window, by reading
 * the one period a monthly budget is measured over.
 */
export function MonthBudget({
  monthKey,
  onMonth,
  now,
  workspaceId,
  userId,
  isEnabled = true,
  budget,
  capLabel,
  spendLabel = "Charged so far",
  noBudgetFact,
}: {
  /** The URL's `month`, "" for this one. */
  monthKey: string
  onMonth: (key: string) => void
  now: number
  workspaceId?: string
  /** Narrows the month to one person's spend. */
  userId?: string
  isEnabled?: boolean
  /**
   * The monthly budget the total is measured against, if one applies: its
   * amount, when its counter began, and what it has counted this period,
   * where the caller may read them.
   */
  budget: { cap: number; startedAt?: number; counter?: number } | undefined
  /** What the budget line is called: "Team budget", "Your limit". */
  capLabel: string
  spendLabel?: string
  /** Said beside the month's spend where no monthly budget applies: "no monthly team budget". */
  noBudgetFact: string
}) {
  const months = offeredMonths(now)
  const month = monthFromUrl(monthKey, now)
  const summary = useUsageSummary(
    {
      workspace_id: workspaceId || undefined,
      user_id: userId ? [userId] : undefined,
      ...monthRange(month),
      counts_toward_budget: true,
    },
    "day",
    NO_BREAKDOWNS,
    isEnabled,
    "organization",
  )
  // Another month's answer stands in while this one loads; it is not this
  // month's, so the chart waits rather than draw it under this month's name.
  const data = summary.isPlaceholderData ? undefined : summary.data
  const totals = data ? runningTotal(dailyTotals(data.series, month)) : []
  const spent = totals.at(-1) ?? 0
  const line = budget
    ? budgetLine({
        cap: budget.cap,
        totals,
        month,
        startedAt: budget.startedAt,
        counter: budget.counter,
      })
    : undefined
  const projection = projectMonth(
    totals,
    month,
    month.isCurrent ? line : undefined,
    now,
  )
  const capName = (
    month.isCurrent ? (budget ? capLabel : "") : `${capLabel} today`
  ).toLowerCase()
  const facts: string[] = []
  if (data) {
    if (!line) {
      facts.push(`${formatUsd(spent)} charged`)
      if (noBudgetFact) facts.push(noBudgetFact)
    } else if (line.base > 0 || line.fromDay > 0) {
      // Part of the month is not on the budget's counter: say both.
      facts.push(`${formatUsd(spent)} charged`)
      facts.push(
        `${formatUsd(spent - line.base)} of ${formatUsd(line.cap)} ${capName}${
          line.fromDay > 0 ? ` since ${dayLabel(month, line.fromDay + 1)}` : ""
        }`,
      )
    } else {
      facts.push(
        `${formatUsd(spent)} charged of ${formatUsd(line.cap)} ${capName}`,
      )
    }
    if (canProject(month, now) && projection.projected.length > 0) {
      facts.push(`on pace for ${formatUsd(projection.end)}`)
    }
  }

  return (
    <section aria-label="Monthly budget" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-title">Month against the budget</h2>
          <p className="text-caption">
            {data ? (
              <InlineList>
                {facts.map((fact) => (
                  <span key={fact}>{fact}</span>
                ))}
              </InlineList>
            ) : summary.isError ? (
              "Could not load"
            ) : (
              "Loading"
            )}
          </p>
        </div>
        <FilterSelect
          ariaLabel="Month"
          value={month.key}
          onChange={onMonth}
          options={months.map((one) => ({
            value: one.key,
            label: monthName(one),
          }))}
        />
      </div>
      {data ? (
        <BudgetChart
          month={month}
          now={now}
          totals={totals}
          line={line}
          capLabel={capLabel}
          spendLabel={spendLabel}
        />
      ) : summary.isError ? (
        <EmptyMessage>Could not load this month's spend.</EmptyMessage>
      ) : (
        <Skeleton className="h-52 w-full" />
      )}
    </section>
  )
}
