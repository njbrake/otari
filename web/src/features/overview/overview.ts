import type { AllocationHealth, UsageTotals, WorstAllocation } from "@/client"
import { shortBudgetId } from "@/features/budgets/budgetLabel"

// A tile's judgment. "neutral" means nothing to judge (no data, nothing
// capped) and renders with no color, never as green or red.
export type Health = "ok" | "warn" | "alert" | "neutral"

// ---------- error rate ----------

// Thresholds (fractions): >=2% amber, >=10% red. Red is the server's
// `error_rate` attention item (ERROR_RATE_ALERT), and like it no verdict is
// passed under ERROR_RATE_MIN_REQUESTS, where one failure swings the rate.
const ERROR_WARN = 0.02
const ERROR_ALERT = 0.1
const ERROR_MIN_REQUESTS = 20

interface ErrorRateHealth {
  // null when there are no requests to derive a rate from (renders as "—").
  rate: number | null
  status: Health
}

export function errorRateHealth(
  totals: UsageTotals | undefined,
): ErrorRateHealth {
  if (!totals || totals.request_count === 0) {
    return { rate: null, status: "neutral" }
  }
  const rate = totals.error_count / totals.request_count
  if (totals.request_count < ERROR_MIN_REQUESTS) {
    return { rate, status: "neutral" }
  }
  const status: Health =
    rate >= ERROR_ALERT ? "alert" : rate >= ERROR_WARN ? "warn" : "ok"
  return { rate, status }
}

// ---------- budget health ----------

// >=80% of an allocation is near its limit, >=100% over it.
export const BUDGET_WARN = 0.8

interface TightestAllocation {
  name: string
  spent: number
  allocated: number
  pct: number
}

/**
 * The tightest capped row of the server's scan, named and with its share.
 *
 * The gateway decides which row is tightest, because that means reading every
 * row (otari#1425); the name and the percentage are presentation. Undefined
 * where the caller may not see the scan, or nothing in it is capped.
 */
export function tightestAllocation(
  health: AllocationHealth | null | undefined,
  /**
   * What to call the row when nobody named it. A spend ceiling is named after
   * what it caps ("A workspace"), which the id fingerprint below cannot say.
   */
  nameOf?: (worst: WorstAllocation) => string,
): TightestAllocation | undefined {
  if (!health || health.capped_count === 0 || !health.worst) return undefined
  const { worst } = health
  return {
    name: worst.name ?? nameOf?.(worst) ?? shortBudgetId(worst.budget_id),
    spent: worst.spent,
    allocated: worst.allocated,
    // A zero allowance admits nothing, so anything spent against one is over
    // it: a full 100% rather than the infinite ratio, as the gateway ranks it.
    pct:
      worst.allocated > 0
        ? worst.spent / worst.allocated
        : worst.spent > 0
          ? 1
          : 0,
  }
}
