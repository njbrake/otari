import { FiAlertTriangle, FiArrowRight } from "react-icons/fi"
import type { KeyRequests, PolicySpec } from "@/client"
import { Dot } from "@/design-system/indicators/Dot"
import { describeOffering } from "@/features/models/offerings"
import { keyRequestLabel } from "@/features/routing/routingTraffic"
import { formatCount } from "@/shared/helpers/format"

import {
  computeShares,
  findBudgetConditions,
  findCandidates,
  findFallthroughTarget,
  findRouterBackend,
  findWeights,
  PRIORITY_BACKEND,
  type RoutingRow,
  WEIGHTED_BACKEND,
} from "./policyModel"

/**
 * What to call the backend that decides, for a mark or a one-line summary.
 *
 * Named per backend rather than "Dynamic", because the backend's name is what
 * tells the reader what to do next (move the shares, or the order). A backend
 * this build does not know gets the neutral word.
 */
export function routerLabelOf(spec: PolicySpec): string {
  const backend = findRouterBackend(spec)
  if (backend === WEIGHTED_BACKEND) return "Weighted"
  if (backend === PRIORITY_BACKEND) return "Priority"
  return "Routed"
}

/** A selector in a table cell: its model, then its provider. */
export function selectorText(selector: string): string {
  const { model, provider } = describeOffering(selector)
  return provider ? `${model} · ${provider}` : model
}

/** A routed policy's pool in one line: the split, or the pool and its default. */
function routedSummary(spec: PolicySpec, pool: string[]): string {
  const target = findFallthroughTarget(spec)
  if (findRouterBackend(spec) === WEIGHTED_BACKEND) {
    // The split's shape, not the model names: the shares are what tells one
    // weighted policy from another, and the pool is spelled out in the editor.
    const declared = findWeights(spec)
    const full = pool.includes(target) ? pool : [...pool, target]
    const split = computeShares(full.map((selector) => declared[selector] ?? 0))
      .map((share) => `${Math.round(share)}%`)
      .join(" / ")
    return `Weighted · ${split} across ${full.length} models`
  }
  return `${routerLabelOf(spec)} · ${pool.length} candidates, ${selectorText(target)} by default`
}

/** The affirmative kind mark: an accent dot and the word, in mono. */
function KindMark({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2 text-mono-caption text-foreground">
      <Dot className="bg-accent" />
      {label.toUpperCase()}
    </span>
  )
}

/** A selector as its model and provider, without a catalog read per row. */
function SelectorName({ selector }: { selector: string }) {
  const { model, provider } = describeOffering(selector)
  return (
    <span title={selector} className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-sm text-foreground">{model}</span>
      {/* Read as two words: a flex row drops the space visually, not from
          the accessible name. */}
      {provider ? " " : null}
      {provider ? <span className="text-caption">{provider}</span> : null}
    </span>
  )
}

/** A caution in a cell: an icon and a few words in the warning color. */
export function Warning({ children }: { children: string }) {
  return (
    <span className="flex items-center gap-1 text-sm text-warning">
      <FiAlertTriangle aria-hidden className="size-3 shrink-0" />
      {children}
    </span>
  )
}

/** A row's tier-downs and guardrails, each on a caption line of its own. */
function PolicyCaptions({ spec }: { spec: PolicySpec }) {
  const conditions = findBudgetConditions(spec)
  const guardrails = spec.guardrails ?? []
  return (
    <>
      {conditions.map((condition) => (
        <span
          key={`${condition.threshold}:${condition.target}`}
          className="text-caption"
        >
          From {condition.threshold}% of budget:{" "}
          {selectorText(condition.target)}
        </span>
      ))}
      {guardrails.length > 0 ? (
        <span className="text-caption">
          Always checks{" "}
          {guardrails
            .map((guardrail) => `${guardrail.profile} (${guardrail.mode})`)
            .join(", ")}
        </span>
      ) : null}
    </>
  )
}

/**
 * What a request through this row tries, in order. A single-model policy reads
 * as one chain, its model then each backup; a routed one keeps its summary
 * line, since the router rather than an order picks among the pool, with its
 * backups after it. A row whose first failure has nowhere to go says so.
 */
export function TriedInOrderCell({ row }: { row: RoutingRow }) {
  const pool = findCandidates(row.spec)
  const backups = row.spec.on_failure ?? []
  const chain =
    pool.length > 0 ? backups : [findFallthroughTarget(row.spec), ...backups]
  return (
    <div className="flex flex-col gap-1">
      {pool.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground">
            {routedSummary(row.spec, pool)}
          </span>
          <KindMark label={routerLabelOf(row.spec)} />
        </div>
      ) : null}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {pool.length > 0 && chain.length > 0 ? (
          <span className="text-caption">Then</span>
        ) : null}
        <ol
          aria-label="Tried in order"
          className="flex flex-wrap items-center gap-x-2 gap-y-1"
        >
          {chain.map((selector, index) => (
            <li
              key={`${index}:${selector}`}
              className="flex items-center gap-2"
            >
              {index > 0 ? (
                <FiArrowRight
                  aria-label="then"
                  className="size-3 shrink-0 text-subtle"
                />
              ) : null}
              <SelectorName selector={selector} />
            </li>
          ))}
        </ol>
        {/* A routed pool fails over within itself, so only a lone target with
            nothing behind it has no backup. */}
        {backups.length === 0 && pool.length < 2 ? (
          <Warning>No backup</Warning>
        ) : null}
        {pool.length === 0 && row.is_dynamic ? (
          <KindMark label="Dynamic" />
        ) : null}
        {row.kind === "alias" ? (
          <span className="text-mono-overline text-subtle">alias</span>
        ) : null}
      </span>
      <PolicyCaptions spec={row.spec} />
    </div>
  )
}

/** Which keys sent a name, busiest first: two by name and the rest as a count, every one with its count on hover. */
export function SentByCell({ sentBy }: { sentBy: readonly KeyRequests[] }) {
  if (sentBy.length === 0) return <span className="text-muted">None (30d)</span>
  const named = sentBy.slice(0, 2)
  const rest = sentBy.length - named.length
  return (
    <span
      className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-foreground"
      title={sentBy
        .map((key) => `${keyRequestLabel(key)}: ${formatCount(key.requests)}`)
        .join("\n")}
    >
      {named.map((key, index) => (
        <span key={key.api_key_id}>
          {keyRequestLabel(key)}
          {index < named.length - 1 || rest > 0 ? "," : ""}
        </span>
      ))}
      {rest > 0 ? <span className="text-caption">+{rest} more</span> : null}
    </span>
  )
}
