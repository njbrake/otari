import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useSyncExternalStore } from "react"
import type {
  DashboardBuild,
  DeploymentAdminAccess,
  DeploymentUser,
  DeploymentUserPassword,
  GatewayHealth,
  UpdateDeploymentUserRequest,
} from "@/client"
import {
  ApiError,
  apiFetch,
  DASHBOARD_BUILD_PATH,
  siteFetch,
} from "@/shared/api/client"
import { fetchAllPaged } from "@/shared/api/paging"
import {
  BUILD,
  BUILD_POLL_MS,
  DEPLOYMENT_ADMIN,
  GATEWAY_LIVENESS,
  GATEWAY_LIVENESS_RECHECK_MS,
  HEALTH,
  HEALTH_POLL_MS,
  NO_RETRY,
  ORGANIZATION_MEMBERS,
} from "@/shared/api/queryKeys"

export function useDashboardBuild() {
  return useQuery({
    queryKey: [BUILD],
    // `siteFetch`, not `apiFetch`: the gateway serves this beside the dashboard
    // at its own root rather than under `API_ROOT`, so the helper that prepends
    // the root asks for a path nothing mounts.
    queryFn: () => siteFetch<DashboardBuild>(DASHBOARD_BUILD_PATH),
    refetchInterval: BUILD_POLL_MS,
    // A tab left open in the background is the one most likely to be stale, so
    // check again the moment someone comes back to it.
    refetchOnWindowFocus: true,
    staleTime: 0,
    // A failed check is not worth reporting: the tab keeps working, and the next
    // poll retries anyway.
    retry: false,
  })
}

/**
 * Whether this gateway is answering, and whether it can reach its control plane.
 *
 * `/health` is public and served in both modes, which is what makes it the one
 * read a hybrid gateway's landing page can make: it hosts no management API, so
 * every other endpoint the dashboard knows is a 404 there. A failure is the
 * answer here rather than an error to retry past, so the page can say the
 * gateway is not responding on the first attempt instead of ~three requests
 * later.
 */
