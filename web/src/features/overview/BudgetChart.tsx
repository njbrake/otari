import { type KeyboardEvent, useRef, useState } from "react"
import { arrowDelta, barIndexAt, stepBar } from "@/features/activity/chartBars"
import {
  formatUsd,
  formatUsdAxis,
  formatUsdLimit,
  formatUtcMonthName,
} from "@/shared/helpers/format"
import { budgetAxisTop, dayLabel, projectMonth } from "./overviewModel"
import type { Month } from "./overviewQuery"

const TICK_FRACTIONS = [0, 0.5, 1]
const LABELED_DAYS = new Set([1, 8, 15, 22, 29])
// Headroom over the taller of the month's end and the budget, so neither
// touches the top of the plot.
const HEADROOM = 1.12

/**
 * The month's running total of billed spend, a bar a day, against the
 * budget's line: solid for the days that have happened, hatched for the rest
 * at this month's pace so far once it has run long enough to have one, and in
 * danger past the budget. At You, a
 * manager's own share sits under the rest of the workspace's. A month that has
 * ended is drawn against today's budget, the only one stored, so it passes no
 * verdict on it.
 *
 * A member sees no workspace totals, so their chart is their own total alone,
 * with no budget, projection or today line: their share cannot say how close
 * the workspace is.
 *
 * A pointer or the arrow keys read out a day. It picks nothing, unlike
 * Usage's chart: the place to narrow time is Usage, which the header links.
 */
