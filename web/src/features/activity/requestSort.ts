import type { SortDescriptor } from "react-aria-components"
import type { UsageSortKey, UsageSortOrder } from "@/client"
import { NEWEST_FIRST, type UsageSort } from "@/shared/api/usage"

/**
 * The request log's sortable columns, by column id: the server's sort key, the
 * order a first press asks for, and how the phone's sheet names each order.
 *
 * Names and categories read A to Z first; sizes, costs, times and the status
 * ranking read largest first, since the question there is usually "which ones".
 */
export const SORTABLE_COLUMNS: Record<
  string,
  { key: UsageSortKey; first: UsageSortOrder; label: string }
> = {
  time: { key: "timestamp", first: "asc", label: "Time" },
  user: { key: "user", first: "asc", label: "User" },
  model: { key: "model", first: "asc", label: "Model" },
  routing: { key: "policy", first: "asc", label: "Routing" },
  api_key: { key: "source", first: "asc", label: "API key" },
  input_tokens: { key: "input_tokens", first: "desc", label: "Input tokens" },
  output_tokens: {
    key: "output_tokens",
    first: "desc",
    label: "Output tokens",
  },
  cost: { key: "cost", first: "desc", label: "Cost" },
  latency: { key: "latency", first: "desc", label: "Total time" },
  status: { key: "status", first: "desc", label: "Status" },
}

const SORT_KEYS = new Set<string>(
  Object.values(SORTABLE_COLUMNS).map((column) => column.key),
)

// A term the server looks up as an id rather than searching by substring.
const UUID_TERM =
  /^(urn:uuid:)?\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i

/** Whether the server bounds this read to a window: any order but time, and a search for anything but an id. */
export function boundsWindow(sort: UsageSort, search: string): boolean {
  const term = search.trim()
  return (
    sort.sort !== NEWEST_FIRST.sort || (term !== "" && !UUID_TERM.test(term))
  )
}

const isDefault = (sort: UsageSort) =>
  sort.sort === NEWEST_FIRST.sort && sort.order === NEWEST_FIRST.order

const reverse = (order: UsageSortOrder): UsageSortOrder =>
  order === "asc" ? "desc" : "asc"

/** The order the URL's `sort` and `order` hold, newest first for anything it does not know. */
export function readSort(sort: string, order: string): UsageSort {
  if (!SORT_KEYS.has(sort)) return NEWEST_FIRST
  return {
    sort: sort as UsageSortKey,
    order: order === "asc" ? "asc" : "desc",
  }
}

/** The URL values an order is written as; the default drops both keys. */
export function sortUrl(sort: UsageSort): { sort: string; order: string } {
  return isDefault(sort)
    ? { sort: "", order: "" }
    : { sort: sort.sort, order: sort.order }
}

/**
 * What pressing a column's header does: its first order, then the reverse,
 * then back to newest first. Time has one order besides the default, oldest
 * first, so it toggles between the two.
 */
export function nextSort(current: UsageSort, columnId: string): UsageSort {
  const column = SORTABLE_COLUMNS[columnId]
  if (!column) return current
  const first: UsageSort = { sort: column.key, order: column.first }
  if (isDefault(current) || current.sort !== column.key) return first
  if (current.order !== column.first) return NEWEST_FIRST
  const reversed: UsageSort = { sort: column.key, order: reverse(column.first) }
  return isDefault(reversed) ? NEWEST_FIRST : reversed
}

/** The header the table marks sorted, and which way: time, descending, by default. */
export function sortDescriptorFor(sort: UsageSort): SortDescriptor {
  const column =
    Object.entries(SORTABLE_COLUMNS).find(
      ([, spec]) => spec.key === sort.sort,
    )?.[0] ?? "time"
  return {
    column,
    direction: sort.order === "asc" ? "ascending" : "descending",
  }
}

/** Every order the phone's sheet offers, newest first at the top, each column's first order then its reverse. */
export function sortChoices(): { value: string; label: string }[] {
  const choices = [{ value: "timestamp:desc", label: "Newest first" }]
  for (const spec of Object.values(SORTABLE_COLUMNS)) {
    const orders: UsageSortOrder[] =
      spec.key === "timestamp" ? ["asc"] : [spec.first, reverse(spec.first)]
    for (const order of orders) {
      choices.push({
        value: `${spec.key}:${order}`,
        label: describeOrder(spec, order),
      })
    }
  }
  return choices
}

function describeOrder(
  spec: { key: UsageSortKey; first: UsageSortOrder; label: string },
  order: UsageSortOrder,
): string {
  if (spec.key === "timestamp") return "Oldest first"
  if (spec.key === "status")
    return order === "desc" ? "Failures first" : "Successes first"
  if (spec.key === "latency")
    return `Total time, ${order === "desc" ? "longest" : "shortest"} first`
  const isText = spec.first === "asc"
  if (isText) return `${spec.label}, ${order === "asc" ? "A to Z" : "Z to A"}`
  return `${spec.label}, ${order === "desc" ? "highest first" : "lowest first"}`
}

/** A sheet choice's value (`key:order`) as an order. */
export function readSortChoice(value: string): UsageSort {
  const [sort = "", order = ""] = value.split(":")
  return readSort(sort, order)
}
