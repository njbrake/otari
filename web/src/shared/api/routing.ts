import {
  useIsFetching,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type {
  AliasResponse,
  AutomaticFallbacksResponse,
  CreateAliasRequest,
  OrganizationPolicyFields,
  RouterStatus,
  RoutingPolicyResponse,
  RoutingTrafficResponse,
  SetRoutingPolicyRequest,
} from "@/client"
import { apiFetch } from "@/shared/api/client"
import { useDeploymentOperator } from "@/shared/api/organizations"
import {
  ALIASES,
  AUTOMATIC_FALLBACKS,
  CATALOG,
  MODELS,
  ROUTER_STATUS,
  ROUTING_POLICIES,
  ROUTING_TRAFFIC,
  workspaceMeta,
} from "@/shared/api/queryKeys"

// Which of the two routing surfaces this caller may read, the `useKeysScope`
// construction over the same pair of endpoints. `/routing/policies` and
// `/aliases` are deployment-wide and refuse anyone who does not operate the
// deployment; the `/organizations/me/*` two answer the same shapes for the
// caller's own organization (otari-ai#1942, otari-ai#1969). The bases are part
// of every query key they feed, so a demotion cannot serve the wider list from
// cache, and an errored context takes the wider one, as every operator gate
// does (`useDeploymentOperator`).
export function useRoutingScope(): {
  policies: string
  aliases: string
  isReady: boolean
} {
  const { isOperator: isDeploymentWide, isSettled } = useDeploymentOperator()
  return {
    policies: isDeploymentWide
      ? "/routing/policies"
      : "/organizations/me/routing-policies",
    aliases: isDeploymentWide ? "/aliases" : "/organizations/me/aliases",
    isReady: isSettled,
  }
}

function inWorkspace(base: string, workspaceId?: string): string {
  return workspaceId
    ? `${base}?workspace_id=${encodeURIComponent(workspaceId)}`
    : base
}

// The scope query a deployment-wide delete carries. Only a null or absent
// `userId` means workspace-wide, checked explicitly because "" is a legal user
// id and treating it as workspace-wide would delete the wrong row.
function deploymentScope(
  userId?: string | null,
  workspaceId?: string | null,
): string {
  const parts: string[] = []
  if (userId != null) parts.push(`user_id=${encodeURIComponent(userId)}`)
  if (workspaceId != null)
    parts.push(`workspace_id=${encodeURIComponent(workspaceId)}`)
  return parts.length === 0 ? "" : `?${parts.join("&")}`
}

// The workspace is part of the key, not just the request, so switching
// workspaces refetches rather than serving the previous one's rows. An unset id
// keeps the whole-scope view, which is what a caller who belongs to no
// workspace, and every read that wants the catalog rather than one workspace's
// management list, still wants.
export function useAliases(workspaceId?: string, enabled = true) {
  const scope = useRoutingScope()
  return useQuery({
    queryKey: [ALIASES, scope.aliases, workspaceId ?? null],
    meta: workspaceMeta(workspaceId),
    queryFn: () =>
      apiFetch<AliasResponse[]>(inWorkspace(scope.aliases, workspaceId)),
    staleTime: 60_000,
    enabled: scope.isReady && enabled,
  })
}

export function useRoutingPolicies(workspaceId?: string, enabled = true) {
  const scope = useRoutingScope()
  return useQuery({
    queryKey: [ROUTING_POLICIES, scope.policies, workspaceId ?? null],
    meta: workspaceMeta(workspaceId),
    queryFn: () =>
      apiFetch<RoutingPolicyResponse[]>(
        inWorkspace(scope.policies, workspaceId),
      ),
    staleTime: 60_000,
    enabled: scope.isReady && enabled,
  })
}

/** `api_key_id` repeated, the shape the routing reads take a key filter in. */
function keyParams(apiKeyIds: readonly string[]): string {
  const params = new URLSearchParams()
  for (const id of apiKeyIds) params.append("api_key_id", id)
  const query = params.toString()
  return query ? `?${query}` : ""
}

// The models the caller's organization used in the last 30 days, each with the
// offerings its catalog ID tries in order and the keys the caller may see that
// sent it. One endpoint for every caller: the server scopes the traffic to the
// workspaces the caller may see. `apiKeyIds` narrows to what those keys sent.
export function useAutomaticFallbacks(apiKeyIds: readonly string[] = []) {
  return useQuery({
    queryKey: [AUTOMATIC_FALLBACKS, apiKeyIds],
    queryFn: () =>
      apiFetch<AutomaticFallbacksResponse>(
        `/organizations/me/automatic-fallbacks${keyParams(apiKeyIds)}`,
      ),
    staleTime: 60_000,
  })
}

/**
 * Who sent each policy and alias name in the last 30 days and what each step of
 * its plan did, per workspace and person, among the requests the caller may see.
 */
export function useRoutingTraffic(
  workspaceId: string | undefined,
  apiKeyIds: readonly string[] = [],
  enabled = true,
) {
  return useQuery({
    queryKey: [ROUTING_TRAFFIC, workspaceId ?? null, apiKeyIds],
    queryFn: () => {
      const params = new URLSearchParams()
      if (workspaceId) params.set("workspace_id", workspaceId)
      for (const id of apiKeyIds) params.append("api_key_id", id)
      const query = params.toString()
      return apiFetch<RoutingTrafficResponse>(
        `/organizations/me/routing-policies/traffic${query ? `?${query}` : ""}`,
      )
    },
    staleTime: 60_000,
    enabled,
  })
}

// Whether a routing write or a refetch of the routing lists is in flight, so a
// form that writes a whole policy from the cached copy can wait for it.
export function useRoutingSyncing(): boolean {
  const writing =
    useIsMutating({ mutationKey: [ROUTING_POLICIES] }) +
    useIsMutating({ mutationKey: [ALIASES] })
  const refetching =
    useIsFetching({ queryKey: [ROUTING_POLICIES] }) +
    useIsFetching({ queryKey: [ALIASES] })
  return writing + refetching > 0
}

export function useSetRoutingPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [ROUTING_POLICIES],
    mutationFn: (body: SetRoutingPolicyRequest) =>
      apiFetch<RoutingPolicyResponse>("/routing/policies", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ROUTING_POLICIES] })
      // A policy is listed as a model, so the catalog changes too.
      void queryClient.invalidateQueries({ queryKey: [MODELS] })
      void queryClient.invalidateQueries({ queryKey: [CATALOG] })
    },
  })
}

