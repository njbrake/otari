import type { NameTraffic, StepOutcome } from "@/client"
import { SettingsGroup } from "@/design-system/layout/SettingsGroup"
import { formatCount } from "@/shared/helpers/format"
import { SentByCell, selectorText } from "./PolicyCells"
import type { RoutingRow } from "./policyModel"
import { trafficForRow } from "./routingTraffic"

/**
 * Why the plan tried a target, in the words the policy's own sections use.
 * A backup is numbered by its place in the policy's chain where it is still
 * there; one since removed from the chain is a backup alone.
 */
export function roleLabel(step: StepOutcome, row: RoutingRow): string {
  // An alias is sent to its one target as written, with no plan to give it a role.
  if (row.kind === "alias") return "Alias target"
  switch (step.role) {
    case "routed":
      return step.router ? `Routed pick (${step.router})` : "Routed pick"
    case "default":
      return "Main model"
    case "condition":
      return "Tier-down"
    case "catalog":
      return "Catalog offering"
    case "on_failure": {
      const index = (row.spec.on_failure ?? []).indexOf(step.target)
      return index < 0 ? "Backup" : `Backup ${index + 1}`
    }
    default:
      return "Other"
  }
}

/**
 * Whether the place a target was first tried says something: in a plan with
 * no router and no `when` entry every request tries the same targets in the
 * same order, so place 2 is the first backup. A router ranks its pool per
 * request and any `when` entry (a budget, a key or a user) swaps the head for
 * some requests, so there it would mislead.
 */
function isFixedOrder(row: RoutingRow): boolean {
  return row.spec.select.every(
    (entry) => entry.router === undefined && entry.when === undefined,
  )
}

/**
 * A policy's or an alias's last 30 days: how many requests it took, which keys sent them,
 * and what each target did, served or failed and handed on, by the role the
 * plan gave it. Grouped by what served rather than by place in the plan,
 * because a place names different targets from request to request.
 */
export function PolicyTraffic({
  row,
  traffic,
  isPending,
}: {
  row: RoutingRow
  traffic: readonly NameTraffic[]
  isPending: boolean
}) {
  const summary = trafficForRow(row, traffic)
  const showsOrder = isFixedOrder(row)
  return (
    <SettingsGroup title="Last 30 days">
      {isPending ? (
        <p className="text-caption">
          Reading this {row.kind === "alias" ? "alias" : "policy"}’s traffic…
        </p>
      ) : summary.requests === 0 ? (
        <p className="text-caption">No requests sent under this name.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1 text-sm">
            <dt className="text-subtle">Requests</dt>
            <dd className="tabular-nums">{formatCount(summary.requests)}</dd>
            <dt className="text-subtle">Sent by</dt>
            <dd>
              <SentByCell sentBy={summary.sentBy} />
            </dd>
          </dl>
          <table className="text-sm">
            <caption className="sr-only">What each target did</caption>
            <thead>
              <tr className="text-left text-overline">
                {showsOrder ? (
                  <th scope="col" className="py-1 pr-4 font-normal">
                    Tried
                  </th>
                ) : null}
                <th scope="col" className="py-1 pr-6 font-normal">
                  Target
                </th>
                <th scope="col" className="py-1 pr-6 font-normal">
                  Role
                </th>
                <th scope="col" className="py-1 pr-6 text-right font-normal">
                  Served
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  Failed
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.steps.map((step) => (
                <tr
                  key={`${step.role}:${step.router ?? ""}:${step.target}`}
                  className="border-t border-border-subtle"
                >
                  {showsOrder ? (
                    <td className="py-1.5 pr-4 tabular-nums text-muted">
                      {step.position}
                    </td>
                  ) : null}
                  <td
                    className="py-1.5 pr-6 text-foreground"
                    title={step.target}
                  >
                    {selectorText(step.target)}
                  </td>
                  <td className="py-1.5 pr-6 text-muted">
                    {roleLabel(step, row)}
                  </td>
                  <td className="py-1.5 pr-6 text-right tabular-nums text-muted">
                    {formatCount(step.served)}
                  </td>
                  <td
                    className={`py-1.5 text-right tabular-nums ${step.failed > 0 ? "text-warning" : "text-muted"}`}
                  >
                    {formatCount(step.failed)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsGroup>
  )
}
