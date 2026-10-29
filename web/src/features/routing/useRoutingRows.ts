import { useCallback, useMemo } from "react"

import { canManage } from "@/features/organization/roles"
import {
  useDeploymentOperator,
  useOrganizationContext,
} from "@/shared/api/organizations"
import { useAliases, useRoutingPolicies } from "@/shared/api/routing"
import { useWorkspaceVisibility } from "@/shared/api/workspaces"
import { useSelectedWorkspace } from "@/shared/hooks/SelectedWorkspace"

import { aliasAsRow, type RoutingRow } from "./policyModel"

/**
 * The policies and aliases in force in the selected workspace, and what the
 * caller may do with them, for the list and for a policy's own page.
 *
 * Resolution is workspace-keyed, so a stored policy belongs on its
 * workspace's page. Which surface answers depends on who is signed in: an
 * operator reads the deployment-wide pair, anyone else the tenant-scoped one.
 * Config-file entries have no workspace and are listed in every one.
 */
export function useRoutingRows() {
  const organization = useOrganizationContext()
  const { isOperator, isSettled: isContextSettled } = useDeploymentOperator()
  // Null only for a caller in no workspace, who has nowhere to write.
  const { selected, isLoading: isWorkspaceLoading } = useSelectedWorkspace()
  const workspaceId = selected?.workspace_id
  // Held until the switcher has resolved, not just the context: a page that
  // mounts between the two reads the context first, and would ask for every
  // workspace's rows before its own.
  const isWorkspaceSettled = !isWorkspaceLoading
  const policies = useRoutingPolicies(workspaceId, isWorkspaceSettled)
  const aliases = useAliases(workspaceId, isWorkspaceSettled)
  // Where a create lands. A write to an existing row uses the row's own
  // workspace instead, so a list refetched mid-switch cannot move a row.
  const writeWorkspaceId = workspaceId ?? null
  // Owners and admins (and operators) manage every row; a member, their own.
  const manages = isOperator || canManage(organization.data)
  const canEdit = isOperator || (manages && writeWorkspaceId !== null)
  // The identity id a member's own rows carry on the tenant surface.
  const ownerId = isOperator ? "" : (organization.data?.caller?.user_id ?? "")
  const visibility = useWorkspaceVisibility(workspaceId ?? "", {
    enabled: !manages,
  })
  // Whether a member may add a policy of their own here. Their existing ones
  // stay editable when the workspace turns this off.
  const canCreateOwn =
    !manages &&
    writeWorkspaceId !== null &&
    visibility.data?.members_create_policies === true
  // Stable, since the list's columns are memoized on them for DataTable.
  const isOwn = useCallback(
    (row: RoutingRow) => ownerId !== "" && row.user_id === ownerId,
    [ownerId],
  )
  const canEditRow = useCallback(
    (row: RoutingRow) =>
      row.source !== "config" && (canEdit || (isOwn(row) && !manages)),
    [canEdit, isOwn, manages],
  )

  // Listed together: an alias is the one-target case of a policy. Memoized
  // because the list's columns are, and they read every row.
  const rows = useMemo<RoutingRow[]>(
    () =>
      [
        ...(policies.data ?? []).map((policy) => ({
          ...policy,
          kind: "policy" as const,
        })),
        ...(aliases.data ?? []).map(aliasAsRow),
      ].sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          (a.user_id ?? "").localeCompare(b.user_id ?? ""),
      ),
    [policies.data, aliases.data],
  )

  return {
    rows,
    // Until the context settles neither list has been asked, and an empty
    // table would read as "no policies" rather than "not yet".
    isLoading:
      !isContextSettled ||
      !isWorkspaceSettled ||
      policies.isLoading ||
      aliases.isLoading,
    // A row missing from a list being refetched may be one just renamed into it.
    isFetching: policies.isFetching || aliases.isFetching,
    error: policies.error ?? aliases.error,
    isOperator,
    canEdit,
    manages,
    ownerId,
    isOwn,
    canEditRow,
    canCreateOwn,
    writeWorkspaceId,
    isWorkspaceSettled,
  }
}
