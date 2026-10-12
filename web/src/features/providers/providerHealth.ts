import type { ProviderHealth } from "@/client"

// A repeated column's words, in their own casing. The uppercase these carried
// was emphasis applied to every row alike, including the reachable ones, which
// is the state a column watching for failures wants to draw the eye to least.
// Same treatment, and same reasoning, as Activity's status column.
export const HEALTH_LABELS = {
  ok: "Reachable",
  degraded: "No model discovery",
  unreachable: "Unreachable",
} as const

/**
 * Which of the three a provider's last check says it is. One that answers but
 * lists no models is degraded rather than unreachable: only discovery is
 * broken, and it may still serve requests.
 */
export function healthState(
  health: Pick<ProviderHealth, "ok" | "discovery_unsupported">,
): keyof typeof HEALTH_LABELS {
  if (health.ok) return "ok"
  return health.discovery_unsupported ? "degraded" : "unreachable"
}
