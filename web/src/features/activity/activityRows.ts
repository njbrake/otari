/**
 * How the log's rows are arranged: recovered attempts under the request they
 * belong to, and the grouped log's groups as filters, titles and drill-downs.
 */

import type {
  UsageActivityGroup,
  UsageActivityGroupBy,
  UsageEntry,
  UsageFilters,
} from "@/client"
import { shortId } from "./activityModel"
import type { GroupKey, Patch } from "./activityQuery"

// The rows a group opens to in place. More than this is a list, and the group
// offers to become one.
export const GROUP_PREVIEW = 8

// The phone lists rows rather than paging them, this many more at a time, up
// to the most the API returns at once.
export const PHONE_BATCH = 20
export const PHONE_LIMIT_MAX = 1000

/**
 * With recovered attempts listed, each goes under the row that served its
 * request when that row is on the page, and stands alone when it is not (the
 * served row is on another page, or filtered out).
 */
export function nestAttempts(rows: readonly UsageEntry[]): {
  rows: UsageEntry[]
  attempts: Map<string, UsageEntry[]>
} {
  const served = new Set(
    rows.flatMap((entry) =>
      entry.status !== "absorbed" && entry.request_group_id
        ? [entry.request_group_id]
        : [],
    ),
  )
  const attempts = new Map<string, UsageEntry[]>()
  const top = rows.filter((entry) => {
    const groupId = entry.request_group_id
    if (entry.status !== "absorbed" || !groupId || !served.has(groupId)) {
      return true
    }
    attempts.set(groupId, [...(attempts.get(groupId) ?? []), entry])
    return false
  })
  return { rows: top, attempts }
}

// The rows of a group with no value in its column (no key, no session, no
// billed user) are found by that column being empty.
const NULL_COLUMN = {
  api_key: "api_key_id",
  source_label: "source_label",
  user: "user_id",
} as const

/** The filters that narrow the log to one group's rows. */
export function groupFilters(
  filters: UsageFilters,
  groupBy: UsageActivityGroupBy,
  group: UsageActivityGroup,
): UsageFilters {
  if (group.key === null) {
    const column = NULL_COLUMN[groupBy as keyof typeof NULL_COLUMN]
    return column ? { ...filters, is_null: [column] } : filters
  }
  switch (groupBy) {
    case "api_key":
      return { ...filters, api_key_id: [group.key] }
    case "source_label":
      return { ...filters, source_label: group.key }
    case "user":
      return { ...filters, user_id: [group.key] }
    default:
      return { ...filters, model: [group.key] }
  }
}

/** A group's heading, and whether it is an identifier set in mono. */
export function describeGroup(
  group: GroupKey,
  row: UsageActivityGroup,
  memberName: (userId: string | null, alias?: string | null) => string,
): { title: string; isMono: boolean } {
  switch (group) {
    case "session":
      return {
        title: row.key ? `Session ${row.key}` : "No session",
        isMono: row.key !== null,
      }
    case "member":
      return { title: memberName(row.key, row.label), isMono: false }
    case "source":
      return {
        title: row.label ?? (row.key ? shortId(row.key) : "No key"),
        isMono: false,
      }
    default:
      return { title: row.key ?? "Unknown model", isMono: true }
  }
}

/** A group opened as a list of its own: its value as a filter, and the grouping off. */
export function showGroupPatch(group: GroupKey, value: string): Patch {
  const filter = {
    source: { api_key_id: [value] },
    session: { source_label: value },
    model: { model: [value] },
    member: { user_id: [value] },
  }[group]
  return { ...filter, group: "", page: "0" }
}

/** The key names the page has seen, for chips naming a key the rows carry. */
export function keyNames(
  rows: readonly UsageEntry[],
  groups: readonly UsageActivityGroup[],
): Map<string, string> {
  return new Map([
    ...rows.flatMap((entry) =>
      entry.api_key_id && entry.api_key_name
        ? [[entry.api_key_id, entry.api_key_name] as const]
        : [],
    ),
    ...groups.flatMap((group) =>
      group.key && group.label ? [[group.key, group.label] as const] : [],
    ),
  ])
}
