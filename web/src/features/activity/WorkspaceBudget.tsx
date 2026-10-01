import type { WorkspaceSpend } from "@/client"
import { SpendMeter, spendState } from "@/design-system/metrics/SpendMeter"
import {
  formatUsd,
  formatUsdHeadline,
  formatUtcDay,
  formatUtcMonth,
} from "@/shared/helpers/format"

/** "Sep" for a calendar month, "since Sep 22" for any other period, "" before one starts. */
function describeBudgetPeriod(spend: WorkspaceSpend): string {
  if (!spend.period_start) return ""
  const start = new Date(spend.period_start)
  const end = spend.period_end ? new Date(spend.period_end) : undefined
  const isMonth =
    start.getUTCDate() === 1 &&
    end?.getUTCDate() === 1 &&
    (end.getUTCMonth() - start.getUTCMonth() + 12) % 12 === 1
  return isMonth
    ? formatUtcMonth(spend.period_start)
    : `since ${formatUtcDay(spend.period_start)}`
}

/**
 * What the workspace has spent against its ceiling this period, shown to
 * everyone in it: members see the workspace's total, never whose it is.
 * Nothing renders for a workspace without a dollar ceiling, or with one of $0.
 */
export function WorkspaceBudget({
  spend,
  isFullWidth = false,
}: {
  spend: WorkspaceSpend | undefined
  /** A phone's lane, where the meter takes the width the words leave. */
  isFullWidth?: boolean
}) {
  if (!spend?.max_budget) return null
  const period = describeBudgetPeriod(spend)
  return (
    <span
      className={`flex items-center gap-2 text-caption ${isFullWidth ? "w-full" : ""}`}
    >
      <span className="text-subtle">
        Workspace budget{period ? `, ${period}` : ""}
      </span>
      <span
        className={`text-mono-caption ${
          spendState(spend.spent, spend.max_budget) === "over"
            ? "text-danger"
            : "text-foreground"
        }`}
      >
        {formatUsd(spend.spent)} / {formatUsdHeadline(spend.max_budget)}
      </span>
      <span className={isFullWidth ? "flex-1" : "w-16"}>
        <SpendMeter
          spent={spend.spent}
          allocated={spend.max_budget}
          ariaLabel={`Workspace budget used: ${formatUsd(spend.spent)} of ${formatUsd(spend.max_budget)}`}
        />
      </span>
    </span>
  )
}
