import {
  useDeleteAlias,
  useDeleteOrganizationAlias,
  useDeleteOrganizationRoutingPolicy,
  useDeleteRoutingPolicy,
} from "@/shared/api/routing"

import type { RoutingRow } from "./policyModel"

/**
 * Delete a stored policy or alias through whichever of the four surfaces it
 * belongs to: the deployment-wide pair for an operator, the tenant pair for
 * anyone else, which names a member's own policy by `member_id`.
 */
export function usePolicyDelete({
  isOperator,
  fallbackWorkspaceId,
}: {
  isOperator: boolean
  /** Where a row with no workspace of its own lives: the selected one. */
  fallbackWorkspaceId: string | null
}) {
  const deletePolicy = useDeleteRoutingPolicy()
  const deleteAlias = useDeleteAlias()
  const deleteOrgPolicy = useDeleteOrganizationRoutingPolicy()
  const deleteOrgAlias = useDeleteOrganizationAlias()

  const mutationFor = (row: RoutingRow) =>
    isOperator
      ? row.kind === "alias"
        ? deleteAlias
        : deletePolicy
      : row.kind === "alias"
        ? deleteOrgAlias
        : deleteOrgPolicy

  const remove = (row: RoutingRow, onSuccess: () => void) => {
    // The row's own workspace, so a list refetched mid-switch cannot aim the
    // delete at another workspace's row of the same name.
    const workspaceId = row.workspace_id ?? fallbackWorkspaceId
    if (isOperator) {
      const scope = { name: row.name, userId: row.user_id, workspaceId }
      if (row.kind === "alias") deleteAlias.mutate(scope, { onSuccess })
      else deletePolicy.mutate(scope, { onSuccess })
      return
    }
    // Unreachable: a tenant caller deletes only stored rows, which carry a workspace.
    if (workspaceId === null) return
    const scoped = { name: row.name, workspaceId }
    if (row.kind === "alias") deleteOrgAlias.mutate(scoped, { onSuccess })
    else
      deleteOrgPolicy.mutate(
        { ...scoped, memberId: row.user_id ?? undefined },
        { onSuccess },
      )
  }

  return {
    /** The one mutation a row's delete goes through, for its pending and error state. */
    mutationFor,
    remove,
    /** Clear every refusal, so the next confirm does not open on the last one's. */
    reset: () => {
      deletePolicy.reset()
      deleteAlias.reset()
      deleteOrgPolicy.reset()
      deleteOrgAlias.reset()
    },
  }
}
