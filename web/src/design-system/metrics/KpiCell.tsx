import type { CSSProperties, ReactNode } from "react"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { InlineList } from "@/design-system/layout/InlineList"
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
  subline?: ReactNode | ReactNode[]
  delta?: ReactNode
  graphic?: ReactNode
  /**
   * The figure is still being read: a placeholder holds the figure and its
   * line rather than a dash, which reads as a figure that is missing.
   */
  isLoading?: boolean
}) {
  return (
    // `grid-rows-subgrid` over `row-span-4` puts the cell's four parts on the
    // strip's own rows, so labels, values, lines and graphics line up across
    // the cells and each row is as tall as its tallest part: a label that
    // wraps, or a line that wraps, moves the whole row rather than one value.
    //
    // The cell must not be a size container. `container-type` applies layout
    // containment, which makes the cell an independent formatting context, and
    // a subgrid inside one computes to `none` (CSS Grid 2, "Establishing a
    // subgrid"): the four parts then split the cell's height evenly. The
    // container the figure sizes against is the wrapper around the figure.
    //
    // `minmax(0,1fr)` for the cell's own column, not the `auto` a grid gives
    // itself by default, so the widest child cannot widen the column past the
    // strip's track and paint into the cell beside it.
    //
    // The rule between cells belongs to a cell with a neighbor on its right,
    // so it comes off the last cell of each row, at every column count. On a
    // phone the left lane starts flush with the page column, the right lane
    // sits 16px off the rule, and an odd last cell takes the whole row.
    <div
      aria-busy={isLoading || undefined}
      className="grid row-span-4 min-w-0 grid-rows-subgrid grid-cols-[minmax(0,1fr)] gap-1.5 border-border px-7 py-[1.125rem] not-last:border-r max-sm:px-4 max-sm:odd:pl-0 max-sm:even:pr-0 max-sm:even:border-r-0 max-sm:last:odd:col-span-2 max-sm:last:odd:pr-0 sm:max-xl:[&:nth-child(3n)]:border-r-0"
    >
      <span className="flex items-end text-overline">{label}</span>
      {/* 400, deliberately, where the rest of the page's emphasis is 550: at
          30px the size is already the hierarchy, and a heavier numeral here
          would out-weigh the page title above it. One line, so a figure and its
          unit ("15.85 s") never part. */}
      <span className="@container block min-w-0">
        <span
          className="otari-kpi-figure block text-mono-figure font-normal text-nowrap text-foreground"
          style={{ "--figure-chars": value.length } as CSSProperties}
        >
          {isLoading ? (
            <>
              <Skeleton className="h-[1lh] w-28 max-w-full" />
              <span className="sr-only">Loading</span>
            </>
          ) : (
            value
          )}
        </span>
      </span>
      {/* Most-judged to least, left to right: a severity, then the comparison,
          then the raw facts. The severity and the delta hold their width; the
          subline wraps under them when the line runs out, and the subgrid
          gives that height to every cell in the strip's row so their parts
          still line up. The middots between them never hang at a wrap
          (`InlineList`). A subline given as a list keeps each fact whole and
          breaks only between them. */}
      <span className="flex min-h-[1.125rem] min-w-0 items-center text-xs text-muted">
        {isLoading ? (
          <Skeleton className="h-3 w-24 max-w-full" />
        ) : (
          <InlineList isNowrapItems={false}>
            {severity ? <SeverityMark severity={severity} /> : null}
            {delta ? (
              <span className="flex max-w-full shrink-0 items-center whitespace-nowrap">
                {delta}
              </span>
            ) : null}
            {Array.isArray(subline) ? (
              subline.map((fact, index) => (
                <span key={index} className="whitespace-nowrap">
                  {fact}
                </span>
              ))
            ) : subline ? (
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {subline}
              </span>
            ) : null}
          </InlineList>
        )}
      </span>
      {/* Reserved rather than conditional: an absent sparkline must not make one
          cell shorter than the four beside it. Dropped in the empty state by
          the caller passing none to any cell, which shortens the whole strip. */}
      {graphic ? (
        <span className="flex min-h-10 min-w-0 items-center">{graphic}</span>
      ) : null}
    </div>
  )
}
