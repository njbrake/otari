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
  isEnabled = true,
}: {
  window: SpendWindow
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
  const starts = bucketStarts(window, now)
  const data = grouped.isPlaceholderData ? undefined : grouped.data
  const chart = data
    ? foldSeries({ data, starts, metric, labelOf })
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
    isLoading: data === undefined,
    isEmpty:
      data !== undefined &&
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
            ariaLabel={`${
              METRICS.find((one) => one.value === metric)?.label ?? "Cost"
            } per ${window.bucket} by ${cutLabel}${
              isIncludingNotCharged ? "" : ", charged only"
            }. Drag across bars to narrow the window.`}
            height={180}
            showYAxis
            showTotal
            yTickCount={4}
            integerY={metric !== "cost"}
            onSelectRange={(lo, hi) => {
              const span = draggedSpan(starts, window.bucket, lo, hi)
              if (span) onSelectSpan(span)
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {isLoading ? (
              <span className="text-caption">Loading the breakdown</span>
            ) : isEmpty ? (
              <span className="text-caption">Nothing to chart here.</span>
            ) : (
              <ChartLegend series={chart.series} />
            )}
            <span className="text-caption max-sm:hidden">
              Drag across the bars to narrow the window. Times are UTC.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
