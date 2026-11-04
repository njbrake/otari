import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { FiAlertTriangle } from "react-icons/fi"
import type { KeyRouting, KeyRoutingModel } from "@/client"
import { TEXT_LINK_CLASS } from "@/design-system/actions/TextButton"
import {
  Tooltip,
  type TooltipTriggerProps,
} from "@/design-system/overlays/Tooltip"
import type { KeyModelsSummary } from "./keyModels"

function modelCount(count: number): string {
  return `${count} ${count === 1 ? "model" : "models"}`
}

/**
 * A one-line link that ends in "…" when its column is too narrow, with the
 * whole of it in the tooltip.
 *
 * The tooltip's function form, so the trigger is this button itself: the
 * wrapper form is an `inline-flex` box as wide as its text, which nothing in a
 * fixed-width column caps, so the text ran into the next lane and the button's
 * own `truncate` never had an edge to end against. The trigger's class is
 * dropped for the reason `RowAction` drops it.
 */
function TruncatingLink({
  tooltip,
  onPress,
  className = "",
  children,
}: {
  tooltip: ReactNode
  onPress: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <Tooltip content={tooltip} delay={0}>
      {({ className: _triggerClass, ...trigger }: TooltipTriggerProps = {}) => (
        <button
          {...trigger}
          type="button"
          onClick={onPress}
          className={`block max-w-full truncate text-left text-sm ${TEXT_LINK_CLASS} ${className}`}
        >
          {children}
        </button>
      )}
    </Tooltip>
  )
}

/**
 * A key's Models lane: what its allow-list reaches, as the providers it draws
 * on and how many models that is, with each provider's count on hover. Pressing
 * it opens Edit, which is where the list is changed.
 */
export function KeyModelsCell({
  summary,
  onOpen,
}: {
  summary: KeyModelsSummary
  onOpen: () => void
}) {
  if (summary.kind !== "selected") {
    return (
      <TruncatingLink
        tooltip={
          summary.kind === "all"
            ? "Every model its owner may use"
            : "Every request on this key is refused"
        }
        onPress={onOpen}
        className={summary.kind === "none" ? "text-danger" : ""}
      >
        {summary.kind === "all" ? "All allowed models" : "No models"}
      </TruncatingLink>
    )
  }
  const detail = summary.providers
    .map((provider) => {
      const count = summary.counts.get(provider)
      return count === undefined
        ? provider
        : `${provider}: ${modelCount(count)}`
    })
    .join(" · ")
  return (
    <span className="flex min-w-0 flex-col">
      <TruncatingLink tooltip={detail} onPress={onOpen}>
        {summary.providers.join(", ")}
      </TruncatingLink>
      {summary.total === undefined ? null : (
        <span className="text-caption text-subtle">
          {modelCount(summary.total)}
        </span>
      )}
    </span>
  )
}

/** Why a name has no backup, in the words the Edit dialog and the tooltip share. */
export function noBackupReason(model: KeyRoutingModel): string {
  switch (model.reason) {
    case "single_offering":
      return model.provider
        ? `only ${model.provider} serves it`
        : "one provider serves it"
    case "single_target_policy":
      return "policy with one target"
    case "pinned":
      return model.provider
        ? `pinned to ${model.provider}`
        : "pinned to one provider"
    case "no_allowed_offering":
      return "no provider this key may use serves it"
    default:
      return "no backup"
  }
}

/** The backup state under a name: said in words, with a mark where it needs noticing. */
export function KeyBackupLine({ model }: { model: KeyRoutingModel }) {
  if (model.backup === "no_backup") {
    return (
      <Tooltip content={noBackupReason(model)} delay={0}>
        <span className="flex items-center gap-1.5 text-caption text-warning">
          <FiAlertTriangle aria-hidden className="size-3 shrink-0" />
          No backup
        </span>
      </Tooltip>
    )
  }
  const word =
    model.backup === "has_backup"
      ? "Has backup"
      : model.backup === "subscription"
        ? "Subscription"
        : "Not routed now"
  return <span className="text-caption text-subtle">{word}</span>
}

/**
 * A key's Most-used model lane: the name it sent most in the last 30 days, how
 * many others it sent, and whether a failure on it has somewhere to go.
 * `routing` is absent while the read is in flight or for a key it did not
 * cover, and then the lane says nothing rather than guessing.
 */
