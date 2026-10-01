/**
 * What an activity row means, shared by the page and by the parts it renders.
 *
 * The derivations a row, a cell or the request panel needs: where it came
 * from, why it failed, what it was billed for, and how a routed request's
 * attempts fit together. Kept out of the components so they can be tested
 * without rendering one.
 */

import type { ChargeLine, UsageEntry } from "@/client"
import { isUnitChargeLine } from "@/client"
import {
  ACTIVITY_DEFAULT_KEY,
  ACTIVITY_PRESETS,
  CUSTOM_KEY,
  findPreset,
  isoAgo,
  YEAR_SPAN_S,
} from "@/shared/helpers/timeRange"

// ---------- charge lines ----------

// Token lines first, tool lines after, each group keeping the order the writers
// emitted. "Billed meters" otherwise reads as an unordered mix once a row has both.
// A line is told apart by its rate: token meters price per million, gateway-run
// tool meters per call.
export function sortChargeLines(lines: readonly ChargeLine[]): ChargeLine[] {
  return [...lines].sort(
    (a, b) => Number(isUnitChargeLine(a)) - Number(isUnitChargeLine(b)),
  )
}

// ---------- formatting ----------

// Coarser than a settled request's latency: this is a wall-clock wait an
// operator is watching rather than a measurement, so sub-second precision is
// noise. Minutes appear because a stuck local model is the case this exists for.
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

// ---------- windows ----------
//
// The time presets and window math are shared with the Usage page via
// `@/shared/helpers/timeRange`. Activity keeps a truthful "All": newest first,
// the list endpoint applies no default and no clamp, so an omitted start really
// is all-time.

// Resolve the query window. Explicit start_date/end_date bounds (a custom range,
// or a drill-down from the Usage page) take precedence; otherwise a preset anchors
// `start` to "now minus N", and "all" (or an empty custom range) leaves it open.
// `now` is a parameter, not a call inside, so a caller deriving more than one
// window can hand both the same clock reading. Read independently they land
// milliseconds apart, and `useActivityWindow` compares two of them for strict
// inequality, so drift of a single millisecond changes what the page does.
export function resolveWindow(
  range: string,
  start: string,
  end: string,
  now: number = Date.now(),
): { start?: string; end?: string } {
  if (start || end) {
    return { start: start || undefined, end: end || undefined }
  }
  if (range === CUSTOM_KEY) {
    return {}
  }
  const preset =
    findPreset(ACTIVITY_PRESETS, range) ??
    findPreset(ACTIVITY_PRESETS, ACTIVITY_DEFAULT_KEY)
  const seconds = preset?.seconds ?? null
  return {
    start: seconds == null ? undefined : isoAgo(seconds, now),
    end: undefined,
  }
}

// The histogram extent (what the bars span), which is *not* always the list
// window. For bounded presets it matches `resolveWindow`. Any range with no
// rolling start of its own (the unbounded "All", or the `custom` sentinel) gets an
// explicit year-long start instead: the list genuinely omits its start there, but
// the summary endpoint would then apply a hidden 30-day default, so the bars would
// silently show a rolling month while the caption reads "All time". The explicit
// start gives a deterministic, draggable span (the axis shows exactly what it
// covers) while the list stays all-time.
export function resolveExtentWindow(
  range: string,
  now: number = Date.now(),
): { start?: string; end?: string } {
  const win = resolveWindow(range, "", "", now)
  if (win.start) return win
  const preset = findPreset(ACTIVITY_PRESETS, range)
  if (preset?.seconds == null) return { start: isoAgo(YEAR_SPAN_S, now) }
  return win
}

// Friendly labels for known provenance sources; unknown sources render their slug.
const SOURCE_LABELS: Record<string, string> = {
  gateway: "Gateway",
  claude_code: "Claude Code",
  codex: "Codex",
}