export function useGatewayHealth() {
  return useQuery({
    ...NO_RETRY,
    queryKey: [HEALTH],
    queryFn: () => apiFetch<GatewayHealth>("/health"),
    refetchInterval: HEALTH_POLL_MS,
    // A tab left open in the background holds the stalest answer of all, so ask
    // again the moment someone looks at it.
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
}

// apiFetch normalizes an unreachable gateway to ApiError status 0 ("Network
// error: could not reach the gateway."). A 401/403 is a different failure: the
// backend answered, it just rejected the key, and that already bounces to
// sign-in, so it is not "can't connect".
function isUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0
}

// When the newest query that failed to reach the gateway failed, or 0 when none
// is currently in that state. Scanning the whole cache keeps the answer the same
// wherever the operator is standing. A failure left on a page they navigated
// away from stays in the cache until it is collected, which is why this is only
// a suspicion for the probe to settle rather than the answer itself.
//
// The cache is an external store and is read as one. Subscribing in an effect
// and calling `setState` from the listener does not hold here: the cache emits
// synchronously when an observer is created, and an observer is created when a
// component calls `useQuery` during its render, so the listener runs inside
// another component's render pass. React calls that a bad `setState` in render.
// `useSyncExternalStore` is the primitive for this shape, and React owns the
// timing, so the same notification arrives safely.
function useUnreachableSince(): number {
  const queryClient = useQueryClient()

  // `useSyncExternalStore` identity-checks `subscribe` and re-subscribes when it
  // changes, so this is held stable rather than rebuilt every render. That is
  // the "a reference something else identity-checks" case performance.md keeps,
  // not memoization by reflex.
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  )

  // Runs on every notification and more than once per render, so it stays a
  // scan that returns a number. React compares snapshots with `Object.is`, so
  // returning anything carrying an identity of its own would loop. The probe's
  // own failures are left out: they are the verdict, not a new suspicion.
  const getSnapshot = useCallback(
    () =>
      queryClient
        .getQueryCache()
        .getAll()
        .reduce(
          (newest, query) =>
            query.queryKey[0] !== GATEWAY_LIVENESS &&
            query.state.status === "error" &&
            isUnreachable(query.state.error)
              ? Math.max(newest, query.state.errorUpdatedAt)
              : newest,
          0,
        ),
    [queryClient],
  )

  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * True once a request has failed to reach the gateway and a liveness probe,
 * retries included, has failed too. Clears when the probe next succeeds.
 *
 * One request failing at the network layer is not evidence the gateway is down:
 * a laptop waking from sleep, a Wi-Fi or VPN change, or an edge proxy dropping a
 * pooled connection each fail a single fetch against a healthy backend, and the
 * build poll every page runs does not retry. So a failed query only starts the
 * probe, and the probe's answer is the verdict. The liveness route does no I/O,
 * so it answers whenever the process does.
 *
 * The probe runs when the newest unreachable failure is newer than its own last
 * success, and keeps re-asking for as long as it fails. It retries before
 * settling on an error (the delay is the client's default), and it runs whatever
 * the browser believes about being online, because an offline browser cannot
 * reach the gateway either and the answer should say so. Each attempt has a
 * short deadline of its own rather than `apiFetch`'s 30s: the route does no
 * I/O, so a gateway that has not answered it in a few seconds is not answering,
 * and three full-length attempts would hold the alarm back for a minute and a
 * half while every page spins.
 *
 * "Down" is read from the timestamps, not `status`: a query that has never held
 * data goes back to `pending` on every refetch, so `isError` would drop the
 * banner for the length of each recheck while the gateway is still down.
 */
const GATEWAY_LIVENESS_TIMEOUT_MS = 5_000

export function useGatewayUnreachable(): boolean {
  const unreachableSince = useUnreachableSince()
  const liveness = useQuery({
    queryKey: [GATEWAY_LIVENESS],
    queryFn: () =>
      apiFetch<string>("/health/liveness", {
        signal: AbortSignal.timeout(GATEWAY_LIVENESS_TIMEOUT_MS),
      }),
    enabled: (query) =>
      isDown(query.state) || unreachableSince > query.state.dataUpdatedAt,
    retry: 2,
    networkMode: "always",
    refetchInterval: (query) =>
      isDown(query.state) ? GATEWAY_LIVENESS_RECHECK_MS : false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
  return isDown(liveness)
}

function isDown(state: {
  errorUpdatedAt: number
  dataUpdatedAt: number
}): boolean {
  return state.errorUpdatedAt > state.dataUpdatedAt
}

// Every model the configured credentials can reach, per provider. Distinct from
// useModels: that is the catalog served to API callers (curated by
// model_discovery, aliases listed, targets withheld), while this is what an
// operator could pick from. A provider that failed is reported rather than
// dropped, so the picker can say why a list is empty.
//
// Live provider calls, cached gateway-side; kept fresh for the length of a
// session rather than refetched per open, since the set of models a key can
// reach does not move minute to minute.
//
// `enabled` is the `useToolSettings` composition: the read is
// deployment-operator-only, so a tenant-facing page declines to ask.

// ---------------------------------------------------------------------------
// Deployment administration
//
// The one management surface scoped to the deployment rather than to an
// organization. `useDeploymentAdminAccess` is its gate, which is why it answers
// 200 with a boolean where the rest of the prefix refuses a non-operator with
// 404: a gate cannot be built on a failed request, and hiding a destination
// grants nothing either way.
//
// Read by the deployment accounts page alone, to word its own refusal, and it
// holds that decision until this lands. Nothing else asks: the rail and the
// Overview index need the answer before their first paint, so they take
// `deployment_operator` off the organization context, which is the same
// server-side predicate on a read the shell already makes (otari#836).
// ---------------------------------------------------------------------------

export function useDeploymentAdminAccess() {
  return useQuery({
    queryKey: [DEPLOYMENT_ADMIN, "access"],
    queryFn: () =>
      apiFetch<DeploymentAdminAccess>("/admin/access").then(
        (body) => body.granted,
      ),
    staleTime: 60_000,
    // No `enabled` parameter: the one caller sits behind a route declaring
    // `surface: "admin"`, so a deployment that does not host `/admin` never
    // renders it and the 404 never becomes a second reading of `surfaces`.
    // Deliberately not inferred from a 404 here either, which is the scattered
    // mode check the surface axis replaced; the ordinary retry policy applies,
    // and a failure is a failure.
  })
}

export function useDeploymentUsers(enabled = true) {
  return useQuery({
    queryKey: [DEPLOYMENT_ADMIN, "users"],
    queryFn: () => fetchAllPaged<DeploymentUser>("/admin/users"),
    staleTime: 60_000,
    enabled,
  })
}

export function useUpdateDeploymentUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string
      body: UpdateDeploymentUserRequest
    }) =>
      apiFetch<DeploymentUser>(`/admin/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [DEPLOYMENT_ADMIN] })
      // Deactivating an account ends its sessions and changes what the
      // organization roster may offer it, so the tenancy reads go stale with it.
      void queryClient.invalidateQueries({ queryKey: [ORGANIZATION_MEMBERS] })
    },
  })
}

export function useGenerateDeploymentUserPassword() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<DeploymentUserPassword>(
        `/admin/users/${encodeURIComponent(id)}/password`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [DEPLOYMENT_ADMIN] })
    },
  })
}
