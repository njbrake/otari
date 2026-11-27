import type { UsageSummary } from "@/client"
import {
  type PersonCut,
  personCutOf,
} from "@/features/people/personBreakdownModel"
import { type SpendWindow, usageRange } from "@/features/spend/period"
import type { BreakdownSort } from "@/features/usage/breakdownSort"
import { NO_BREAKDOWNS, useUsageSummary } from "@/shared/api/usage"

export interface PersonSpend {
  budgeted: UsageSummary | undefined
  exempt: UsageSummary | undefined
  /** The cut's breakdown over all their spend, ranked by the table's sort, with each value's p95. */
  breakdown: UsageSummary | undefined
  /** Either total has no answer yet, or the breakdown has none. */
  isLoading: boolean
  /**
   * The breakdown on screen is a previous cut's, window's or sort's, kept while
   * the new one loads: right for nothing in the table.
   */
  isStale: boolean
  error: unknown
}

/**
 * One person's spend over a window: what counts toward a budget and what does
 * not, as totals, and the cut's one breakdown over both, each row carrying
 * what of it was charged. Over the caller's whole organization, as the
 * person's figures beside it are.
 */
export function usePersonSpend(
  userId: string,
  window: SpendWindow,
  cut: PersonCut,
  sort: BreakdownSort,
  isEnabled = true,
): PersonSpend {
  const filters = { user_id: [userId], ...usageRange(window) }
  const { dimension } = personCutOf(cut)
  const budgeted = useUsageSummary(
    { ...filters, counts_toward_budget: true },
    "day",
    NO_BREAKDOWNS,
    isEnabled,
    "organization",
  )
  const exempt = useUsageSummary(
    { ...filters, counts_toward_budget: false },
    "day",
    NO_BREAKDOWNS,
    isEnabled,
    "organization",
  )
  const breakdown = useUsageSummary(
    filters,
    "day",
    [dimension],
    isEnabled,
    "organization",
    { p95By: dimension, rank: { by: sort.key, order: sort.order } },
  )
  return {
    budgeted: budgeted.data,
    exempt: exempt.data,
    breakdown: breakdown.data,
    isLoading:
      (budgeted.isPending && !budgeted.data) ||
      (exempt.isPending && !exempt.data) ||
      (breakdown.isPending && !breakdown.data),
    isStale: breakdown.isPlaceholderData,
    error: budgeted.error ?? exempt.error ?? breakdown.error,
  }
}
