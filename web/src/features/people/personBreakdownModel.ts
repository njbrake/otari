import type {
  ApiKey,
  BreakdownDimension,
  SummaryDimension,
  UsageGroupRow,
  UsageSummary,
  UsageTotals,
} from "@/client"
import { describeSource } from "@/features/activity/activityModel"
import { keyName } from "@/features/spend/names"
import type { BreakdownFigures } from "@/features/usage/breakdownSort"
import { groupModels, OTHER } from "@/features/usage/modelGroups"
import { formatCost, formatUsd } from "@/shared/helpers/format"
import { providerDisplayName } from "@/shared/helpers/providers"

/** A cent and up as dollars and cents; a fraction of one to its digits. */
export const formatSpend = (value: number) =>
  value === 0 || value >= 0.01 ? formatUsd(value) : formatCost(value)

export type PersonCut =
  | "models"
  | "keys"
  | "providers"
  | "sources"
  | "sessions"
  | "channels"
  | "policies"

/**
 * The cuts of a person's spend, each one summary dimension, and the page and
 * filter a row opens: Sessions where it filters on that value, else Requests.
 */
export const PERSON_CUTS: {
  value: PersonCut
  label: string
  /** The first column's head. */
  noun: string
  dimension: SummaryDimension & BreakdownDimension
  field:
    | "by_model"
    | "by_api_key"
    | "by_provider"
    | "by_source"
    | "by_source_label"
    | "by_channel"
    | "by_policy"
  to: "/sessions" | "/requests"
  filter:
    | "model"
    | "api_key_id"
    | "provider"
    | "source"
    | "source_label"
    | "channel"
    | "policy_name"
  /** What a row of the requests that recorded no value opens: those requests. */
  none?: Record<string, string>
}[] = [
  {
    value: "models",
    label: "Models",
    noun: "Model",
    dimension: "model",
    field: "by_model",
    to: "/sessions",
    filter: "model",
  },
  {
    value: "keys",
    label: "API keys",
    noun: "API key",
    dimension: "api_key",
    field: "by_api_key",
    to: "/sessions",
    filter: "api_key_id",
  },
  {
    value: "providers",
    label: "Providers",
    noun: "Provider",
    dimension: "provider",
    field: "by_provider",
    to: "/requests",
    filter: "provider",
  },
  {
    value: "sources",
    label: "Sources",
    noun: "Source",
    dimension: "source",
    field: "by_source",
    to: "/requests",
    filter: "source",
  },
  {
    value: "sessions",
    label: "Sessions",
    noun: "Session",
    dimension: "source_label",
    field: "by_source_label",
    to: "/requests",
    filter: "source_label",
    none: { is_null: "session" },
  },
  {
    value: "channels",
    label: "Channels",
    noun: "Channel",
    dimension: "channel",
    field: "by_channel",
    to: "/requests",
    filter: "channel",
  },
  {
    value: "policies",
    label: "Routing policies",
    noun: "Routing policy",
    dimension: "policy",
    field: "by_policy",
    to: "/requests",
    filter: "policy_name",
    none: { routed: "false" },
  },
]

export const DEFAULT_PERSON_CUT: PersonCut = "models"

export function personCutOf(value: string): (typeof PERSON_CUTS)[number] {
  return (
    PERSON_CUTS.find((cut) => cut.value === value) ??
    PERSON_CUTS.find((cut) => cut.value === DEFAULT_PERSON_CUT) ??
    PERSON_CUTS[0]
  )
}

/** A person's spend over a window, apart by whether it counts toward a budget. */
export interface SpendSplit {
  /** What counts toward their budgets: the spend that is charged. */
  budgeted: number
  /** What is recorded and not charged: a budget-exempt key's, imported usage. */
  exempt: number
  total: number
  requests: number
  exemptRequests: number
}

/** The two summaries' totals as one split; undefined until both are read. */
export function splitTotals(
  budgeted: UsageTotals | undefined,
  exempt: UsageTotals | undefined,
): SpendSplit | undefined {
  if (!budgeted || !exempt) return undefined
  return {
    budgeted: budgeted.cost,
    exempt: exempt.cost,
    total: budgeted.cost + exempt.cost,
    requests: budgeted.request_count + exempt.request_count,
    exemptRequests: exempt.request_count,
  }
}

/** One row of "Where it went": a value of the cut, its spend split in two. */
export interface BreakdownRow {
  id: string
  name: string
  detail?: string
  /** What a row's filter takes; empty for a row that opens nothing. */
  filterValues: string[]
  requests: number
  tokens: number
  /** What counted toward their budgets: the spend that is charged. */
  budgeted: number
  /** What is recorded and not charged: a budget-exempt key's, imported usage. */
  exempt: number
  failed: number
  /** The 95th-percentile latency, null where none was read or recorded. */
  p95: number | null
  /** An API key flagged `exclude_from_budget`. */
  isExemptKey: boolean
  /** The server's fold of its smallest rows. */
  isOther: boolean
  /** The requests that recorded no value for the cut: no session, no policy. */
  isNone: boolean
}

