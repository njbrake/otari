/**
 * What the Activity page is asking for, as it lives in the URL.
 *
 * Every filter, the sort, the grouping and the open request are URL state, so a
 * view is a link: it survives a reload and the back button, and a saved view is
 * nothing more than a query string under a name. The keys are the API's own
 * query parameters wherever one exists, so reading the URL into a request is
 * close to the identity, and links other pages already build (Usage drills in
 * with `model`, `user_id`, `source_label`; the unpriced banner with `priced`)
 * keep working unchanged.
 *
 * Status is the one translation. The page offers any subset of the three
 * outcomes, the API takes one `status` or a list to exclude, and
 * `statusParams` maps the one onto the other.
 */

import type {
  UsageActivityGroup,
  UsageActivityGroupBy,
  UsageEntry,
  UsageFilters,
  UsageMutationSelection,
  UsageSortKey,
  UsageTotals,
} from "@/client"
import { NEWEST_FIRST, type UsageSort } from "@/shared/api/usage"
import {
  formatCompact,
  formatSeconds,
  formatUsd,
} from "@/shared/helpers/format"
import type { UrlState } from "@/shared/helpers/urlState"
import {
  describeSource,
  describeTool,
  isImported,
  listToolUsage,
} from "./activityModel"

export const ACTIVITY_URL_DEFAULTS = {
  range: "24h",
  // A sub-window of `range`: a brushed span, or a drill-down's own bounds.
  start_date: "",
  end_date: "",
  // "you" narrows a manager's workspace view to their own requests.
  scope: "",
  q: "",
  status: "",
  exclude_status: "",
  model: "",
  exclude_model: "",
  requested_model: "",
  user_id: "",
  exclude_user_id: "",
  api_key_id: "",
  exclude_api_key_id: "",
  policy_name: "",
  exclude_policy_name: "",
  routed: "",
  source: "",
  exclude_source: "",
  source_label: "",
  endpoint: "",
  provider: "",
  tool: "",
  priced: "",
  tokens_gt: "",
  cost_gt: "",
  latency_ms_gt: "",
  sort: "timestamp",
  order: "desc",
  group: "",
  recovered: "",
  request: "",
  page: "0",
  size: "50",
} as const

export type ActivityUrlKey = keyof typeof ACTIVITY_URL_DEFAULTS
export type ActivityUrl = UrlState<ActivityUrlKey>
/** A change to the page's URL: the keys it sets, each to one value or several. */
export type Patch = Partial<Record<ActivityUrlKey, string | string[]>>

export type ColumnKey =
  | "time"
  | "member"
  | "model"
  | "policy"
  | "source"
  | "tokens"
  | "cost"
  | "latency"
  | "status"

export const SORT_KEYS: Record<ColumnKey, UsageSortKey> = {
  time: "timestamp",
  member: "member",
  model: "model",
  policy: "policy",
  source: "source",
  tokens: "tokens",
  cost: "cost",
  latency: "latency",
  status: "status",
}

// Text columns sort A to Z first; numbers, and status, lead with the largest.
const TEXT_COLUMNS: readonly ColumnKey[] = [
  "member",
  "model",
  "policy",
  "source",
]

export function firstOrder(column: ColumnKey): UsageSort["order"] {
  return TEXT_COLUMNS.includes(column) ? "asc" : "desc"
}

/** What one press of a column's header does: first order, the other, then back to newest first. */
export function nextSort(column: ColumnKey, current: UsageSort): UsageSort {
  const key = SORT_KEYS[column]
  if (column === "time") {
    return {
      key,
      order: current.key === key && current.order === "desc" ? "asc" : "desc",
    }
  }
  const first = firstOrder(column)
  if (current.key !== key) return { key, order: first }
  if (current.order === first) {
    return { key, order: first === "asc" ? "desc" : "asc" }
  }
  return NEWEST_FIRST
}

export function describeSort(column: ColumnKey, order: UsageSort["order"]) {
  if (column === "time")
    return order === "asc" ? "Oldest first" : "Newest first"
  if (column === "status") {
    return order === "desc" ? "Failures first" : "Succeeded first"
  }
  if (TEXT_COLUMNS.includes(column)) return order === "asc" ? "A → Z" : "Z → A"
  return order === "asc" ? "Lowest first" : "Highest first"
}

export function columnForSort(key: UsageSortKey): ColumnKey {
  const found = (Object.keys(SORT_KEYS) as ColumnKey[]).find(
    (column) => SORT_KEYS[column] === key,
  )
  return found ?? "time"
}