export function describeSource(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

// Whether a row was imported (an agent's own usage, reported to the gateway)
// rather than served by it. Imported usage was paid for by a subscription, so it
// carries an equivalent cost that nothing billed.
export function isImported(entry: UsageEntry): boolean {
  return entry.source !== "gateway"
}

/** An id with no name to show, shortened to a recognizable prefix. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`
}

// What the Source column shows: the API key a gateway request came in on, or
// where an imported row came from.
export function describeRowSource(entry: UsageEntry): string {
  if (isImported(entry)) return describeSource(entry.source)
  if (entry.api_key_id === null) return "No key"
  return entry.api_key_name ?? shortId(entry.api_key_id)
}

// The gateway-run tools by what they do. An MCP tool's name comes from the
// caller's own server, so an unknown one is de-underscored rather than dropped.
const TOOL_LABELS: Record<string, string> = {
  any: "any tool",
  web_search: "web search",
  web_fetch: "web fetch",
  code_execution: "code execution",
}

export function describeTool(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replaceAll("_", " ")
}

// The name the caller sent, when it says something the model does not: an
// alias. A routing policy's name is the Policy column's to show, and a name
// equal to the model says nothing new.
export function requestedAlias(entry: UsageEntry): string | undefined {
  const requested = entry.requested_model
  if (!requested || requested === entry.model) return undefined
  if (requested === entry.policy_name) return undefined
  if (requested === findPricingSelector(entry)) return undefined
  return requested
}

// Why a request failed, in words, beside the status code. Read off the code,
// except a 400 whose message says the prompt did not fit, which is common
// enough on agent traffic to name.
const FAILURE_REASONS: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  402: "Payment required",
  403: "Forbidden",
  404: "Not found",
  408: "Timed out",
  413: "Too large",
  422: "Invalid request",
  429: "Rate limited",
  500: "Provider error",
  502: "Bad gateway",
  503: "Unavailable",
  504: "Upstream timeout",
  529: "Overloaded",
}

/** An outcome led by its status code, where one was recorded: "429 Rate limited". */
export function withStatusCode(code: number | null, outcome: string): string {
  return code === null ? outcome : `${code} ${outcome}`
}

export function describeFailure(entry: UsageEntry): string {
  const message = (entry.error_message ?? "").toLowerCase()
  if (
    message.includes("too long") ||
    message.includes("context length") ||
    message.includes("context window")
  ) {
    return "Context too long"
  }
  return (
    (entry.status_code !== null && FAILURE_REASONS[entry.status_code]) ||
    "Failed"
  )
}

/**
 * What a set of requests cost, split the way the page reports it: what the
 * gateway billed, and what imported usage came to, which a subscription paid
 * for. The totals' `cost` holds both.
 */
export function splitCost(
  totals: { cost: number; imported_cost: number } | undefined,
): { billed: number; subscription: number } {
  const subscription = totals?.imported_cost ?? 0
  return {
    billed: Math.max(0, (totals?.cost ?? 0) - subscription),
    subscription,
  }
}

// ---------- token composition ----------
//
// One total is the least useful number on the row: on a cached agent workload it
// is ~98% cache read, so every row shows a large, similar-looking figure. The
// composition is what varies, so the column renders the split.

export interface TokenComposition {
  // Input tokens billed at the full input rate (the prompt minus whatever was
  // served from, or written to, the cache).
  fresh: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
}

function readPositive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0
}

// Split a row's tokens into fresh input / cache read / cache write / output, or
// null when the row carries no usage at all (an error before the provider replied).
//
// `billing_meters` is preferred because it is the *normalized* view: providers
// disagree on whether cache reads and writes are counted inside `prompt_tokens`
// (OpenAI: yes, Anthropic: no), and the row does not record which convention its
// numbers follow, so the raw columns alone cannot be split reliably. The writers
// resolve that when they price a row, so meters are present for any priced row.
// Failing that, assume the subset convention and clamp, which is exact whenever
// there is no cache usage to misattribute.
export function buildTokenComposition(
  entry: UsageEntry,
): TokenComposition | null {
  // Per key, not per object: a row can carry meters for its gateway-run tool calls
  // while its tokens were never metered (an unpriced model still owes for the
  // searches it ran). Keying off the object's presence would then read every token
  // as 0 and the bar would vanish from a row that has real tokens.
  const meters = entry.billing_meters ?? null
  const meter = (key: string, fallback: number | null): number =>
    meters && typeof meters[key] === "number"
      ? readPositive(meters[key])
      : readPositive(fallback)
  const totalInput = meter("total_input_tokens", entry.prompt_tokens)
  const cacheRead = meter("cache_read_tokens", entry.cache_read_tokens)
  const cacheWrite = meter("cache_write_tokens", entry.cache_write_tokens)
  const output = meter("completion_tokens", entry.completion_tokens)
  const fresh = Math.max(0, totalInput - cacheRead - cacheWrite)
  const total = fresh + cacheRead + cacheWrite + output
  return total > 0 ? { fresh, cacheRead, cacheWrite, output, total } : null
}

// A row's gateway-run tool calls, read out of the reserved `tools` meter namespace.
// Nested under one key so a caller-named MCP tool can never collide with a token
// meter (which the billed-token SQL and `buildTokenComposition` both read by name).
export type ToolUsage = {
  tool: string
  billed: number
  errors: number
  unitRate: number | null
}

