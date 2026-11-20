import { useRefreshUsageReads } from "@/shared/api/usage"

/**
 * Home's Refresh: moves the page clock on, so every window ends now, and reads
 * the page's usage, sessions and limits again.
 */
export function useHomeRefresh(refreshClock: () => void): {
  refresh: () => void
  isFetching: boolean
} {
  const reads = useRefreshUsageReads()
  return {
    isFetching: reads.isFetching,
    refresh: () => {
      refreshClock()
      reads.refresh()
    },
  }
}