export function readSort(url: ActivityUrl): UsageSort {
  const key = url.get("sort")
  const known = (Object.values(SORT_KEYS) as string[]).includes(key)
  return {
    key: known ? (key as UsageSortKey) : NEWEST_FIRST.key,
    order: url.get("order") === "asc" ? "asc" : "desc",
  }
}

/** Every key that filters a column, for marking it filtered and for clearing it. */
export const COLUMN_FILTER_KEYS: Record<ColumnKey, ActivityUrlKey[]> = {
  time: [],
  member: ["user_id", "exclude_user_id"],
  model: ["model", "exclude_model", "requested_model"],
  policy: ["policy_name", "exclude_policy_name", "routed"],
  source: ["api_key_id", "exclude_api_key_id", "source", "exclude_source"],
  tokens: ["tokens_gt"],
  cost: ["cost_gt", "priced"],
  latency: ["latency_ms_gt"],
  status: ["status", "exclude_status"],
}

export function isColumnFiltered(url: ActivityUrl, column: ColumnKey) {
  return COLUMN_FILTER_KEYS[column].some((key) => url.getAll(key).length > 0)
}

/** The columns filtered by picking values, and the pair of keys each writes. */
export const VALUE_FILTERS = {
  member: { include: "user_id", exclude: "exclude_user_id" },
  model: { include: "model", exclude: "exclude_model" },
  policy: { include: "policy_name", exclude: "exclude_policy_name" },
  source: { include: "api_key_id", exclude: "exclude_api_key_id" },
  status: { include: "status", exclude: "exclude_status" },
} as const satisfies Record<
  string,
  { include: ActivityUrlKey; exclude: ActivityUrlKey }
>
export type ValueColumn = keyof typeof VALUE_FILTERS

const STATUSES = ["success", "error", "absorbed"] as const
export type Status = (typeof STATUSES)[number]

// An absorbed row is an attempt a routing policy recovered from, so the
// request it belonged to was served: "Recovered", not "Failed".
export const STATUS_LABELS: Record<Status, string> = {
  success: "Succeeded",
  error: "Failed",
  absorbed: "Recovered",
}

/**
 * The statuses picked, as the API takes them. A pick that keeps "Recovered"
 * also asks for absorbed rows, which the list otherwise leaves out of any read
 * that names no single status.
 */
export function statusParams(
  include: readonly string[],
  exclude: readonly string[],
): Pick<UsageFilters, "status" | "exclude_status" | "include_absorbed"> {
  const allowed = STATUSES.filter(
    (status) =>
      (include.length === 0 || include.includes(status)) &&
      !exclude.includes(status),
  )
  if (allowed.length === STATUSES.length) return {}
  const absorbed = allowed.includes("absorbed")
    ? { include_absorbed: true }
    : {}
  if (allowed.length === 1) return { status: allowed[0], ...absorbed }
  return {
    exclude_status: STATUSES.filter((status) => !allowed.includes(status)),
    ...absorbed,
  }
}

/** Only these values, or everything but them: replaces the column's other pick. */
export function valuePatch(
  url: ActivityUrl,
  column: ValueColumn,
  value: string,
  mode: "include" | "exclude",
): Patch {
  const keys = VALUE_FILTERS[column]
  const current = url.getAll(keys[mode])
  return {
    [keys[mode]]: current.includes(value) ? current : [...current, value],
    [keys[mode === "include" ? "exclude" : "include"]]: [],
  }
}

/**
 * Toggle one value in a column's checklist. An excluded value is unchecked in
 * the list, so pressing it lifts the exclusion rather than adding a pick.
 */
export function togglePatch(
  url: ActivityUrl,
  column: ValueColumn,
  value: string,
): Patch {
  const { include, exclude } = VALUE_FILTERS[column]
  const excluded = url.getAll(exclude)
  if (excluded.includes(value)) {
    return { [exclude]: excluded.filter((one) => one !== value) }
  }
  const picked = url.getAll(include)
  return {
    [include]: picked.includes(value)
      ? picked.filter((one) => one !== value)
      : [...picked, value],
  }
}

export interface ValueOption {
  value: string
  label: string
  /** Requests carrying it in the window, when the page knows. */
  count?: number
}

/**
 * The three outcomes as a checklist, counted from the window's totals while no
 * status filter narrows them (after that the totals count only what is picked).
 */
