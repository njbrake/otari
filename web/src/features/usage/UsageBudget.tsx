import type { WorkspaceSpend } from "@/client"
import { SpendMeter } from "@/design-system/metrics/SpendMeter"
import { describeBudgetPeriod } from "@/features/activity/WorkspaceBudget"
import {
  formatPct,
  formatUsd,
  formatUsdHeadline,
} from "@/shared/helpers/format"

// Where the figure starts warning, and where it reads as nearly spent.
const NEAR_LIMIT = 0.75
const AT_LIMIT = 0.9

/**
 * The workspace's spend against its ceiling this period: billed spend only,
 * since subscription usage counts toward no limit. Nothing renders for a
 * workspace without a dollar ceiling.
 */
export function UsageBudget({ spend }: { spend: WorkspaceSpend | undefined }) {
  // A null `spent` is withheld from this caller, so there is no dollar figure to show.
  if (!spend?.max_budget || spend.spent === null) return null
  const share = spend.spent / spend.max_budget
  const period = describeBudgetPeriod(spend)
  return (
    // The rule sets it off from the window beside it on a wide row; on a
    // phone the row wraps and it starts a line of its own, with no rule to lean
    // on.
    <span className="flex items-center gap-3.5 xl:border-l xl:border-border xl:pl-4">
      <span className="flex flex-col gap-0.5">
        <span className="text-overline">
          Workspace budget{period ? ` · ${period}` : ""}
        </span>
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-mono-caption text-foreground">
            {formatUsd(spend.spent)}
          </span>
          <span className="text-caption text-subtle">
            of {formatUsdHeadline(spend.max_budget)}, billed only
          </span>
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <span
          className={`text-mono-caption ${
            share >= AT_LIMIT
              ? "text-danger"
              : share >= NEAR_LIMIT
                ? "text-warning"
                : "text-foreground"
          }`}
        >
          {formatPct(share, 0)}
        </span>
        <span className="w-30">
          <SpendMeter
            spent={spend.spent}
            allocated={spend.max_budget}
            nearLimitAt={NEAR_LIMIT}
            ariaLabel={`Workspace budget used: ${formatUsd(spend.spent)} of ${formatUsd(spend.max_budget)}`}
          />
        </span>
      </span>
    </span>
  )
}
