import { type SpendWindow, usageRange, windowOf } from "@/features/spend/period"
import { useUsageSummary } from "@/shared/api/usage"

export interface SpendDetail {
  /** What counted toward a budget over the window; undefined until read. */
  charged: number | undefined
  /** Spend since local midnight, for a window that runs on past today's start. */
  today: number | undefined
  /** Successful requests with no price over the window. */
  unpriced: number | undefined
}

/**
 * The figures under Home's Spent and Failures, over the page's own scope: the
 * window's charged spend (the usage summary's `counts_toward_budget` filter,
 * as a person's page reads it), today's spend where the window reaches today
 * and is longer than it, and how many requests went unpriced. Totals only.
 */
export function useSpendDetail({
  window,
  now,
  workspaceId,
  userId,
  isEnabled = true,
}: {
  window: SpendWindow
  now: number
  workspaceId?: string
  userId?: string
  isEnabled?: boolean
}): SpendDetail {
  const scope = {
    workspace_id: workspaceId || undefined,
    user_id: userId ? [userId] : undefined,
  }
  const charged = useUsageSummary(
    { ...scope, ...usageRange(window), counts_toward_budget: true },
    window.bucket,
    [],
    isEnabled,
    "organization",
  )
  const hasToday = window.end === "" && window.kind !== "today"
  const today = windowOf("today", now)
  const todaySpend = useUsageSummary(
    { ...scope, ...usageRange(today) },
    "hour",
    [],
    isEnabled && hasToday,
    "organization",
  )
  const unpriced = useUsageSummary(
    { ...scope, ...usageRange(window), status: "success", priced: false },
    window.bucket,
    [],
    isEnabled,
    "organization",
  )
  // A previous window's answer is held while the new one loads; it is not
  // this window's.
  const current = <T>(query: { data?: T; isPlaceholderData: boolean }) =>
    query.isPlaceholderData ? undefined : query.data
  return {
    charged: current(charged)?.totals.cost,
    today: hasToday ? current(todaySpend)?.totals.cost : undefined,
    unpriced: current(unpriced)?.totals.request_count,
  }
}
