import { FiGlobe } from "react-icons/fi"
import type { UsageEntry } from "@/client"
import { Chip } from "@/design-system/indicators/Chip"
import {
  formatCost,
  formatLatency,
  formatNumber,
  formatRelative,
  formatTokens,
  formatUtcTime,
} from "@/shared/helpers/format"
import {
  buildTokenComposition,
  countToolCalls,
  describeRowSource,
  isImported,
  rowCost,
  rowOutcome,
  withStatusCode,
} from "./activityModel"
import { OUTCOME_NOTE_INK, OutcomeDot } from "./StatusMark"

/**
 * One request as the phone lists it: nine columns do not fit in 400px, so a
 * row is three lines. The model and its cost; who sent it and from where, with
 * tokens and time; and when, with the one thing worth knowing (why it failed,
 * that a fallback recovered it, or the policy that routed it). A square in the
 * margin carries the outcome, read as the desk's Status column reads it.
 */
export function PhoneRow({
  entry,
  member,
  onOpen,
}: {
  entry: UsageEntry
  /** The member's name, when the list spans several people. */
  member: string | undefined
  onOpen: () => void
}) {
  const outcome = rowOutcome(entry)
  const cost = rowCost(entry)
  const isFailed = outcome.kind === "failed"
  const calls = countToolCalls(entry)
  const tokens = buildTokenComposition(entry)?.total ?? 0
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-16 w-full items-start gap-3 border-b border-border-subtle bg-surface px-4 py-3 text-left focus-visible:otari-focus-ring"
    >
      <OutcomeDot kind={outcome.kind} className="mt-[0.4375rem]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-mono-caption">
            {entry.model}
          </span>
          <span
            className={`shrink-0 text-mono-caption ${
              cost.kind === "priced" && cost.isBilled ? "" : "text-subtle"
            }`}
          >
            {cost.kind === "none"
              ? "—"
              : cost.kind === "unpriced"
                ? "unpriced"
                : formatCost(cost.cost)}
          </span>
        </span>
        <span className="flex h-5 items-center gap-1.5 text-caption">
          <span className="truncate">
            {member ? (
              <span
                className={member === "You" ? "text-subtle" : "text-foreground"}
              >
                {member} ·{" "}
              </span>
            ) : null}
            {describeRowSource(entry)}
          </span>
          {isImported(entry) ? (
            <Chip tone="info" size="sm">
              Subscription
            </Chip>
          ) : null}
          {calls ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-mono-micro">
              <FiGlobe aria-hidden className="size-2.5" />×{formatNumber(calls)}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-mono-micro whitespace-nowrap text-subtle">
            {formatTokens(tokens)} · {formatLatency(entry.latency_ms) ?? "—"}
          </span>
        </span>
        <span
          className={`flex gap-1.5 overflow-hidden text-mono-micro whitespace-nowrap ${
            isFailed ? "text-danger" : "text-subtle"
          }`}
        >
          <span>
            {formatUtcTime(entry.timestamp, true)} ·{" "}
            {formatRelative(entry.timestamp)}
          </span>
          {outcome.kind !== "success" ? (
            <span>· {withStatusCode(entry.status_code, outcome.note)}</span>
          ) : outcome.note ? (
            <span className={OUTCOME_NOTE_INK.success}>· {outcome.note}</span>
          ) : entry.policy_name ? (
            <span>· via {entry.policy_name}</span>
          ) : null}
        </span>
      </span>
    </button>
  )
}
