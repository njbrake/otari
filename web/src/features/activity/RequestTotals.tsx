import { Link } from "@tanstack/react-router"
import { Fragment, type ReactNode } from "react"

import type { UsageTotals } from "@/client"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { InlineList } from "@/design-system/layout/InlineList"
import { billedTokenTotal } from "@/features/usage/usageTotals"
import {
  formatLatency,
  formatNumber,
  formatPct,
  formatTokens,
  formatUsd,
} from "@/shared/helpers/format"
import type { DashboardSearch } from "@/shared/helpers/search"

/** What the cost splits into: billed through the gateway, and imported usage nothing charged. */
export function splitCost(totals: UsageTotals): {
  billed: number
  subscription: number
} {
  const subscription = totals.imported_cost ?? 0
  return { billed: Math.max(0, totals.cost - subscription), subscription }
}

/** The share of billed input tokens read from a cache, 0 with no input. */
export function cacheShare(totals: UsageTotals): number {
  const input = totals.billed_input_tokens ?? 0
  return input > 0 ? (totals.cache_read_tokens ?? 0) / input : 0
}

/**
 * One line of what the rows below add up to, over every page and the current
 * filters: how many requests, how many failed and how many attempts a routing
 * policy recovered from, what was billed and what imported subscription usage
 * would have cost, how many carry no price (a link to them), the tokens with
 * their cache share, and the 95th-percentile total time.
 *
 * A figure that is zero and says nothing (no recovered attempts, no imported
 * usage, nothing unpriced) is left out rather than shown as a zero. Held at its
 * own height by skeletons until the totals answer, so the table does not move.
 */
export function RequestTotals({
  totals,
  isLoading,
  isPinned = false,
}: {
  totals: UsageTotals | undefined
  isLoading: boolean
  /**
   * The phone's line pinned over its list as it scrolls: the requests, the
   * failures, what was billed and the tokens, on one line.
   */
  isPinned?: boolean
}) {
  const frame = isPinned
    ? "otari-request-totals otari-request-totals--pinned"
    : "otari-request-totals"
  if (isLoading || totals === undefined) {
    return (
      <div className={frame}>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-80 max-w-[60%]" />
        <span className="sr-only">Loading totals</span>
      </div>
    )
  }
  const { billed, subscription } = splitCost(totals)
  if (isPinned) {
    return (
      <section aria-label="Totals" className={frame}>
        <span className="min-w-0 truncate text-mono-caption text-muted">
          <span className="text-caption text-foreground">
            {formatNumber(totals.request_count)}{" "}
            {totals.request_count === 1 ? "request" : "requests"}
          </span>
          {totals.error_count ? (
            <span className="text-danger">
              {" "}
              · {formatNumber(totals.error_count)} failed
            </span>
          ) : null}
          <span className="text-foreground"> · {formatUsd(billed)} billed</span>
          {" · "}
          {formatTokens(billedTokenTotal(totals) ?? 0)} tokens
        </span>
      </section>
    )
  }
  const p95 = formatLatency(totals.p95_latency_ms)
  const parts: { key: string; node: ReactNode }[] = [
    {
      key: "failed",
      node: (
        <span className={totals.error_count ? "text-danger" : undefined}>
          {formatNumber(totals.error_count)} failed
        </span>
      ),
    },
  ]
  if (totals.absorbed_count) {
    parts.push({
      key: "recovered",
      node: <span>{formatNumber(totals.absorbed_count)} recovered</span>,
    })
  }
  parts.push({
    key: "billed",
    node: <span className="text-foreground">{formatUsd(billed)} billed</span>,
  })
  if (subscription > 0) {
    parts.push({
      key: "subscription",
      node: (
        <span title="What imported subscription usage would have cost. Nothing was charged for it through the gateway.">
          {formatUsd(subscription)} subscription (not charged)
        </span>
      ),
    })
  }
  if (totals.unpriced_requests) {
    parts.push({
      key: "unpriced",
      node: (
        <Link
          to="."
          search={(prev) => {
            const {
              page: _page,
              request: _request,
              ...rest
            } = prev as DashboardSearch
            return { ...rest, priced: "false" }
          }}
          className="text-link underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
        >
          {formatNumber(totals.unpriced_requests)} unpriced
        </Link>
      ),
    })
  }
  parts.push({
    key: "tokens",
    node: (
      <span>
        {formatTokens(billedTokenTotal(totals) ?? 0)} tokens (
        {formatPct(cacheShare(totals))} cached)
      </span>
    ),
  })
  if (p95) {
    parts.push({ key: "p95", node: <span>P95 {p95}</span> })
  }
  return (
    <section aria-label="Totals" className={frame}>
      {/* Each fact keeps its separator and never breaks inside, so a narrow
          line wraps whole facts rather than leaving a label alone. */}
      <InlineList className="text-mono-caption text-muted">
        <span className="text-caption text-foreground">
          {formatNumber(totals.request_count)}{" "}
          {totals.request_count === 1 ? "request" : "requests"}
        </span>
        {parts.map((part) => (
          <Fragment key={part.key}>{part.node}</Fragment>
        ))}
      </InlineList>
    </section>
  )
}