export function BudgetChart({
  month,
  now,
  totals,
  mine,
  cap,
  marksCrossing,
  ownOnly = false,
}: {
  month: Month
  /** The instant the month's pace is measured to. */
  now: number
  /** The running total for each day so far. */
  totals: readonly number[]
  /** The reader's own running total, stacked under `totals`, at You. */
  mine?: readonly number[]
  /** The budget, drawn as a line; none across the organization. */
  cap: number | undefined
  /** Whether the bars are the total the budget is measured against. */
  marksCrossing: boolean
  /** A member's own total, with nothing measured against it. */
  ownOnly?: boolean
}) {
  const plot = useRef<HTMLDivElement>(null)
  const box = useRef<DOMRect>(undefined)
  const [shown, setShown] = useState<number>()
  const projection = projectMonth(
    totals,
    month,
    marksCrossing && month.isCurrent ? cap : undefined,
    now,
  )
  const projected = ownOnly ? [] : projection.projected
  const end = ownOnly ? (totals.at(-1) ?? 0) : projection.end
  const crossDay = ownOnly ? undefined : projection.crossDay
  const count = month.length
  const elapsed = totals.length
  // The days a pointer or the keyboard can read: a member's chart has nothing
  // to say about the days to come.
  const readable = ownOnly ? Math.max(1, elapsed) : count
  const heightOf = (index: number) =>
    index < elapsed ? totals[index] : (projected[index - elapsed] ?? 0)
  const top = budgetAxisTop(Math.max(end, cap ?? 0) * HEADROOM)
  const pct = (value: number) => `${Math.max(0, (value / top) * 100)}%`
  const isPastMiddle = (index: number) => index >= count / 2

  const readOut = (index: number): [string, number][] => {
    if (ownOnly) return [["Yours", totals[index] ?? 0]]
    if (index >= elapsed) return [["Projected", heightOf(index)]]
    if (mine) {
      return [
        ["Yours", mine[index] ?? 0],
        ["Rest of workspace", totals[index] - (mine[index] ?? 0)],
      ]
    }
    return [["Billed so far", totals[index]]]
  }
  const describe = (index: number) =>
    `${dayLabel(month, index + 1)}${index >= elapsed ? ", projected" : ""}: ${readOut(
      index,
    )
      .map(([label, value]) => `${label} ${formatUsd(value)}`)
      .join(", ")}`

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setShown(undefined)
      return
    }
    const delta = arrowDelta(event.key)
    if (!delta) return
    event.preventDefault()
    setShown((current) =>
      stepBar(current ?? Math.max(0, elapsed - 1), delta, readable),
    )
  }

  return (
    <div className="flex select-none">
      <div aria-hidden className="relative h-45 w-13 shrink-0">
        {TICK_FRACTIONS.map((fraction) => (
          <span
            key={fraction}
            className="absolute right-2 translate-y-1/2 text-mono-micro whitespace-nowrap text-subtle"
            style={{ bottom: `${fraction * 100}%` }}
          >
            {formatUsdAxis(fraction * top, top / 2)}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div
          ref={plot}
          role="slider"
          tabIndex={0}
          aria-label={`${ownOnly ? "Your billed" : "Billed"} spend in ${formatUtcMonthName(month.start.getTime())}, running total${
            cap !== undefined
              ? `, against ${month.isCurrent ? "a" : "today's"} ${formatUsdLimit(cap)} budget`
              : ""
          }. Use the arrow keys to read a day.`}
          aria-valuemin={1}
          aria-valuemax={readable}
          aria-valuenow={(shown ?? Math.max(0, elapsed - 1)) + 1}
          aria-valuetext={describe(shown ?? Math.max(0, elapsed - 1))}
          onPointerEnter={() => {
            box.current = plot.current?.getBoundingClientRect()
          }}
          onPointerMove={(event) => {
            box.current ??= plot.current?.getBoundingClientRect()
            const index = barIndexAt(event.clientX, box.current, count)
            setShown(index < readable ? index : undefined)
          }}
          onPointerLeave={() => setShown(undefined)}
          onKeyDown={onKeyDown}
          onBlur={() => setShown(undefined)}
          className="relative h-45 touch-pan-y border-b border-border focus-visible:otari-focus-ring"
        >
          <div className="absolute inset-0 flex items-end gap-0.5">
            {Array.from({ length: count }, (_, index) => {
              const value = heightOf(index)
              const isActual = index < elapsed
              const isOver = cap !== undefined && value > cap
              return (
                <div
                  key={index}
                  className={`flex h-full flex-1 flex-col-reverse ${
                    shown === index ? "bg-surface-subtle" : ""
                  }`}
                >
                  {isActual && mine ? (
                    <>
                      <span
                        className="bg-accent"
                        style={{ height: pct(mine[index] ?? 0) }}
                      />
                      <span
                        className="border-b border-background bg-chart-cat-other"
                        style={{ height: pct(value - (mine[index] ?? 0)) }}
                      />
                    </>
                  ) : isActual ? (
                    <span
                      className="bg-accent"
                      style={{ height: pct(value) }}
                    />
                  ) : ownOnly ? null : (
                    <span
                      className={`otari-hatch ${isOver ? "otari-hatch--over" : ""}`}
                      style={{ height: pct(value) }}
                    />
                  )}
                </div>
              )
            })}
          </div>
          {cap !== undefined ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground"
              style={{ bottom: pct(cap) }}
            >
              <span className="absolute bottom-0.75 left-1 bg-background px-1 text-mono-micro">
                {month.isCurrent ? "Budget" : "Today's budget"}{" "}
                {formatUsdLimit(cap)}
              </span>
            </div>
          ) : null}
          {crossDay !== undefined ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l border-danger"
              style={{ left: `${((crossDay - 0.5) / count) * 100}%` }}
            >
              <span
                className={`absolute top-0 bg-background px-1 text-mono-micro whitespace-nowrap text-danger ${
                  crossDay > count * 0.7 ? "right-1.5" : "left-1.5"
                }`}
              >
                Over budget ~{dayLabel(month, crossDay)}
              </span>
            </div>
          ) : null}
          {month.isCurrent && !ownOnly ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 border-l border-border"
              style={{ left: `${(elapsed / count) * 100}%` }}
            >
              <span
                className={`absolute top-0 text-mono-micro whitespace-nowrap text-subtle ${
                  elapsed > count * 0.7 ? "right-1.5" : "left-1.5"
                }`}
              >
                Today
              </span>
            </div>
          ) : null}
          {shown !== undefined ? (
            <div
              aria-hidden
              className={`pointer-events-none absolute top-1 z-10 flex min-w-42 flex-col border border-control-border bg-surface text-caption ${
                isPastMiddle(shown) ? "-translate-x-full" : ""
              }`}
              style={{
                left: isPastMiddle(shown)
                  ? `calc(${(shown / count) * 100}% - 0.5rem)`
                  : `calc(${((shown + 1) / count) * 100}% + 0.5rem)`,
              }}
            >
              <span className="border-b border-border px-2.5 py-1.5 text-mono-micro text-subtle">
                {dayLabel(month, shown + 1)}
                {shown >= elapsed ? " · projected" : ""}
              </span>
              {readOut(shown).map(([label, value]) => (
                <span key={label} className="flex gap-3 px-2.5 py-1">
                  <span className="flex-1 text-muted">{label}</span>
                  <span className="text-mono-caption">{formatUsd(value)}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div
          aria-hidden
          className="flex text-mono-micro whitespace-nowrap text-subtle"
        >
          {Array.from({ length: count }, (_, index) => (
            <span key={index} className="relative flex-1">
              {LABELED_DAYS.has(index + 1) ? (
                <span
                  className={`absolute left-1/2 -translate-x-1/2 ${
                    index + 1 === 8 || index + 1 === 22 ? "max-sm:hidden" : ""
                  }`}
                >
                  {dayLabel(month, index + 1)}
                </span>
              ) : null}
              {" "}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
