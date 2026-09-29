import { type KeyboardEvent, useRef, useState } from "react"
import { formatCompact, formatNumber } from "@/shared/helpers/format"
import {
  type ChartBar,
  describeSpan,
  formatBarTime,
  type Span,
} from "./chartBars"

const TICKS = 8

/**
 * Requests per bar across the window, succeeded under failed, and the way to
 * narrow the log to a stretch of it: drag across bars, or click one.
 *
 * Its own rather than `TrendChart`, which deliberately ignores a click so that
 * hovering never zooms: here a click on a bar is the commonest way in. It also
 * takes the range from the keyboard, where `TrendChart` leaves that to its
 * callers. The arrow keys move a cursor bar, Shift extends it, Enter applies and
 * Escape clears.
 *
 * The selection is the page's (it lives in the URL as the list's bounds), so
 * this reports a span and draws whichever one it is given.
 */
export function ActivityChart({
  bars,
  span,
  onSpan,
}: {
  bars: ChartBar[]
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
  const barMs = bars.length ? bars[0].end - bars[0].start : 0
  const max = Math.max(1, ...bars.map((bar) => bar.ok + bar.failed))

  const measure = () => {
    box.current = plot.current?.getBoundingClientRect()
  }
  const indexAt = (clientX: number) => {
    const rect = box.current
    if (!rect || rect.width === 0) return 0
    const at = Math.floor(((clientX - rect.left) / rect.width) * bars.length)
    return Math.max(0, Math.min(bars.length - 1, at))
  }
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
  const hovered = hover !== undefined && !drag ? bars[hover] : undefined
  const at = (index: number) => `${(index / bars.length) * 100}%`
  const step = Math.max(1, Math.ceil(bars.length / TICKS))
  const ticks = bars.filter((_, index) => index % step === 0)

  const onKeyDown = (event: KeyboardEvent) => {
    const last = bars.length - 1
    if (event.key === "Escape") {
      if (!cursor && !span) return
      // Handled here, so the page's own Escape does not also close a request.
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
    const delta =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
    if (!delta) return
    event.preventDefault()
    setCursor((current) => {
      const from = current ?? { anchor: last, head: last }
      const head = Math.max(0, Math.min(last, from.head + delta))
      return event.shiftKey
        ? { anchor: from.anchor, head }
        : { anchor: head, head }
    })
  }

  return (
    <div className="flex gap-2">
      <div
        aria-hidden
        className="flex h-24 w-8 shrink-0 flex-col justify-between text-right text-mono-micro text-subtle"
      >
        <span>{formatCompact(max)}</span>
        <span>0</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* A slider over the bars rather than `<input type="range">`,
            which picks one value where this picks a stretch of them. */}
        <div
          ref={plot}
          role="slider"
          tabIndex={0}
          aria-label="Filter by time. Drag or click a bar, or use the arrow keys (Shift to extend) and Enter."
          aria-valuemin={0}
          aria-valuemax={Math.max(0, bars.length - 1)}
          aria-valuenow={selected ? selected[1] : bars.length - 1}
          aria-valuetext={
            selected
              ? describeSpan(
                  bars[selected[0]].start,
                  bars[selected[1]].end,
                  barMs,
                )
              : "No time filter"
          }
          // The pointer is captured for the drag, so releasing outside the
          // plot still ends it where the pointer left.
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture?.(event.pointerId)
            measure()
            const index = indexAt(event.clientX)
            setCursor(undefined)
            setDrag({ anchor: index, head: index })
          }}
          onPointerMove={(event) => {
            const index = indexAt(event.clientX)
            setHover(index)
            if (drag) setDrag({ anchor: drag.anchor, head: index })
          }}
          onPointerUp={(event) => {
            if (!drag) return
            apply(drag.anchor, indexAt(event.clientX))
            setDrag(undefined)
          }}
          onPointerCancel={() => setDrag(undefined)}
          onPointerEnter={measure}
          onPointerLeave={() => setHover(undefined)}
          onKeyDown={onKeyDown}
          onBlur={() => setCursor(undefined)}
          className="relative h-24 cursor-crosshair touch-none select-none border-b border-border focus-visible:otari-focus-ring"
        >
          {selected ? (
            <div
              className="absolute inset-y-0 border-x border-accent bg-primary-subtle"
              style={{
                left: at(selected[0]),
                width: at(selected[1] - selected[0] + 1),
              }}
            />
          ) : null}
          <div
            className={`absolute inset-0 flex items-end ${bars.length > 120 ? "gap-px" : "gap-0.5"}`}
          >
            {bars.map((bar, index) => {
              const isDim =
                selected && (index < selected[0] || index > selected[1])
              return (
                <div
                  key={bar.start}
                  className={`flex h-full flex-1 flex-col-reverse ${
                    isDim ? "opacity-35" : ""
                  } ${hover === index && !drag ? "bg-surface-alt" : ""}`}
                >
                  <div
                    className="bg-accent"
                    style={{ height: `${(bar.ok / max) * 100}%` }}
                  />
                  <div
                    className={`bg-danger ${bar.failed ? "min-h-[0.1875rem]" : ""}`}
                    style={{ height: `${(bar.failed / max) * 100}%` }}
                  />
                </div>
              )
            })}
          </div>
          {selected ? (
            <div
              className="absolute -top-0.5 -translate-y-full bg-foreground px-1.5 text-mono-micro whitespace-nowrap text-background"
              style={{ left: at(selected[0]) }}
            >
              {describeSpan(
                bars[selected[0]].start,
                bars[selected[1]].end,
                barMs,
              )}
            </div>
          ) : null}
          {hovered && hover !== undefined ? (
            <div
              className="pointer-events-none absolute top-1 z-10 flex flex-col border border-border bg-surface px-2.5 py-1.5 whitespace-nowrap"
              style={{ left: `calc(${at(hover)} + 0.875rem)` }}
            >
              <span className="text-mono-caption">
                {describeSpan(hovered.start, hovered.end, barMs)} UTC
              </span>
              <span className="text-caption">
                {formatNumber(hovered.ok)} succeeded
                {hovered.failed
                  ? ` · ${formatNumber(hovered.failed)} failed`
                  : ""}
              </span>
              <span className="text-mono-micro text-subtle">
                click to select · drag for a range
              </span>
            </div>
          ) : null}
        </div>
        <div
          aria-hidden
          className="flex justify-between text-mono-micro text-subtle"
        >
          {ticks.map((bar) => (
            <span key={bar.start}>{formatBarTime(bar.start, barMs)}</span>
          ))}
          {bars.length ? (
            <span>{formatBarTime(bars[bars.length - 1].end, barMs)}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