export function useDeleteRoutingPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    // Scoped like an alias delete: the same name can exist globally and per user,
    // so a delete must say which. Only a null/absent userId means global, checked
    // explicitly because "" is a legal user id. The workspace travels too, or the
    // route falls back to the deployment's default one and deletes a row the page
    // is not showing.
    mutationFn: ({
      name,
      userId,
      workspaceId,
    }: {
      name: string
      userId?: string | null
      workspaceId?: string | null
    }) =>
      apiFetch<void>(
        `/routing/policies/${encodeURIComponent(name)}${deploymentScope(userId, workspaceId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ROUTING_POLICIES] })
      void queryClient.invalidateQueries({ queryKey: [MODELS] })
      void queryClient.invalidateQueries({ queryKey: [CATALOG] })
    },
  })
}

/**
 * The four tenant-scoped writers behind the Build pages' Edit for admins.
 *
 * Each is its operator sibling above with one difference the server insists on:
 * the workspace is named rather than defaulted, because the deployment's default
 * workspace is not the caller's organization's to write into (otari-ai#1969).
 * `user_id` is never sent: a policy that is one member's own names them by
 * `member_id` instead, and aliases are workspace-wide.
 *
 * Both list keys carry their surface and their workspace as trailing segments,
 * so invalidating the head of each covers whichever one this caller is reading.
 */
function invalidateRoutingLists(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  void queryClient.invalidateQueries({ queryKey: [ROUTING_POLICIES] })
  void queryClient.invalidateQueries({ queryKey: [ALIASES] })
  // A policy and an alias are both listed as models, so the catalog changes too.
  void queryClient.invalidateQueries({ queryKey: [MODELS] })
  void queryClient.invalidateQueries({ queryKey: [CATALOG] })
}

export function useSetOrganizationRoutingPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [ROUTING_POLICIES],
    mutationFn: (
      body: SetRoutingPolicyRequest & {
        workspace_id: string
      } & Partial<OrganizationPolicyFields>,
    ) =>
      apiFetch<RoutingPolicyResponse>("/organizations/me/routing-policies", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateRoutingLists(queryClient),
  })
}

export function useDeleteOrganizationRoutingPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      name,
      workspaceId,
      memberId,
    }: {
      name: string
      workspaceId: string
      // A member's own row lists its identity id as `user_id`. Without it the
      // delete is workspace-wide and would take the shared policy of that name.
      memberId?: string
    }) => {
      const params = new URLSearchParams({ workspace_id: workspaceId })
      if (memberId) params.set("member_id", memberId)
      return apiFetch<void>(
        `/organizations/me/routing-policies/${encodeURIComponent(name)}?${params}`,
        { method: "DELETE" },
      )
    },
    onSuccess: () => invalidateRoutingLists(queryClient),
  })
}

/** Make the caller's own version of a shared policy: the same name and spec, applying only to them. */
export function useCopyOrganizationRoutingPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [ROUTING_POLICIES],
    mutationFn: (body: { name: string; workspace_id: string }) =>
      apiFetch<RoutingPolicyResponse>(
        "/organizations/me/routing-policies/copy",
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => invalidateRoutingLists(queryClient),
  })
}

export function useCreateOrganizationAlias() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [ALIASES],
    mutationFn: (body: CreateAliasRequest & { workspace_id: string }) =>
      apiFetch<AliasResponse>("/organizations/me/aliases", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateRoutingLists(queryClient),
  })
}

export function useDeleteOrganizationAlias() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      name,
      workspaceId,
    }: {
      name: string
      workspaceId: string
    }) =>
      apiFetch<void>(
        `/organizations/me/aliases/${encodeURIComponent(name)}?workspace_id=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => invalidateRoutingLists(queryClient),
  })
}

