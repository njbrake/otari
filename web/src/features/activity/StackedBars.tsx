import { barMax, type ChartBar } from "./chartBars"

/**
 * A chart's bars, each a column with its succeeded requests stacked under the
 * failed, scaled against the tallest. The failed part keeps a sliver's height
 * whenever there is any, so a lone failure in a busy bar is still seen.
 *
 * Presentational: the plot around it owns the pointer and the keys, and says
 * through the two class callbacks which bars it marks (hovered, picked, dimmed).
 */
export function StackedBars({
  bars,
  columnClassName,
  stackClassName,
}: {
  bars: readonly ChartBar[]
  /** The whole column's, its headroom included. */
  columnClassName: (index: number) => string
  /** The stack's own, which sets its height. */
  stackClassName: (index: number) => string
}) {
  const max = barMax(bars)
  return bars.map((bar, index) => (
    <div
      key={bar.start}
      className={`flex flex-1 flex-col justify-end ${columnClassName(index)}`}
    >
      <div className={`flex flex-col-reverse ${stackClassName(index)}`}>
        <span
          className="bg-accent"
          style={{ height: `${(bar.ok / max) * 100}%` }}
        />
        <span
          className={`bg-danger ${bar.failed ? "min-h-[0.1875rem]" : ""}`}
          style={{ height: `${(bar.failed / max) * 100}%` }}
        />
      </div>
    </div>
  ))
}
