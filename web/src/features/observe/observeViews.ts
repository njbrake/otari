import type { SavedViewPage } from "@/client"
import { DEFAULT_TRACE_SORT } from "@/shared/api/traces"
import type { DashboardSearch } from "@/shared/helpers/search"
import { ACTIVITY_DEFAULT_KEY } from "@/shared/helpers/timeRange"

// The query keys each page keeps in a view, in the order a view's query string
// lists them: which rows, and in what order. The page number, the open row and a
// window dragged on the chart are where the reader is, not a view. The gateway
// holds the same lists (`VIEW_QUERY_KEYS`) and refuses a view naming any other.
const SHARED_KEYS = [
  "scope",
  "range",
  "q",
  "status",
  "model",
  "user_id",
  "api_key_id",
  "sort",
  "order",
] as const

export const VIEW_KEYS: Record<SavedViewPage, readonly string[]> = {
  sessions: SHARED_KEYS,
  requests: [
    ...SHARED_KEYS,
    "exclude_status",
    "status_code",
    "exclude_model",
    "exclude_user_id",
    "exclude_api_key_id",
    "priced",
    "source",
    "exclude_source",
    "source_label",
    "endpoint",
    "provider",
    "tool",
    "policy_name",
    "exclude_policy_name",
    "routed",
    "tokens_gt",
    "cost_gt",
    "latency_ms_gt",
    "channel",
    "is_null",
    "recovered",
  ],
}

// What a page reads when a key is absent, so a URL that spells the default
// matches a view that leaves it out.
const PAGE_DEFAULTS: Record<SavedViewPage, Record<string, string>> = {
  sessions: {
    range: ACTIVITY_DEFAULT_KEY,
    sort: DEFAULT_TRACE_SORT.key,
    order: DEFAULT_TRACE_SORT.direction,
  },
  requests: { range: ACTIVITY_DEFAULT_KEY },
}

// Where the reader is in a page's view, which applying a view starts over, and
// the view applied, which the caller sets again.
const POSITION_KEYS = [
  "view",
  "start_date",
  "end_date",
  "page",
  "request",
  "peek",
  "peek_workspace",
  "span",
] as const

const asSearch = (query: string | DashboardSearch): DashboardSearch => {
  if (typeof query !== "string") return query
  const params = new URLSearchParams(query)
  return Object.fromEntries(
    [...new Set(params.keys())].map((key) => [key, params.getAll(key)]),
  )
}

const valuesOf = (search: DashboardSearch, key: string): string[] => {
  const raw = search[key]
  if (raw === undefined) return []
  return (Array.isArray(raw) ? raw : [raw])
    .map((value) => value.trim())
    .filter((value) => value !== "")
}

/**
 * A page's view as one canonical query string: only the keys the page keeps,
 * in their own order, each key's values sorted, defaults and blanks left out.
 * Two views that show the same rows read the same, whatever order their URLs
 * spelled them in.
 */
export function canonicalQuery(
  page: SavedViewPage,
  query: string | DashboardSearch,
): string {
  const search = asSearch(query)
  const params = new URLSearchParams()
  for (const key of VIEW_KEYS[page]) {
    const values = valuesOf(search, key).sort()
    if (values.length === 1 && values[0] === PAGE_DEFAULTS[page][key]) continue
    for (const value of values) params.append(key, value)
  }
  return params.toString()
}

/** Whether the URL holds a window dragged on the chart, which no view names. */
export const hasSpan = (search: DashboardSearch): boolean =>
  valuesOf(search, "start_date").length > 0 ||
  valuesOf(search, "end_date").length > 0

/**
 * The URL change that applies a view: every key either page keeps set to what
 * the view names, or cleared, so applying one replaces the view rather than
 * adding to it, and back to the first page with nothing open.
 */
export function viewPatch(query: string): Record<string, string | string[]> {
  const search = asSearch(query)
  const patch: Record<string, string | string[]> = {}
  for (const key of new Set([...VIEW_KEYS.sessions, ...VIEW_KEYS.requests])) {
    const values = valuesOf(search, key)
    patch[key] = values.length > 1 ? values : (values[0] ?? "")
  }
  for (const key of POSITION_KEYS) patch[key] = ""
  return patch
}

/** Every key `viewPatch` writes, as the defaults `useUrlState` takes. */
export const VIEW_PATCH_DEFAULTS: Record<string, string> = Object.fromEntries(
  [
    ...new Set([...VIEW_KEYS.sessions, ...VIEW_KEYS.requests]),
    ...POSITION_KEYS,
  ].map((key) => [key, ""]),
)
