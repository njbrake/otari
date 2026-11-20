import { type KeyboardEvent, useRef, useState } from "react"
import {
  axisTop,
  type BudgetLine,
  dayLabel,
  type Month,
  monthTitle,
  projectMonth,
} from "@/features/home/budgetMonth"
import { formatUsd, formatUsdCompact } from "@/shared/helpers/format"

const TICK_FRACTIONS = [0, 0.5, 1]
const LABELED_DAYS = new Set([1, 8, 15, 22, 29])
// Headroom over the taller of the month's end and the budget, so neither
// touches the top of the plot.
const HEADROOM = 1.12
// Past this share of the month a label beside a vertical marker hangs on its
// left, so it never runs past the plot's right edge on a phone.
const LATE = 0.7

/** The bar index an arrow key moves to, clamped to `count` bars. */
export function stepDay(
  current: number,
  key: string,
  count: number,
): number | undefined {
  const delta =
    key === "ArrowRight" || key === "ArrowUp"
      ? 1
      : key === "ArrowLeft" || key === "ArrowDown"
        ? -1
        : key === "Home"
          ? -count
          : key === "End"
            ? count
            : 0
  if (delta === 0) return undefined
  return Math.min(Math.max(current + delta, 0), Math.max(count - 1, 0))
}

/**
 * A calendar month's running total of charged spend, a bar a day, against the
 * budget's line: solid for the days that have happened, hatched for the rest
 * at the month's pace so far once it has run long enough to have one, and in
 * the danger hue past the budget, with the day the total crosses it marked. A
 * month that has ended is drawn against the budget as it stands today, the
 * only one stored, so it passes no verdict on it.
 *
 * A pointer or the arrow keys read out a day. It selects nothing: narrowing
 * time is what the usage chart under "Where it went" does.
 */
