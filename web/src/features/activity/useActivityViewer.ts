import { canManage, canManageWorkspace } from "@/features/organization/roles"
import {
  useOrganizationContext,
  useOrganizationMembers,
} from "@/shared/api/organizations"
import { useUsageScope } from "@/shared/api/usage"
import { useSelectedWorkspace } from "@/shared/hooks/SelectedWorkspace"
import { useSurfaces } from "@/shared/hooks/useDeployment"

/**
 * Who is reading the log, and so what the page offers them.
 *
 * - A member reads their own requests; the server narrows the log for them.
 * - A manager (an owner or admin of the organization) reads everyone's and
 *   can narrow to their own. The server decides this by organization role
 *   alone, so a workspace admin who is an organization member reads their own
 *   requests like any member; sharing a view is a workspace write, which that
 *   admin may still make.
 * - A deployment operator also watches in-flight requests, manages imported
 *   rows and sets model prices, which are deployment-wide writes.
 *
 * Every one of these is the client half of a check the server makes, so a
 * control that would be refused is not offered; none of them decides access.
 */
export function useActivityViewer() {
  const context = useOrganizationContext()
  const usageScope = useUsageScope()
  const { selected: workspace } = useSelectedWorkspace()
  const isOperator = usageScope.isDeploymentWide
  const isManager = isOperator || canManage(context.data)
  // Usage rows are attributed to the gateway's user id, which a member row
  // carries as `attribution_user_id`; the caller is found by their identity.
  const hasSurface = useSurfaces()
  const members = useOrganizationMembers(
    isManager && hasSurface("organizations"),
  )
  const callerId = context.data?.caller?.user_id
  const ownUserId =
    members.data?.find((member) => member.user_id === callerId)
      ?.attribution_user_id ?? undefined
  return {
    isOperator,
    isManager,
    canShareViews:
      isOperator || canManageWorkspace(context.data, workspace?.role),
    /** The id the caller's own requests carry, once the roster has answered. */
    ownUserId,
    /** Whether the roster that names it is still on its way. */
    isFindingOwnUserId: members.isPending && members.fetchStatus !== "idle",
    workspaceId: workspace?.workspace_id ?? "",
    workspaceName: workspace?.name ?? "",
  }
}
