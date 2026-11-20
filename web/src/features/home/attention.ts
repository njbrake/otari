/**
 * What needs an owner or admin on Home, as one pure function over what the
 * page has read. The hook that reads it lives in `useTeamAttention.ts`.
 *
 * A message earns its place only if all three hold:
 *
 * 1. it means someone's requests are refused or failing now, or will be before
 *    the next reset;
 * 2. an owner or admin can fix it;
 * 3. it carries one action: a dialog on Home, or a link to the exact place.
 *
 * | Type          | Fires when                                                | Severity        |
 * | ------------- | --------------------------------------------------------- | --------------- |
 * | 1 Account     | the edition that holds the organization's money says so   | its own         |
 * |               | (`overlayHomeAccount.tsx`; nothing in this build)         |                 |
 * | 2 Reached     | a limit's spend is at its maximum, period not ended       | urgent          |
 * | 3 Refused     | the gateway sent 403 in the last 24 hours, to someone     | urgent          |
 * |               | with no row of type 2                                     |                 |
 * | 4 Failures    | 5 or more server-side errors in 24 hours at 2% or more    | warning, urgent |
 * |               | of requests; urgent at 10% with 20 or more requests       | at 10% and 20   |
 * | 5 Pace       | organization or workspace limit, period of 7 days or more, | warning         |
 * |               | 10% gone, projected past the maximum, under 80% used      |                 |
 * | 6 Near limit  | 80% or more of a limit used, under 100%, period not ended | warning         |
 * | 7 Unreachable | a provider's credentials cannot reach it (operator only)  | urgent          |
 * | 8 Key expiry  | a key in use expires within 7 days; four or more fold     | warning         |
 * |               | into one row                                              |                 |
 *
 * Refusals and failures are counted per workspace, because Requests lists one
 * workspace at a time: a row says which workspace it counted when the
 * organization has more than one, and its link opens that workspace.
 * Failures count the error classes a person at the keyboard did not cause:
 * missing pricing (402), rate limits (429), provider errors (any 5xx) and the
 * unknown (no status code). The caller's own 4xx are not counted.
 *
 * A limit whose period ended counts as nothing spent: the gateway resets a
 * ceiling on the next request that reaches it, so until then it still carries
 * last period's figure.
 */

import type { ReactNode } from "react"
import type { OrganizationSpendCeiling } from "@/client"
import {
  calendarDaysUntil,
  DAY_MS,
  EXPIRY_WARN_DAYS,
} from "@/features/home/days"
import type { HomeAccount } from "@/features/home/overlayHomeAccount"
import {
  type LimitTarget,
  perWords,
  usedShare,
  wholePct,
} from "@/features/spend/limits"
import { paceOf } from "@/features/spend/pace"
import type { ReadState } from "@/features/spend/useSpend"
import { formatNumber, formatPct, formatUsd } from "@/shared/helpers/format"

/** A limit this far along is worth a look before it refuses someone. */
const NEAR_LIMIT = 0.8
/** Near-limit rows shown before the rest fold. */
const NEAR_ROWS_SHOWN = 3

const MIN_FAILURES = 5
const MIN_FAILURE_RATE = 0.02
const URGENT_FAILURE_RATE = 0.1
const URGENT_FAILURE_REQUESTS = 20
/** Expiring keys shown one by one; more fold into one row. */
const KEY_ROWS_SHOWN = 3

/** The error classes a failure count includes; see the table above. */
const COUNTED_ERROR_CLASSES: readonly string[] = [
  "pricing",
  "rate_limit",
  "provider_error",
  "unknown",
]

export type AttentionSource =
  | "limits"
  | "refusals"
  | "failures"
  | "keys"
  | "providers"
  | "account"
export type AttentionState = ReadState

/**
 * "the Research workspace", or "the Default workspace" for a workspace whose
 * name already says it is one, so the noun is not doubled.
 */
export function theWorkspace(name: string): string {
  return /\bworkspace$/i.test(name.trim())
    ? `the ${name}`
    : `the ${name} workspace`
}

/** Whether a source is still being read, and a sentence for each that failed. */
export function readsOf<Source extends string>(
  states: Record<Source, AttentionState>,
  names: Record<Source, string>,
): { isLoading: boolean; notChecked: string[] } {
  const sources = Object.keys(states) as Source[]
  return {
    isLoading: sources.some((source) => states[source] === "loading"),
    notChecked: sources
      .filter((source) => states[source] === "failed")
      .map(
        (source) =>
          `${names[source]} could not be checked, so this list may be incomplete.`,
      ),
  }
}