export function BudgetChart({
  month,
  now,
  totals,
  line,
  capLabel,
  spendLabel,
}: {
  month: Month
  /** The instant the month's pace is measured to. */
  now: number
  /** The running total for each day of the month that has begun. */
  totals: readonly number[]
  /** The budget, drawn as a line from the day it counts; undefined where none applies. */
  line: BudgetLine | undefined
  /** "Team budget", "Your limit". */
  capLabel: string
  /** What a day's figure is: "Charged so far". */
  spendLabel: string
}) {
  const plot = useRef<HTMLDivElement>(null)
  const box = useRef<DOMRect>(undefined)
  const [shown, setShown] = useState<number>()
  const { projected, end, crossDay } = projectMonth(
    totals,
    month,
    month.isCurrent ? line : undefined,
    now,
  )
  const cap = line?.cap
  // Where the line sits: the budget over the spend it does not count.
  const limit = line ? line.base + line.cap : undefined
  const fromDay = line?.fromDay ?? 0
  const count = month.length
  const elapsed = totals.length
  const heightOf = (index: number) =>
    index < elapsed ? totals[index] : (projected[index - elapsed] ?? 0)
  const top = axisTop(Math.max(end, limit ?? 0) * HEADROOM)
  const pct = (value: number) => `${Math.max(0, (value / top) * 100)}%`
  const readable = projected.length > 0 ? count : Math.max(1, elapsed)
  const resting = Math.max(0, elapsed - 1)
  const capName = month.isCurrent ? capLabel : `${capLabel} today`

  const readOut = (index: number): [string, number][] =>
    index >= elapsed
      ? [["Projected", heightOf(index)]]
      : line && index < fromDay
        ? [["Before the budget", totals[index] ?? 0]]
        : [[spendLabel, totals[index] ?? 0]]
  const readDay = (index: number) =>
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
    const next = stepDay(shown ?? resting, event.key, readable)
    if (next === undefined) return
    event.preventDefault()
    setShown(next)
  }

  const isLate = (day: number) => day > count * LATE
  // Projected unless a day's actual total passed the budget: the pace can put
  // the crossing on today before today's spend has reached it.
  const isCrossProjected =
    crossDay !== undefined &&
    !((totals[crossDay - 1] ?? 0) > (limit ?? Number.POSITIVE_INFINITY))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex select-none">
        <div aria-hidden className="relative h-45 w-12 shrink-0">
          {TICK_FRACTIONS.map((fraction) => (
            <span
              key={fraction}
              className="absolute right-2 translate-y-1/2 text-mono-micro whitespace-nowrap text-subtle"
              style={{ bottom: `${fraction * 100}%` }}
            >
              {formatUsdCompact(fraction * top)}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div
            ref={plot}
            role="slider"
            tabIndex={0}
            aria-label={`Charged spend in ${monthTitle(month)}, running total${
              cap !== undefined
                ? `, against the ${formatUsd(cap)} ${capName.toLowerCase()}${
                    fromDay > 0 ? ` from ${dayLabel(month, fromDay + 1)}` : ""
                  }`
                : ""
            }. Use the arrow keys to read a day.`}
            aria-valuemin={1}
            aria-valuemax={readable}
            aria-valuenow={(shown ?? resting) + 1}
            aria-valuetext={readDay(shown ?? resting)}
            onPointerEnter={() => {
              box.current = plot.current?.getBoundingClientRect()
            }}
            onPointerMove={(event) => {
              box.current ??= plot.current?.getBoundingClientRect()
              const rect = box.current
              if (!rect || rect.width <= 0) return
              const index = Math.floor(
                ((event.clientX - rect.left) / rect.width) * count,
              )
              setShown(index >= 0 && index < readable ? index : undefined)
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
                // A past month is drawn against today's budget, not its own,
                // so its bars pass no verdict on it.
                const isOver =
                  month.isCurrent &&
                  limit !== undefined &&
                  index >= fromDay &&
                  value > limit
                // Spend before the budget began is shown, not counted.
                const isUncounted = line !== undefined && index < fromDay
                return (
                  <div
                    key={index}
                    className={`flex h-full flex-1 flex-col-reverse ${
                      shown === index ? "bg-surface-subtle" : ""
                    }`}
                  >
                    {isActual ? (
                      <span
                        className={
                          isOver
                            ? "bg-danger"
                            : isUncounted
                              ? "bg-chart-cat-other"
                              : "bg-chart-cat-1"
                        }
                        style={{ height: pct(value) }}
                      />
                    ) : projected.length > 0 ? (
                      <span
                        className={`otari-hatch ${isOver ? "otari-hatch--over" : ""}`}
                        style={{ height: pct(value) }}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
            {line && limit !== undefined ? (
              <div
                aria-hidden
                className="pointer-events-none absolute right-0 border-t border-dashed border-foreground"
                style={{
                  bottom: pct(limit),
                  left: `${(fromDay / count) * 100}%`,
                }}
              >
                <span
                  className={`absolute bottom-0.75 bg-background px-1 text-mono-micro whitespace-nowrap text-foreground ${
                    isLate(fromDay + 1) ? "right-1" : "left-1"
                  }`}
                >
                  {capName} {formatUsd(line.cap)}
                  {fromDay > 0 ? ` from ${dayLabel(month, fromDay + 1)}` : ""}
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
                  className={`absolute top-5 bg-background px-1 text-mono-micro whitespace-nowrap text-danger ${
                    isLate(crossDay) ? "right-1.5" : "left-1.5"
                  }`}
                >
                  {isCrossProjected ? "Over budget ~" : "Over budget "}
                  {dayLabel(month, crossDay)}
                </span>
              </div>
            ) : null}
            {month.isCurrent ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 border-l border-border-strong"
                style={{ left: `${(elapsed / count) * 100}%` }}
              >
                <span
                  className={`absolute top-0 text-mono-micro whitespace-nowrap text-subtle ${
                    isLate(elapsed) ? "right-1.5" : "left-1.5"
                  }`}
                >
                  Today
                </span>
              </div>
            ) : null}
            {shown !== undefined ? (
              <div
                aria-hidden
                className={`pointer-events-none absolute top-1 z-10 flex min-w-40 flex-col border border-control-border bg-surface text-caption ${
                  shown >= count / 2 ? "-translate-x-full" : ""
                }`}
                style={{
                  left:
                    shown >= count / 2
                      ? `calc(${(shown / count) * 100}% - 0.5rem)`
                      : `calc(${((shown + 1) / count) * 100}% + 0.5rem)`,
                }}
              >
                <span className="border-b border-border px-2.5 py-1.5 text-mono-micro text-subtle">
                  {dayLabel(month, shown + 1)} UTC
                  {shown >= elapsed ? " · projected" : ""}
                </span>
                {readOut(shown).map(([label, value]) => (
                  <span key={label} className="flex gap-3 px-2.5 py-1">
                    <span className="flex-1 text-muted">{label}</span>
                    <span className="text-mono-caption text-foreground">
                      {formatUsd(value)}
                    </span>
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
                      [8, 22, 29].includes(index + 1) ? "max-sm:hidden" : ""
                    }`}
                  >
                    {dayLabel(month, index + 1)}
                  </span>
                ) : null}{" "}
              </span>
            ))}
          </div>
        </div>
      </div>
      <BudgetLegend
        hasUncounted={line !== undefined && fromDay > 0}
        hasProjection={projected.length > 0}
        cap={cap}
        capName={capName}
        spendLabel={spendLabel}
      />
    </div>
  )
}

function BudgetLegend({
  hasUncounted,
  hasProjection,
  cap,
  capName,
  spendLabel,
}: {
  hasUncounted: boolean
  hasProjection: boolean
  cap: number | undefined
  capName: string
  spendLabel: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-2 shrink-0 bg-chart-cat-1" />
        {spendLabel}
      </span>
      {hasUncounted ? (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 shrink-0 bg-chart-cat-other" />
          Before the budget began
        </span>
      ) : null}
      {hasProjection ? (
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="otari-hatch size-2.5 shrink-0" />
          Projected at this month's pace
        </span>
      ) : null}
      {cap !== undefined ? (
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="w-3 shrink-0 border-t border-dashed border-foreground"
          />
          {capName}
        </span>
      ) : null}
    </div>
  )
}
