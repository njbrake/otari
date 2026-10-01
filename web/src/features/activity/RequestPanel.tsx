import { buttonVariants } from "@heroui/react"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useEffect, useRef } from "react"
import {
  FiChevronDown,
  FiChevronUp,
  FiGlobe,
  FiMessageSquare,
  FiX,
} from "react-icons/fi"
import type { UsageEntry } from "@/client"
import { isTokenChargeLine, isUnitChargeLine } from "@/client"
import { Button } from "@/design-system/actions/Button"
import { CopyButton } from "@/design-system/actions/CopyButton"
import { IconButton } from "@/design-system/actions/IconButton"
import { Chip } from "@/design-system/indicators/Chip"
import { Dot } from "@/design-system/indicators/Dot"
import {
  formatCost,
  formatLatency,
  formatNumber,
  formatPct,
  formatUnitRate,
  formatUtcDateTime,
} from "@/shared/helpers/format"
import { useSurfaces } from "@/shared/hooks/useDeployment"
import {
  buildTokenComposition,
  computeToolCost,
  describeFailure,
  describeRowSource,
  describeTool,
  findPricingSelector,
  isImported,
  listToolUsage,
  sortChargeLines,
  TOKEN_SEGMENTS,
  withStatusCode,
} from "./activityModel"
import { RoutingPlan } from "./RoutingPlan"

