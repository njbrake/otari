import type { SortDescriptor } from "react-aria-components"
import type { BreakdownRankBy } from "@/client"
import type { DataTableColumn } from "@/design-system/data/DataTable"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import {
  type BreakdownFigures,
  type BreakdownSort,
  isSortKey,
} from "@/features/usage/breakdownSort"
import {
  formatLatency,
  formatNumber,
  formatTokens,
  formatUsd,
} from "@/shared/helpers/format"

const UNKNOWN = "—"

/**
 * The figures every "Where it went" table shows after a row's spend: charged
 * and not charged (only where the window has spend no budget counted), then
 * requests, tokens, failures and p95 latency. Each column sorts the table.
 * `figuresOf` is undefined for a row whose figures are not known; `isP95Loading`
 * says the latencies are still being read, from the rows rather than the
 * rollups, after everything else has arrived.
 */
export function breakdownFigureColumns<Row>({
  figuresOf,
  hasNotCharged,
  isP95Loading,
  money = formatUsd,
}: {
  figuresOf: (row: Row) => BreakdownFigures | undefined
  hasNotCharged: boolean
  isP95Loading: boolean
  /** How a dollar figure reads; the person page shows a fraction of a cent. */
  money?: (value: number) => string
}): DataTableColumn<Row>[] {
  const figure = (
    row: Row,
    read: (figures: BreakdownFigures) => string,
    tone?: (figures: BreakdownFigures) => string,
  ) => {
    const figures = figuresOf(row)
    return (
      <span
        className={`text-mono-caption ${figures && tone ? tone(figures) : "text-foreground"}`}
      >
        {figures ? read(figures) : UNKNOWN}
      </span>
    )
  }
  const notCharged = (figures: BreakdownFigures) =>
    Math.max(0, figures.cost - figures.charged)
  return [
    ...(hasNotCharged
      ? ([
          {
            id: "charged",
            header: "Charged",
            align: "end",
            allowsSorting: true,
            cell: (row) => figure(row, (figures) => money(figures.charged)),
          },
          {
            id: "not_charged",
            header: "Not charged",
            align: "end",
            allowsSorting: true,
            cell: (row) =>
              figure(
                row,
                (figures) => money(notCharged(figures)),
                (figures) =>
                  notCharged(figures) > 0 ? "text-foreground" : "text-muted",
              ),
          },
        ] satisfies DataTableColumn<Row>[])
      : []),
    {
      id: "requests",
      header: "Requests",
      align: "end",
      allowsSorting: true,
      cell: (row) => figure(row, (figures) => formatNumber(figures.requests)),
    },
    {
      id: "tokens",
      header: "Tokens",
      align: "end",
      allowsSorting: true,
      cell: (row) => figure(row, (figures) => formatTokens(figures.tokens)),
    },
    {
      id: "failed",
      header: "Failed",
      align: "end",
      allowsSorting: true,
      cell: (row) =>
        figure(
          row,
          (figures) => formatNumber(figures.failed),
          (figures) => (figures.failed > 0 ? "text-danger" : "text-muted"),
        ),
    },
    {
      id: "p95",
      header: <span className="normal-case">p95 latency</span>,
      align: "end",
      allowsSorting: true,
      cell: (row) =>
        isP95Loading && figuresOf(row) ? (
          <>
            <Skeleton className="ml-auto h-3 w-12" />
            <span className="sr-only">Loading</span>
          </>
        ) : (
          figure(row, (figures) => formatLatency(figures.p95) ?? UNKNOWN)
        ),
    },
  ]
}

/** The DataTable's sort props for a breakdown sort, a new column starting largest first. */
export function breakdownSortProps(
  sort: BreakdownSort,
  onSort: (next: BreakdownSort) => void,
): {
  sortDescriptor: SortDescriptor
  onSortChange: (descriptor: SortDescriptor) => void
} {
  return {
    sortDescriptor: {
      column: sort.key,
      direction: sort.order === "asc" ? "ascending" : "descending",
    },
    onSortChange: (descriptor) => {
      const column = String(descriptor.column)
      if (!isSortKey(column)) return
      onSort({
        key: column,
        order:
          column !== sort.key
            ? "desc"
            : descriptor.direction === "ascending"
              ? "asc"
              : "desc",
      })
    },
  }
}

const SORT_LABELS: Record<BreakdownRankBy, string> = {
  cost: "Most spent",
  charged: "Most charged",
  not_charged: "Most not charged",
  tokens: "Most tokens",
  requests: "Most requests",
  failed: "Most failed",
  p95: "Slowest p95",
}

const ASC_LABELS: Record<BreakdownRankBy, string> = {
  cost: "Least spent",
  charged: "Least charged",
  not_charged: "Least not charged",
  tokens: "Fewest tokens",
  requests: "Fewest requests",
  failed: "Fewest failed",
  p95: "Fastest p95",
}

/**
 * The sort on a phone, whose cards have no header to press: each figure,
 * largest first, and the current sort as it is when it runs the other way.
 */
export function BreakdownSortSelect({
  sort,
  onSort,
  hasNotCharged,
}: {
  sort: BreakdownSort
  onSort: (next: BreakdownSort) => void
  hasNotCharged: boolean
}) {
  const keys = (Object.keys(SORT_LABELS) as BreakdownRankBy[]).filter(
    (key) => hasNotCharged || (key !== "charged" && key !== "not_charged"),
  )
  const current = `${sort.key}:${sort.order}`
  const options = keys.map((key) => ({
    value: `${key}:desc`,
    label: SORT_LABELS[key],
  }))
  if (sort.order === "asc") {
    options.push({
      value: current,
      label: ASC_LABELS[sort.key],
    })
  }
  return (
    <FilterSelect
      ariaLabel="Sort by"
      value={current}
      onChange={(next) => {
        const [key, order] = next.split(":")
        if (isSortKey(key))
          onSort({ key, order: order === "asc" ? "asc" : "desc" })
      }}
      options={options}
    />
  )
}