export function statusOptions(
  url: ActivityUrl,
  totals: UsageTotals | undefined,
): ValueOption[] {
  const counts: Partial<Record<Status, number>> =
    totals &&
    !url.getAll("status").length &&
    !url.getAll("exclude_status").length
      ? {
          success: totals.request_count - totals.error_count,
          error: totals.error_count,
          absorbed: totals.absorbed_count,
        }
      : {}
  return STATUSES.map((status) => ({
    value: status,
    label: STATUS_LABELS[status],
    count: counts[status],
  }))
}

/** A grouping's values as a checklist, busiest first, leaving out the group with none. */
export function groupOptions(
  groups: readonly UsageActivityGroup[] | undefined,
  label: (group: UsageActivityGroup & { key: string }) => string,
): ValueOption[] {
  return (groups ?? [])
    .flatMap((group) =>
      group.key === null
        ? []
        : [
            {
              value: group.key,
              label: label({ ...group, key: group.key }),
              count: group.requests,
            },
          ],
    )
    .sort((a, b) => b.count - a.count)
}

/**
 * Only the successful requests that carried no price, which is what the totals
 * count as unpriced (a failure carries no cost either). Turning it off drops the
 * status it set, and only that one, so a status picked on its own survives.
 */
export function unpricedPatch(url: ActivityUrl, isOn: boolean): Patch {
  const status = url.getAll("status")
  if (isOn) {
    return status.length || url.getAll("exclude_status").length
      ? { priced: "false" }
      : { priced: "false", status: "success" }
  }
  return status.length === 1 && status[0] === "success"
    ? { priced: "", status: "" }
    : { priced: "" }
}

/**
 * What a cell's own filter writes. Most columns filter on the value they show;
 * a Source cell filters on the key a gateway request used or the source an
 * imported one came from, and a Policy cell reading "Direct" on whether the
 * request was routed at all.
 */
export function cellFilterPatch(
  url: ActivityUrl,
  column: ColumnKey,
  entry: UsageEntry,
  mode: "include" | "exclude",
): Patch | undefined {
  switch (column) {
    case "member":
      return entry.user_id
        ? valuePatch(url, "member", entry.user_id, mode)
        : undefined
    case "model":
      return valuePatch(url, "model", entry.model, mode)
    case "policy":
      return entry.policy_name
        ? valuePatch(url, "policy", entry.policy_name, mode)
        : { routed: mode === "include" ? "false" : "true" }
    case "source":
      if (isImported(entry)) {
        return mode === "include"
          ? { source: entry.source, exclude_source: [] }
          : {
              source: "",
              exclude_source: [...url.getAll("exclude_source"), entry.source],
            }
      }
      return entry.api_key_id
        ? valuePatch(url, "source", entry.api_key_id, mode)
        : undefined
    case "status":
      return valuePatch(url, "status", entry.status, mode)
    default:
      return undefined
  }
}

/** "Filter to" from a request's details: its session, source, model, or the tools it ran. */
export function panelFilterPatch(
  url: ActivityUrl,
  filter: "session" | "source" | "model" | "tool",
  entry: UsageEntry,
): Patch | undefined {
  switch (filter) {
    case "session":
      return { source_label: entry.source_label ?? "" }
    case "model":
      return valuePatch(url, "model", entry.model, "include")
    case "tool":
      return toolPatch(listToolUsage(entry).map((tool) => tool.tool))
    default:
      return cellFilterPatch(url, "source", entry, "include")
  }
}

/** Requests that ran these gateway tools: the one named, or any of several. */
export function toolPatch(tools: readonly string[]): Patch {
  return { tool: tools.length === 1 ? tools[0] : "any" }
}

export const THRESHOLD_FILTERS = {
  tokens: {
    key: "tokens_gt",
    presets: [500_000, 100_000, 10_000],
    describe: (value: number) => `> ${formatCompact(value)}`,
  },
  cost: {
    key: "cost_gt",
    presets: [0.4, 0.1, 0.01],
    describe: (value: number) => `> ${formatUsd(value)}`,
  },
  latency: {
    key: "latency_ms_gt",
    presets: [10_000, 5_000, 2_000],
    describe: (value: number) => `> ${formatSeconds(value)}`,
  },
} as const satisfies Record<
  string,
  {
    key: ActivityUrlKey
    presets: readonly number[]
    describe: (value: number) => string
  }
>

