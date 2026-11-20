import { Button } from "@heroui/react"
import type { ReactNode } from "react"
import { FiTool } from "react-icons/fi"

import type { UsageEntry } from "@/client"
import { isTokenChargeLine, isToolChargeLine, isUnitChargeLine } from "@/client"
import { Chip } from "@/design-system/indicators/Chip"
import { dataLocationLabel } from "@/features/hostedProviders/dataLocations"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { userDisplay } from "@/features/users/userDisplay"
import { formatNumber, formatUnitRate } from "@/shared/helpers/format"
import { providerDisplayName } from "@/shared/helpers/providers"
import {
  buildTokenComposition,
  calledPath,
  computeToolCost,
  describeSkip,
  describeSource,
  findPricingSelector,
  formatLatencyCell,
  formatTokenCount,
  formatUSD,
  isSkippedAttempt,
  listToolUsage,
  sortChargeLines,
  type ToolUsage,
} from "./activityModel"
import { DetailField } from "./DetailField"
import { RoutingPlan } from "./RoutingPlan"
import { apiKeyLabel } from "./requestColumns"
import {
  budgetChip,
  cacheHitFraction,
  describeBudget,
  describeChannel,
  describeFailure,
  describeRequested,
  describeTool,
  explainFailure,
  isImported,
  pricingRefusal,
  tokenSegments,
  withStatusCode,
} from "./requestPanelModel"
import { TokenCompositionBar } from "./TokenCompositionBar"

const GRID = "grid gap-x-6 gap-y-3 @xs:grid-cols-2 @3xl:grid-cols-4"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-overline">{title}</h3>
      {children}
    </section>
  )
}

