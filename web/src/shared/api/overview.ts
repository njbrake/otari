import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { OverviewSummary } from "@/client"
import { apiFetch, heavyReadSignal } from "@/shared/api/client"
import { OVERVIEW } from "@/shared/api/queryKeys"
import { HEAVY_READ } from "@/shared/api/usage"

export type OverviewScope = OverviewSummary["scope"]

/**
 * The overview's server-judged parts in one read: the counts, the budget
 * strips, what needs attention and the limits beside them, for one scope and
 * one calendar month.
 *
 * `budgets` and `ceilings` are null where the caller may not see them, which
 * is not the same as nothing in them. `scope` in the answer is the scope the
 * server read, which falls back to `you` where the one asked for is not the
 * caller's to read.
 */
export function useOverviewSummary({
  workspaceId,
  month,
  scope,
}: {
  workspaceId?: string
  month: string
  scope: OverviewScope
}) {
  return useQuery({
    queryKey: [OVERVIEW, workspaceId ?? null, month, scope],
    // Its month aggregate waits its turn with the Usage page's reads.
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ month, scope })
      if (workspaceId) params.set("workspace_id", workspaceId)
      return apiFetch<OverviewSummary>(`/overview?${params}`, {
        signal: heavyReadSignal(signal),
      })
    },
    staleTime: 60_000,
    ...HEAVY_READ,
    // The last answer stays up while another scope or month loads, so the
    // attention line, the rail and the budget do not drop out and back.
    placeholderData: (previous) => previous,
  })
}

/**
 * Ask for every overview answer again. For a reading that changed underneath
 * it without a write here, such as the provider check the attention list reads
 * from the gateway's cache.
 */
export function useRefreshOverview() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: [OVERVIEW] })
}
