import { useMemo } from "react"

import type { UsageFilters, ValueGroupBy } from "@/client"
import type { ColumnFilterOption } from "@/design-system/data/ColumnFilterList"
import { STATUS_OPTIONS } from "@/features/activity/activityModel"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { userDisplay } from "@/features/users/userDisplay"
import { useUsageValueGroups } from "@/shared/api/usage"
import {
  formatLatency,
  formatTokensCompact,
  formatUsd,
} from "@/shared/helpers/format"
import { providerDisplayName } from "@/shared/helpers/providers"
import { useUrlState } from "@/shared/helpers/urlState"
import { useSelectedWorkspace } from "@/shared/hooks/SelectedWorkspace"
import { useSurfaces } from "@/shared/hooks/useDeployment"
import { type ObserveView, statusApplies, windowFor } from "./observeSearch"
import { useObserveScope } from "./useObserveScope"

/** A column whose values a funnel lists, each written to its own URL keys. */
export type ValueDimension =
  | "model"
  | "user"
  | "api_key"
  | "provider"
  | "status"
  | "policy"

/** A threshold a row must exceed, on the token, cost and latency columns. */
export type ThresholdKey = "tokens_gt" | "cost_gt" | "latency_ms_gt"

/** A filter a column carries beside its values: unpriced rows, direct requests. */
export type ExtraKey = "unpriced" | "direct"

const URL_DEFAULTS = {
  scope: "",
  range: "",
  start_date: "",
  end_date: "",
  status: "",
  exclude_status: "",
  model: "",
  exclude_model: "",
  user_id: "",
  exclude_user_id: "",
  api_key_id: "",
  exclude_api_key_id: "",
  provider: "",
  policy_name: "",
  exclude_policy_name: "",
  routed: "",
  tokens_gt: "",
  cost_gt: "",
  latency_ms_gt: "",
  priced: "",
  source: "",
  source_label: "",
  endpoint: "",
  status_code: "",
  tool: "",
  page: "0",
} as const

export type ObserveUrlKey = keyof typeof URL_DEFAULTS

/** The URL keys a value column includes and excludes by. */
export const VALUE_KEYS: Record<
  ValueDimension,
  { include: ObserveUrlKey; exclude?: ObserveUrlKey; isSingle?: boolean }
> = {
  model: { include: "model", exclude: "exclude_model" },
  user: { include: "user_id", exclude: "exclude_user_id" },
  api_key: { include: "api_key_id", exclude: "exclude_api_key_id" },
  provider: { include: "provider", isSingle: true },
  status: { include: "status", exclude: "exclude_status", isSingle: true },
  policy: { include: "policy_name", exclude: "exclude_policy_name" },
}

/** The presets each threshold offers, and how a value reads. */
export const THRESHOLDS: Record<
  ThresholdKey,
  { label: string; presets: number[]; describe: (value: number) => string }
> = {
  tokens_gt: {
    label: "Tokens",
    presets: [500_000, 100_000, 10_000],
    describe: (value) => `> ${formatTokensCompact(value)}`,
  },
  cost_gt: {
    label: "Cost",
    presets: [0.4, 0.1, 0.01],
    describe: (value) => `> ${formatUsd(value)}`,
  },
  latency_ms_gt: {
    label: "Total time",
    presets: [10_000, 5_000, 2_000],
    describe: (value) => `> ${formatLatency(value)}`,
  },
}

/** A non-negative number the URL holds, or undefined for anything else. */
export function readThreshold(raw: string): number | undefined {
  const parsed = Number.parseFloat(raw)
  return raw !== "" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined
}

const listOrNone = (values: string[]) =>
  values.length > 0 ? values : undefined

/**
 * The filters a Sessions tab reads from the URL, and the writer that changes
 * them and returns to the first page.
 *
 * The exclusions, the routing policy, the provider and the thresholds are the
 * request log's alone (`isRequests`): they are not shared keys, so a tab switch
 * leaves them behind, and a link that names one elsewhere shows it as not
 * applied.
 */
