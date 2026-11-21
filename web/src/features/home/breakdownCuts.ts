import type { BreakdownDimension, UsageGroupBy } from "@/client"
import { filterValues, type SpendRow } from "@/features/spend/useSpend"

/** A breakdown of Home's "Where it went". */
export type HomeCut =
  | "people"
  | "keys"
  | "models"
  | "providers"
  | "sessions"
  | "channels"
  | "policies"
  | "workspaces"
  | "tools"

export interface HomeCutDef {
  value: HomeCut
  label: string
  /** The first column's head. */
  noun: string
  /** What "Show all 19 …" counts. */
  plural: string
  /** What an empty table says shows up in it once there is spend. */
  each: string
  /** The summary breakdown the table reads; none for tools, which bill per call. */
  dimension?: BreakdownDimension
  /** The usage series' `group_by` the chart splits by; none where no series splits by it. */
  groupBy?: UsageGroupBy
  /** What a row opens: Sessions where it filters on the value, else Requests. */
  to: "/sessions" | "/requests" | "/"
}

export const HOME_CUTS: Record<HomeCut, HomeCutDef> = {
  people: {
    value: "people",
    label: "People",
    noun: "Person",
    plural: "people",
    each: "person",
    dimension: "user",
    groupBy: "user_id",
    to: "/sessions",
  },
  keys: {
    value: "keys",
    label: "API keys",
    noun: "API key",
    plural: "API keys",
    each: "key you make",
    dimension: "api_key",
    groupBy: "api_key_id",
    to: "/sessions",
  },
  models: {
    value: "models",
    label: "Models",
    noun: "Model",
    plural: "models",
    each: "model you use",
    dimension: "model",
    groupBy: "model",
    to: "/sessions",
  },
  providers: {
    value: "providers",
    label: "Providers",
    noun: "Provider",
    plural: "providers",
    each: "provider you use",
    dimension: "provider",
    groupBy: "provider",
    to: "/requests",
  },
  sessions: {
    value: "sessions",
    label: "Sessions",
    noun: "Session",
    plural: "sessions",
    each: "session",
    dimension: "source_label",
    groupBy: "source_label",
    to: "/requests",
  },
  channels: {
    value: "channels",
    label: "Channels",
    noun: "Channel",
    plural: "channels",
    each: "channel",
    dimension: "channel",
    groupBy: "channel",
    to: "/requests",
  },
  policies: {
    value: "policies",
    label: "Routing policies",
    noun: "Routing policy",
    plural: "routing policies",
    each: "routing policy",
    dimension: "policy",
    groupBy: "policy_name",
    to: "/requests",
  },
  workspaces: {
    value: "workspaces",
    label: "Workspaces",
    noun: "Workspace",
    plural: "workspaces",
    each: "workspace",
    dimension: "workspace",
    groupBy: "workspace_id",
    to: "/",
  },
  tools: {
    value: "tools",
    label: "Tools",
    noun: "Tool",
    plural: "tools",
    each: "tool a request runs",
    to: "/requests",
  },
}

/**
 * The filter a row's link carries to Sessions or Requests: the row's value, or
 * for the requests that recorded none, the filter that asks for them (no
 * session, no routing policy). Undefined for a row that is no one value (the
 * server's fold) and for a cut whose rows open something else.
 */
export function rowFilter(
  cut: HomeCut,
  row: SpendRow,
): Record<string, string | string[]> | undefined {
  const key = row.filterKey
  if (key === null) {
    if (!row.isNone) return undefined
    if (cut === "sessions") return { is_null: "session" }
    if (cut === "policies") return { routed: "false" }
    return undefined
  }
  switch (cut) {
    case "people":
      return { user_id: filterValues(row) }
    case "keys":
      return { api_key_id: filterValues(row) }
    case "models":
      return { model: filterValues(row) }
    case "providers":
      return { provider: key }
    case "sessions":
      return { source_label: key }
    case "channels":
      return { channel: key }
    case "policies":
      return { policy_name: key }
    default:
      return undefined
  }
}

/** The filter Requests leaves a row's value out with, where it can. */
export function rowExclusion(
  cut: HomeCut,
  row: SpendRow,
): Record<string, string[]> | undefined {
  if (row.filterKey === null) return undefined
  switch (cut) {
    case "people":
      return { exclude_user_id: filterValues(row) }
    case "keys":
      return { exclude_api_key_id: filterValues(row) }
    case "models":
      return { exclude_model: filterValues(row) }
    case "policies":
      return { exclude_policy_name: [row.filterKey] }
    default:
      return undefined
  }
}