/** The figures a table sorts a row by. */
export const rowFigures = (row: BreakdownRow): BreakdownFigures => ({
  cost: row.budgeted + row.exempt,
  charged: row.budgeted,
  tokens: row.tokens,
  requests: row.requests,
  failed: row.failed,
  p95: row.p95,
})

const CHANNEL_NAMES: Record<string, string> = {
  api: "API",
  imported: "Imported",
  playground: "Playground",
}

interface Part {
  id: string
  name: string
  detail?: string
  filterValues: string[]
  isOther: boolean
  isExemptKey: boolean
  cost: number
  charged: number
  failed: number
  p95: number | null
  tokens: number
  requests: number
}

/** How a value of a cut other than models and keys reads, or the requests that recorded none. */
function valueName(cut: PersonCut, key: string | null): string {
  switch (cut) {
    case "providers":
      return key === null ? "Unknown provider" : providerDisplayName(key)
    case "sessions":
      return key ?? "No session"
    case "channels":
      return key === null ? "Unknown" : (CHANNEL_NAMES[key] ?? key)
    case "policies":
      return key ?? "Direct"
    default:
      return key === null ? "Unknown source" : describeSource(key)
  }
}

/** A value's id, name and filter, by cut; ids no value can take for the fold and for none. */
function partsOf(
  cut: PersonCut,
  rows: readonly UsageGroupRow[],
  keys: readonly ApiKey[],
): Part[] {
  if (cut === "models") {
    // One row per model however many ids it ran as, as every model cut is.
    return groupModels(rows).map((model) => ({
      id: model.id,
      name: model.name,
      filterValues: model.isOther ? [] : model.spellings,
      isOther: model.isOther,
      isExemptKey: false,
      cost: model.cost,
      charged: model.charged,
      failed: model.failed,
      p95: model.p95,
      tokens: model.tokens,
      requests: model.requests,
    }))
  }
  return rows.map((row) => {
    const base = {
      cost: row.cost,
      charged: row.charged_cost,
      failed: row.error_count,
      p95: row.p95_latency_ms ?? null,
      tokens: row.tokens,
      requests: row.requests,
      isOther: row.is_other ?? false,
      filterValues: row.is_other || row.key === null ? [] : [row.key],
    }
    const id = row.is_other
      ? `${cut}::other`
      : row.key === null
        ? `${cut}::none`
        : `${cut}:${row.key}`
    if (row.is_other) {
      return { ...base, id, name: OTHER, isExemptKey: false }
    }
    if (cut === "keys") {
      const key = keys.find((one) => one.id === row.key)
      return {
        ...base,
        id,
        name:
          row.key === null
            ? "No key"
            : key
              ? keyName(key)
              : row.label || "A deleted key",
        detail: row.key === null ? "The Playground or imported" : undefined,
        isExemptKey: key?.exclude_from_budget ?? false,
      }
    }
    return {
      ...base,
      id,
      name: valueName(cut, row.key),
      isExemptKey: false,
    }
  })
}

/**
 * The cut's rows from one summary of the person's spend, one per value with
 * what of it was charged and what was not, the costliest first, then the most
 * tokens. A value with neither spend nor requests is left out.
 */
export function splitRows(
  cut: PersonCut,
  summary: UsageSummary | undefined,
  keys: readonly ApiKey[],
): BreakdownRow[] {
  const field = personCutOf(cut).field
  const merged = new Map<string, BreakdownRow>()
  for (const part of partsOf(cut, summary?.[field] ?? [], keys)) {
    const row = merged.get(part.id) ?? {
      id: part.id,
      name: part.name,
      detail: part.detail,
      filterValues: [],
      requests: 0,
      tokens: 0,
      budgeted: 0,
      exempt: 0,
      failed: 0,
      p95: null,
      isExemptKey: part.isExemptKey,
      isOther: part.isOther,
      isNone: part.id.endsWith("::none"),
    }
    row.requests += part.requests
    row.tokens += part.tokens
    row.budgeted += part.charged
    row.exempt += Math.max(0, part.cost - part.charged)
    row.failed += part.failed
    if (part.p95 !== null && (row.p95 === null || part.p95 > row.p95)) {
      row.p95 = part.p95
    }
    for (const value of part.filterValues) {
      if (!row.filterValues.includes(value)) row.filterValues.push(value)
    }
    merged.set(part.id, row)
  }
  return [...merged.values()]
    .filter((row) => row.requests > 0 || row.budgeted + row.exempt > 0)
    .sort(
      (a, b) =>
        // The fold is no one value, so it closes the list whatever it sums to.
        Number(a.isOther) - Number(b.isOther) ||
        b.budgeted + b.exempt - (a.budgeted + a.exempt) ||
        b.tokens - a.tokens,
    )
}