export function useObserveFilterState(view: ObserveView) {
  const url = useUrlState(URL_DEFAULTS)
  const { scope, userIds: users, isResolved, clearMine } = useObserveScope()
  const status = url.get("status")
  const patch = url.patch
  return {
    url,
    patch: (updates: Parameters<typeof patch>[0]) =>
      patch({ ...updates, page: 0 }),
    status,
    statusApplied: statusApplies(view, status),
    users,
    isRequests: view === "requests",
    isMine: scope === "mine",
    isResolved,
    clearMine,
  }
}

export type ObserveFilterState = ReturnType<typeof useObserveFilterState>

/** The values a column's own URL keys hold. */
export function valuesOf(
  state: ObserveFilterState,
  dimension: ValueDimension,
): { selected: string[]; excluded: string[] } {
  const keys = VALUE_KEYS[dimension]
  const selected =
    dimension === "user"
      ? state.isMine
        ? []
        : state.users
      : state.url.getAll(keys.include)
  return {
    selected,
    excluded: keys.exclude ? state.url.getAll(keys.exclude) : [],
  }
}

/**
 * Every filter the view applies, as the usage reads take them, with one column's
 * own filters left out so its list stays complete.
 */
function usageFiltersFor(
  state: ObserveFilterState,
  leaveOut: ValueDimension,
): Omit<UsageFilters, "workspace_id" | "start_date" | "end_date"> {
  const { url, isRequests } = state
  const all = (dimension: ValueDimension) =>
    dimension === leaveOut
      ? undefined
      : listOrNone(url.getAll(VALUE_KEYS[dimension].include))
  const out = (dimension: ValueDimension) => {
    const key = VALUE_KEYS[dimension].exclude
    return isRequests && key && dimension !== leaveOut
      ? listOrNone(url.getAll(key))
      : undefined
  }
  const threshold = (key: ThresholdKey) =>
    isRequests ? readThreshold(url.get(key)) : undefined
  const priced = url.get("priced")
  return {
    status:
      leaveOut !== "status" && state.statusApplied && state.status
        ? state.status
        : undefined,
    exclude_status: out("status") as UsageFilters["exclude_status"],
    model: all("model"),
    exclude_model: out("model"),
    // Under Mine the user is the caller, whatever the column lists.
    user_id:
      state.isMine || leaveOut !== "user" ? listOrNone(state.users) : undefined,
    exclude_user_id: out("user"),
    api_key_id: all("api_key"),
    exclude_api_key_id: out("api_key"),
    ...(isRequests
      ? {
          provider:
            leaveOut === "provider"
              ? undefined
              : url.get("provider") || undefined,
          policy_name: all("policy"),
          exclude_policy_name: out("policy"),
          routed:
            leaveOut !== "policy" && url.get("routed") === "false"
              ? false
              : undefined,
          tokens_gt: threshold("tokens_gt"),
          cost_gt: threshold("cost_gt"),
          latency_ms_gt: threshold("latency_ms_gt"),
          priced:
            priced === "true" ? true : priced === "false" ? false : undefined,
          source: url.get("source") || undefined,
          source_label: url.get("source_label") || undefined,
          endpoint: url.get("endpoint") || undefined,
          status_code: url.get("status_code") || undefined,
          tool: url.get("tool") || undefined,
        }
      : {}),
  }
}

const GROUP_BY: Record<ValueDimension, ValueGroupBy> = {
  model: "model",
  user: "user",
  api_key: "api_key",
  provider: "provider",
  status: "status",
  policy: "policy",
}

// Values per read; past them the list says how many more there are.
const PAGE = 50

// The window is read off the clock, so two readers a few milliseconds apart (a
// funnel and the chips naming its values) would key two reads of one list. To
// the minute, they share it.
const MINUTE_MS = 60_000

/**
 * One column's values over the window the view shows, busiest first, searched
 * on the server, with that column's own filters left out so its list stays
 * complete. Read only while `enabled`: a funnel asks when it opens, and the
 * chips when they have a value to name. Where the usage surface is not served
 * there is nothing to read, and the list is empty.
 */
