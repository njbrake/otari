import { Link } from "@tanstack/react-router"
import type { UsageSeriesPoint, UsageTotals } from "@/client"
import { Sparkline } from "@/design-system/metrics/charts"
import { KpiCell } from "@/design-system/metrics/KpiCell"
import { KpiStrip } from "@/design-system/metrics/KpiStrip"
import { SpendMeter } from "@/design-system/metrics/SpendMeter"
import { CostSplit } from "@/features/usage/CostSplit"
import { formatNumber, formatPct, formatUsd } from "@/shared/helpers/format"
import type { DashboardSearch } from "@/shared/helpers/search"
import { errorRateHealth } from "./overview"
import type { BudgetView } from "./overviewModel"

const ERROR_WORDS = { ok: "Healthy", warn: "Elevated", alert: "High" } as const

const LINK =
  "text-link underline-offset-2 hover:underline focus-visible:otari-focus-ring"

/**
 * The month in three numbers: the total at API prices split into billed and
 * subscription, the budget it counts against, and how many requests ran and
 * how many failed. A tile whose read has not answered says so rather than
 * showing a zero it does not know.
 */
export function OverviewTiles({
  totals,
  series,
  previousCost,
  comparison,
  todayCost,
  budget,
  failuresSearch,
}: {
  totals: UsageTotals | undefined
  series: readonly UsageSeriesPoint[]
  /** The comparison window's total, once read. */
  previousCost: number | undefined
  /** How the comparison window is named: "Sep 1 – 12", "August". */
  comparison: string
  /** Today's total, while the month runs. */
  todayCost: number | undefined
  budget: BudgetView
  /** Activity's search for the month's failed requests, where it can show them. */
  failuresSearch: DashboardSearch | undefined
}) {
  const total = totals?.cost ?? 0
  const subscription = totals?.imported_cost ?? 0
  const requests = totals?.request_count ?? 0
  const failed = totals?.error_count ?? 0
  const errors = errorRateHealth(totals)
  const failedText = `${formatNumber(failed)} failed`
  const failedTitle =
    failed && requests
      ? `${formatPct(failed / requests)} of requests. Opens Activity filtered to failures.`
      : undefined

  return (
    <KpiStrip isEmpty={false} columns={3}>
      <KpiCell
        label="Total at API prices"
        value={totals ? formatUsd(total) : "—"}
        delta={
          previousCost !== undefined ? (
            <span className="text-muted">
              {comparison} {formatUsd(previousCost)}
            </span>
          ) : undefined
        }
        subline={
          !totals
            ? "no data"
            : todayCost !== undefined
              ? `${formatUsd(todayCost)} today`
              : "month total"
        }
        graphic={
          totals ? (
            <CostSplit
              billed={Math.max(0, total - subscription)}
              subscription={subscription}
              subscriptionLabel="subscription · not billed"
            />
          ) : undefined
        }
      />
      <BudgetCell budget={budget} />
      <KpiCell
        label="Requests"
        value={totals ? formatNumber(requests) : "—"}
        severity={
          errors.status === "neutral"
            ? undefined
            : { status: errors.status, word: ERROR_WORDS[errors.status] }
        }
        subline={
          !totals ? (
            "no data"
          ) : failed > 0 && failuresSearch ? (
            <Link
              to="/activity"
              search={failuresSearch}
              title={failedTitle}
              className={LINK}
            >
              {failedText}
            </Link>
          ) : (
            failedText
          )
        }
        graphic={
          series.length > 1 ? (
            <Sparkline
              values={series.map((point) => point.requests)}
              ariaLabel="Requests per day"
              height={40}
            />
          ) : undefined
        }
      />
    </KpiStrip>
  )
}

function BudgetCell({ budget }: { budget: BudgetView }) {
  if (budget.kind === "unknown") {
    return (
      <KpiCell
        label={budget.label}
        value="—"
        subline={budget.subline}
        graphic={
          budget.line ? (
            <span className="truncate text-caption text-subtle">
              {budget.line}
            </span>
          ) : undefined
        }
      />
    )
  }
  if (budget.kind === "none") {
    return (
      <KpiCell
        label={budget.label}
        value={budget.used === undefined ? "—" : formatUsd(budget.used)}
        subline={budget.subline}
        graphic={
          <span className="flex w-full flex-col gap-1.5 pt-1">
            {/* A dashed rule where the meter would be: nothing to fill. */}
            <span
              aria-hidden
              className="w-full border-t-3 border-dashed border-border"
            />
            <span className="flex flex-wrap items-center gap-x-1.5 text-caption text-subtle">
              <span>{budget.note}</span>
              {budget.action ? (
                <>
                  <span aria-hidden>·</span>
                  <Link to={budget.action.to} className={LINK}>
                    {budget.action.text}
                  </Link>
                </>
              ) : null}
            </span>
          </span>
        }
      />
    )
  }
  return (
    <KpiCell
      label={budget.label}
      value={formatPct(budget.fraction, 0)}
      severity={budget.severity}
      subline={budget.subline}
      graphic={
        <span className="flex w-full flex-col gap-1.5 pt-1">
          <SpendMeter
            spent={budget.used}
            allocated={budget.cap}
            ariaLabel={budget.label}
            className="w-full"
          />
          <span
            className={`truncate text-caption ${budget.isWarning ? "text-warning" : "text-subtle"}`}
          >
            {budget.line}
          </span>
        </span>
      }
    />
  )
}