// The detail panel for one request: why it failed, how it was routed, what it
// was asked for and what served it, its tokens, its cost and its timing. The
// stored `error_message` is shown as stored: the gateway redacts upstream text
// before persisting it, so nothing here needs to. It is source-neutral by
// nature, carrying either a fixed gateway rejection string or the upstream
// provider error, so the heading stays "Error" rather than blaming the provider
// for every failure.
export function RequestDetail({
  entry,
  onPriceModel,
  isInset = true,
  showsRequestId = true,
}: {
  entry: UsageEntry
  /**
   * Whether the detail pads itself to the panel's 16px edge. Off inside a
   * trace's detail column, which already pads its contents by that much.
   */
  isInset?: boolean
  /** Off where the frame around the detail already shows and copies the request id. */
  showsRequestId?: boolean
  /**
   * Absent for a caller who does not operate the deployment. Pricing a model is a
   * deployment-wide write (`/pricing`), so offering the button to a tenant
   * would be offering a refusal; the sentence beside it is still theirs to read,
   * because "this row cost nothing" is a fact about their own request. The
   * endpoint goes with the model, so the price can open in the unit that
   * endpoint is billed in.
   */
  onPriceModel?: (model: string, endpoint: string) => void
}) {
  const memberLabels = useMemberAttributionLabels()
  // A served request with no cost (cost IS NULL, the same test the "Priced?"
  // filter uses) was metered without a price, and pricing the model is the fix;
  // the row holds the selector, which a provider without model discovery would
  // never have put in the catalog. A failed attempt carries no cost because
  // nothing was billed, whatever the cause, so a price is offered there only for
  // the gateway's own refusal of an unpriced model, which pricing does fix. A $0
  // cost is a real price, so it is deliberately not treated as uncosted.
  const isUnpricedServed = entry.status === "success" && entry.cost === null
  const refusal = pricingRefusal(entry)
  const pricingKey = findPricingSelector(entry)
  const isSkipped = isSkippedAttempt(entry)
  const requestId = entry.request_group_id || entry.id
  const user =
    entry.user_id === null
      ? null
      : userDisplay(entry.user_id, entry.user_alias, memberLabels)
  const tools = listToolUsage(entry)
  const toolCost = computeToolCost(entry)
  const composition = buildTokenComposition(entry)
  const imported = isImported(entry)
  const chip = budgetChip(entry)
  const explanation = explainFailure(entry)
  const priceButton = onPriceModel ? (
    <Button
      size="sm"
      variant="ghost"
      onPress={() => onPriceModel(pricingKey, entry.endpoint)}
    >
      Price this model
    </Button>
  ) : null
  return (
    <div
      className={`@container flex flex-col gap-5 ${isInset ? "px-4 pt-3 pb-4" : ""}`}
    >
      {/* A skip is the walk moving past a full model, not a failure, so it is
          worded and styled as a note rather than an error. */}
      {isSkipped ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-overline">Skipped</span>
          <p className="rounded-lg border border-border bg-surface p-3 text-xs text-foreground">
            {describeSkip(entry)}. Routing moved this request to the next
            candidate without calling this one.
          </p>
        </div>
      ) : entry.error_message ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-overline">
            Error{entry.status_code !== null ? ` (${entry.status_code})` : ""}
          </span>
          {/* An absorbed attempt is a failure the request recovered from, so it
              reads in the warning tone rather than as the request's failure. */}
          <div
            className={`flex flex-col gap-2 rounded-lg border p-3 ${
              entry.status === "absorbed"
                ? "border-warning bg-warning-subtle text-warning"
                : "border-danger bg-danger-subtle text-danger"
            }`}
          >
            <p className="text-sm font-medium">
              {withStatusCode(entry.status_code, describeFailure(entry))}
            </p>
            <pre className="max-h-48 overflow-auto text-xs whitespace-pre-wrap break-all">
              {entry.error_message}
            </pre>
            {explanation ? (
              <p className="text-xs text-foreground">{explanation}</p>
            ) : null}
            {refusal === "model" && priceButton ? (
              <span className="self-start">{priceButton}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {/* Routed requests only. Placed above the metadata, because on a failed
          attempt it answers the first question the failure raises: what served
          the request instead. */}
      {entry.policy_name !== null && entry.policy_name !== undefined ? (
        <RoutingPlan entry={entry} />
      ) : null}
      <Section title="Request">
        <div className={GRID}>
          {/* In full: the row's Model and API key lanes cut them short, and a
              title is no help to a keyboard or a touch screen. */}
          <DetailField label="Model">{entry.model}</DetailField>
          <DetailField label="Provider">
            {entry.provider ? providerDisplayName(entry.provider) : "—"}
          </DetailField>
          {entry.requested_model ? (
            <DetailField label="Requested as">
              <span className="text-mono-caption">{entry.requested_model}</span>{" "}
              <span className="text-caption">· {describeRequested(entry)}</span>
            </DetailField>
          ) : null}
          <DetailField label="Served by">
            <span className="text-mono-caption">{pricingKey}</span>
          </DetailField>
          {entry.data_location ? (
            <DetailField label="Data location">
              {dataLocationLabel(entry.data_location)}
            </DetailField>
          ) : null}
          <DetailField label="Endpoint">{calledPath(entry)}</DetailField>
          <DetailField label="Channel">
            <span className="inline-flex flex-wrap items-center gap-2">
              {describeChannel(entry)}
              {chip ? <Chip tone="info">{chip}</Chip> : null}
            </span>
          </DetailField>
          <DetailField label="Source">
            {describeSource(entry.source)}
          </DetailField>
          {entry.source_label ? (
            <DetailField label="Session">{entry.source_label}</DetailField>
          ) : null}
          {/* The name reads, the id stays copyable: this is the one place an
              operator goes for the raw id, so naming the person here must not
              take it away. */}
          <DetailField
            label="User"
            copyValue={entry.user_id}
            copyLabel="user id"
            isId={user !== null && user.id === undefined}
          >
            {user?.label ?? "—"}
          </DetailField>
          <DetailField label="API key">{apiKeyLabel(entry)}</DetailField>
        </div>
      </Section>
      {tools.length ? (
        <Section title="Gateway tools">
          <ul className="flex flex-col gap-2">
            {tools.map((tool) => (
              <ToolCard key={tool.tool} tool={tool} />
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Tokens">
        {composition ? (
          <div className="flex flex-col gap-2">
            <TokenCompositionBar composition={composition} />
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
              {tokenSegments(composition).map((segment) => (
                <li key={segment.key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`size-2 shrink-0 ${segment.fill}`}
                  />
                  {segment.label}{" "}
                  <span className="text-foreground tabular-nums">
                    {formatNumber(segment.value)}
                  </span>
                </li>
              ))}
              <li className="tabular-nums">
                {Math.round(cacheHitFraction(composition) * 100)}% cache hit
              </li>
            </ul>
          </div>
        ) : null}
        <div className={GRID}>
          <DetailField label="Prompt tokens">
            {formatTokenCount(entry.prompt_tokens)}
          </DetailField>
          <DetailField label="Completion tokens">
            {formatTokenCount(entry.completion_tokens)}
          </DetailField>
          <DetailField label="Total tokens">
            {formatTokenCount(entry.total_tokens)}
          </DetailField>
          {/* The row's Input and Output added up, spelled out here because it can
              exceed the provider-reported total above: the cache buckets count, and
              an additive-convention provider reports them outside the prompt. */}
          <DetailField label="Billed tokens">
            <span title="Fresh input, cache reads and writes, and output: the tokens this request was priced on, which the row splits into Input and Output.">
              {formatTokenCount(composition?.total ?? null)}
            </span>
          </DetailField>
          <DetailField label="Cache read tokens">
            {formatTokenCount(entry.cache_read_tokens)}
          </DetailField>
          <DetailField label="Cache write tokens">
            {formatTokenCount(entry.cache_write_tokens)}
          </DetailField>
          <DetailField label="1h cache writes">
            {formatTokenCount(entry.cache_write_1h_tokens ?? null)}
          </DetailField>
          <DetailField label="Reasoning tokens">
            {formatTokenCount(entry.reasoning_tokens ?? null)}
          </DetailField>
        </div>
      </Section>
      <Section title="Cost">
        <div className={GRID}>
          {/* An imported row's cost is what its usage would have cost here; its
              subscription paid, so nothing billed it. */}
          <DetailField label={imported ? "Equivalent cost" : "Billed"}>
            {formatUSD(entry.cost)}
          </DetailField>
          {tools.length && entry.cost !== null ? (
            <DetailField label="Includes">
              {toolCost === null ? (
                <span
                  className="text-warning"
                  title="No per-request price is configured for this tool, so its calls were recorded at zero cost. Set one on the Tools & Guardrails screen."
                >
                  tools unpriced
                </span>
              ) : (
                `${formatUSD(Math.max(0, entry.cost - toolCost))} model · ${formatUSD(toolCost)} tools`
              )}
            </DetailField>
          ) : null}
          <DetailField label="Budget">{describeBudget(entry)}</DetailField>
        </div>
        {isUnpricedServed ? (
          <div className="flex flex-wrap items-center gap-3">
            {priceButton}
            <span className="text-caption">
              {onPriceModel ? (
                <>
                  This request carries no cost. Set a price for{" "}
                  <code className="break-all">{pricingKey}</code> so later
                  requests are metered and count against budgets. Rows already
                  logged keep the cost they were served with.
                </>
              ) : (
                <>
                  This request carries no cost, because no price is set for{" "}
                  <code className="break-all">{pricingKey}</code>. A deployment
                  operator sets one; rows already logged keep the cost they were
                  served with.
                </>
              )}
            </span>
          </div>
        ) : null}
        {entry.pricing_breakdown?.length ? (
          <div className="flex flex-col gap-2">
            <span className="text-overline">Billed meters</span>
            <div className={GRID}>
              {sortChargeLines(entry.pricing_breakdown).map((line) => {
                // A line of neither known shape was written by an older gateway.
                // Its cost is still real, so it is shown as a charge with no rate
                // rather than rendered through one of the two rate formats, which
                // would print an undefined rate as "NaN / 1M".
                const meter = String(line.meter ?? "")
                // A tool runs under one line per label, so the label keeps the
                // lines of one meter apart.
                const label = isToolChargeLine(line) ? line.label : null
                return (
                  <DetailField
                    key={label === null ? meter : `${meter} ${label}`}
                    label={meter.replaceAll("_", " ")}
                  >
                    {label === null ? null : (
                      <>
                        <code className="break-all">{label}</code>:{" "}
                      </>
                    )}
                    {isUnitChargeLine(line)
                      ? `${formatTokenCount(line.units)} at ${formatUnitRate(line.unit_rate)} each, ${formatUSD(line.cost)}`
                      : isTokenChargeLine(line)
                        ? `${formatTokenCount(line.units)} at ${formatUSD(line.rate_per_million)} / 1M, ${formatUSD(line.cost)}`
                        : formatUSD(Number(line.cost ?? 0))}
                  </DetailField>
                )
              })}
            </div>
          </div>
        ) : null}
      </Section>
      <Section title="Timing">
        <div className={GRID}>
          {/* Recorded for a streamed request only, from the request's start, so
              on a routed request it includes the attempts before this one. */}
          <DetailField label="First token">
            {entry.ttft_ms !== null && entry.ttft_ms !== undefined
              ? formatLatencyCell(entry.ttft_ms)
              : imported
                ? "Not recorded for imported rows"
                : "—"}
          </DetailField>
          <DetailField label="Total time">
            {formatLatencyCell(entry.latency_ms)}
          </DetailField>
          {/* Provider-reported compute time, best-effort (Groq, Ollama today).
              formatLatencyCell's null placeholder means not reported, not zero.
              Diagnostic only: Total time above stays the canonical measure. */}
          <DetailField label="Provider time">
            {formatLatencyCell(entry.provider_latency_ms)}
          </DetailField>
        </div>
      </Section>
      {/* The ids on a row of their own, each half the panel: a 36-character id
          does not fit a quarter of it beside its copy control. */}
      <div className="grid gap-x-6 gap-y-3 @xs:grid-cols-2">
        <DetailField
          label="API key ID"
          copyValue={entry.api_key_id}
          copyLabel="api key id"
          isId
        >
          {entry.api_key_id ?? "—"}
        </DetailField>
        {/* The id the request was answered under (`Otari-Request-ID`), which every
            attempt's row shares; a row older than request groups has only its own. */}
        {showsRequestId ? (
          <DetailField label="Request ID" copyValue={requestId} isId>
            {requestId}
          </DetailField>
        ) : null}
      </div>
    </div>
  )
}

/** One gateway-run tool the request called: how often, how many failed, at what rate, for what. */
function ToolCard({ tool }: { tool: ToolUsage }) {
  const isUnpriced = tool.unitRate === null && tool.billed > 0
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-subtle px-3 py-2">
      <FiTool aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm">
          {describeTool(tool.tool)}{" "}
          <span className="text-mono-caption text-muted">
            ×{formatNumber(tool.billed)}
          </span>
        </span>
        <span className="text-caption">
          {tool.errors
            ? `${formatNumber(tool.errors)} failed`
            : "all succeeded"}
          {tool.unitRate !== null
            ? ` · ${formatUnitRate(tool.unitRate)} per call`
            : " · no per-call price is set"}
        </span>
      </span>
      <span className={`text-mono-caption ${isUnpriced ? "text-warning" : ""}`}>
        {/* A tool with no rate records its calls at no cost, which is not free;
            one with no billed call owes nothing either way. */}
        {isUnpriced
          ? "unpriced"
          : formatUSD(tool.billed * (tool.unitRate ?? 0))}
      </span>
    </li>
  )
}
