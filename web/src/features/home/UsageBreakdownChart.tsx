import type { UsageGroupBy, UsageGroupRow, UsageSeriesPoint } from "@/client"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { ChartLegend, TrendChart } from "@/design-system/metrics/charts"
import { Segmented } from "@/design-system/navigation/Segmented"
import {
  bucketStarts,
  draggedSpan,
  type FoldedChart,
  foldSeries,
  formatBucket,
  formatMetric,
  formatMetricAxis,
  METRICS,
  type Metric,
  placeholderSeries,
} from "@/features/home/usageChartModel"
import { type SpendWindow, usageRange } from "@/features/spend/period"
import { useUsageGroupedSeries } from "@/shared/api/usage"

export interface BreakdownChart {
  chart: FoldedChart
  /** Every bucket's start, empty ones included. */
  starts: number[]
  /** The breakdown's own series has not arrived; the bars are placeholders. */
  isLoading: boolean
  isEmpty: boolean
  isError: boolean
}

/**
 * The usage chart's bars for the page's window and breakdown, which the chart
 * draws and the share image paints: one read, whoever asks.
 */
export function useBreakdownChart({
  window,
  now,
  workspaceId,
  userId,
  groupBy,
  labelOf,
  metric,
  isIncludingNotCharged,
  totals,
  colorWindow,
  isEnabled = true,
}: {
  window: SpendWindow
  /**
   * The page's own window, before a drag narrowed it: the groups take their
   * colors from their ranking there, over all spend, so neither a drag nor the
   * not-charged toggle repaints them.
   */
  colorWindow: SpendWindow
  now: number
  workspaceId?: string
  userId?: string
  /** Undefined until the page knows which breakdown it shows. */
  groupBy: UsageGroupBy | undefined
  labelOf: (group: UsageGroupRow) => string
  metric: Metric
  isIncludingNotCharged: boolean
  /** The window's ungrouped series, for the placeholder bars. */
  totals: readonly UsageSeriesPoint[]
  isEnabled?: boolean
}): BreakdownChart {
  const grouped = useUsageGroupedSeries(
    {
      workspace_id: workspaceId || undefined,
      user_id: userId ? [userId] : undefined,
      ...usageRange(window),
      counts_toward_budget: isIncludingNotCharged ? undefined : true,
    },
    window.bucket,
    groupBy ?? null,
    isEnabled,
    "organization",
  )
  const isOwnRanking =
    isIncludingNotCharged &&
    colorWindow.start === window.start &&
    colorWindow.end === window.end
  const ranking = useUsageGroupedSeries(
    {
      workspace_id: workspaceId || undefined,
      user_id: userId ? [userId] : undefined,
      ...usageRange(colorWindow),
    },
    colorWindow.bucket,
    groupBy ?? null,
    isEnabled && !isOwnRanking,
    "organization",
  )
  const starts = bucketStarts(window, now)
  // Another window's or breakdown's answer stands in while this one loads, and
  // an answer without groups is no breakdown at all (a mock, or a proxy's
  // page): either way the placeholder bars stay up.
  const data =
    grouped.isPlaceholderData || !Array.isArray(grouped.data?.groups)
      ? undefined
      : grouped.data
  const rankingGroups =
    isOwnRanking || ranking.isPlaceholderData ? undefined : ranking.data?.groups
  // Until the page's ranking has answered, the bars wait for it rather than
  // draw in colors they would then trade; a ranking that failed leaves the
  // window's own.
  const isRankingPending =
    !isOwnRanking && !Array.isArray(rankingGroups) && !ranking.isError
  const order = Array.isArray(rankingGroups)
    ? rankingGroups.filter((group) => !group.is_other).map((group) => group.key)
    : undefined
  const chart =
    data && !isRankingPending
      ? foldSeries({ data, starts, metric, labelOf, order })
      : placeholderSeries({
          // The totals include spend no budget counted, so they stand in only
          // where the chart will show it too.
          totals: isIncludingNotCharged ? totals : [],
          starts,
          metric,
        })
  return {
    chart,
    starts,
    isLoading: data === undefined || isRankingPending,
    isEmpty:
      data !== undefined &&
      !isRankingPending &&
      chart.points.every((point) =>
        chart.series.every((one) => !(Number(point[one.key]) > 0)),
      ),
    isError: grouped.isError && !grouped.data,
  }
}

/**
 * The window's spend over time, each bar stacked from the four largest groups
 * of the breakdown the table under it shows and one Other for the rest. Cost,
 * tokens or requests; charged spend only, or with what counted toward no
 * budget too. A drag across the bars (or a click on one) narrows the page's
 * window to that span; the window picker above is the keyboard's way to the
 * same thing. While another breakdown's series loads, the window's totals
 * stand in as grey bars, so the chart keeps its shape.
 */
export function UsageBreakdownChart({
  view,
  window,
  cutLabel,
  metric,
  onMetric,
  isIncludingNotCharged,
  onIncludeNotCharged,
  hasNotCharged,
  onSelectSpan,
}: {
  view: BreakdownChart
  window: SpendWindow
  /** The breakdown, lowercase, for the chart's name: "models". */
  cutLabel: string
  metric: Metric
  onMetric: (next: Metric) => void
  isIncludingNotCharged: boolean
  onIncludeNotCharged: (next: boolean) => void
  /** Whether the window spent anything that counted toward no budget. */
  hasNotCharged: boolean
  onSelectSpan: (span: { start: string; end: string }) => void
}) {
  const { chart, starts, isLoading, isEmpty } = view

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Segmented
          label="Chart shows"
          options={METRICS}
          value={metric}
          onChange={(next) => onMetric(next as Metric)}
        />
        {hasNotCharged || !isIncludingNotCharged ? (
          <Checkbox
            isSelected={isIncludingNotCharged}
            onChange={onIncludeNotCharged}
            hasTouchTarget={false}
            className="max-sm:min-h-11 max-sm:items-center"
          >
            Include not charged
          </Checkbox>
        ) : null}
      </div>
      {view.isError ? (
        <EmptyMessage>Could not load the chart.</EmptyMessage>
      ) : (
        <div className="flex flex-col gap-2" aria-busy={isLoading}>
          <TrendChart
            data={chart.points}
            series={chart.series}
            formatValue={(value) => formatMetric(metric, value)}
            formatYTick={(value) => formatMetricAxis(metric, value)}
            formatXTick={(x) => formatBucket(window.bucket, x)}
            formatTooltipLabel={(x) => `${formatBucket(window.bucket, x)} UTC`}
            selectHint="Drag to narrow the window"
            ariaLabel={`${
              METRICS.find((one) => one.value === metric)?.label ?? "Cost"
            } per ${window.bucket} by ${cutLabel}${
              isIncludingNotCharged ? "" : ", charged only"
            }. Drag across bars to narrow the window.`}
            height={180}
            showYAxis
            showTotal
            integerY={metric !== "cost"}
            onSelectRange={(lo, hi) => {
              const span = draggedSpan(starts, window.bucket, lo, hi)
              if (span) onSelectSpan(span)
            }}
          />
          {isLoading ? (
            <span className="text-caption">Loading the breakdown</span>
          ) : isEmpty ? (
            <span className="text-caption">Nothing to chart here.</span>
          ) : (
            <ChartLegend series={chart.series} />
          )}
        </div>
      )}
    </div>
  )
}
