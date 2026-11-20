import type { KeyRequests, NameTraffic, StepOutcome } from "@/client"
import type { RoutingRow } from "@/features/routing/policyModel"

/** A row's share of the traffic: how many requests it served, which keys sent them, and each step's outcome. */
export interface RowTraffic {
  requests: number
  /** Busiest first. */
  sentBy: KeyRequests[]
  /**
   * What each target did in each role, by earliest place tried. By target
   * rather than by place: a router ranks its pool per request and the compiler
   * drops candidates a key may not reach, so one place names different targets.
   */
  steps: StepOutcome[]
}

/** Within one place, the order a plan reaches roles in: a pick, then the default, then a backup. */
const ROLE_ORDER: Record<StepOutcome["role"], number> = {
  routed: 0,
  condition: 1,
  default: 2,
  catalog: 3,
  on_failure: 4,
  other: 5,
}

/** The names a key filter leaves: those any of the filtered traffic was sent under. */
export function namesSent(traffic: readonly NameTraffic[]): Set<string> {
  return new Set(
    traffic.filter((entry) => entry.requests > 0).map((entry) => entry.name),
  )
}

/** A key's name for a cell or an option, or a stand-in for one with none. */
export function keyRequestLabel(key: KeyRequests): string {
  return key.key_name ?? `Key ${key.api_key_id.slice(0, 8)}`
}

/**
 * The traffic one row of the routing list served. A stored row takes its own
 * workspace's traffic; a config-file row, in force in every workspace, takes
 * any workspace's under its name. Aliases are not recorded on usage rows, so an
 * alias row has none.
 */
export function trafficForRow(
  row: RoutingRow,
  traffic: readonly NameTraffic[],
): RowTraffic {
  const workspace = row.workspace_id ?? undefined
  const entries =
    row.kind === "alias"
      ? []
      : traffic.filter(
          (entry) =>
            entry.name === row.name &&
            (workspace === undefined || entry.workspace_id === workspace),
        )
  const keys = new Map<string, KeyRequests>()
  const steps = new Map<string, StepOutcome>()
  for (const entry of entries) {
    for (const key of entry.sent_by) {
      const sum = keys.get(key.api_key_id)
      keys.set(key.api_key_id, {
        ...key,
        requests: (sum?.requests ?? 0) + key.requests,
      })
    }
    for (const step of entry.steps) {
      const id = `${step.role}\u0000${step.router ?? ""}\u0000${step.target}`
      const sum = steps.get(id)
      steps.set(
        id,
        sum
          ? {
              ...sum,
              position: Math.min(sum.position, step.position),
              served: sum.served + step.served,
              failed: sum.failed + step.failed,
            }
          : step,
      )
    }
  }
  return {
    requests: entries.reduce((total, entry) => total + entry.requests, 0),
    sentBy: [...keys.values()].sort(
      (a, b) =>
        b.requests - a.requests || a.api_key_id.localeCompare(b.api_key_id),
    ),
    steps: [...steps.values()].sort(
      (a, b) =>
        a.position - b.position ||
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        a.target.localeCompare(b.target),
    ),
  }
}
