import type { BreakdownRankBy } from "@/client"

/**
 * How a "Where it went" table is ordered: by one figure, either way. The server
 * ranks by the same figure (`rank_by`), so the groups a table lists are the top
 * ones by what it is sorted on rather than the top ones by spend re-sorted.
 */
export interface BreakdownSort {
  key: BreakdownRankBy
  order: "asc" | "desc"
}

export const DEFAULT_SORT: BreakdownSort = { key: "cost", order: "desc" }

const KEYS: readonly BreakdownRankBy[] = [
  "cost",
  "charged",
  "not_charged",
  "tokens",
  "requests",
  "failed",
  "p95",
]

/** The figures a row is sorted by; `p95` is null where none was recorded, undefined while it is read. */
export interface BreakdownFigures {
  cost: number
  charged: number
  tokens: number
  requests: number
  failed: number
  p95: number | null | undefined
}

/** The sort the URL names (`sort`, `order`), else spend, largest first. */
export function sortFromUrl(sort: string, order: string): BreakdownSort {
  const key = KEYS.find((one) => one === sort)
  if (!key) return DEFAULT_SORT
  return { key, order: order === "asc" ? "asc" : "desc" }
}

/** The URL's `sort` and `order` for a sort, blank for the default. */
export function sortToUrl(sort: BreakdownSort): {
  sort: string
  order: string
} {
  return sort.key === DEFAULT_SORT.key && sort.order === DEFAULT_SORT.order
    ? { sort: "", order: "" }
    : { sort: sort.key, order: sort.order }
}

/** Whether a column id is one the server can rank by. */
export const isSortKey = (id: string): id is BreakdownRankBy =>
  (KEYS as readonly string[]).includes(id)

/** The figure a sort reads off a row, or null where the row has none. */
export function figureOf(
  figures: BreakdownFigures,
  key: BreakdownRankBy,
): number | null {
  switch (key) {
    case "cost":
      return figures.cost
    case "charged":
      return figures.charged
    case "not_charged":
      return Math.max(0, figures.cost - figures.charged)
    case "tokens":
      return figures.tokens
    case "requests":
      return figures.requests
    case "failed":
      return figures.failed
    case "p95":
      return figures.p95 ?? null
  }
}

/**
 * Rows in the table's order: by the sorted figure, then by name. A row with no
 * figure to sort by (a p95 never recorded, figures not read) and a row that is
 * no one value (the server's fold) close the list whichever way it runs.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  sort: BreakdownSort,
  {
    figuresOf,
    nameOf,
    isLast = () => false,
  }: {
    figuresOf: (row: Row) => BreakdownFigures | undefined
    nameOf: (row: Row) => string
    /** A row that closes the list whatever it sums to: the fold. */
    isLast?: (row: Row) => boolean
  },
): Row[] {
  const sign = sort.order === "asc" ? 1 : -1
  const sortedFigure = (row: Row) => {
    const figures = figuresOf(row)
    return figures ? figureOf(figures, sort.key) : null
  }
  return [...rows].sort((a, b) => {
    const last = Number(isLast(a)) - Number(isLast(b))
    if (last !== 0) return last
    const va = sortedFigure(a)
    const vb = sortedFigure(b)
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1
    } else if (va !== vb) {
      return sign * (va - vb)
    }
    return nameOf(a).localeCompare(nameOf(b))
  })
}
