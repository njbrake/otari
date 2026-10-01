import { Fragment, type ReactNode } from "react"
import type { UsageTotals } from "@/client"
import { TextButton } from "@/design-system/actions/TextButton"
import { billedTokenTotal } from "@/features/usage/usageTotals"
import {
  formatLatency,
  formatNumber,
  formatPct,
  formatTokens,
  formatUsd,
} from "@/shared/helpers/format"
import { cacheHitFraction, splitCost } from "./activityModel"

/**
 * One line of what the rows below add up to: how many, how many failed, what
 * was billed and what subscriptions covered, and how many carried no price.
 *
 * Billed is the gateway's own spend; imported usage (a Claude Code
 * subscription, say) is shown beside it rather than inside it, because nothing
 * charged it through the gateway. `isCompact` drops the token and latency
 * figures while the side panel narrows the page. The phone's line, pinned
 * under its search, keeps only the count, the failures and the two costs.
 */
export function ActivityTotals({
  totals,
  variant = "desk",
  isFiltered = false,
  isCompact = false,
  onUnpriced,
  trailing,
}: {
  totals: UsageTotals | undefined
  variant?: "desk" | "phone"
  isFiltered?: boolean
  isCompact?: boolean
  onUnpriced?: () => void
  trailing?: ReactNode
}) {
  const isPhone = variant === "phone"
  const count = totals?.request_count ?? 0
  const failed = totals?.error_count ?? 0
  const recovered = isPhone ? 0 : (totals?.absorbed_count ?? 0)
  const { billed, subscription } = splitCost(totals)
  const unpriced = isPhone ? 0 : (totals?.unpriced_requests ?? 0)
  const isBrief = isPhone || isCompact
  const p95 = formatLatency(totals?.p95_latency_ms)
  const label = `${formatNumber(count)} ${isFiltered ? "filtered " : ""}${
    count === 1 ? "request" : "requests"
  }`
  const parts = [
    <span key="failed" className={failed ? "text-danger" : undefined}>
      {formatNumber(failed)} failed
    </span>,
    recovered ? (
      <span key="recovered">{formatNumber(recovered)} recovered</span>
    ) : null,
    <span key="billed" className="text-foreground">
      {formatUsd(billed)} billed
    </span>,
    <span key="subscription">{formatUsd(subscription)} subscription</span>,
    unpriced && onUnpriced ? (
      <TextButton key="unpriced" onPress={onUnpriced}>
        {formatNumber(unpriced)} unpriced
      </TextButton>
    ) : null,
    isBrief ? null : (
      <span key="tokens">
        {formatTokens(billedTokenTotal(totals) ?? 0)} tokens (
        {formatPct(
          cacheHitFraction(
            totals?.cache_read_tokens ?? 0,
            totals?.billed_input_tokens ?? 0,
          ),
          0,
        )}{" "}
        cached)
      </span>
    ),
    isBrief || !p95 ? null : <span key="p95">P95 {p95}</span>,
  ].filter((part) => part !== null)
  if (isPhone) {
    return (
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 border-t border-border-subtle bg-surface-subtle px-4 py-[0.4375rem] text-mono-micro whitespace-nowrap text-subtle">
        <span className="text-foreground">{label}</span>
        {parts}
      </div>
    )
  }
  return (
    <div className="-mx-4 flex min-h-10 flex-wrap items-center gap-2.5 border-b border-border bg-surface-subtle px-4 py-1.5 md:-mx-6 md:px-6">
      <span className="text-caption whitespace-nowrap text-foreground">
        {label}
      </span>
      <span className="flex flex-wrap items-center gap-2.5 text-mono-caption whitespace-nowrap text-subtle">
        {parts.map((part, index) => (
          <Fragment key={part.key}>
            {index ? <span aria-hidden>·</span> : null}
            {part}
          </Fragment>
        ))}
      </span>
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </div>
  )
}
