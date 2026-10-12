import { useEffect, useRef } from "react"
import { useRefreshOverview } from "@/shared/api/overview"
import { useProviderHealth } from "@/shared/api/providers"
import { ProvidersPanel } from "./ProvidersPanel"

/**
 * Provider health, read only where the reader operates the deployment. The
 * attention list reads the same check from the gateway's cache, which a fresh
 * gateway fills only once this read runs, so a disagreement asks for the
 * overview again.
 */
export function OperatorProviders({
  reportedDown,
}: {
  /** The providers the overview's attention list names as unreachable. */
  reportedDown: string[] | undefined
}) {
  const health = useProviderHealth()
  const refreshOverview = useRefreshOverview()
  const down = health.data?.providers
    .filter((provider) => !provider.ok && !provider.discovery_unsupported)
    .map((provider) => provider.instance)
    .sort()
    .join()
  const reported = reportedDown?.toSorted().join()
  // Once per check result, so a lasting disagreement cannot loop.
  const askedFor = useRef<string>(undefined)
  useEffect(() => {
    if (down === undefined || reported === undefined || down === reported)
      return
    if (askedFor.current === down) return
    askedFor.current = down
    void refreshOverview()
  }, [down, reported, refreshOverview])
  return (
    <ProvidersPanel
      providers={health.data?.providers}
      isError={health.isError}
    />
  )
}
