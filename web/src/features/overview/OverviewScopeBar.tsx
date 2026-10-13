import { FiUser } from "react-icons/fi"
import { RefreshButton } from "@/design-system/actions/RefreshButton"
import { Segmented } from "@/design-system/navigation/Segmented"
import { SCOPE_LABELS, type UsageScopeKey } from "@/features/usage/usageQuery"
import { MonthMenu } from "./MonthMenu"
import { describeMonthSoFar } from "./overviewModel"
import type { Month } from "./overviewQuery"

/**
 * Whose numbers, for which calendar month, and what that scope covers. Someone
 * who manages the workspace switches scope; a member reads their own usage,
 * which the server decides, and is told so rather than offered a choice.
 */
export function OverviewScopeBar({
  scopes,
  scope,
  isScopePending = false,
  onScope,
  months,
  month,
  shownMonth,
  days,
  onMonth,
  description,
  onRefresh,
  isFetching,
  updatedAt,
}: {
  scopes: readonly UsageScopeKey[]
  scope: UsageScopeKey
  /** Whether there is a choice of scope waits on the workspace's answer, so none is shown yet. */
  isScopePending?: boolean
  onScope: (scope: UsageScopeKey) => void
  months: readonly Month[]
  /** The month asked for, which the menu shows at once. */
  month: Month
  /** The month whose numbers are on screen, which the caption describes. */
  shownMonth: Month
  /** How far into the month today is, as the server counted it. */
  days: { elapsed: number; length: number }
  onMonth: (key: string) => void
  /** What the scope covers: "Everything in Research, all members". */
  description: string
  onRefresh: () => void
  isFetching: boolean
  updatedAt: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border py-3">
      {isScopePending ? (
        // The scope control's footprint, held while the workspace's answer
        // says whether there is a choice, so the row does not shift when it lands.
        <span aria-hidden className="h-11 w-36 md:h-8" />
      ) : scopes.length > 1 ? (
        <Segmented
          label="Scope"
          value={scope}
          onChange={(next) => onScope(next as UsageScopeKey)}
          options={scopes.map((value) => ({
            value,
            label: SCOPE_LABELS[value],
          }))}
        />
      ) : (
        <span className="flex items-center gap-1.5 text-body whitespace-nowrap">
          <FiUser aria-hidden className="size-3.5 text-muted" />
          Your usage
        </span>
      )}
      <span aria-hidden className="h-5 w-px bg-border max-sm:hidden" />
      <MonthMenu months={months} month={month} onMonth={onMonth} />
      <span className="text-caption">
        {describeMonthSoFar(shownMonth)}
        {shownMonth.isCurrent
          ? ` · day ${days.elapsed} of ${days.length}`
          : null}
      </span>
      <span className="flex min-w-0 items-center justify-between gap-4 max-sm:w-full sm:ml-auto">
        <span className="truncate text-caption text-subtle">{description}</span>
        <RefreshButton
          onRefresh={onRefresh}
          isFetching={isFetching}
          updatedAt={updatedAt || undefined}
        />
      </span>
    </div>
  )
}
