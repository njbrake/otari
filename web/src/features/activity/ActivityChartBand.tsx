import { FiMove } from "react-icons/fi"
import { TextButton } from "@/design-system/actions/TextButton"
import { ChartLegend } from "@/design-system/metrics/charts"
import { ActivityChart } from "./ActivityChart"
import {
  type ChartBar,
  describeBar,
  describeSpan,
  type Span,
} from "./chartBars"

/** The request-volume band: what the bars count, their key, and the chart. */
export function ActivityChartBand({
  bars,
  span,
  onSpan,
}: {
  bars: ChartBar[]
  span: Span | undefined
  onSpan: (span: Span | undefined) => void
}) {
  const barMs = bars.length ? bars[0].end - bars[0].start : 300_000
  return (
    <div className="flex flex-col gap-[1.375rem] border-b border-border pt-4 pb-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-overline">Requests / {describeBar(barMs)}</span>
        <ChartLegend
          series={[
            { key: "ok", label: "Succeeded", color: "var(--color-primary)" },
            { key: "failed", label: "Failed", color: "var(--color-danger)" },
          ]}
        />
        <span className="ml-auto flex items-center gap-1.5 text-caption text-subtle">
          {span ? (
            <>
              Showing {describeSpan(span.from, span.to, barMs)} ·{" "}
              <TextButton onPress={() => onSpan(undefined)}>Reset</TextButton>
            </>
          ) : (
            <>
              <FiMove aria-hidden className="size-3" />
              Drag or click to filter by time
            </>
          )}
        </span>
      </div>
      <ActivityChart bars={bars} span={span} onSpan={onSpan} />
    </div>
  )
}