function Row({
  label,
  children,
  isMono,
}: {
  label: ReactNode
  children: ReactNode
  isMono?: boolean
}) {
  return (
    <div className="flex gap-4 border-t border-border-subtle py-[0.4375rem] text-sm">
      <span className="w-28 shrink-0 text-subtle">{label}</span>
      <span
        className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${isMono ? "text-mono-caption" : ""}`}
      >
        {children}
      </span>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="pb-1.5 text-overline">{title}</h3>
      {children}
    </section>
  )
}

// A request routed through a policy, a model it named, or an alias of one.
function describeRequested(entry: UsageEntry): string {
  if (entry.requested_model === entry.policy_name) return "routing policy"
  if (
    entry.requested_model === entry.model ||
    entry.requested_model === findPricingSelector(entry)
  ) {
    return "model"
  }
  return `alias → ${findPricingSelector(entry)}`
}

/**
 * One request, read in full beside the log (or over it, where the log has no
 * room to spare).
 *
 * Everything the row could not hold: why it failed, how it was routed, where it
 * came from, its token composition, what it cost and why, and how long it took.
 * Nothing it holds is request or response content, which the gateway does not
 * store.
 */
export function RequestPanel({
  entry,
  position,
  memberName,
  showsMember,
  onPrevious,
  onNext,
  onClose,
  onFilter,
  onPriceModel,
  isOverlaid,
}: {
  entry: UsageEntry
  /** "3 / 25": where the request sits in the list the arrows step through. */
  position: string
  memberName: (userId: string | null, alias?: string | null) => string
  showsMember: boolean
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
  /** Narrow the log to this request's session, source, model, or the tools it ran. */
  onFilter: (filter: "session" | "source" | "model" | "tool") => void
  /** Only for a deployment operator: a price is a deployment-wide write. */
  onPriceModel: ((modelKey: string) => void) | undefined
  /**
   * Read over the list (a phone's pushed view, a narrow desk's drawer), filling
   * what holds it, rather than beside it at its own width.
   */
  isOverlaid?: boolean
}) {
  const hasPlayground = useSurfaces()("playground")
  // Focus moves into the panel as it opens, so the keyboard carries on where
  // the reader is looking, and goes back to what opened it on close. Stepping
  // to another request keeps the panel, so it keeps the focus too.
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined
    panel.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  const requestId = entry.request_id ?? entry.id
  const composition = buildTokenComposition(entry)
  const tools = listToolUsage(entry)
  const toolCost = computeToolCost(entry)
  const isImportedRow = isImported(entry)
  const pricingKey = findPricingSelector(entry)
  // No price to cost it at: a request served on an unpriced model, or one the
  // gateway refused for lacking a price. The refusal is told apart by its text,
  // not its 402 alone: a provider's own 402 (an exhausted balance) is recorded
  // with the same status, and pricing does not fix it. Every refusal the
  // gateway writes names require_pricing (test_pricing_refusal_text.py).
  const isPricingRefusal =
    entry.status_code === 402 &&
    (entry.error_message ?? "").includes("require_pricing")
  const isUnpriced =
    entry.cost === null && (entry.status === "success" || isPricingRefusal)
  const segments = composition
    ? TOKEN_SEGMENTS.map((segment) => ({
        ...segment,
        value: composition[segment.key],
      })).filter((segment) => segment.value > 0)
    : []
  const cacheHit = composition
    ? composition.cacheRead /
      Math.max(1, composition.total - composition.output)
    : 0

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Request details"
      className={`flex min-h-0 flex-col bg-surface ${
        isOverlaid
          ? "h-full w-full"
          : "h-full w-[26.25rem] shrink-0 border-l border-control-border"
      }`}
    >
      <div className="flex items-start gap-2 border-b border-border py-3.5 pr-4 pl-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-title [overflow-wrap:anywhere]">
            <span className="text-mono-title">{entry.model}</span>
          </h2>
          <div className="flex items-center gap-1">
            <span className="truncate text-mono-micro text-subtle">
              {requestId}
            </span>
            <CopyButton value={requestId} label="request id" />
            {position ? (
              <span className="ml-auto text-mono-micro whitespace-nowrap text-subtle">
                {position}
              </span>
            ) : null}
          </div>
        </div>
        <IconButton label="Previous request (↑)" size="sm" onPress={onPrevious}>
          <FiChevronUp aria-hidden className="size-4" />
        </IconButton>
        <IconButton label="Next request (↓)" size="sm" onPress={onNext}>
          <FiChevronDown aria-hidden className="size-4" />
        </IconButton>
        <IconButton label="Close (Esc)" size="sm" onPress={onClose}>
          <FiX aria-hidden className="size-4" />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[1.125rem] overflow-y-auto px-5 pt-3 pb-5">
        {entry.status === "error" ? (
          <p className="border border-danger bg-danger-subtle px-3 py-2 text-sm break-words text-danger">
            {withStatusCode(entry.status_code, describeFailure(entry))}
            {entry.error_message ? `: ${entry.error_message}` : ""}
          </p>
        ) : null}

        {entry.policy_name ? <RoutingPlan entry={entry} /> : null}

        <Group title="Request">
          <Row label="Time" isMono>
            {formatUtcDateTime(entry.timestamp)}
          </Row>
          <Row label="Status">
            {entry.status === "success" ? (
              <span className="flex items-center gap-2">
                <Dot className="bg-success" />
                {withStatusCode(entry.status_code, "Succeeded")}
              </span>
            ) : (
              <span
                className={`flex items-center gap-2 ${entry.status === "error" ? "text-danger" : "text-muted"}`}
              >
                <Dot
                  className={
                    entry.status === "error" ? "bg-danger" : "bg-text-subtle"
                  }
                />
                {withStatusCode(entry.status_code, describeFailure(entry))}
              </span>
            )}
          </Row>
          {showsMember && entry.user_id ? (
            <Row label="Member">
              {memberName(entry.user_id, entry.user_alias)}{" "}
              <span className="text-mono-micro text-subtle">
                {entry.user_id}
              </span>
            </Row>
          ) : null}
          <Row label="Source">
            <span className="flex flex-wrap items-center gap-2">
              <span>{describeRowSource(entry)}</span>
              {isImportedRow ? (
                <Chip tone="info" size="sm">
                  Subscription
                </Chip>
              ) : null}
            </span>
            {isImportedRow && entry.api_key_name ? (
              <span className="block text-caption text-subtle">
                via key {entry.api_key_name}
              </span>
            ) : null}
          </Row>
          {entry.source_label ? (
            <Row label="Session" isMono>
              {entry.source_label}
            </Row>
          ) : null}
          {entry.requested_model ? (
            <Row label="Requested">
              <span className="text-mono-caption">{entry.requested_model}</span>{" "}
              <span className="text-caption text-subtle">
                · {describeRequested(entry)}
              </span>
            </Row>
          ) : null}
          <Row label="Served by" isMono>
            {pricingKey}
          </Row>
          <Row label="Channel">
            {isImportedRow ? `${describeRowSource(entry)} subscription` : "API"}{" "}
            <span className="text-mono-micro text-subtle">
              {entry.endpoint}
            </span>
          </Row>
        </Group>

        {tools.length ? (
          <Group title="Gateway tools">
            <div className="flex flex-col gap-2">
              {tools.map((tool) => (
                <div
                  key={tool.tool}
                  className="flex items-center gap-2.5 border border-border-strong bg-surface-subtle px-2.5 py-2"
                >
                  <FiGlobe
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">
                      {describeTool(tool.tool)}{" "}
                      <span className="text-mono-caption text-subtle">
                        ×{formatNumber(tool.billed)}
                      </span>
                    </span>
                    <span className="block text-caption text-subtle">
                      {tool.errors
                        ? `${formatNumber(tool.errors)} failed`
                        : "all succeeded"}
                      {tool.unitRate !== null
                        ? ` · ${formatUnitRate(tool.unitRate)} per call, run by the gateway`
                        : " · no per-call price is set"}
                    </span>
                  </span>
                  <span className="text-mono-caption">
                    {tool.unitRate !== null
                      ? formatCost(tool.billed * tool.unitRate)
                      : "—"}
                  </span>
                </div>
              ))}
              <Button
                size="sm"
                className="self-start"
                onPress={() => onFilter("tool")}
              >
                {tools.length === 1
                  ? `Filter to ${describeTool(tools[0].tool)}`
                  : "Filter to these tools"}
              </Button>
            </div>
          </Group>
        ) : null}

        {composition ? (
          <Group title="Tokens">
            <div className="mb-2 flex h-1.5 gap-px">
              {segments.map((segment) => (
                <span
                  key={segment.key}
                  className={segment.fill}
                  style={{
                    flex: Math.max(segment.value, composition.total * 0.01),
                  }}
                />
              ))}
            </div>
            {segments.map((segment) => (
              <Row
                key={segment.key}
                isMono
                label={
                  <span className="flex items-center gap-1.5">
                    <span className={`size-2 shrink-0 ${segment.fill}`} />
                    {segment.label}
                  </span>
                }
              >
                {formatNumber(segment.value)}
              </Row>
            ))}
            <Row label="Total" isMono>
              {formatNumber(composition.total)}{" "}
              <span className="text-subtle">
                · {formatPct(cacheHit, 0)} cache hit
              </span>
            </Row>
          </Group>
        ) : null}

        <Group title="Cost">
          <Row label={isImportedRow ? "Equivalent cost" : "Billed"} isMono>
            {entry.cost === null ? "—" : formatCost(entry.cost)}
          </Row>
          {tools.length && entry.cost !== null && toolCost !== null ? (
            <Row label="Includes" isMono>
              {formatCost(Math.max(0, entry.cost - toolCost))} model ·{" "}
              {formatCost(toolCost)} tools
            </Row>
          ) : null}
          <Row label="Budget">
            {isImportedRow
              ? "Excluded. Subscription usage doesn't count toward limits."
              : !entry.counts_toward_budget
                ? "Excluded from budgets."
                : entry.cost === null
                  ? "Nothing counted"
                  : "Counts toward budgets"}
          </Row>
          {isUnpriced ? (
            <Row label="Price">
              <span className="flex flex-col items-start gap-2">
                <span>
                  No price is set for{" "}
                  <span className="text-mono-caption">{pricingKey}</span>
                  {isPricingRefusal
                    ? ", so the gateway refused this request."
                    : ", so this request carries no cost."}
                </span>
                {onPriceModel ? (
                  <Button size="sm" onPress={() => onPriceModel(pricingKey)}>
                    Set model price…
                  </Button>
                ) : (
                  <span className="text-caption text-subtle">
                    A deployment operator sets model prices.
                  </span>
                )}
              </span>
            </Row>
          ) : entry.status !== "success" ? (
            <Row label="Price">
              <span className="text-caption">
                {entry.total_tokens
                  ? "Failed attempts carry their tokens and no charge."
                  : "Failed before the provider reported usage."}
              </span>
            </Row>
          ) : null}
          {entry.pricing_breakdown?.length
            ? sortChargeLines(entry.pricing_breakdown).map((line, index) => {
                // A line of neither known shape was written by an older
                // gateway. Its cost is still real, so it is shown with no rate
                // rather than through a rate format that would print "NaN".
                const meter = String(line.meter ?? "")
                return (
                  <Row
                    key={`${meter}-${index}`}
                    label={meter.replaceAll("_", " ")}
                    isMono
                  >
                    {isUnitChargeLine(line)
                      ? `${formatNumber(line.units)} at ${formatUnitRate(line.unit_rate)}, ${formatCost(line.cost)}`
                      : isTokenChargeLine(line)
                        ? `${formatNumber(line.units)} at ${formatCost(line.rate_per_million)} / 1M, ${formatCost(line.cost)}`
                        : formatCost(Number(line.cost ?? 0))}
                  </Row>
                )
              })
            : null}
        </Group>

        <Group title="Timing">
          <Row label="First token" isMono>
            {entry.ttft_ms !== null
              ? formatLatency(entry.ttft_ms)
              : isImportedRow
                ? "Not recorded for imported rows"
                : "—"}
          </Row>
          <Row label="Total" isMono>
            {formatLatency(entry.latency_ms) ?? "—"}
          </Row>
        </Group>

        <p className="text-caption text-subtle">
          No request or response content is stored.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
        <span className="text-caption text-subtle">Filter to</span>
        {entry.source_label ? (
          <Button size="sm" onPress={() => onFilter("session")}>
            Session
          </Button>
        ) : (
          <Button size="sm" onPress={() => onFilter("source")}>
            Source
          </Button>
        )}
        <Button size="sm" onPress={() => onFilter("model")}>
          Model
        </Button>
        {hasPlayground ? (
          <Link
            to="/playground"
            className={`${buttonVariants({ size: "sm", variant: "ghost" })} ml-auto`}
          >
            <FiMessageSquare aria-hidden className="size-3.5" />
            Playground
          </Link>
        ) : null}
      </div>
    </aside>
  )
}
