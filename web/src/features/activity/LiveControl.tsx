import { FiChevronDown } from "react-icons/fi"
import type { InFlightResponse } from "@/client"
import { Button } from "@/design-system/actions/Button"
import { Toggle } from "@/design-system/forms/Toggle"
import { Dot } from "@/design-system/indicators/Dot"
import { Divider } from "@/design-system/layout/Divider"
import { Popover } from "@/design-system/overlays/Popover"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { userDisplay } from "@/features/users/userDisplay"
import { formatNumber } from "@/shared/helpers/format"
import { InFlightWait } from "./InFlightWait"
import { MenuHeading } from "./MenuRow"

function LiveDot({ isLive }: { isLive: boolean }) {
  return <Dot className={isLive ? "bg-success" : "bg-text-subtle"} />
}

/**
 * Whether the log follows new requests, and for a deployment operator, what
 * the gateway is serving right now.
 *
 * Live mode brings the window up to now every ten seconds; it holds still on
 * its own while the reader pages back, has a request open, or looks at a window
 * that has ended, so a row never moves under someone reading it. Members and
 * managers get the switch alone. An operator's control also reports the
 * in-flight count and opens the list behind it, which is gateway-wide by
 * nature: a request that has not finished has no outcome, cost or token count
 * for the log's filters to match on.
 */
export function LiveControl({
  isLive,
  onLive,
  isOperator,
  inFlight,
  isInFlightFailed = false,
  inFlightUpdatedAt,
}: {
  isLive: boolean
  onLive: (isLive: boolean) => void
  isOperator: boolean
  /** The operator's in-flight read, until it answers or when it fails. */
  inFlight: InFlightResponse | undefined
  /** The read failed, which the list says in place of its rows. */
  isInFlightFailed?: boolean
  inFlightUpdatedAt: number
}) {
  const memberLabels = useMemberAttributionLabels()
  const label = isLive ? "Live" : "Paused"
  if (!isOperator) {
    return (
      // Named for what it switches, so its pressed state carries on or off
      // rather than a label that flips as well.
      <Button
        size="sm"
        aria-label="Live updates"
        aria-pressed={isLive}
        onPress={() => onLive(!isLive)}
      >
        <LiveDot isLive={isLive} />
        {label}
      </Button>
    )
  }
  const shown = inFlight?.requests ?? []
  const hidden = inFlight ? Math.max(0, inFlight.total - shown.length) : 0
  return (
    <Popover
      label="Live updates"
      placement="bottom end"
      padding="none"
      trigger={
        <Button
          size="sm"
          aria-label={
            inFlight
              ? `${label}, ${formatNumber(inFlight.total)} in flight`
              : isInFlightFailed
                ? `${label}, in-flight count unavailable`
                : label
          }
        >
          <LiveDot isLive={isLive} />
          {label}
          {inFlight ? (
            <span className="text-subtle">
              · {formatNumber(inFlight.total)} in flight
            </span>
          ) : null}
          <FiChevronDown aria-hidden className="size-3.5" />
        </Button>
      }
    >
      <div className="flex w-80 flex-col py-1">
        <div className="flex items-center gap-2.5 px-3 py-2">
          <span className="flex-1 text-sm">
            Live updates
            <span className="block text-caption text-subtle">
              Brings the log up to now every 10 seconds. Pauses while you page
              or read a row.
            </span>
          </span>
          <Toggle isSelected={isLive} onChange={onLive} label="Live updates" />
        </div>
        <Divider weight="subtle" className="my-1" />
        <MenuHeading>In flight across the gateway</MenuHeading>
        {isInFlightFailed ? (
          <p className="px-3 py-1.5 text-caption text-danger">
            The requests in flight could not be loaded.
          </p>
        ) : !inFlight ? (
          <p className="px-3 py-1.5 text-caption text-subtle">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-1.5 text-caption">
            Nothing running right now. Settled requests join the log as they
            land.
          </p>
        ) : (
          <ul className="flex flex-col">
            {shown.map((request) => (
              <li
                key={request.id}
                className="flex items-center gap-2.5 px-3 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-mono-caption">
                    {request.model}
                  </span>
                  <span className="block truncate text-caption text-subtle">
                    {request.user_id === null
                      ? "—"
                      : userDisplay(request.user_id, null, memberLabels).label}
                    {request.policy_name ? ` · ${request.policy_name}` : ""}
                  </span>
                </span>
                <span className="text-mono-caption">
                  <InFlightWait
                    startedAtMs={inFlightUpdatedAt - request.elapsed_ms}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 ? (
          <p className="px-3 pt-1 text-caption text-subtle">
            {formatNumber(hidden)} further{" "}
            {hidden === 1 ? "request is" : "requests are"} in flight beyond the{" "}
            {formatNumber(shown.length)} listed.
          </p>
        ) : null}
        <p className="px-3 pt-1 pb-2 text-caption text-subtle">
          Longest running first. Not narrowed by filters.
        </p>
      </div>
    </Popover>
  )
}
