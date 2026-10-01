/**
 * What each column of the log shows for one row. Two lines at most: the value,
 * then the one thing worth knowing about it, quietly.
 */

import { FiGlobe } from "react-icons/fi"
import type { UsageEntry } from "@/client"
import { Chip } from "@/design-system/indicators/Chip"
import {
  formatCost,
  formatLatency,
  formatNumber,
  formatPct,
  formatRelative,
  formatTokens,
  formatUtcTime,
} from "@/shared/helpers/format"
import {
  buildTokenComposition,
  cacheHitFraction,
  compositionInput,
  countToolCalls,
  describeRowSource,
  describeTool,
  isImported,
  listToolUsage,
  requestedAlias,
  rowCost,
  rowOutcome,
  tokenSegments,
} from "./activityModel"
import { OUTCOME_NOTE_INK, StatusMark } from "./StatusMark"
import { TokenCompositionBar } from "./TokenCompositionBar"

export function TimeCell({
  entry,
  isAttempt,
}: {
  entry: UsageEntry
  /** A recovered attempt shown under the row that served names its attempt instead. */
  isAttempt?: boolean
}) {
  return (
    <>
      <div className="text-mono-caption" title={entry.timestamp}>
        {formatUtcTime(entry.timestamp, true)}
      </div>
      <div className="text-mono-micro text-subtle">
        {isAttempt
          ? `attempt ${entry.attempt_position ?? "?"}`
          : formatRelative(entry.timestamp)}
      </div>
    </>
  )
}

export function ModelCell({
  entry,
  showsPolicy,
  onTool,
}: {
  entry: UsageEntry
  /** Whether the Policy column is on screen; if not, the route goes here. */
  showsPolicy: boolean
  onTool: (tools: string[]) => void
}) {
  const tools = listToolUsage(entry)
  const calls = countToolCalls(entry)
  const alias = requestedAlias(entry)
  const route =
    entry.policy_name && !showsPolicy
      ? `via ${entry.policy_name}${
          entry.attempt_position && entry.attempt_count
            ? ` · attempt ${entry.attempt_position}/${entry.attempt_count}`
            : ""
        }`
      : undefined
  const note = alias ? `requested as ${alias}` : route
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-mono-caption">{entry.model}</span>
        {calls ? (
          <button
            type="button"
            title={`Gateway tools ran ${formatNumber(calls)}× on this request. Click to show only requests that used them.`}
            aria-label={`Filter to requests using ${tools
              .map((tool) => describeTool(tool.tool))
              .join(", ")}`}
            onClick={(event) => {
              event.stopPropagation()
              onTool(tools.map((tool) => tool.tool))
            }}
            className="inline-flex h-[1.125rem] shrink-0 items-center gap-1 border border-border-strong bg-surface-subtle px-1.5 text-mono-micro whitespace-nowrap text-foreground focus-visible:otari-focus-ring"
          >
            <FiGlobe aria-hidden className="size-2.5" />×{formatNumber(calls)}
          </button>
        ) : null}
      </div>
      {note ? (
        <div className="truncate text-mono-micro text-subtle">{note}</div>
      ) : null}
    </>
  )
}

export function PolicyCell({
  entry,
  isAttempt,
}: {
  entry: UsageEntry
  isAttempt?: boolean
}) {
  if (!entry.policy_name) return <span className="text-subtle">Direct</span>
  const position = entry.attempt_position ?? undefined
  const isFallback = position !== undefined && position > 1
  return (
    <>
      <div className="truncate text-mono-caption">{entry.policy_name}</div>
      {position !== undefined && entry.attempt_count != null ? (
        <div
          className={`truncate text-mono-micro ${isFallback ? "text-warning" : "text-subtle"}`}
        >
          {position}/{entry.attempt_count} ·{" "}
          {isAttempt ? "failed" : isFallback ? "fallback" : "default"}
        </div>
      ) : null}
    </>
  )
}

export function SourceCell({ entry }: { entry: UsageEntry }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{describeRowSource(entry)}</span>
      {isImported(entry) ? (
        <Chip tone="info" size="sm">
          Subscription
        </Chip>
      ) : null}
    </span>
  )
}

/**
 * The billed total, and a hairline bar of its composition whose length is the
 * row's share of the largest row on the page, so a heavy request stands out in
 * a scan. The title carries every number the bar draws.
 */
export function TokensCell({
  entry,
  maxTokens,
}: {
  entry: UsageEntry
  maxTokens: number
}) {
  const composition = buildTokenComposition(entry)
  if (!composition) {
    return <span className="text-mono-caption text-subtle">—</span>
  }
  const summary = tokenSegments(composition)
    .map((segment) => `${segment.label} ${formatNumber(segment.value)}`)
    .join(", ")
  const cached = cacheHitFraction(
    composition.cacheRead,
    compositionInput(composition),
  )
  const width = Math.max(10, (composition.total / Math.max(1, maxTokens)) * 80)
  return (
    <span
      className="flex flex-col items-end"
      title={`${summary}. ${formatPct(cached, 0)} of input from cache.`}
    >
      <span className="text-mono-caption">
        {formatTokens(composition.total)}
      </span>
      <TokenCompositionBar
        composition={composition}
        label={`Token composition: ${summary}`}
        className="mt-[0.1875rem] h-[0.1875rem]"
        widthRem={width / 16}
      />
    </span>
  )
}

export function CostCell({ entry }: { entry: UsageEntry }) {
  const cost = rowCost(entry)
  if (cost.kind === "none") {
    return <span className="text-mono-caption text-subtle">—</span>
  }
  if (cost.kind === "unpriced") {
    return (
      <>
        <div className="text-mono-caption text-subtle">—</div>
        <div className="text-mono-micro text-subtle">unpriced</div>
      </>
    )
  }
  return (
    <>
      <div
        className={`text-mono-caption ${cost.isBilled ? "" : "text-subtle"}`}
      >
        {formatCost(cost.cost)}
      </div>
      {cost.isBilled ? null : (
        <div className="text-mono-micro text-subtle">not billed</div>
      )}
    </>
  )
}

export function LatencyCell({ entry }: { entry: UsageEntry }) {
  const note =
    entry.ttft_ms !== null
      ? `TTFT ${formatLatency(entry.ttft_ms)}`
      : entry.status === "error"
        ? "no response"
        : ""
  return (
    <>
      <div className="text-mono-caption">
        {formatLatency(entry.latency_ms) ?? "—"}
      </div>
      <div className="min-h-[0.9375rem] text-mono-micro whitespace-nowrap text-subtle">
        {note}
      </div>
    </>
  )
}

export function StatusCell({ entry }: { entry: UsageEntry }) {
  const { kind, label, note } = rowOutcome(entry)
  return (
    <>
      <StatusMark
        kind={kind}
        className={`text-mono-caption ${kind === "success" ? "text-subtle" : ""}`}
      >
        {label}
      </StatusMark>
      {note ? (
        <div
          className={`pl-3.5 text-mono-micro whitespace-nowrap ${OUTCOME_NOTE_INK[kind]}`}
        >
          {note}
        </div>
      ) : null}
    </>
  )
}