const SOURCE_NAMES: Record<Exclude<AttentionSource, "account">, string> = {
  limits: "Limits",
  refusals: "Refusals",
  failures: "Failures",
  keys: "API keys",
  providers: "Provider health",
}

interface AttentionAction {
  label: string
  /** A limit to change in place. */
  limit?: LimitTarget
  to?: "/rules" | "/requests" | "/keys" | "/admin/hosted-providers"
  search?: Record<string, string>
  /**
   * The workspace the destination has to be looking at to show what the row
   * counted: Requests and API keys list the shell's selected workspace.
   */
  workspaceId?: string
  /** A control an edition renders itself (`overlayHomeAccount.tsx`). */
  node?: ReactNode
}

export interface AttentionItem {
  id: string
  isUrgent: boolean
  text: string
  action: AttentionAction
}

export interface AttentionInput {
  now: number
  states: Record<AttentionSource, AttentionState>
  ceilings: readonly OrganizationSpendCeiling[]
  /** Who a ceiling is on, by scope id, as the sentence names them. */
  subjects: ReadonlyMap<string, string>
  workspaceNames: ReadonlyMap<string, string>
  /** What a ceiling's dialog edits, by ceiling id; none where Home has no row. */
  targets: ReadonlyMap<string, LimitTarget>
  /** The user ids behind a person-level scope id (member, workspace member). */
  peopleOf: ReadonlyMap<string, readonly string[]>
  /** What the edition holding the organization's money adds, if any. */
  account: Pick<HomeAccount, "sourceName" | "attention" | "quietClause">
  /** The whole organization's last 24 hours, by error class. */
  orgDay: AttentionDay
  /**
   * The same, workspace by workspace: read only once the organization's own
   * figures cross a threshold, and for one workspace its organization's.
   */
  days: readonly (AttentionDay & { workspaceId: string })[]
  /**
   * The 403s of the last 24 hours, by workspace and user; a null user id is
   * nobody in particular.
   */
  refusals: readonly {
    workspaceId: string
    userId: string | null
    name: string
    requests: number
  }[]
  /** The organization's keys the caller can list. */
  keys: readonly AttentionKey[]
  /** Whether provider reachability was read: only a deployment operator's. */
  checksProviders: boolean
  /** Providers whose credentials could not reach them; empty when not checked. */
  unreachable: readonly { name: string; error: string }[]
}

export interface AttentionDay {
  requests: number
  errors: readonly { errorClass: string; requests: number }[]
}

export interface AttentionKey {
  id: string
  name: string
  workspaceId: string
  expiresAt: string | null
  lastUsedAt: string | null
  isActive: boolean
}

export interface AttentionResult {
  /** Loading until every source has answered, or failed. */
  isLoading: boolean
  items: AttentionItem[]
  /** Near-limit rows past the third, shown on "Show all". */
  folded: AttentionItem[]
  foldText: string
  /** One line per source that could not be read. */
  notChecked: string[]
  /** What to say when nothing qualifies and every source answered. */
  quiet: { lead: string; detail: string } | undefined
}

const SCOPE_RANK: Record<string, number> = {
  organization: 0,
  workspace: 1,
  org_member: 2,
  workspace_member: 2,
  api_token: 3,
}

interface Ranked {
  item: AttentionItem
  /** The row's type in the table above. */
  type: number
  scopeRank: number
  used: number
}

