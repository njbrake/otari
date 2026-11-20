import type { DashboardSearch } from "@/shared/helpers/search"

/**
 * Where a link to a retired page lands, with its filters carried onto the
 * names the page that replaced it reads.
 *
 * `/usage` was a spend breakdown with filters and `/activity` a request log.
 * Home answers the first without filters (a window and a cut), Requests
 * answers both once a filter names rows, and Sessions answers a breakdown by
 * session. A parameter the destination has no name for is dropped rather than
 * carried, so it does not sit in the address doing nothing.
 */
export interface RetiredPageTarget {
  to: "/" | "/requests" | "/sessions"
  search: DashboardSearch
}

/** The row filters Usage and Activity shared with today's Requests, by name. */
const REQUEST_FILTERS = [
  "model",
  "exclude_model",
  "api_key_id",
  "exclude_api_key_id",
  "user_id",
  "exclude_user_id",
  "provider",
  "policy_name",
  "exclude_policy_name",
  "source_label",
] as const

/** What Activity alone could filter on, and Requests still can. */
const ACTIVITY_ONLY_FILTERS = [
  "status",
  "exclude_status",
  "source",
  "exclude_source",
  "endpoint",
  "status_code",
  "tool",
  "priced",
  "routed",
  "tokens_gt",
  "cost_gt",
  "latency_ms_gt",
  "request",
  "page",
  "size",
] as const

/** The filters Sessions reads, of those a Usage link could carry. */
const SESSION_FILTERS = ["model", "api_key_id", "user_id"] as const

const WINDOW_BOUNDS = ["start_date", "end_date"] as const

/** Requests' and Sessions' windows, which name the old ones they still offer. */
const LOG_RANGES = new Set(["1h", "24h", "7d", "30d", "all"])

/** Usage's windows onto Home's nearest period. */
const HOME_PERIODS: Record<string, string> = {
  "1h": "today",
  "24h": "today",
  "7d": "7d",
  "30d": "30d",
  "90d": "3m",
  "12mo": "6m",
}

/** Usage's breakdowns onto Home's cuts. */
const HOME_CUTS: Record<string, string> = {
  model: "models",
  key: "keys",
  member: "people",
  provider: "providers",
  workspace: "workspaces",
}

function pick(
  search: DashboardSearch,
  names: readonly string[],
): DashboardSearch {
  const picked: DashboardSearch = {}
  for (const name of names) {
    const value = search[name]
    if (value !== undefined && value !== "") picked[name] = value
  }
  return picked
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ""
}

/**
 * A log page's window, the old one where it still exists, and its scope: the
 * caller's own rows (Usage's `you`, Activity's `mine`) stay the caller's own.
 */
function logWindow(search: DashboardSearch): DashboardSearch {
  const range = first(search.range)
  const scope = first(search.scope)
  return {
    ...(scope === "mine" || scope === "you" ? { scope: "mine" } : {}),
    ...(LOG_RANGES.has(range) ? { range } : {}),
    ...pick(search, WINDOW_BOUNDS),
  }
}

/** `/usage?…` onto Home, Sessions or Requests. */
export function retiredUsageTarget(search: DashboardSearch): RetiredPageTarget {
  const by = first(search.by)
  if (by === "session") {
    return {
      to: "/sessions",
      search: { ...logWindow(search), ...pick(search, SESSION_FILTERS) },
    }
  }
  const filters = pick(search, REQUEST_FILTERS)
  if (Object.keys(filters).length > 0) {
    return { to: "/requests", search: { ...logWindow(search), ...filters } }
  }
  const period = HOME_PERIODS[first(search.range)]
  const cut = HOME_CUTS[by]
  return {
    to: "/",
    search: {
      ...(period ? { period } : {}),
      ...(cut ? { by: cut } : {}),
    },
  }
}

/** `/activity?…` onto Requests. */
export function retiredActivityTarget(
  search: DashboardSearch,
): RetiredPageTarget {
  return {
    to: "/requests",
    search: {
      ...logWindow(search),
      ...pick(search, REQUEST_FILTERS),
      ...pick(search, ACTIVITY_ONLY_FILTERS),
    },
  }
}
