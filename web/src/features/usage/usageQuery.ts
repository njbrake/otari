import type {
  BreakdownDimension,
  UsageChannel,
  UsageFilters,
  UsageGroupBy,
  UsageSummary,
} from "@/client"
import type { BuiltInView } from "@/features/savedViews/savedViews"
import type { UsageBreakdownRow } from "@/shared/api/usage"
import type { DashboardSearch } from "@/shared/helpers/search"
import {
  findPreset,
  USAGE_DEFAULT_KEY,
  USAGE_PRESETS,
} from "@/shared/helpers/timeRange"
import type { UrlState } from "@/shared/helpers/urlState"

/**
 * Everything that decides what the Usage page shows, in the URL, under the
 * usage API's and the Activity page's own names wherever the two share one, so
 * a link from Keys (`api_key_id`) lands on the filter it means and a drill into
 * Activity carries the same filters across.
 */
export const USAGE_URL_DEFAULTS = {
  // "" is the reader's default: Workspace for someone who manages it, You for
  // everyone else.
  scope: "",
  range: USAGE_DEFAULT_KEY,
  // A span dragged on the chart, inside the window.
  start_date: "",
  end_date: "",
  // The breakdown that drives the chart and the table; "" is the scope's first.
  by: "",
  metric: "cost",
  // "exclude" leaves subscription usage out of the cost the chart draws.
  subscription: "",
  sort: "",
  order: "",
  model: "",
  exclude_model: "",
  api_key_id: "",
  exclude_api_key_id: "",
  user_id: "",
  exclude_user_id: "",
  source_label: "",
  channel: "",
  exclude_channel: "",
  provider: "",
  policy_name: "",
  exclude_policy_name: "",
  workspace_id: "",
} as const

type UsageUrlKey = keyof typeof USAGE_URL_DEFAULTS
export type UsageUrl = UrlState<UsageUrlKey>
type UsagePatch = Partial<Record<UsageUrlKey, string | string[]>>

// ---------- scope ----------

export type UsageScopeKey = "you" | "workspace" | "organization"

export const SCOPE_LABELS: Record<UsageScopeKey, string> = {
  you: "You",
  workspace: "Workspace",
  organization: "Organization",
}

/**
 * The scopes a reader may pick, in the order the switch lists them. A manager
 * whose own requests cannot be told apart reads the workspace only; while the
 * roster that would tell them apart loads, You stays offered.
 */
export function scopesFor(viewer: {
  isManager: boolean
  canReadOrganization: boolean
  ownUserId: string | undefined
  isFindingOwnUserId: boolean
}): UsageScopeKey[] {
  if (!viewer.isManager) return ["you"]
  const canNarrowToOwn =
    viewer.ownUserId !== undefined || viewer.isFindingOwnUserId
  return [
    "workspace",
    ...(canNarrowToOwn ? (["you"] as const) : []),
    ...(viewer.canReadOrganization ? (["organization"] as const) : []),
  ]
}

/** The scope the URL names, if the reader may have it, else their default. */
export function readScope(
  url: { get: (key: "scope") => string },
  scopes: readonly UsageScopeKey[],
): UsageScopeKey {
  const asked = url.get("scope")
  return (scopes as readonly string[]).includes(asked)
    ? (asked as UsageScopeKey)
    : scopes[0]
}

// ---------- windows ----------

/** The windows the page offers: no hour, which Activity answers request by request. */
export const WINDOWS = USAGE_PRESETS.map((preset) => ({
  value: preset.key,
  label: preset.label,
}))

export function readPreset(url: UsageUrl) {
  return (
    findPreset(USAGE_PRESETS, url.get("range")) ??
    (findPreset(USAGE_PRESETS, USAGE_DEFAULT_KEY) as (typeof USAGE_PRESETS)[0])
  )
}

// ---------- breakdowns ----------

export type DimensionKey =
  | "model"
  | "key"
  | "session"
  | "channel"
  | "provider"
  | "policy"
  | "member"
  | "workspace"

