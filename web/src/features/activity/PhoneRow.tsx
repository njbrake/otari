import type { UsageEntry } from "@/client"
import { Dot } from "@/design-system/indicators/Dot"
import {
  formatLatency,
  formatRelative,
  formatTokens,
} from "@/shared/helpers/format"
import {
  buildTokenComposition,
  describeStatus,
  displayStatus,
  formatUSD,
} from "./activityModel"

const OUTCOME_DOT: Record<string, string> = {
  error: "bg-danger",
  success: "bg-success",
}

/**
 * One request as the phone lists it, in three lines where a desk has nine
 * columns: the model and its cost; who sent it, with its tokens and time; and
 * when, with its outcome where it did not simply succeed. A square in the
 * margin carries the outcome, as the desk's Status column does.
 */
export function PhoneRow({
  entry,
  sender,
  isOpen,
  onOpen,
}: {
  entry: UsageEntry
  /** Who sent it: the person, or the key where the list is one person's. */
  sender: string
  isOpen: boolean
  onOpen: () => void
}) {
  const status = displayStatus(entry)
  const tokens =
    buildTokenComposition(entry)?.total ??
    (entry.prompt_tokens ?? 0) + (entry.completion_tokens ?? 0)
  const latency = formatLatency(entry.latency_ms) ?? "—"
  const isFailed = status === "error"
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={isOpen ? "true" : undefined}
      className={`flex min-h-16 w-full items-start gap-3 border-border border-b px-4 py-3 text-left focus-visible:otari-focus-ring ${
        isOpen ? "bg-surface-subtle" : isFailed ? "bg-danger-subtle" : ""
      }`}
    >
      <span className="flex pt-[0.4375rem]">
        <Dot className={OUTCOME_DOT[status] ?? "bg-text-subtle"} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-mono-caption text-foreground">
            {entry.model}
          </span>
          <span
            className={`shrink-0 text-mono-caption ${entry.cost === null ? "text-subtle" : "text-foreground"}`}
          >
            {formatUSD(entry.cost)}
          </span>
        </span>
        <span className="flex items-baseline gap-2 text-caption">
          <span className="min-w-0 flex-1 truncate">{sender}</span>
          <span className="shrink-0 text-mono-micro whitespace-nowrap text-subtle">
            {formatTokens(tokens)} · {latency}
          </span>
        </span>
        <span
          className={`truncate text-mono-micro ${isFailed ? "text-danger" : "text-subtle"}`}
        >
          {formatRelative(entry.timestamp)}
          {status === "success" ? "" : ` · ${describeStatus(status)}`}
          {isFailed && entry.status_code ? ` ${entry.status_code}` : ""}
          {entry.policy_name ? ` · via ${entry.policy_name}` : ""}
        </span>
      </span>
    </button>
  )
}
