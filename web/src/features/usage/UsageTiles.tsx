import { Link } from "@tanstack/react-router"
import type { UsageSummary, UsageTotals } from "@/client"
import { Sparkline } from "@/design-system/metrics/charts"
import { KpiCell } from "@/design-system/metrics/KpiCell"
import { KpiStrip } from "@/design-system/metrics/KpiStrip"
import {
  formatNumber,
  formatPct,
  formatTokens,
  formatUsd,
} from "@/shared/helpers/format"
import type { DashboardSearch } from "@/shared/helpers/search"
import { CostSplit } from "./CostSplit"
import { SplitBar } from "./SplitBar"
import { describeGrowth } from "./usageModel"
import { billedTokenTotal, cacheSums } from "./usageTotals"

/**
 * The three numbers the page answers with. The total is what this usage
 * would cost at API prices, split straight away into what was billed (and
 * counts toward limits) and what a subscription covered, so the headline is
 * never mistaken for the bill. Growth is a multiple or a percentage against
 * the window before, never a red "+1820%" off a near-empty baseline.
 */
export function UsageTiles({
  summary,
  previous,
  windowLabel,
  unpricedSearch,
  isLoading = false,
}: {
  summary: UsageSummary | undefined
  /** The window before's totals; none for a dragged span. */
  previous: UsageTotals | undefined
  /** How the window before is named: "30d". */
  windowLabel: string
  /** Activity's search for the unpriced requests, where Activity can show them. */
  unpricedSearch: DashboardSearch | undefined
  /** The summary has not answered yet, as opposed to failing. */
  isLoading?: boolean
}) {
  const totals = summary?.totals
  const total = totals?.cost ?? 0
  const subscription = totals?.imported_cost ?? 0
  const billed = Math.max(0, total - subscription)
  const requests = totals?.request_count ?? 0
  const failed = totals?.error_count ?? 0
  const unpriced = totals?.unpriced_requests ?? 0
  const series = summary?.series ?? []
  const tokens = billedTokenTotal(totals) ?? 0
  const cache = cacheSums(series)
  const fromCache = tokens > 0 ? cache.read / tokens : 0
  const growth = (
    current: number,
    before: number | undefined,
    format: (value: number) => string,
  ) => {
    const text = describeGrowth(current, before, windowLabel, format)
    return text ? <span className="text-muted">{text}</span> : undefined
  }

  return (
    <KpiStrip isEmpty={!summary} columns={3}>
      <KpiCell
        label="Total at API prices"
        isLoading={isLoading}
        value={formatUsd(total)}
        delta={growth(total, previous?.cost, formatUsd)}
        subline={
          unpriced > 0 ? (
            unpricedSearch ? (
              <Link
                to="/activity"
                search={unpricedSearch}
                className="text-link underline-offset-2 hover:underline focus-visible:otari-focus-ring"
              >
                {formatNumber(unpriced)} unpriced
              </Link>
            ) : (
              `${formatNumber(unpriced)} unpriced`
            )
          ) : (
            "Billed + subscription"
          )
        }
        graphic={<CostSplit billed={billed} subscription={subscription} />}
      />
      <KpiCell
        label="Requests"
        isLoading={isLoading}
        value={formatNumber(requests)}
        delta={growth(requests, previous?.request_count, formatNumber)}
        subline={
          <span className={failed ? "text-danger" : undefined}>
            {formatNumber(failed)} failed
            {failed ? ` (${formatPct(failed / Math.max(requests, 1))})` : ""}
          </span>
        }
        graphic={
          series.length > 1 ? (
            <Sparkline
              values={series.map((point) => point.requests)}
              ariaLabel="Request trend"
              height={40}
            />
          ) : undefined
        }
      />
      <KpiCell
        label="Tokens"
        isLoading={isLoading}
        value={formatTokens(tokens)}
        delta={growth(tokens, billedTokenTotal(previous), formatTokens)}
        subline={`${formatPct(fromCache, 0)} from cache`}
        graphic={
          <span className="flex w-full flex-col gap-1.5 pt-3.5">
            <SplitBar
              ariaLabel={`${formatPct(fromCache, 0)} of tokens from cache`}
              parts={[
                { value: cache.read, className: "bg-chart-ramp-4" },
                {
                  value: Math.max(0, tokens - cache.read),
                  className: "bg-chart-ramp-1",
                },
              ]}
            />
            <span className="flex justify-between gap-3 text-mono-micro text-subtle">
              <span>cache</span>
              <span>fresh + output</span>
            </span>
          </span>
        }
      />
    </KpiStrip>
  )
}