export function KeyMostUsedCell({
  routing,
}: {
  routing: KeyRouting | undefined
}) {
  if (!routing) {
    return <span className="text-caption text-subtle">—</span>
  }
  const [top] = routing.models
  if (!top) {
    return <span className="text-caption text-subtle">Not used (30d)</span>
  }
  const others = routing.model_count - 1
  return (
    <span className="flex min-w-0 flex-col">
      <span
        title={others > 0 ? `${top.name} and ${others} more` : top.name}
        className="truncate text-mono-caption text-foreground"
      >
        {top.name}
        {others > 0 ? <span className="text-subtle"> +{others}</span> : null}
      </span>
      <KeyBackupLine model={top} />
    </span>
  )
}

/**
 * How many of the names a key sent have no backup, as a sentence. A count of
 * zero does not mean every name has one: imported (`subscription`) and
 * unresolvable (`unknown`) names are counted as neither.
 */
function backupSentence(routing: KeyRouting): string {
  if (routing.model_count === 0) return "No requests in the last 30 days"
  if (routing.no_backup_count === 0) return "None without one"
  const verb = routing.no_backup_count === 1 ? "has" : "have"
  return `${routing.no_backup_count} of ${modelCount(routing.model_count)} ${verb} none`
}

/**
 * A link that starts routing for one key: the new-policy page titled for it,
 * starting on the model the key sends most where that is a concrete
 * `provider:model` (a catalog ID, an alias or a policy name is no policy
 * target). The operator creates from the Routing list's dialog instead, which
 * takes the same `?target=`.
 */
export function SetUpRoutingLink({
  apiKeyId,
  routing,
  isDeploymentWide,
  className = TEXT_LINK_CLASS,
  children,
}: {
  apiKeyId: string
  routing?: KeyRouting
  isDeploymentWide: boolean
  className?: string
  children: ReactNode
}) {
  const top = routing?.models[0]
  const target = top?.kind === "pinned" ? top.name : ""
  return isDeploymentWide ? (
    <Link to="/routing" search={target ? { target } : {}} className={className}>
      {children}
    </Link>
  ) : (
    <Link
      to="/routing/new"
      search={{ key: apiKeyId, ...(target ? { target } : {}) }}
      className={className}
    >
      {children}
    </Link>
  )
}

/**
 * The Routing part of a key's Edit: what a key's requests are routed by, which
 * a key does not own. Policies are chosen by the name a request sends, so this
 * reports the policies the key sent and how many of its names have no backup,
 * the three most used of those, and where routing is set.
 */
export function KeyRoutingSummary({
  apiKeyId,
  routing,
  isDeploymentWide,
}: {
  apiKeyId: string
  routing: KeyRouting | undefined
  isDeploymentWide: boolean
}) {
  if (!routing) {
    return <p className="text-caption">Reading what this key sent…</p>
  }
  const missing = routing.models.filter((model) => model.backup === "no_backup")
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-y-1 text-sm">
        <dt className="text-subtle">Policies sent (30d)</dt>
        <dd>
          {routing.policies.length > 0
            ? routing.policies
                .map(
                  (policy) =>
                    `${policy.name} (${policy.requests.toLocaleString("en-US")})`,
                )
                .join(", ")
            : "None, requests name models directly"}
        </dd>
        <dt className="text-subtle">Backups</dt>
        <dd className={routing.no_backup_count > 0 ? "text-warning" : ""}>
          {backupSentence(routing)}
        </dd>
      </dl>
      {missing.length > 0 ? (
        <ul className="flex flex-col">
          {missing.slice(0, 3).map((model) => (
            <li
              key={model.name}
              className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-baseline gap-2 border-t border-border-subtle py-1.5"
            >
              <FiAlertTriangle aria-hidden className="size-3 text-warning" />
              <span className="min-w-0 truncate">
                <span className="text-mono-caption text-foreground">
                  {model.name}
                </span>{" "}
                <span className="text-caption">· {noBackupReason(model)}</span>
              </span>
              <span className="text-mono-caption text-subtle">
                {model.requests.toLocaleString("en-US")} req
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-sm">
        <SetUpRoutingLink
          apiKeyId={apiKeyId}
          routing={routing}
          isDeploymentWide={isDeploymentWide}
        >
          Set up routing
        </SetUpRoutingLink>
      </p>
    </div>
  )
}
