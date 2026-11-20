/**
 * What the request panel says about one row beyond its raw fields: why it
 * failed, the name it was asked for, the channel it came in on, how it counts
 * against budgets, and how its tokens divide. Pure, so each reading is tested
 * without rendering the panel.
 */

import type { UsageEntry } from "@/client"
import {
  describeSource,
  findPricingSelector,
  type TokenComposition,
} from "./activityModel"

/** Whether a row was imported (an agent's own usage reported to the gateway) rather than served here. */
export function isImported(entry: Pick<UsageEntry, "source">): boolean {
  return entry.source !== "gateway"
}

// ---------- failure ----------

// Why a request failed, in words beside the status code, read off the code.
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

/**
 * The gateway's own refusal of a request it could not bill, which
 * `require_pricing` makes: `model` when the model has no usable price, `tool`
 * when a gateway-run tool the request would run has none. Told apart by the
 * text, not the 402 alone: a provider's own 402 (an exhausted balance) is
 * recorded with the same status, and pricing does not fix it. Every such
 * refusal the gateway writes names `require_pricing`.
 */
export function pricingRefusal(
  entry: Pick<UsageEntry, "status_code" | "error_message">,
): "model" | "tool" | null {
  const message = entry.error_message ?? ""
  if (entry.status_code !== 402 || !message.includes("require_pricing"))
    return null
  return /^(No pricing is configured for model|Model ')/.test(message)
    ? "model"
    : "tool"
}

/** The headline of a failed row's banner: what went wrong, in a few words. */
export function describeFailure(entry: UsageEntry): string {
  const refusal = pricingRefusal(entry)
  if (refusal === "model") return "Refused: this model has no price"
  if (refusal === "tool") return "Refused: a gateway tool has no price"
  const message = (entry.error_message ?? "").toLowerCase()
  if (
    message.includes("too long") ||
    message.includes("context length") ||
    message.includes("context window")
  )
    return "Context too long"
  return (
    (entry.status_code !== null && FAILURE_REASONS[entry.status_code]) ||
    "Failed"
  )
}

/**
 * What a failure banner adds below the stored message: what the gateway did,
 * and what fixes it where the row says. Empty where the message is the whole
 * story.
 */
export function explainFailure(entry: UsageEntry): string {
  const refusal = pricingRefusal(entry)
  if (refusal === "model")
    return `require_pricing is on, so the gateway refused ${findPricingSelector(entry)} before calling the provider. Nothing was billed. Set a price for it to serve it.`
  if (refusal === "tool")
    return "require_pricing is on, so the gateway refused a request that would run a gateway tool with no per-call price. Nothing was billed. Set one on the Tools & Guardrails screen."
  if (entry.status === "absorbed")
    return "This attempt failed and routing moved on to the next candidate. Failed attempts carry no charge."
  return ""
}

// ---------- request ----------

/**
 * What the name the caller sent was: the routing policy that chose the model,
 * the model itself, or an alias of it. Null where the row recorded no name.
 */
export function describeRequested(entry: UsageEntry): string | null {
  const requested = entry.requested_model
  if (!requested) return null
  if (requested === entry.policy_name) return "routing policy"
  if (requested === entry.model || requested === findPricingSelector(entry))
    return "model"
  return `alias → ${findPricingSelector(entry)}`
}

/**
 * How a request reached the gateway. An imported row's usage was paid for by
 * its source's subscription; a gateway row came in on an API key, or with none,
 * which the Playground and the master key both do, and which the row cannot
 * tell apart.
 */
export function describeChannel(entry: UsageEntry): string {
  if (isImported(entry)) return `${describeSource(entry.source)} subscription`
  return entry.api_key_id === null ? "Playground or master key" : "API"
}

/**
 * The chip beside the channel when the row is outside budgets: an imported
 * row's subscription, or a gateway row on a budget-exempt key. An absorbed
 * attempt is outside them because it is a failure routing recovered from, not
 * because of how it came in, so it takes none.
 */
export function budgetChip(entry: UsageEntry): string | null {
  if (entry.counts_toward_budget) return null
  if (isImported(entry)) return "Subscription"
  return entry.status === "absorbed" ? null : "Budget-exempt"
}

/** The Budget line: whether, and why not, this row counts toward budgets. */
export function describeBudget(entry: UsageEntry): string {
  if (isImported(entry) && !entry.counts_toward_budget)
    return "Excluded. Subscription usage does not count toward budgets."
  if (entry.status === "absorbed")
    return "Excluded. The attempt that served the request carries its charge."
  if (!entry.counts_toward_budget)
    return "Excluded. This key is exempt from budgets."
  if (entry.cost === null) return "Nothing counted, because nothing was priced."
  return "Counts toward budgets."
}

// ---------- tools ----------

// The gateway-run tools by what they do. An MCP tool's name comes from the
// caller's own server, so an unknown one is de-underscored rather than dropped.
const TOOL_LABELS: Record<string, string> = {
  web_search: "Web search",
  web_fetch: "Web fetch",
  code_execution: "Code execution",
}

export function describeTool(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replaceAll("_", " ")
}

// ---------- tokens ----------

export const TOKEN_SEGMENTS: readonly {
  key: "fresh" | "cacheRead" | "cacheWrite" | "output"
  label: string
  fill: string
}[] = [
  { key: "fresh", label: "Fresh input", fill: "bg-chart-ramp-1" },
  { key: "cacheRead", label: "Cache read", fill: "bg-chart-ramp-3" },
  { key: "cacheWrite", label: "Cache write", fill: "bg-chart-ramp-4" },
  { key: "output", label: "Output", fill: "bg-chart-ramp-2" },
]

/** A composition's segments in bar order, leaving out the buckets it has none of. */
export function tokenSegments(composition: TokenComposition) {
  return TOKEN_SEGMENTS.map((segment) => ({
    ...segment,
    value: composition[segment.key],
  })).filter((segment) => segment.value > 0)
}

/**
 * The share of input served from the cache, over every input token, both
 * cache buckets included. Zero with no input.
 */
export function cacheHitFraction(composition: TokenComposition): number {
  const input = composition.total - composition.output
  return input > 0 ? composition.cacheRead / input : 0
}
