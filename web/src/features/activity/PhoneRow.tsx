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
  describeFailure,
  describeRowSource,
  isImported,
  listToolUsage,
  withStatusCode,
} from "./activityModel"

/**
 * One request as the phone lists it: nine columns do not fit in 400px, so a
 * row is three lines. The model and its cost; who sent it and from where, with
 * tokens and time; and when, with the one thing worth knowing (why it failed,
 * that a fallback recovered it, or the policy that routed it). A square in the
 * margin carries the outcome.
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
  const isFailed = entry.status === "error"
  const isImportedRow = isImported(entry)
  const calls = listToolUsage(entry).reduce((sum, tool) => sum + tool.billed, 0)
  const tokens = buildTokenComposition(entry)?.total ?? 0
  const mark = isFailed
    ? "bg-danger"
    : entry.absorbed_attempts
      ? "bg-warning"
      : "bg-success"
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-16 w-full items-start gap-3 border-b border-border-subtle bg-surface px-4 py-3 text-left focus-visible:otari-focus-ring"
    >
      <span
        aria-hidden
        className={`mt-[0.4375rem] size-1.5 shrink-0 ${mark}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-mono-caption">
            {entry.model}
          </span>
          <span
            className={`shrink-0 text-mono-caption ${
              isImportedRow || entry.cost === null ? "text-subtle" : ""
            }`}
          >
            {isFailed
              ? "—"
              : entry.cost === null
                ? "unpriced"
                : formatCost(entry.cost)}
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
          {isImportedRow ? (
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
          {isFailed ? (
            <span>
              · {withStatusCode(entry.status_code, describeFailure(entry))}
            </span>
          ) : entry.absorbed_attempts ? (
            <span className="text-warning">
              · {formatNumber(entry.absorbed_attempts)} recovered
            </span>
          ) : entry.policy_name ? (
            <span>· via {entry.policy_name}</span>
          ) : null}
        </span>
      </span>
    </button>
  )
}