interface DimensionDef {
  label: string
  /** How the table's heading names it after "By": "model", "API key". */
  noun: string
  /** The summary's `dimensions` value, and the latency's `group_by`. */
  summary: BreakdownDimension
  /** The grouped series' `group_by`. */
  series: UsageGroupBy
  rows: (summary: UsageSummary) => UsageBreakdownRow[] | undefined
  /** The URL key a value is picked under, and the one it is left out under where the API can. */
  include: UsageUrlKey
  exclude?: UsageUrlKey
  /** Values that are identifiers, set in mono. */
  isMono?: boolean
  /** How a row with no value reads, and what it holds. */
  none?: { label: string; hint: string }
}

export const DIMENSIONS: Record<DimensionKey, DimensionDef> = {
  model: {
    label: "Model",
    noun: "model",
    summary: "model",
    series: "model",
    rows: (summary) => summary.by_model,
    include: "model",
    exclude: "exclude_model",
    isMono: true,
  },
  key: {
    label: "API key",
    noun: "API key",
    summary: "api_key",
    series: "api_key_id",
    rows: (summary) => summary.by_api_key,
    include: "api_key_id",
    exclude: "exclude_api_key_id",
    none: {
      label: "No API key",
      hint: "Imported usage and requests made without a key",
    },
  },
  session: {
    label: "Session",
    noun: "session",
    summary: "source_label",
    series: "source_label",
    rows: (summary) => summary.by_source_label,
    include: "source_label",
    isMono: true,
    none: {
      label: "No session",
      hint: "Requests sent without a session ID (scripts, CI, apps)",
    },
  },
  channel: {
    label: "Channel",
    noun: "channel",
    summary: "channel",
    series: "channel",
    rows: (summary) => summary.by_channel,
    include: "channel",
    exclude: "exclude_channel",
  },
  provider: {
    label: "Provider",
    noun: "provider",
    summary: "provider",
    series: "provider",
    rows: (summary) => summary.by_provider,
    include: "provider",
    isMono: true,
  },
  policy: {
    label: "Policy",
    noun: "policy",
    summary: "policy",
    series: "policy",
    rows: (summary) => summary.by_policy,
    include: "policy_name",
    exclude: "exclude_policy_name",
    isMono: true,
    none: {
      label: "Direct",
      hint: "No routing policy: a model named directly or through an alias",
    },
  },
  member: {
    label: "Member",
    noun: "member",
    summary: "user",
    series: "user_id",
    rows: (summary) => summary.by_user,
    include: "user_id",
    exclude: "exclude_user_id",
    none: { label: "No member", hint: "Requests billed to no member" },
  },
  workspace: {
    label: "Workspace",
    noun: "workspace",
    summary: "workspace",
    series: "workspace",
    rows: (summary) => summary.by_workspace,
    include: "workspace_id",
  },
}

const SCOPE_DIMENSIONS: Record<UsageScopeKey, DimensionKey[]> = {
  you: ["model", "key", "session", "channel", "provider", "policy"],
  workspace: [
    "member",
    "model",
    "key",
    "session",
    "channel",
    "provider",
    "policy",
  ],
  organization: ["workspace", "model", "provider", "channel"],
}

export function dimensionsFor(scope: UsageScopeKey): DimensionKey[] {
  return SCOPE_DIMENSIONS[scope]
}

/** The breakdown the URL names, if the scope has it, else the scope's first. */
export function readDimension(
  url: UsageUrl,
  scope: UsageScopeKey,
): DimensionKey {
  const asked = url.get("by")
  const offered = dimensionsFor(scope)
  return (offered as string[]).includes(asked)
    ? (asked as DimensionKey)
    : offered[0]
}

// ---------- filters ----------

export type Mode = "include" | "exclude"

/** One applied filter, as its chip says it. */
export interface UsageFilter {
  dimension: DimensionKey
  mode: Mode
  values: string[]
}

/** Every filter the URL holds, whichever scope the page is in. */
export function readFilters(url: UsageUrl): UsageFilter[] {
  return (Object.keys(DIMENSIONS) as DimensionKey[]).flatMap((dimension) => {
    const def = DIMENSIONS[dimension]
    const keep = url.getAll(def.include)
    const drop = def.exclude ? url.getAll(def.exclude) : []
    return [
      ...(keep.length
        ? [{ dimension, mode: "include" as const, values: keep }]
        : []),
      ...(drop.length
        ? [{ dimension, mode: "exclude" as const, values: drop }]
        : []),
    ]
  })
}

