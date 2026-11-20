import type { UsageEntry } from "@/client"
import type { DashboardSearch } from "@/shared/helpers/search"
import { sortPlanRows } from "./activityModel"

/** The cells that filter by their own value, each writing a column funnel's URL keys. */
export type CellDimension = "user" | "model" | "policy" | "api_key" | "status"

export type CellFilterMode = "include" | "exclude"

// The keys each cell writes, the same ones its column's funnel writes
// (`VALUE_KEYS`), so a cell filter shows in that funnel and as its chip.
const KEYS: Record<CellDimension, { include: string; exclude: string }> = {
  user: { include: "user_id", exclude: "exclude_user_id" },
  model: { include: "model", exclude: "exclude_model" },
  policy: { include: "policy_name", exclude: "exclude_policy_name" },
  api_key: { include: "api_key_id", exclude: "exclude_api_key_id" },
  status: { include: "status", exclude: "exclude_status" },
}

// A cell with nothing in it filters to the rows with nothing there too.
const EMPTY: Partial<Record<CellDimension, DashboardSearch>> = {
  user: { is_null: "user" },
  api_key: { is_null: "api_key" },
  policy: { routed: "false" },
}

const listOf = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

const withList = (
  search: DashboardSearch,
  key: string,
  values: string[],
): DashboardSearch => {
  const next = { ...search }
  if (values.length === 0) delete next[key]
  else next[key] = values
  return next
}

/**
 * The search a cell's "only this" or "exclude" leaves: the value added to the
 * one list and taken out of the other, back on the first page with nothing
 * open. A value of `null` is the empty cell, which can only be kept.
 */
export function applyCellFilter(
  prev: DashboardSearch,
  dimension: CellDimension,
  value: string | null,
  mode: CellFilterMode,
): DashboardSearch {
  let next: DashboardSearch = { ...prev }
  delete next.page
  delete next.request
  if (value === null) {
    const empty = EMPTY[dimension]
    if (!empty || mode === "exclude") return next
    if (empty.is_null) {
      const fields = listOf(next.is_null).filter(
        (field) => field !== empty.is_null,
      )
      return withList(next, "is_null", [...fields, empty.is_null as string])
    }
    return { ...next, ...empty }
  }
  const keys = KEYS[dimension]
  const [into, outOf] =
    mode === "include"
      ? [keys.include, keys.exclude]
      : [keys.exclude, keys.include]
  next = withList(
    next,
    outOf,
    listOf(next[outOf]).filter((one) => one !== value),
  )
  return withList(next, into, [
    ...listOf(next[into]).filter((one) => one !== value),
    value,
  ])
}

/** Whether a cell can leave its value out, which an empty cell cannot. */
export const canExcludeCell = (value: string | null): boolean => value !== null

/**
 * The page with each request's recovered attempts listed under it, newest
 * attempt first, read from the request groups looked up for the page. Returns
 * the rows and which of them were added, so the table can indent those.
 */
export function nestRecoveredAttempts(
  rows: readonly UsageEntry[],
  groupRows: readonly UsageEntry[],
): { rows: UsageEntry[]; nested: Set<string> } {
  const onPage = new Set(rows.map((row) => row.id))
  const nested = new Set<string>()
  const out: UsageEntry[] = []
  for (const row of rows) {
    out.push(row)
    if (!row.request_group_id || row.status === "absorbed") continue
    const attempts = sortPlanRows(
      groupRows.filter(
        (attempt) =>
          attempt.request_group_id === row.request_group_id &&
          attempt.status === "absorbed" &&
          !onPage.has(attempt.id) &&
          !nested.has(attempt.id),
      ),
    ).reverse()
    for (const attempt of attempts) {
      nested.add(attempt.id)
      out.push(attempt)
    }
  }
  return { rows: out, nested }
}

/** Groups whose recovered attempts are worth looking up: a request served or failed after an earlier attempt. */
export function groupsWithEarlierAttempts(
  rows: readonly UsageEntry[],
): string[] {
  return rows.flatMap((row) =>
    row.request_group_id &&
    row.status !== "absorbed" &&
    (row.attempt_position ?? 1) > 1
      ? [row.request_group_id]
      : [],
  )
}