/** A non-negative number the URL holds, or undefined for anything else. */
export function readNumber(
  url: ActivityUrl,
  key: ActivityUrlKey,
): number | undefined {
  const parsed = Number.parseFloat(url.get(key))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export const GROUPS = {
  source: { label: "API key", groupBy: "api_key" },
  session: { label: "Session", groupBy: "source_label" },
  model: { label: "Model", groupBy: "model" },
  member: { label: "Member", groupBy: "user" },
} as const satisfies Record<
  string,
  { label: string; groupBy: UsageActivityGroupBy }
>
export type GroupKey = keyof typeof GROUPS

/** The groupings in menu order. */
export const GROUP_KEYS: GroupKey[] = ["source", "session", "model", "member"]

export function readGroup(url: ActivityUrl, canSeeMembers: boolean) {
  const group = url.get("group")
  if (!Object.hasOwn(GROUPS, group)) return undefined
  if (group === "member" && !canSeeMembers) return undefined
  return group as GroupKey
}

interface ActivityScope {
  workspaceId?: string
  /** Set when the view is narrowed to the caller's own requests. */
  ownUserId?: string
}

/**
 * The filters every read on the page shares, for the given window.
 *
 * The list, its count and the totals take the brushed span; the chart takes
 * the whole window so there is something to brush. Either way the same
 * filters apply, so the bars and the rows describe one set.
 */
export function toUsageFilters(
  url: ActivityUrl,
  window: { start?: string; end?: string },
  scope: ActivityScope,
): UsageFilters {
  const list = (key: ActivityUrlKey) => {
    const values = url.getAll(key)
    return values.length ? values : undefined
  }
  const routed = url.get("routed")
  const priced = url.get("priced")
  const latency = readNumber(url, "latency_ms_gt")
  const tokens = readNumber(url, "tokens_gt")
  const status = statusParams(
    url.getAll("status"),
    url.getAll("exclude_status"),
  )
  return {
    workspace_id: scope.workspaceId,
    start_date: window.start,
    end_date: window.end,
    status: status.status,
    exclude_status: status.exclude_status,
    model: list("model"),
    exclude_model: list("exclude_model"),
    requested_model: list("requested_model"),
    user_id: scope.ownUserId ? [scope.ownUserId] : list("user_id"),
    exclude_user_id: scope.ownUserId ? undefined : list("exclude_user_id"),
    api_key_id: list("api_key_id"),
    exclude_api_key_id: list("exclude_api_key_id"),
    policy_name: list("policy_name"),
    exclude_policy_name: list("exclude_policy_name"),
    routed: routed === "true" ? true : routed === "false" ? false : undefined,
    source: url.get("source") || undefined,
    exclude_source: list("exclude_source"),
    source_label: url.get("source_label") || undefined,
    endpoint: url.get("endpoint") || undefined,
    provider: url.get("provider") || undefined,
    tool: url.get("tool") || undefined,
    priced: priced === "true" ? true : priced === "false" ? false : undefined,
    tokens_gt: tokens === undefined ? undefined : Math.floor(tokens),
    cost_gt: readNumber(url, "cost_gt"),
    latency_ms_gt: latency === undefined ? undefined : Math.floor(latency),
    q: url.get("q").trim() || undefined,
    // Each routed request is one row, with its earlier failed attempts counted
    // on it, unless the operator asked to see those attempts as rows.
    include_absorbed:
      status.include_absorbed ?? url.get("recovered") === "show",
  }
}

/**
 * Whether a search reads by substring rather than looking up an id, as the
 * server splits it (`is_substring_search`): a UUID, in the spellings Python's
 * `uuid.UUID` takes (braces, hyphens anywhere, a `urn:uuid:` prefix), is an id
 * lookup. The server bounds a substring search to the summary's window, so the
 * page sends it a start.
 */
export function isSubstringSearch(q: string | undefined): boolean {
  const term = (q ?? "").trim()
  if (!term) return false
  const hex = term
    .replaceAll("urn:", "")
    .replaceAll("uuid:", "")
    .replace(/^[{}]+|[{}]+$/g, "")
    .replaceAll("-", "")
  return !/^[0-9a-f]{32}$/i.test(hex)
}

/**
 * The bulk actions' selection: every filter the rows were counted under, so a
 * delete or recost reaches exactly the rows the operator was shown. The server
 * narrows it to imported rows itself.
 */
export function toSelection(filters: UsageFilters): UsageMutationSelection {
  const { include_absorbed: _listOnly, ...selection } = filters
  return { by_filter: true, ...selection }
}

export interface ActivityChip {
  key: string
  label: string
  value: string
  clear: Patch
}

interface ChipNames {
  member: (userId: string) => string
  apiKey: (keyId: string) => string
}

/** Every applied filter as a removable chip, each clearing only itself. */
export function activityChips(
  url: ActivityUrl,
  names: ChipNames,
): ActivityChip[] {
  const chips: ActivityChip[] = []
  const values = (
    key: ActivityUrlKey,
    label: string,
    display: (value: string) => string = (value) => value,
  ) => {
    const picked = url.getAll(key)
    if (picked.length) {
      chips.push({
        key,
        label,
        value: picked.map(display).join(", "),
        clear: { [key]: [] },
      })
    }
  }
  const single = (
    key: ActivityUrlKey,
    label: string,
    display: (value: string) => string = (value) => value,
  ) => {
    const value = url.get(key)
    if (value)
      chips.push({ key, label, value: display(value), clear: { [key]: "" } })
  }
  const status = (value: string) =>
    Object.hasOwn(STATUS_LABELS, value) ? STATUS_LABELS[value as Status] : value
  values("status", "Status", status)
  values("exclude_status", "Status is not", status)
  values("user_id", "Member", names.member)
  values("exclude_user_id", "Member is not", names.member)
  values("model", "Model")
  values("exclude_model", "Model is not")
  values("requested_model", "Requested as")
  values("policy_name", "Policy")
  values("exclude_policy_name", "Policy is not")
  single("routed", "Policy", (value) => (value === "false" ? "Direct" : "Any"))
  values("api_key_id", "Source", names.apiKey)
  values("exclude_api_key_id", "Source is not", names.apiKey)
  single("source", "Source", describeSource)
  values("exclude_source", "Source is not", describeSource)
  single("source_label", "Session")
  single("endpoint", "Endpoint")
  single("provider", "Provider")
  single("tool", "Tool", describeTool)
  single("priced", "Cost", (value) =>
    value === "false" ? "unpriced" : "priced",
  )
  for (const [column, spec] of Object.entries(THRESHOLD_FILTERS)) {
    const value = readNumber(url, spec.key)
    if (value !== undefined) {
      chips.push({
        key: spec.key,
        label: column[0].toUpperCase() + column.slice(1),
        value: spec.describe(value),
        clear: { [spec.key]: "" },
      })
    }
  }
  return chips
}

/** Clears every filter, the search and the span, leaving the window, sort and grouping. */
export const CLEAR_FILTERS: Patch = Object.fromEntries(
  (Object.keys(ACTIVITY_URL_DEFAULTS) as ActivityUrlKey[])
    .filter(
      (key) =>
        ![
          "range",
          "scope",
          "sort",
          "order",
          "group",
          "recovered",
          "request",
          "page",
          "size",
        ].includes(key),
    )
    .map((key) => [key, ""]),
)

// What a view holds: everything that decides which rows and how they are laid
// out, and nothing about where the reader is in them (the page, an open
// request) or the span they brushed, which is a moment rather than a view.
const VIEW_KEYS = (
  Object.keys(ACTIVITY_URL_DEFAULTS) as ActivityUrlKey[]
).filter(
  (key) =>
    !["start_date", "end_date", "scope", "request", "page", "size"].includes(
      key,
    ),
)

/** The current view as a canonical query string: keys in one order, defaults left out. */
export function viewQuery(url: ActivityUrl): string {
  const params = new URLSearchParams()
  for (const key of VIEW_KEYS) {
    const values = url.getAll(key)
    const fallback = ACTIVITY_URL_DEFAULTS[key]
    if (values.length === 1 && values[0] === fallback) continue
    for (const value of values) params.append(key, value)
  }
  return params.toString()
}

/** Everything a view sets, with every key it does not name reset, so applying one replaces the view. */
export function viewPatch(query: string): Patch {
  const params = new URLSearchParams(query)
  const patch: Patch = { start_date: "", end_date: "", page: "0" }
  for (const key of VIEW_KEYS) {
    const values = params.getAll(key)
    patch[key] = values.length > 1 ? values : (values[0] ?? "")
  }
  return patch
}

export interface BuiltInView {
  name: string
  query: string
}

export const BUILT_IN_VIEWS: BuiltInView[] = [
  { name: "All requests", query: "" },
  { name: "Failures this week", query: "range=7d&status=error" },
  { name: "Expensive calls", query: "cost_gt=0.4" },
  { name: "Claude Code sessions", query: "source=claude_code&group=session" },
]
