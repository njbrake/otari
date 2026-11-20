import type { ShareCard, ShareFigure } from "@/features/home/shareImage"
import {
  type FoldedChart,
  formatBucket,
  formatMetric,
  METRICS,
  type Metric,
} from "@/features/home/usageChartModel"
import type { SpendWindow } from "@/features/spend/period"

/** The share image of Home as it stands: its figures, and the usage chart's bars. */
export function shareCardOf({
  scope,
  window,
  figures,
  chart,
  metric,
  cutLabel,
}: {
  /** Whose usage: "All workspaces", "Platform". */
  scope: string
  window: SpendWindow
  figures: ShareFigure[]
  chart: FoldedChart
  metric: Metric
  /** The breakdown, lowercase: "models". */
  cutLabel: string
}): ShareCard {
  const bars = chart.points.map((point) =>
    Object.fromEntries(
      chart.series.map((one) => [one.key, Number(point[one.key]) || 0]),
    ),
  )
  const peak = Math.max(
    0,
    ...bars.map((bar) => Object.values(bar).reduce((sum, v) => sum + v, 0)),
  )
  const metricLabel = METRICS.find((one) => one.value === metric)?.label
  return {
    title: `Usage, ${window.label}`,
    detail: `${scope} · times in UTC`,
    figures: figures.filter((figure) => figure.value !== "—"),
    chart: {
      title: `${metricLabel ?? "Cost"} per ${window.bucket} by ${cutLabel}`,
      series: chart.series,
      bars,
      firstLabel: chart.points[0]
        ? formatBucket(window.bucket, chart.points[0].x)
        : "",
      lastLabel:
        chart.points.length > 1
          ? formatBucket(window.bucket, chart.points[chart.points.length - 1].x)
          : "",
      peakLabel: formatMetric(metric, peak),
    },
  }
}