/** Whether a dimension's value can be picked several at a time, or left out. */
export function canExclude(dimension: DimensionKey): boolean {
  return DIMENSIONS[dimension].exclude !== undefined
}

/** A value picked or left out from a breakdown row, replacing the other mode. */
export function filterPatch(
  url: UsageUrl,
  dimension: DimensionKey,
  value: string,
  mode: Mode,
): UsagePatch {
  const def = DIMENSIONS[dimension]
  if (!def.exclude) return { [def.include]: value }
  const key = mode === "include" ? def.include : def.exclude
  const other = mode === "include" ? def.exclude : def.include
  const current = url.getAll(key)
  return {
    [key]: current.includes(value) ? current : [...current, value],
    [other]: [],
  }
}

/** Clears one chip's filter. */
export function clearPatch(filter: UsageFilter): UsagePatch {
  const def = DIMENSIONS[filter.dimension]
  const key =
    filter.mode === "exclude" && def.exclude ? def.exclude : def.include
  return { [key]: [] }
}

/** Clears every filter and the span. */
export const CLEAR_FILTERS: UsagePatch = Object.fromEntries([
  ["start_date", ""],
  ["end_date", ""],
  ...Object.values(DIMENSIONS).flatMap((def) =>
    def.exclude
      ? [
          [def.include, []],
          [def.exclude, []],
        ]
      : [[def.include, []]],
  ),
])

/** What a filter on a dimension asks the usage API for. */
function dimensionFilters(filter: UsageFilter): UsageFilters {
  const { dimension, mode, values } = filter
  const exclude = mode === "exclude"
  switch (dimension) {
    case "model":
      return exclude ? { exclude_model: values } : { model: values }
    case "key":
      return exclude ? { exclude_api_key_id: values } : { api_key_id: values }
    case "member":
      return exclude ? { exclude_user_id: values } : { user_id: values }
    case "policy":
      return exclude ? { exclude_policy_name: values } : { policy_name: values }
    case "session":
      return { source_label: values[0] }
    case "provider":
      return { provider: values[0] }
    case "workspace":
      return { workspace_id: values[0] }
    case "channel":
      return exclude
        ? { exclude_channel: values as UsageChannel[] }
        : { channel: values as UsageChannel[] }
  }
}

export interface UsageContext {
  scope: UsageScopeKey
  /** The sidebar's workspace, which You and Workspace read. */
  workspaceId: string | undefined
  /** The caller's own id, which a manager's You narrows to. */
  ownUserId: string | undefined
  isManager: boolean
}

/** The usage API's filters for what the page shows, in the scope it is in. */
export function toUsageFilters(
  filters: readonly UsageFilter[],
  window: { start?: string; end?: string },
  context: UsageContext,
): UsageFilters {
  const merged: UsageFilters = {
    start_date: window.start,
    end_date: window.end,
  }
  if (context.scope !== "organization") {
    merged.workspace_id = context.workspaceId
  }
  if (context.scope === "you" && context.isManager && context.ownUserId) {
    merged.user_id = [context.ownUserId]
  }
  for (const filter of filters) Object.assign(merged, dimensionFilters(filter))
  return merged
}

// ---------- drilling into Activity ----------

/** Activity's own name for each value a breakdown row narrows to. */
function activityParams(
  dimension: DimensionKey,
  values: string[],
  mode: Mode,
): DashboardSearch {
  const one = values.length === 1 ? values[0] : values
  const exclude = mode === "exclude"
  switch (dimension) {
    case "model":
      return { [exclude ? "exclude_model" : "model"]: one }
    case "key":
      return { [exclude ? "exclude_api_key_id" : "api_key_id"]: one }
    case "member":
      return { [exclude ? "exclude_user_id" : "user_id"]: one }
    case "policy":
      return { [exclude ? "exclude_policy_name" : "policy_name"]: one }
    case "session":
      return { source_label: values[0] }
    case "provider":
      return { provider: values[0] }
    case "workspace":
      return { workspace: values[0] }
    case "channel":
      return { [exclude ? "exclude_channel" : "channel"]: one }
  }
}

