import { useQuery } from "@tanstack/react-query"
import { LIVE_CLOCK } from "@/shared/api/queryKeys"

/**
 * A reading of the clock, taken again every `intervalMs` while `isPolling`, and
 * on a return to the tab once it is that old. Undefined while disabled.
 *
 * Here rather than beside the page because it is a query, and this is where
 * queries and their keys live. Activity anchors its rolling windows to it, so
 * each new reading brings them up to now and every query keyed on them reads
 * again, once. A rolling window polled in place would keep its first start and
 * grow: an hour left open live would show two.
 *
 * Each mount takes its first reading rather than fetching one, so it reads each
 * window once, not once and again when the clock answers.
 */
export function useLiveClock(
  enabled: boolean,
  intervalMs: number,
  { isPolling = true }: { isPolling?: boolean } = {},
): number | undefined {
  const clock = useQuery({
    queryKey: [LIVE_CLOCK, intervalMs, isPolling],
    queryFn: () => Date.now(),
    initialData: () => Date.now(),
    enabled,
    staleTime: intervalMs,
    // A reading is only good to the page anchored to it, so none outlives it.
    gcTime: 0,
    refetchInterval: isPolling ? intervalMs : false,
    refetchOnWindowFocus: true,
  })
  return enabled ? clock.data : undefined
}
