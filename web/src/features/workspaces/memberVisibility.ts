import type { SummaryDimension, WorkspaceVisibility } from "@/client"
import type { UsageScopeKey } from "@/features/usage/usageQuery"
import type { TotalsScope } from "@/shared/api/usage"

/**
 * What a member who does not manage a workspace may read of it, as its
 * managers' visibility settings decide. The one place the dashboard derives
 * that: Overview and Usage read `readMemberReach` and nothing else, so a setting
 * added to the workspace's visibility widens a member's reach here alone.
 *
 * The server is the authority (`WorkspaceReader` in
 * `src/gateway/services/organizations/_visibility.py`); this is its client
 * half, which keeps the page from offering what the server would refuse.
 */

/**
 * The breakdowns a member may split a workspace's shared totals by: none that
 * names a person, key or session. Mirrors the server's
 * `MEMBER_TOTALS_DIMENSIONS`.
 */
export const MEMBER_TOTALS_DIMENSIONS: readonly SummaryDimension[] = [
  "model",
  "provider",
  "status_code",
]

/**
 * The filters (query parameter names) a member may narrow a workspace's shared
 * totals by: the window, and what was asked of which model where. Mirrors the server's
 * `MEMBER_TOTALS_FILTERS`, an allowlist, so a filter added later is refused
 * until it is judged.
 */
export const MEMBER_TOTALS_FILTERS: ReadonlySet<string> = new Set([
  "start_date",
  "end_date",
  "workspace_id",
  "status",
  "exclude_status",
  "status_code",
  "model",
  "exclude_model",
  "requested_model",
  "provider",
  "endpoint",
  "priced",
  "counts_toward_budget",
])

/**
 * What the page knows of the workspace's settings: an answer about the
 * workspace on screen, one still on its way, or none to be had (the read
 * failed, or no workspace is named), which reads as hidden.
 */
export type MemberTotalsVisibility =
  | { status: "known"; visibility: WorkspaceVisibility }
  | { status: "pending" }
  | { status: "unavailable" }

/**
 * The state of a read of the setting, as the page has it. A failed read wins
 * over an answer cached earlier, so a page that cannot confirm the setting
 * reads as hidden rather than trusting a stale "shared".
 */
export function readMemberTotalsVisibility({
  data,
  isError,
}: {
  data: WorkspaceVisibility | undefined
  isError: boolean
}): MemberTotalsVisibility {
  if (isError) return { status: "unavailable" }
  return data ? { status: "known", visibility: data } : { status: "pending" }
}

export interface ReachViewer {
  /** Manages the workspace, or operates the deployment: reads everything. */
  isManager: boolean
  canReadOrganization: boolean
  ownUserId: string | undefined
  isFindingOwnUserId: boolean
  /** The workspace on screen, "" while none is. */
  workspaceId: string
}

export interface MemberReach {
  /**
   * The scopes the switch offers, in its order. A member reads their own
   * usage, and the workspace's totals too while its managers share them. A
   * manager whose own requests cannot be told apart reads the workspace only;
   * while the roster that would tell them apart loads, You stays offered.
   */
  scopes: UsageScopeKey[]
  /** A member's answer about the workspace on screen is still on its way. */
  isPending: boolean
  /** The workspace's managers keep its totals from this member: an answer, not a failure. */
  isHiddenByAdmin: boolean
  /** May read the workspace's aggregate figures. */
  canReadWorkspaceTotals: boolean
  /** Reads of the workspace as a whole go as a member's ask for its totals (`workspace_totals`). */
  isReadingWorkspaceTotals: boolean
  /** Reads the workspace budget in dollars, not only as a share of its cap. */
  showsSpend: boolean
  /** The splits an ask for the workspace's totals may make. */
  totalsDimensions: readonly SummaryDimension[]
  /** The filters an ask for the workspace's totals may carry. */
  totalsFilters: ReadonlySet<string>
  /** Activity can list the requests the Workspace scope counts: it shows a member only their own. */
  canOpenWorkspaceActivity: boolean
  /** The Workspace scope lists the workspace's keys, which for a member are other people's. */
  canListWorkspaceKeys: boolean
  /** The failures listed at Workspace are the reader's own. */
  isListingOwnWorkspaceFailures: boolean
}

/** What one reader may see of the workspace on screen, given what is known of its settings. */
export function readMemberReach(
  viewer: ReachViewer,
  known: MemberTotalsVisibility,
): MemberReach {
  if (viewer.isManager) {
    const canNarrowToOwn =
      viewer.ownUserId !== undefined || viewer.isFindingOwnUserId
    return {
      scopes: [
        "workspace",
        ...(canNarrowToOwn ? (["you"] as const) : []),
        ...(viewer.canReadOrganization ? (["organization"] as const) : []),
      ],
      isPending: false,
      isHiddenByAdmin: false,
      canReadWorkspaceTotals: true,
      isReadingWorkspaceTotals: false,
      showsSpend: true,
      totalsDimensions: MEMBER_TOTALS_DIMENSIONS,
      totalsFilters: MEMBER_TOTALS_FILTERS,
      canOpenWorkspaceActivity: true,
      canListWorkspaceKeys: true,
      isListingOwnWorkspaceFailures: false,
    }
  }
  // Only an answer about a named workspace counts: with none there are no
  // totals to ask for, and the server refuses an ask that names none.
  const isNamed = viewer.workspaceId !== ""
  const settings =
    isNamed && known.status === "known" ? known.visibility : undefined
  const isShared = settings?.members_see_workspace_totals === true
  return {
    scopes: isShared ? ["you", "workspace"] : ["you"],
    isPending: isNamed && known.status === "pending",
    isHiddenByAdmin: settings !== undefined && !isShared,
    canReadWorkspaceTotals: isShared,
    isReadingWorkspaceTotals: true,
    showsSpend: isShared,
    totalsDimensions: isShared ? MEMBER_TOTALS_DIMENSIONS : [],
    totalsFilters: isShared ? MEMBER_TOTALS_FILTERS : new Set(),
    canOpenWorkspaceActivity: false,
    canListWorkspaceKeys: false,
    isListingOwnWorkspaceFailures: true,
  }
}

/**
 * The scopes a reader could be offered, before the workspace's answer: a
 * member's as if it shared its totals, since only the server's answer says
 * whether it does, and it reads the caller's own usage where it does not.
 */
export function listAskableScopes(viewer: ReachViewer): UsageScopeKey[] {
  return readMemberReach(viewer, {
    status: "known",
    visibility: { members_see_workspace_totals: true },
  }).scopes
}

/** How a scope's usage reads go: across the organization, as a member's ask for the workspace's totals, or as the caller's rows. */
export function pickUsageScope(
  reach: MemberReach,
  scope: UsageScopeKey,
): TotalsScope {
  if (scope === "organization") return "organization"
  return scope === "workspace" && reach.isReadingWorkspaceTotals
    ? "workspace_totals"
    : "caller"
}
