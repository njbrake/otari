import type { ReactNode } from "react"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { type Severity, SeverityMark } from "./SeverityMark"

export function KpiCell({
  label,
  value,
  severity,
  subline,
  delta,
  graphic,
  isLoading = false,
}: {
  label: string
  value: string
  severity?: Severity
  /**
   * Why the value is what it is. Carried in every page state and not only in
   * the empty one: an em dash with nothing under it makes the reader guess
   * whether the number is missing or zero, and the empty state is simply the
   * case where every cell has something to say.
   */
  subline?: ReactNode
  delta?: ReactNode
  graphic?: ReactNode
  /**
   * The read behind the value has not answered: the value and the line under it
   * hold their space as skeletons rather than showing a figure nobody has read.
   */
  isLoading?: boolean
}) {
  return (
    // `grid-rows-subgrid` over `row-span-4` is what keeps the five values on one
    // baseline. The cells are equal-height grid items, so a wrapped label used
    // to make its own cell taller and push its value down while the other four
    // stayed put (measured with a 1180px column: value tops 241 against 223).
    // Subgridding the cell's four parts onto the strip's own rows lines the
    // labels, values, deltas and graphics up with their neighbors instead, and
    // reserves nothing when no label wraps, so it costs no dead space wide.
    // `items-end` on the label is what makes a one-line label sit on the same
    // baseline as the last line of a two-line one.
    // `minmax(0,1fr)` for the cell's own column, not the `auto` a grid gives
    // itself by default. The strip's tracks are already `minmax(0,1fr)`, so the
    // cell's box is its track; what was unbounded was the column INSIDE it,
    // which took its floor from the widest child. The subline never wraps, so
    // its min-content is the whole string: measured with a 59-character
    // subline, the inner column came out 356px inside a 283px cell and every
    // child sized to it, the sparkline included, painted 129px into the cell
    // beside it (218px at 1280, since the track shrinks and the string does
    // not). Bounding the column is what makes the truncation and the
    // sparkline's `w-full` mean anything.
    <div
      aria-busy={isLoading || undefined}
      className="grid row-span-4 min-w-0 grid-rows-subgrid grid-cols-[minmax(0,1fr)] gap-1.5 border-border px-7 py-[1.125rem]"
    >
      <span className="flex items-end text-overline">{label}</span>
      {/* 400, deliberately, where the rest of the page's emphasis is 550: at
          30px the size is already the hierarchy, and a heavier numeral here
          would out-weigh the page title above it. */}
      <span className="text-mono-figure font-normal text-foreground">
        {isLoading ? <Skeleton className="h-[1lh] w-32" /> : value}
      </span>
      {/* One line, always present, so no cell is shorter than its neighbors,
          and never wrapped, which would undo the subgrid's shared baseline.
          Most-judged to least: a severity, then the comparison, then the raw
          fact. The severity and the delta hold their width; the subline is the
          only thing that gives, and it truncates, because its facts also live
          in the breakdown tables while a delta lives nowhere else. */}
      <span className="flex min-h-[1.125rem] items-center gap-2 text-xs text-nowrap text-muted">
        {isLoading ? (
          <Skeleton className="h-3 w-24" />
        ) : (
          <>
            {severity ? <SeverityMark severity={severity} /> : null}
            {severity && delta ? <Separator /> : null}
            {delta}
            {(severity || delta) && subline ? <Separator /> : null}
            {subline ? (
              <span
                className="min-w-0 truncate"
                title={typeof subline === "string" ? subline : undefined}
              >
                {subline}
              </span>
            ) : null}
          </>
        )}
      </span>
      {/* Reserved rather than conditional: an absent sparkline must not make one
          cell shorter than the four beside it. Dropped in the empty state by
          the caller passing none to any cell, which shortens the whole strip. */}
      {/* At least the sparkline's height, and as tall as a graphic that says
          more (a split with its legend): the subgrid gives every cell in the
          row the tallest one's height, so the baselines still line up. */}
      {graphic ? (
        <span className="flex min-h-10 items-center">
          {isLoading ? <Skeleton className="h-2 w-full" /> : graphic}
        </span>
      ) : null}
    </div>
  )
}

/** The middot between two things sharing the line under a value. */
function Separator() {
  return (
    <span aria-hidden className="shrink-0 text-subtle">
      ·
    </span>
  )
}
