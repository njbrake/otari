import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react"
import { formatNumber } from "@/shared/helpers/format"
import {
  type ChartBar,
  describeBar,
  describeSpan,
  formatBarTime,
  type Span,
} from "./chartBars"

// Past this far a press is a slide rather than a tap.
const SLIDE_PX = 6

/**
 * The phone's request volume: 12 to 15 bars, each a round stretch of the
 * window, and the way to narrow the log to one of them.
 *
 * A drag is unreliable on touch, so a bar is picked rather than a range: tap
 * one, or press and slide across them while the line above reads out the bar
 * under the finger, and lift to apply it. Tapping the picked bar again clears
 * it. Each bar's target is its whole column, gaps and headroom included, so a
 * thumb lands on one even where the bar itself is a sliver. With a keyboard the
 * arrow keys step between bars; the page's Escape clears.
 */
export function PhoneChart({
  bars,
  span,
  onSpan,
}: {
  bars: ChartBar[]
  span: Span | undefined
  onSpan: (span: Span | undefined) => void
}) {
  const plot = useRef<HTMLDivElement>(null)
  // Measured when a press starts, not on every move: reading layout in a
  // pointermove forces a reflow per event.
  const press = useRef<{ x: number; box: DOMRect; isSlide: boolean }>(undefined)
  const [slide, setSlide] = useState<number>()
  const max = Math.max(1, ...bars.map((bar) => bar.ok + bar.failed))
  const barMs = bars.length ? bars[0].end - bars[0].start : 0
  const last = bars.length - 1

  const picked = span
    ? bars.findIndex((bar) => bar.start === span.from && bar.end === span.to)
    : -1
  const hot = slide ?? picked
  const hotBar = hot >= 0 ? bars[hot] : undefined

  const indexAt = (clientX: number, box: DOMRect) =>
    box.width === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            last,
            Math.floor(((clientX - box.left) / box.width) * bars.length),
          ),
        )
  const pick = (index: number) =>
    onSpan({ from: bars[index].start, to: bars[index].end })

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!bars.length || !plot.current) return
    plot.current.setPointerCapture?.(event.pointerId)
    const box = plot.current.getBoundingClientRect()
    press.current = { x: event.clientX, box, isSlide: false }
    setSlide(indexAt(event.clientX, box))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = press.current
    if (!current) return
    if (Math.abs(event.clientX - current.x) > SLIDE_PX) current.isSlide = true
    setSlide(indexAt(event.clientX, current.box))
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = press.current
    if (!current) return
    const index = indexAt(event.clientX, current.box)
    press.current = undefined
    setSlide(undefined)
    if (!current.isSlide && index === picked) onSpan(undefined)
    else pick(index)
  }
  const onPointerCancel = () => {
    press.current = undefined
    setSlide(undefined)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const delta =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
    if (!delta || !bars.length) return
    event.preventDefault()
    pick(Math.max(0, Math.min(last, (picked < 0 ? last : picked) + delta)))
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`flex h-4 gap-2 text-mono-micro whitespace-nowrap ${hotBar ? "text-foreground" : "text-subtle"}`}
      >
        {hotBar ? (
          <>
            <span>{describeSpan(hotBar.start, hotBar.end, barMs)}</span>
            <span className="text-subtle">
              {formatNumber(hotBar.ok)} ok
              {hotBar.failed ? ` · ${formatNumber(hotBar.failed)} failed` : ""}
            </span>
            {slide !== undefined ? (
              <span className="ml-auto text-subtle">release to filter</span>
            ) : null}
          </>
        ) : (
          <span>Tap a bar, or slide across to pick one</span>
        )}
      </div>
      <div
        ref={plot}
        role="slider"
        tabIndex={0}
        aria-label="Filter by time"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, last)}
        aria-valuenow={hot >= 0 ? hot : undefined}
        aria-valuetext={
          hotBar
            ? `${describeSpan(hotBar.start, hotBar.end, barMs)}: ${formatNumber(hotBar.ok)} succeeded, ${formatNumber(hotBar.failed)} failed`
            : "No time filter"
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
        className="flex h-[4.75rem] cursor-pointer touch-none select-none focus-visible:otari-focus-ring"
      >
        {bars.map((bar, index) => (
          <div
            key={bar.start}
            className={`flex flex-1 flex-col justify-end px-[0.09375rem] ${
              index === hot ? "bg-primary-subtle" : ""
            }`}
          >
            <div
              className={`flex h-14 flex-col-reverse ${
                hot >= 0 && index !== hot ? "opacity-35" : ""
              }`}
            >
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
        ))}
      </div>
      <div className="flex justify-between text-mono-micro whitespace-nowrap text-subtle">
        <span>{bars.length ? formatBarTime(bars[0].start, barMs) : ""}</span>
        <span>{describeBar(barMs, true)} bars</span>
        <span>now</span>
      </div>
    </div>
  )
}