const plural = (n: number, one: string, many: string) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`

function daysUntil(end: string, now: number): number {
  return Math.ceil((Date.parse(end) - now) / DAY_MS)
}

function resetWords(ceiling: OrganizationSpendCeiling, now: number): string {
  if (!ceiling.period_end) return ""
  const days = daysUntil(ceiling.period_end, now)
  if (days <= 0) return ""
  return days === 1 ? " Resets tomorrow." : ` Resets in ${days} days.`
}

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
})

/**
 * Who a limit is on when the page has no name for it: a key the caller's list
 * does not carry, someone off the roster, a workspace it has not read.
 */
const UNNAMED: Record<string, string> = {
  organization: "The organization",
  workspace: "A workspace",
  api_token: "An API key",
}

function limitRows(input: AttentionInput): Ranked[] {
  const { now } = input
  const rows: Ranked[] = []
  for (const ceiling of input.ceilings) {
    const max = ceiling.max_budget
    // $0 is a limit, and one that is always reached.
    if (max == null || ceiling.provider_key_id !== null) continue
    const end = ceiling.period_end ? Date.parse(ceiling.period_end) : undefined
    if (end !== undefined && end < now) continue
    const used = usedShare({ spent: ceiling.current_spend, max })
    if (used <= 0) continue
    const scopeRank = SCOPE_RANK[ceiling.scope_type] ?? 4
    const who =
      input.subjects.get(ceiling.scope_id) ??
      UNNAMED[ceiling.scope_type] ??
      "Someone"
    const limit = `${formatUsd(max)} ${perWords(ceiling)}`.trim()
    const target = input.targets.get(ceiling.id)
    const dialog = (label: string): AttentionAction =>
      target ? { label, limit: target } : { label: "Open Rules", to: "/rules" }

    if (used >= 1) {
      const days = ceiling.period_end ? daysUntil(ceiling.period_end, now) : 0
      const until =
        !ceiling.period_end || days <= 0
          ? "the limit is raised"
          : days === 1
            ? "it resets tomorrow"
            : `it resets in ${days} days`
      rows.push({
        type: 2,
        scopeRank,
        used,
        item: {
          id: ceiling.id,
          isUrgent: true,
          text: `${who} is at the limit of ${limit}. Requests are refused until ${until}.`,
          action: dialog("Raise the limit"),
        },
      })
      continue
    }
    if (used >= NEAR_LIMIT) {
      rows.push({
        type: 6,
        scopeRank,
        used,
        item: {
          id: ceiling.id,
          isUrgent: false,
          text: `${who} has used ${wholePct(used)} of ${limit}.${resetWords(ceiling, now)}`,
          action: dialog("Raise the limit"),
        },
      })
      continue
    }
    if (
      ceiling.scope_type !== "organization" &&
      ceiling.scope_type !== "workspace"
    )
      continue
    const pace = paceOf({
      spent: ceiling.current_spend,
      max,
      periodStart: ceiling.period_start,
      periodEnd: ceiling.period_end,
      now,
    })
    const runsOut = pace?.runsOutAt
    if (pace === undefined || runsOut === undefined) continue
    const before = Math.max(1, Math.round((pace.end - runsOut) / DAY_MS))
    const date = DAY_LABEL.format(runsOut)
    const isOrganization = ceiling.scope_type === "organization"
    const name = input.workspaceNames.get(ceiling.scope_id)
    if (!isOrganization && !name) continue
    rows.push({
      type: 5,
      scopeRank,
      used,
      item: {
        id: ceiling.id,
        isUrgent: false,
        text: isOrganization
          ? `At this pace the team budget of ${limit} runs out around ${date}, ${plural(before, "day", "days")} before it resets.`
          : `At this pace ${name ? theWorkspace(name) : "this workspace"}’s limit of ${limit} runs out around ${date}, ${plural(before, "day", "days")} before it resets.`,
        action: dialog(isOrganization ? "Change the limit" : "Raise the limit"),
      },
    })
  }
  return rows
}

function accountRow(input: AttentionInput): Ranked | undefined {
  const row = input.account.attention
  if (!row) return undefined
  return {
    type: 1,
    scopeRank: 0,
    used: row.isUrgent ? 1 : 0,
    item: {
      id: row.id,
      isUrgent: row.isUrgent,
      text: row.text,
      action: { label: "", node: row.action },
    },
  }
}

/** " in the Platform workspace", where the organization has more than one. */
function inWorkspace(input: AttentionInput, workspaceId: string): string {
  if (input.workspaceNames.size <= 1) return ""
  const name = input.workspaceNames.get(workspaceId)
  return name ? ` in ${theWorkspace(name)}` : " in another workspace"
}

function refusedRows(
  input: AttentionInput,
  reached: ReadonlySet<string>,
): Ranked[] {
  const byWorkspace = new Map<string, AttentionInput["refusals"][number][]>()
  for (const row of input.refusals) {
    if (row.requests <= 0 || (row.userId && reached.has(row.userId))) continue
    const list = byWorkspace.get(row.workspaceId) ?? []
    list.push(row)
    byWorkspace.set(row.workspaceId, list)
  }
  const ranked: Ranked[] = []
  for (const [workspaceId, rows] of byWorkspace) {
    const total = rows.reduce((sum, row) => sum + row.requests, 0)
    const where = inWorkspace(input, workspaceId)
    const people = rows.filter((row) => row.userId)
    const isOnePerson = people.length === 1 && people.length === rows.length
    const text = isOnePerson
      ? total === 1
        ? `The gateway refused a request from ${people[0].name}${where} in the last 24 hours.`
        : `The gateway refused ${formatNumber(total)} requests from ${people[0].name}${where} in the last 24 hours.`
      : people.length > 1
        ? `The gateway refused ${formatNumber(total)} requests from ${people.length} people${where} in the last 24 hours.`
        : total === 1
          ? `The gateway refused a request${where} in the last 24 hours.`
          : `The gateway refused ${formatNumber(total)} requests${where} in the last 24 hours.`
    const userId = isOnePerson ? people[0].userId : undefined
    ranked.push({
      type: 3,
      scopeRank: 0,
      used: total,
      item: {
        id: `refused:${workspaceId}`,
        isUrgent: true,
        text,
        action: {
          label: "See the refusals",
          to: "/requests",
          search: {
            status_code: "403",
            range: "24h",
            ...(userId ? { user_id: userId } : {}),
          },
          workspaceId,
        },
      },
    })
  }
  return ranked
}

/**
 * The last 24 hours' failures, when they are past the thresholds in the table
 * above; undefined below them. Also a member's Home, over their own requests.
 */
export function countedFailures(
  day: AttentionDay,
): { failed: number; rate: number; isUrgent: boolean } | undefined {
  const failed = day.errors
    .filter((row) => COUNTED_ERROR_CLASSES.includes(row.errorClass))
    .reduce((sum, row) => sum + row.requests, 0)
  const judged = judgeFailures(failed, day.requests)
  if (judged.level === "healthy") return undefined
  return { failed, rate: judged.rate, isUrgent: judged.level === "high" }
}

/**
 * How bad a failure count is, by the one set of thresholds Home uses: below
 * five failures or 2% it is healthy, from 10% with 20 or more requests it is
 * high, and elevated between. The band and the Failures figure both judge
 * with it, so they cannot call the same numbers different things.
 */
export function judgeFailures(
  failed: number,
  requests: number,
): { rate: number; level: "healthy" | "elevated" | "high" } {
  const rate = requests > 0 ? failed / requests : 0
  if (failed < MIN_FAILURES || rate < MIN_FAILURE_RATE) {
    return { rate, level: "healthy" }
  }
  return {
    rate,
    level:
      rate >= URGENT_FAILURE_RATE && requests >= URGENT_FAILURE_REQUESTS
        ? "high"
        : "elevated",
  }
}

/** The counted failures of a day, whatever the thresholds say. */
function failedOf(day: AttentionDay): number {
  return day.errors
    .filter((row) => COUNTED_ERROR_CLASSES.includes(row.errorClass))
    .reduce((sum, row) => sum + row.requests, 0)
}

const failureAction = (workspaceId?: string): AttentionAction => ({
  label: "See the failures",
  to: "/requests",
  search: { status: "error", range: "24h" },
  ...(workspaceId ? { workspaceId } : {}),
})

/**
 * A row per workspace past the thresholds. Failures spread thin across
 * workspaces can cross them for the organization while no workspace does:
 * that is one row for the organization, opening the workspace with the most.
 */
function failureRows(input: AttentionInput): Ranked[] {
  const org = countedFailures(input.orgDay)
  if (!org) return []
  const ranked: Ranked[] = []
  for (const day of input.days) {
    const counted = countedFailures(day)
    if (!counted) continue
    const { failed, rate } = counted
    ranked.push({
      type: 4,
      scopeRank: 0,
      used: rate,
      item: {
        id: `failures:${day.workspaceId}`,
        isUrgent: counted.isUrgent,
        text: `${formatNumber(failed)} of ${formatNumber(day.requests)} requests${inWorkspace(input, day.workspaceId)} failed in the last 24 hours (${formatPct(rate)}).`,
        action: failureAction(day.workspaceId),
      },
    })
  }
  if (ranked.length > 0) return ranked
  const worst = [...input.days].sort((a, b) => failedOf(b) - failedOf(a))[0]
  const most =
    worst && failedOf(worst) > 0
      ? input.workspaceNames.get(worst.workspaceId)
      : undefined
  return [
    {
      type: 4,
      scopeRank: 0,
      used: org.rate,
      item: {
        id: "failures",
        isUrgent: org.isUrgent,
        text: `${formatNumber(org.failed)} of ${formatNumber(input.orgDay.requests)} requests across all workspaces failed in the last 24 hours (${formatPct(org.rate)}).${most ? ` The most were in ${theWorkspace(most)}.` : ""}`,
        action: failureAction(most ? worst?.workspaceId : undefined),
      },
    },
  ]
}

function unreachableRows(input: AttentionInput): Ranked[] {
  return input.unreachable.map((provider) => ({
    type: 7,
    scopeRank: 0,
    used: 1,
    item: {
      id: `unreachable:${provider.name}`,
      isUrgent: true,
      text: `${provider.name} is unreachable, so requests routed to it fail.${provider.error ? ` ${provider.error}` : ""}`,
      action: { label: "Check the provider", to: "/admin/hosted-providers" },
    },
  }))
}

/**
 * Keys someone is using that stop working within the week. A key never used
 * refuses nobody when it expires, so it is left to the Keys page.
 */
function keyRows(input: AttentionInput): Ranked[] {
  const { now } = input
  const expiring = input.keys
    .filter((key) => {
      if (!key.isActive || !key.lastUsedAt || !key.expiresAt) return false
      const at = Date.parse(key.expiresAt)
      return at > now && at - now <= EXPIRY_WARN_DAYS * DAY_MS
    })
    .sort(
      (a, b) => Date.parse(a.expiresAt ?? "") - Date.parse(b.expiresAt ?? ""),
    )
  if (expiring.length > KEY_ROWS_SHOWN) {
    return [
      {
        type: 8,
        scopeRank: 0,
        used: 0,
        item: {
          id: "keys-expiring",
          isUrgent: false,
          text: `${formatNumber(expiring.length)} API keys in use expire within ${EXPIRY_WARN_DAYS} days.`,
          action: { label: "Open API keys", to: "/keys" },
        },
      },
    ]
  }
  return expiring.map((key, index) => {
    const days = calendarDaysUntil(Date.parse(key.expiresAt ?? ""), now)
    const when =
      days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`
    return {
      type: 8,
      scopeRank: 0,
      used: -index,
      item: {
        id: `key-expiring:${key.id}`,
        isUrgent: false,
        text: `The key ${key.name}${inWorkspace(input, key.workspaceId)} expires ${when}. Requests made with it are refused after that.`,
        action: {
          label: "Open in API keys",
          to: "/keys",
          workspaceId: key.workspaceId,
        },
      },
    }
  })
}

