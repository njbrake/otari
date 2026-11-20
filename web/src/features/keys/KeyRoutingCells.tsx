import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { FiAlertTriangle } from "react-icons/fi"
import type { KeyRouting, KeyRoutingModel } from "@/client"
import {
  Tooltip,
  type TooltipTriggerProps,
} from "@/design-system/overlays/Tooltip"
import type { KeyModelsSummary } from "@/features/keys/keyModels"

const LINK_CLASS = "text-link hover:text-link-hover"

function modelCount(count: number): string {
  return `${count} ${count === 1 ? "model" : "models"}`
}

/**
 * A one-line link that ends in "…" when its column is too narrow, with the
 * whole of it in the tooltip.
 *
 * The tooltip's function form, so the trigger is this button itself: the
 * wrapper form is an `inline-flex` box as wide as its text, which nothing in a
 * column caps, so the text would run into the next lane. The trigger's class
 * is dropped so the button's own `truncate` has an edge to end against.
 */
function TruncatingLink({
  tooltip,
  onPress,
  className = "",
  children,
}: {
  tooltip: ReactNode
  /** Undefined where the caller may only read the key: the text then stays text. */
  onPress: (() => void) | undefined
  className?: string
  children: ReactNode
}) {
  if (!onPress) {
    return (
      <span
        title={typeof tooltip === "string" ? tooltip : undefined}
        className={`block max-w-full truncate text-body ${className}`}
      >
        {children}
      </span>
    )
  }
  return (
    <Tooltip content={tooltip} delay={0}>
      {({ className: _triggerClass, ...trigger }: TooltipTriggerProps = {}) => (
        <button
          {...trigger}
          type="button"
          onClick={onPress}
          className={`block max-w-full truncate text-left text-body ${LINK_CLASS} ${className}`}
        >
          {children}
        </button>
      )}
    </Tooltip>
  )
}

/**
 * A key's Models lane: what its allow-list reaches, as the providers it draws
 * on and how many catalog models that is, with each provider's count on hover.
 * Pressing it opens Edit, which is where the list is changed, for a caller who
 * may change it.
 */
export function KeyModelsCell({
  summary,
  onOpen,
}: {
  summary: KeyModelsSummary
  onOpen: (() => void) | undefined
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

/** Why a name has no backup, in the words the Edit form and the tooltip share. */
export function noBackupReason(model: KeyRoutingModel): string {
  switch (model.reason) {
    case "single_offering":
      return model.provider
        ? `only ${model.provider} serves it`
        : "one provider serves it"
    case "single_target_policy":
      return "a policy with one target"
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
    const reason = noBackupReason(model)
    return (
      <Tooltip content={reason} delay={0}>
        <span className="flex items-center gap-1.5 text-caption text-warning">
          <FiAlertTriangle aria-hidden className="size-3 shrink-0" />
          No backup
          {/* For a screen reader; a phone reads the reason in Edit. */}
          <span className="sr-only">: {reason}</span>
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
    return <span className="text-mono-caption text-subtle">—</span>
  }
  const [top] = routing.models
  if (!top) {
    return <span className="text-caption text-subtle">Not used (30d)</span>
  }
  const others = routing.model_count - 1
  // The count of the others sits on the second line, so a long name's
  // ellipsis never cuts it off.
  return (
    <span className="flex min-w-0 flex-col">
      <span
        title={others > 0 ? `${top.name} and ${others} more` : top.name}
        className="truncate text-mono-caption text-foreground"
      >
        {top.name}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        {others > 0 ? (
          <>
            <span className="shrink-0 text-caption text-subtle">
              +{others} {others === 1 ? "other" : "others"}
            </span>
            <span aria-hidden="true" className="text-caption text-subtle">
              ·
            </span>
          </>
        ) : null}
        <KeyBackupLine model={top} />
      </span>
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
 * A link to Routing, opening a new fallback on the model the key sends most
 * where that is a concrete `provider:model`: a catalog ID or a policy name is
 * no policy target.
 */
export function SetUpRoutingLink({
  routing,
  children,
}: {
  routing?: KeyRouting
  children: ReactNode
}) {
  const top = routing?.models[0]
  const target = top?.kind === "pinned" ? top.name : ""
  return (
    <Link
      to="/routing"
      search={target ? { target } : {}}
      className={LINK_CLASS}
    >
      {children}
    </Link>
  )
}

/**
 * The Routing part of a key's Edit: what a key's requests are routed by, which
 * a key does not own. Policies are chosen by the name a request sends, so this
 * reports the policies the key sent, how many of its names have no backup, the
 * three most used of those with why, and where routing is set.
 */
export function KeyRoutingSummary({
  routing,
  isPending,
}: {
  routing: KeyRouting | undefined
  isPending: boolean
}) {
  if (!routing) {
    return (
      <p className="text-caption">
        {isPending
          ? "Reading what this key sent…"
          : "What this key sent could not be read."}
      </p>
    )
  }
  const missing = routing.models.filter((model) => model.backup === "no_backup")
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-y-1 text-body">
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
        <ul className="flex flex-col" aria-label="Names with no backup">
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
      <p className="text-body">
        <SetUpRoutingLink routing={routing}>Set up routing</SetUpRoutingLink>
      </p>
    </div>
  )
}
