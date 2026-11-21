import type {
  LogGroupBy,
  UsageFilters,
  UsageLogGroup,
  UsageLogGroupModel,
} from "@/client"
import { userDisplay } from "@/features/users/userDisplay"
import type { DashboardSearch } from "@/shared/helpers/search"
import { applyCellFilter } from "./cellFilters"

// The rows a group opens to in place. Past this a group offers to become a
// filtered list of its own.
export const GROUP_PREVIEW = 8

// The groups read at a time, and the most one read returns.
export const GROUP_PAGE = 50
export const GROUP_PAGE_MAX = 200

// The phone lists rows rather than paging them, this many more at a time, up
// to the most the API returns at once.
export const PHONE_BATCH = 20
export const PHONE_LIMIT_MAX = 1000

const GROUPS: Record<LogGroupBy, string> = {
  api_key: "By API key",
  source_label: "By session",
  model: "By model",
  user: "By person",
}

/** The groupings the Requests toolbar offers, with "none" first. */
export function groupOptions(
  offersPerson: boolean,
): { value: "" | LogGroupBy; label: string }[] {
  return [
    { value: "", label: "No grouping" },
    ...(Object.entries(GROUPS) as [LogGroupBy, string][])
      .filter(([value]) => offersPerson || value !== "user")
      .map(([value, label]) => ({ value, label })),
  ]
}

/** The grouping a URL's `group` names, or undefined for none or a value this build does not know. */
export function readGroupBy(raw: string): LogGroupBy | undefined {
  return Object.hasOwn(GROUPS, raw) ? (raw as LogGroupBy) : undefined
}

// The rows of a group with no value in its column are found by that column
// being empty, as the column funnels' "No …" choices find them.
const EMPTY_FIELD: Partial<Record<LogGroupBy, string>> = {
  api_key: "api_key",
  source_label: "session",
  user: "user",
}

/** The filters that narrow the log to one group's rows. */
export function groupFilters(
  filters: UsageFilters,
  groupBy: LogGroupBy,
  key: string | null,
): UsageFilters {
  if (key === null) {
    const field = EMPTY_FIELD[groupBy]
    return field
      ? {
          ...filters,
          is_null: [
            ...(filters.is_null ?? []).filter((one) => one !== field),
            field,
          ] as UsageFilters["is_null"],
        }
      : filters
  }
  switch (groupBy) {
    case "api_key":
      return { ...filters, api_key_id: [key] }
    case "source_label":
      return { ...filters, source_label: key }
    case "user":
      return { ...filters, user_id: [key] }
    case "model":
      return { ...filters, model: [key] }
  }
}

/**
 * The search "Show all" leaves: the group's value added to the filter its
 * column's funnel writes, the grouping off, on the first page with nothing open.
 */
export function showGroupSearch(
  prev: DashboardSearch,
  groupBy: LogGroupBy,
  key: string | null,
): DashboardSearch {
  const { group: _group, ...rest } = prev
  if (groupBy === "source_label") {
    const { page: _page, request: _request, ...next } = rest
    if (key !== null) return { ...next, source_label: key }
    const listed = next.is_null
    const fields = (
      listed === undefined ? [] : Array.isArray(listed) ? listed : [listed]
    ).filter((one) => one !== "session")
    return { ...next, is_null: [...fields, "session"] }
  }
  return applyCellFilter(rest, groupBy, key, "include")
}

/** A group's heading, and whether it is an identifier set in mono. */
export function describeGroup(
  groupBy: LogGroupBy,
  group: UsageLogGroup,
  memberLabels: ReadonlyMap<string, string>,
): { title: string; isMono: boolean } {
  const { key } = group
  switch (groupBy) {
    case "api_key":
      return {
        title:
          key === null ? "No API key" : group.label || `${key.slice(0, 8)}…`,
        isMono: false,
      }
    case "source_label":
      return { title: key ?? "No session", isMono: key !== null }
    case "user":
      return {
        title:
          key === null
            ? "No user"
            : userDisplay(key, group.label, memberLabels).label,
        isMono: false,
      }
    case "model":
      return { title: key ?? "Unknown model", isMono: key !== null }
  }
}

/** A group's most-used models as a short list: two named, the rest counted. */
export function describeTopModels(
  models: readonly UsageLogGroupModel[],
): string {
  const named = models.slice(0, 2).map((one) => one.model)
  const rest = models.length - named.length
  return rest > 0 ? `${named.join(", ")} +${rest}` : named.join(", ")
}

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" }
const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }

/** When a group was active, in local time: its first and last request, with the day once either is not today. */
export function describeGroupSpan(
  first: string,
  last: string,
  now: Date = new Date(),
): string {
  const from = new Date(first)
  const to = new Date(last)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return ""
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const format = (date: Date, withDay: boolean) =>
    date.toLocaleString(undefined, withDay ? { ...DAY, ...TIME } : TIME)
  const withDay = !sameDay(from, now) || !sameDay(to, now)
  if (from.getTime() === to.getTime()) return format(to, withDay)
  const end = sameDay(from, to) ? format(to, false) : format(to, withDay)
  return `${format(from, withDay)} – ${end}`
}