// --- Learned routing ------------------------------------------------------

/** How warm a user's routing memory is.
 *
 *  Keyed by user because warmth is per user: the records hold that user's
 *  prompts, so a global learned policy warms once per caller. Disabled until a
 *  user is chosen rather than defaulting to one, because "whose memory" has no
 *  sensible default.
 */
export function useRouterStatus(userId: string | null) {
  return useQuery({
    queryKey: [ROUTER_STATUS, userId],
    queryFn: () =>
      apiFetch<RouterStatus>(
        `/routing/status?user_id=${encodeURIComponent(userId ?? "")}`,
      ),
    enabled: userId !== null && userId !== "",
    staleTime: 30_000,
  })
}

export function useCreateAlias() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [ALIASES],
    mutationFn: (body: CreateAliasRequest) =>
      apiFetch<AliasResponse>("/aliases", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ALIASES] })
      // An alias is listed as a model, so the catalog changes too.
      void queryClient.invalidateQueries({ queryKey: [MODELS] })
      void queryClient.invalidateQueries({ queryKey: [CATALOG] })
    },
  })
}

export function useDeleteAlias() {
  const queryClient = useQueryClient()
  return useMutation({
    // Scoped: the same name can exist globally and per user, so deleting one
    // must name which. Only a null/absent userId means global; the check is
    // explicit rather than truthy because "" is a legal user id, and treating it
    // as global would delete the wrong row.
    mutationFn: ({
      name,
      userId,
      workspaceId,
    }: {
      name: string
      userId?: string | null
      workspaceId?: string | null
    }) =>
      apiFetch<void>(
        `/aliases/${encodeURIComponent(name)}${deploymentScope(userId, workspaceId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ALIASES] })
      void queryClient.invalidateQueries({ queryKey: [MODELS] })
      void queryClient.invalidateQueries({ queryKey: [CATALOG] })
    },
  })
}

// `enabled` is the `useToolSettings` composition: the read is
// deployment-operator-only, so a tenant-facing page declines to ask.
