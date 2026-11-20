import type { UsageSummary } from "@/client"
import { type PersonCut, personCutOf } from "@/features/people/personBreakdown"
import { type SpendWindow, usageRange } from "@/features/spend/period"
import { useUsageSummary } from "@/shared/api/usage"

export interface PersonSpend {
  budgeted: UsageSummary | undefined
  exempt: UsageSummary | undefined
  /** Either read has no answer yet. */
  isLoading: boolean
  /**
   * The answers on screen are a previous cut's or window's, kept while the
   * new one loads: right for the totals, not for the cut's rows.
   */
  isStale: boolean
  error: unknown
}

/**
 * One person's spend over a window, read twice: what counts toward a budget,
 * and what does not. Each read carries the cut's one breakdown, so a switch of
 * cut asks for that dimension alone. Over the caller's whole organization, as
 * the person's figures beside it are.
 */
export function usePersonSpend(
  userId: string,
  window: SpendWindow,
  cut: PersonCut,
  isEnabled = true,
): PersonSpend {
  const filters = { user_id: [userId], ...usageRange(window) }
  const dimensions = [personCutOf(cut).dimension]
  const budgeted = useUsageSummary(
    { ...filters, counts_toward_budget: true },
    "day",
    dimensions,
    isEnabled,
    "organization",
  )
  const exempt = useUsageSummary(
    { ...filters, counts_toward_budget: false },
    "day",
    dimensions,
    isEnabled,
    "organization",
  )
  return {
    budgeted: budgeted.data,
    exempt: exempt.data,
    isLoading:
      (budgeted.isPending && !budgeted.data) ||
      (exempt.isPending && !exempt.data),
    isStale: budgeted.isPlaceholderData || exempt.isPlaceholderData,
    error: budgeted.error ?? exempt.error,
  }
}