export function listToolUsage(entry: UsageEntry): ToolUsage[] {
  const nested = entry.billing_meters?.tools
  if (!nested || typeof nested !== "object") return []
  return Object.entries(nested as Record<string, unknown>)
    .flatMap(([tool, counts]) => {
      if (!counts || typeof counts !== "object") return []
      const record = counts as Record<string, unknown>
      const billed = readPositive(record.billed)
      const errors = readPositive(record.errors)
      if (!billed && !errors) return []
      const rate = record.unit_rate
      return [
        {
          tool,
          billed,
          errors,
          unitRate: typeof rate === "number" ? rate : null,
        },
      ]
    })
    .sort((a, b) => b.billed - a.billed || a.tool.localeCompare(b.tool))
}

// Cost attributable to gateway-run tools on this row, from the rate stored with the
// row rather than the live price, so a historical row reads as it was billed.
export function computeToolCost(entry: UsageEntry): number | null {
  const usages = listToolUsage(entry).filter((usage) => usage.billed > 0)
  if (usages.some((usage) => usage.unitRate === null)) return null
  return usages.reduce(
    (sum, usage) => sum + usage.billed * (usage.unitRate ?? 0),
    0,
  )
}

// Segment order runs input side first (fresh, then the two cache buckets), then
// output. Shading is one hue at four lightnesses, assigned for legibility rather
// than for price: every fill clears the track it sits on, adjacent fills differ
// enough to show their boundary, and the bucket that is usually the bulk (cache
// read) takes a mid tone instead of the palest step, so a cache-heavy row reads
// as a filled bar and a fresh-input row as a dark one. Nothing is encoded by hue,
// and the tooltip / accessible name carry every number, so the bar adds a shape
// to scan and removes no information.
export const TOKEN_SEGMENTS: {
  key: keyof Omit<TokenComposition, "total">
  label: string
  /** The segment's ground, a whole class so Tailwind emits it. */
  fill: string
}[] = [
  { key: "fresh", label: "Fresh input", fill: "bg-chart-ramp-1" },
  { key: "cacheRead", label: "Cache read", fill: "bg-chart-ramp-3" },
  { key: "cacheWrite", label: "Cache write", fill: "bg-chart-ramp-4" },
  { key: "output", label: "Output", fill: "bg-chart-ramp-2" },
]

// The pricing key a usage row bills against. A row stores the instance and the
// bare model separately (`log_usage` is called with `provider=resolved.instance,
// model=resolved.model`, and a gateway rejection logs the same pair), while
// pricing is looked up as `instance:model` (`find_model_pricing`), so the key has
// to be rebuilt from both: `entry.model` alone is prefix-less and would store a
// price nothing ever reads. A row whose selector never resolved carries no
// provider and its model is the raw selector, so that is used as-is.
export function findPricingSelector(entry: UsageEntry): string {
  if (!entry.provider) return entry.model
  return entry.model.startsWith(`${entry.provider}:`)
    ? entry.model
    : `${entry.provider}:${entry.model}`
}

// ---------- routing ----------
//
// A routed request writes one usage row per attempt (all sharing a
// `request_group_id`), so a single row answers only half of what an operator
// wants: "attempt 1 of 2 failed" without saying what served the request. These
// helpers name why each attempt was chosen and reassemble a plan from the rows of
// one group.

// Plain English for a compiled attempt's `selection_reason`. The stored values are
// the compiler's vocabulary (`static`, `default`, `on_failure`, `condition:<keys>`,
// `router:<name>`): precise, and meaningless to a reader who has not read the
// compiler. An unrecognized value is de-underscored rather than dropped, since the
// set is open by construction (a condition or router name comes from config).
export function describeSelectionReason(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null
  if (reason === "static") return "the policy's only target"
  if (reason === "default") return "the policy's default target"
  if (reason === "on_failure") return "a fallback candidate"
  if (reason.startsWith("condition:")) {
    const keys = reason
      .slice("condition:".length)
      .split(",")
      .filter(Boolean)
      .join(", ")
    return keys ? `matched on ${keys}` : "matched a condition"
  }
  if (reason.startsWith("router:")) {
    const name = reason.slice("router:".length)
    return name ? `chosen by router ${name}` : "chosen by a router"
  }
  return reason.replaceAll("_", " ")
}

// Attempts in plan order. `attempt_position` is authoritative; timestamp is the
// tiebreaker for a row written before the column existed, or a group whose rows
// share a position (which would be a writer bug, not something to hide).
export function sortPlanRows(rows: readonly UsageEntry[]): UsageEntry[] {
  return [...rows].sort(
    (a, b) =>
      (a.attempt_position ?? 0) - (b.attempt_position ?? 0) ||
      a.timestamp.localeCompare(b.timestamp),
  )
}