/**
 * Activity's search for the requests behind what the page shows: the window or
 * span, the scope, every filter that applies, and optionally one row's value.
 * Undefined where Activity cannot show them: it reads one workspace, so an
 * Organization view needs a workspace, from the row or from a filter.
 */
export function activitySearch({
  window,
  context,
  filters,
  row,
}: {
  window: { start?: string; end?: string }
  context: UsageContext
  filters: readonly UsageFilter[]
  row?: { dimension: DimensionKey; key: string | null }
}): DashboardSearch | undefined {
  const search: DashboardSearch = {}
  if (window.start) search.start_date = window.start
  if (window.end) search.end_date = window.end
  if (context.scope === "you" && context.isManager) search.scope = "you"
  for (const filter of filters) {
    if (row && filter.dimension === row.dimension) continue
    Object.assign(
      search,
      activityParams(filter.dimension, filter.values, filter.mode),
    )
  }
  if (row) {
    if (row.key === null) {
      if (row.dimension !== "policy") return undefined
      search.routed = "false"
    } else {
      Object.assign(search, activityParams(row.dimension, [row.key], "include"))
    }
  }
  if (context.scope === "organization" && search.workspace === undefined) {
    return undefined
  }
  return search
}

// ---------- the table's sort ----------

export type SortKey =
  | "name"
  | "value"
  | "requests"
  | "tokens"
  | "billed"
  | "subscription"
  | "failed"
  | "p95"

const SORT_KEYS: SortKey[] = [
  "name",
  "value",
  "requests",
  "tokens",
  "billed",
  "subscription",
  "failed",
  "p95",
]

export interface TableSort {
  key: SortKey
  order: "asc" | "desc"
}

/** The table's sort, the share of the metric, largest first, unless the URL says otherwise. */
export function readSort(url: UsageUrl): TableSort {
  const key = url.get("sort") as SortKey
  const known = SORT_KEYS.includes(key)
  const order = url.get("order")
  return {
    key: known ? key : "value",
    order:
      order === "asc" || order === "desc"
        ? order
        : known && key === "name"
          ? "asc"
          : "desc",
  }
}

/** The sort written back: the default leaves the URL bare. */
export function sortPatch(sort: TableSort): UsagePatch {
  const isDefault = sort.key === "value" && sort.order === "desc"
  return isDefault
    ? { sort: "", order: "" }
    : { sort: sort.key, order: sort.order }
}

// ---------- saved views ----------

// What a view holds: what is shown and how, and not the span, which is a moment,
// nor the scope, which is the reader's.
const VIEW_KEYS = (Object.keys(USAGE_URL_DEFAULTS) as UsageUrlKey[]).filter(
  (key) => !["start_date", "end_date", "scope"].includes(key),
)

/** The current view as a canonical query string: keys in one order, defaults left out. */
export function viewQuery(url: UsageUrl): string {
  const params = new URLSearchParams()
  for (const key of VIEW_KEYS) {
    const values = url.getAll(key)
    const fallback = USAGE_URL_DEFAULTS[key]
    if (values.length === 1 && values[0] === fallback) continue
    for (const value of values) params.append(key, value)
  }
  return params.toString()
}

/** Everything a view sets, with every key it does not name reset. */
export function viewPatch(query: string): UsagePatch {
  const params = new URLSearchParams(query)
  const patch: UsagePatch = { start_date: "", end_date: "" }
  for (const key of VIEW_KEYS) {
    const values = params.getAll(key)
    patch[key] = values.length > 1 ? values : (values[0] ?? "")
  }
  return patch
}

export const USAGE_VIEWS: BuiltInView[] = [
  { name: "All usage", query: "" },
  {
    name: "Subscription sessions",
    query: "by=session&channel=imported",
    description: "Imported usage, such as Claude Code",
  },
  { name: "Spend by API key", query: "by=key" },
  { name: "Billed API traffic", query: "channel=api" },
]