export function useValueOptions(
  view: ObserveView,
  dimension: ValueDimension,
  search: string,
  enabled: boolean,
): {
  options: ColumnFilterOption[]
  more: number
  isLoading: boolean
  isError: boolean
} {
  const state = useObserveFilterState(view)
  const { url } = state
  const hasSurface = useSurfaces()
  const memberLabels = useMemberAttributionLabels()
  const { selected: workspace } = useSelectedWorkspace()
  const range = url.get("range")
  const startParam = url.get("start_date")
  const endParam = url.get("end_date")
  const minute = enabled ? Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS : 0
  const win = useMemo(
    () =>
      windowFor(
        view,
        { range, start_date: startParam, end_date: endParam },
        minute || Date.now(),
      ),
    [view, range, startParam, endParam, minute],
  )
  const restKey = JSON.stringify(usageFiltersFor(state, dimension))
  const filters: UsageFilters = useMemo(
    () => ({
      ...(JSON.parse(restKey) as UsageFilters),
      workspace_id: workspace?.workspace_id,
      start_date: win.start || undefined,
      end_date: win.end || undefined,
    }),
    [restKey, workspace?.workspace_id, win],
  )
  const read = useUsageValueGroups(
    filters,
    GROUP_BY[dimension],
    search,
    enabled && hasSurface("usage") && state.isResolved,
    PAGE,
  )
  // The rows with no value (no key, no user, no policy) are not a value to
  // pick; a direct request is the Routing column's own filter.
  const groups = (read.data?.groups ?? []).filter((group) => group.key !== null)
  const options = groups.map((group): ColumnFilterOption => {
    const key = group.key as string
    const count = group.requests
    switch (dimension) {
      case "provider":
        return { value: key, label: providerDisplayName(key), count }
      case "user": {
        // Name first, id in parentheses: the id is what the filter submits,
        // and two people can share a name.
        const name = userDisplay(key, group.label, memberLabels)
        return {
          value: key,
          label: name.id ? `${name.label} (${name.id})` : name.label,
          count,
        }
      }
      case "api_key":
        return {
          value: key,
          label: group.label ?? `${key.slice(0, 8)}…`,
          count,
        }
      default:
        return { value: key, label: key, count }
    }
  })
  return {
    options:
      dimension === "status"
        ? withEveryStatus(view, options)
        : withPickedLabels(
            dimension,
            options,
            valuesOf(state, dimension),
            memberLabels,
          ),
    more: Math.max(
      0,
      (read.data?.total ?? 0) - (read.data?.groups.length ?? 0),
    ),
    isLoading: read.isLoading,
    isError: read.isError,
  }
}

/**
 * A picked or excluded value the window holds no rows of keeps its option,
 * named the way a listed one would be.
 */
function withPickedLabels(
  dimension: ValueDimension,
  options: ColumnFilterOption[],
  values: { selected: string[]; excluded: string[] },
  memberLabels: ReadonlyMap<string, string>,
): ColumnFilterOption[] {
  if (dimension !== "provider" && dimension !== "user") return options
  const missing = [...values.selected, ...values.excluded]
    .filter((value) => !options.some((option) => option.value === value))
    .map((value) => ({
      value,
      label:
        dimension === "provider"
          ? providerDisplayName(value)
          : userDisplay(value, null, memberLabels).label,
    }))
  return [...missing, ...options]
}

/** Every status the view can apply, in their own order, with the window's counts. */
function withEveryStatus(
  view: ObserveView,
  counted: ColumnFilterOption[],
): ColumnFilterOption[] {
  return statusOptions(view).map((option) => ({
    ...option,
    count: counted.find((one) => one.value === option.value)?.count ?? 0,
  }))
}

/**
 * The status choices a view can apply: every request status on Requests, and
 * on Sessions the two a session has.
 */
export const statusOptions = (view: ObserveView): ColumnFilterOption[] =>
  STATUS_OPTIONS.filter(
    (option) => option.value !== "" && statusApplies(view, option.value),
  ).map((option) => ({ value: option.value, label: option.label }))
