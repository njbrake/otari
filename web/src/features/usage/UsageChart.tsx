import { type KeyboardEvent, useRef, useState } from "react"
import {
  arrowDelta,
  axisLabelPlace,
  barIndexAt,
  describeSpan,
  formatBarTime,
  type Span,
  stepBar,
} from "@/features/activity/chartBars"
import type { FoldedSeries } from "./usageModel"

// The y-axis ticks: zero, the top and three between, at round values.
const TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1]
const X_LABELS = 8
const DAY_MS = 86_400_000

/**
 * The window's bars, each stacked from the breakdown's four largest groups and
 * Other in the colors the table repeats, on an axis that names its unit, and
 * the way to narrow the page to a stretch of it: drag across bars, or click
 * one. The keyboard does the same, as Activity's chart takes it: the arrows
 * move a cursor bar, Shift extends it, Enter applies and Escape clears.
 *
 * Its own rather than `TrendChart`, which deliberately ignores a click so that
 * hovering never zooms, while here a click on a bar is the commonest way in;
 * and rather than Activity's chart, which stacks succeeded under failed where
 * this stacks the groups of a breakdown.
 */
export function UsageChart({
  starts,
  barMs,
  folded,
  formatValue,
  axisFor,
  span,
  onSpan,
}: {
  /** Every bucket's start in the window, empty ones included. */
  starts: readonly number[]
  barMs: number
  folded: FoldedSeries
  formatValue: (value: number) => string
  /** The y-axis for the tallest bar: its top, and how a tick reads. */
  axisFor: (max: number) => { top: number; format: (value: number) => string }
  span: Span | undefined
  onSpan: (span: Span | undefined) => void
}) {
  const plot = useRef<HTMLDivElement>(null)
  // Measured when a gesture starts, not on every move: reading layout in a
  // pointermove forces a reflow per event.
  const box = useRef<DOMRect>(undefined)
  const [drag, setDrag] = useState<{ anchor: number; head: number }>()
  const [hover, setHover] = useState<number>()
  const [cursor, setCursor] = useState<{ anchor: number; head: number }>()

  const valuesAt = new Map(
    folded.points.map((point) => [point.start, point.values]),
  )
  const bars = starts.map((start) => {
    const values = valuesAt.get(start) ?? {}
    const total = folded.series.reduce(
      (sum, series) => sum + (values[series.key] ?? 0),
      0,
    )
    return { start, end: start + barMs, values, total }
  })
  const axis = axisFor(Math.max(0, ...bars.map((bar) => bar.total)))
  const top = axis.top
  const count = bars.length

  const measure = () => {
    box.current = plot.current?.getBoundingClientRect()
  }
  const indexAt = (clientX: number) => barIndexAt(clientX, box.current, count)
  const apply = (anchor: number, head: number) =>
    onSpan({
      from: bars[Math.min(anchor, head)].start,
      to: bars[Math.max(anchor, head)].end,
    })

  const selection = drag ?? cursor
  let selected: [number, number] | undefined
  if (selection) {
    selected = [
      Math.min(selection.anchor, selection.head),
      Math.max(selection.anchor, selection.head),
    ]
  } else if (span) {
    const first = bars.findIndex((bar) => bar.end > span.from)
    const last = bars.findLastIndex((bar) => bar.start < span.to)
    if (first >= 0 && last >= first) selected = [first, last]
  }
  // The bar a pointer rests on, or the keyboard's cursor, whose figures the
  // tooltip reads out: a keyboard reader gets them as a pointer does.
  const shown = drag ? undefined : (hover ?? cursor?.head)
  const hovered = shown !== undefined ? bars[shown] : undefined
  const at = (index: number) => `${(index / Math.max(1, count)) * 100}%`
  // A tooltip past the middle hangs leftward, so it never reaches past the
  // plot's right edge and scrolls the page sideways.
  const isPastMiddle = (index: number) => index >= count / 2
  const step = Math.max(1, Math.ceil(count / X_LABELS))

  const onKeyDown = (event: KeyboardEvent) => {
    const last = count - 1
    if (event.key === "Escape") {
      if (!cursor && !span) return
      event.stopPropagation()
      setCursor(undefined)
      if (span) onSpan(undefined)
      return
    }
    if (event.key === "Enter" && cursor) {
      apply(cursor.anchor, cursor.head)
      setCursor(undefined)
      return
    }
    const delta = arrowDelta(event.key)
    if (!delta || !count) return
    event.preventDefault()
    setCursor((current) => {
      const from = current ?? { anchor: last, head: last }
      const head = stepBar(from.head, delta, count)
      return event.shiftKey
        ? { anchor: from.anchor, head }
        : { anchor: head, head }
    })
  }

  return (
    <div className="flex select-none">
      <div aria-hidden className="relative h-49 w-16 shrink-0">
        {TICK_FRACTIONS.map((fraction) => (
          <span
            key={fraction}
            className="absolute right-2.5 translate-y-1/2 text-mono-micro whitespace-nowrap text-subtle"
            style={{ bottom: `${fraction * 100}%` }}
          >
            {axis.format(fraction * top)}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* A slider over the bars rather than `<input type="range">`,
            which picks one value where this picks a stretch of them. */}
        <div
          ref={plot}
          role="slider"
          tabIndex={0}
          aria-label="Filter by date. Drag or click a bar, or use the arrow keys (Shift to extend) and Enter."
          aria-valuemin={0}
          aria-valuemax={Math.max(0, count - 1)}
          aria-valuenow={selected ? selected[1] : Math.max(0, count - 1)}
          aria-valuetext={
            selected
              ? describeSpan(
                  bars[selected[0]].start,
                  bars[selected[1]].end,
                  barMs,
                )
              : "No date filter"
          }
          onPointerDown={(event) => {
            if (event.button !== 0 || !count) return
            event.preventDefault()
            event.currentTarget.setPointerCapture?.(event.pointerId)
            measure()
            const index = indexAt(event.clientX)
            setCursor(undefined)
            setDrag({ anchor: index, head: index })
          }}
          onPointerMove={(event) => {
            if (!count) return
            const index = indexAt(event.clientX)
            setHover(index)
            if (drag) setDrag({ anchor: drag.anchor, head: index })
          }}
          onPointerUp={(event) => {
            if (!drag) return
            const head = indexAt(event.clientX)
            setDrag(undefined)
            // A click on the bar already picked lets it go.
            if (
              drag.anchor === head &&
              span &&
              span.from === bars[head].start &&
              span.to === bars[head].end
            ) {
              onSpan(undefined)
              return
            }
            apply(drag.anchor, head)
          }}
          onPointerCancel={() => setDrag(undefined)}
          onPointerEnter={measure}
          onPointerLeave={() => setHover(undefined)}
          onKeyDown={onKeyDown}
          onBlur={() => setCursor(undefined)}
          className="relative h-49 cursor-crosshair touch-pan-y border-b border-border-strong focus-visible:otari-focus-ring"
        >
          {TICK_FRACTIONS.slice(1).map((fraction) => (
            <span
              key={fraction}
              aria-hidden
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border-subtle"
              style={{ bottom: `${fraction * 100}%` }}
            />
          ))}
          <div
            className={`absolute inset-0 flex items-end ${count > 120 ? "gap-px" : "gap-0.5"}`}
          >
            {bars.map((bar, index) => {
              const isPicked =
                selected !== undefined &&
                index >= selected[0] &&
                index <= selected[1]
              const isDimmed = selected !== undefined && !isPicked
              return (
                <div
                  key={bar.start}
                  className={`flex h-full flex-1 flex-col-reverse ${
                    isPicked
                      ? "bg-primary-subtle"
                      : hover === index && !drag
                        ? "bg-surface-subtle"
                        : ""
                  } ${isDimmed ? "opacity-30" : ""}`}
                >
                  {folded.series.map((series) => {
                    const value = bar.values[series.key] ?? 0
                    return value > 0 ? (
                      <span
                        key={series.key}
                        className="border-t border-background"
                        style={{
                          height: `${Math.max((value / top) * 100, 0.6)}%`,
                          background: series.color,
                        }}
                      />
                    ) : null
                  })}
                </div>
              )
            })}
          </div>
          {hovered && shown !== undefined ? (
            <div
              className={`pointer-events-none absolute top-1 z-10 flex min-w-50 flex-col gap-0.5 border border-border bg-surface px-2.5 py-2 text-caption ${
                isPastMiddle(shown) ? "-translate-x-full" : ""
              }`}
              style={{
                left: isPastMiddle(shown)
                  ? `calc(${at(shown)} - 0.75rem)`
                  : `calc(${at(shown + 1)} + 0.75rem)`,
              }}
            >
              <span className="text-subtle">
                {/* A day bar is named by its day; a shorter one by its span. */}
                {barMs >= DAY_MS
                  ? formatBarTime(hovered.start, barMs)
                  : describeSpan(hovered.start, hovered.end, barMs)}{" "}
                UTC
              </span>
              {folded.series
                .filter((series) => (hovered.values[series.key] ?? 0) > 0)
                .reverse()
                .map((series) => (
                  <span key={series.key} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2 shrink-0"
                      style={{ background: series.color }}
                    />
                    <span className="max-w-44 flex-1 truncate">
                      {series.label}
                    </span>
                    <span className="text-mono-micro">
                      {formatValue(hovered.values[series.key] ?? 0)}
                    </span>
                  </span>
                ))}
              <span className="mt-1 flex gap-2 border-t border-border pt-1">
                <span className="flex-1">Total</span>
                <span className="text-mono-micro">
                  {formatValue(hovered.total)}
                </span>
              </span>
            </div>
          ) : null}
        </div>
        {/* Every `step`th bar is labeled, under that bar's middle: a label is
            wider than a narrow bar, so one under each would collide. Placed
            rather than spread, which drifted off its bar whenever the bars did
            not divide evenly, and pinned inside the plot at either end, where
            a centered one ran past the edge on a phone. */}
        <div
          aria-hidden
          className="relative h-lh text-mono-micro whitespace-nowrap text-subtle"
        >
          {bars.map((bar, index) =>
            index % step === 0 ? (
              <span
                key={bar.start}
                // Half of them on a phone, where eight dates are wider than the plot.
                className={`absolute top-0 ${(index / step) % 2 ? "max-sm:hidden" : ""}`}
                style={axisLabelPlace((index + 0.5) / count)}
              >
                {formatBarTime(bar.start, barMs)}
              </span>
            ) : null,
          )}
        </div>
      </div>
    </div>
  )
}