function quietLine(input: AttentionInput): { lead: string; detail: string } {
  const clauses = [
    `No limit is past ${wholePct(NEAR_LIMIT)}`,
    "nothing was refused in the last 24 hours",
    `no key in use expires within ${EXPIRY_WARN_DAYS} days`,
  ]
  if (input.checksProviders) clauses.push("every provider is reachable")
  if (input.account.quietClause) clauses.push(input.account.quietClause)
  const last = clauses.pop()
  const detail =
    clauses.length === 1
      ? `${clauses[0]} and ${last}.`
      : `${clauses.join(", ")}, and ${last}.`
  return { lead: "Nothing needs you right now.", detail }
}

/** The ordered list Home's attention band shows, and what to say when empty. */
export function attention(input: AttentionInput): AttentionResult {
  const { states } = input
  const { isLoading, notChecked } = readsOf(states, {
    ...SOURCE_NAMES,
    account: input.account.sourceName,
  })

  const limits = states.limits === "ready" ? limitRows(input) : []
  const reached = new Set<string>()
  for (const row of limits) {
    if (row.type !== 2) continue
    const ceiling = input.ceilings.find((one) => one.id === row.item.id)
    for (const id of input.peopleOf.get(ceiling?.scope_id ?? "") ?? []) {
      reached.add(id)
    }
  }
  const ranked: Ranked[] = [
    ...(states.account === "ready" ? [accountRow(input)] : []),
    ...limits,
    ...(states.refusals === "ready" ? refusedRows(input, reached) : []),
    ...(states.failures === "ready" ? failureRows(input) : []),
    ...(states.providers === "ready" ? unreachableRows(input) : []),
    ...(states.keys === "ready" ? keyRows(input) : []),
  ].filter((row): row is Ranked => row !== undefined)

  ranked.sort(
    (a, b) =>
      Number(b.item.isUrgent) - Number(a.item.isUrgent) ||
      a.type - b.type ||
      a.scopeRank - b.scopeRank ||
      b.used - a.used,
  )

  const near = ranked.filter((row) => row.type === 6)
  const folded = near.slice(NEAR_ROWS_SHOWN).map((row) => row.item)
  const hidden = new Set(folded)
  const items = ranked.map((row) => row.item).filter((one) => !hidden.has(one))
  return {
    isLoading,
    items,
    folded,
    foldText: `${plural(folded.length, "more limit is", "more limits are")} past ${wholePct(NEAR_LIMIT)}.`,
    notChecked,
    quiet:
      !isLoading && ranked.length === 0 && notChecked.length === 0
        ? quietLine(input)
        : undefined,
  }
}
