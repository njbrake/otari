import { useState } from "react"
import type { UsageFilters } from "@/client"
import { readScope } from "@/features/usage/usageQuery"
import { useUsageViewer } from "@/features/usage/useUsageData"
import {
  listAskableScopes,
  pickUsageScope,
  readMemberReach,
  readMemberTotalsVisibility,
} from "@/features/workspaces/memberVisibility"
import { useWorkspaceSpend } from "@/shared/api/budgets"
import { useOverviewSummary } from "@/shared/api/overview"
import {
  NO_BREAKDOWNS,
  pickReportedError,
  useUsageCount,
  useUsageLogs,
  useUsageSummary,
} from "@/shared/api/usage"
import { useWorkspaceVisibility } from "@/shared/api/workspaces"
import type { DashboardSearch } from "@/shared/helpers/search"
import {
  comparisonWindow,
  type OverviewUrl,
  offeredMonths,
  readMonth,
  scopeFilters,
  windowFilters,
} from "./overviewQuery"

/** How many failures the page lists. */
const FAILURES_SHOWN = 5

/**
 * Every read the Overview makes, for the scope and month the URL names: the
 * month's daily series, the same stretch of the month before, the workspace's
 * own series where the chart sets the caller's share against it, the
 * server-judged attention list and limits, the workspace budget, and the
 * month's latest failures.
 */
export function useOverviewData(url: OverviewUrl) {
  const viewer = useUsageViewer()
  // Asked of the server as if the workspace shared its totals, since only its
  // answer says whether it does: where it does not, a member's Workspace falls
  // back to their own usage, and the switch offers only that.
  const requested = readScope(url, listAskableScopes(viewer))

  // Taken on mount and on refresh rather than each render, so the month's
  // bounds, and with them every query key, hold still in between.
  const [now, setNow] = useState(() => new Date())
  const month = readMonth(url, now)
  const before = comparisonWindow(month, now)
  const workspaceId = viewer.workspaceId || undefined

  // The server reads the caller's own usage where the scope asked for is not
  // theirs (a workspace they no longer manage, say), and says so. Every other
  // read follows the scope it reports, so the page never mixes two.
  const overview = useOverviewSummary({
    workspaceId,
    month: month.key,
    scope: requested,
  })
  const served = overview.isPlaceholderData ? undefined : overview.data?.scope
  // The overview's answer seeds the workspace's visibility, so nothing else
  // asks for it here. A failed overview, or one that named no workspace,
  // leaves it unknown for good, which reads as hidden: the member's own spend.
  const visibility = useWorkspaceVisibility(viewer.workspaceId, {
    enabled: false,
  })
  const reach = readMemberReach(
    viewer,
    readMemberTotalsVisibility({
      data: visibility.data,
      isError:
        overview.isError ||
        (overview.isSuccess &&
          !overview.isPlaceholderData &&
          !overview.data.visibility),
    }),
  )
  const { scopes, canReadWorkspaceTotals } = reach
  // Until the server says which it read, the scope the reader is offered: the
  // one asked for while a member's answer is on its way, their own where the
  // workspace's totals turn out not to be theirs (or the overview failed).
  const scope = served ?? (reach.isPending ? requested : readScope(url, scopes))
  const isFallback = served !== undefined && served !== requested

  // "You" reads nothing until the roster says which requests are the caller's,
  // or it would read the whole workspace under a label saying otherwise. A
  // fallback is the server's answer for a member, which it narrows itself.
  const isReady =
    isFallback ||
    (!(scope === "you" && viewer.isManager && viewer.ownUserId === undefined) &&
      (scope !== "workspace" || canReadWorkspaceTotals))

  const base = scopeFilters({
    scope,
    workspaceId,
    ownUserId: viewer.ownUserId,
    isManager: viewer.isManager && !isFallback,
  })
  const monthWindow = windowFilters(month.start, month.end)
  const monthFilters: UsageFilters = { ...base, ...monthWindow }
  const usageScope = pickUsageScope(reach, scope)
  // The workspace's own series beside the reader's: the rest of the workspace
  // in the chart, measured against the workspace's budget.
  const readsWorkspaceToo =
    scope === "you" && canReadWorkspaceTotals && !isFallback

  const summary = useUsageSummary(
    monthFilters,
    "day",
    NO_BREAKDOWNS,
    isReady,
    usageScope,
  )
  const previous = useUsageSummary(
    { ...base, ...windowFilters(before.start, before.end) },
    "day",
    NO_BREAKDOWNS,
    isReady,
    usageScope,
  )
  const workspace = useUsageSummary(
    { workspace_id: workspaceId, ...monthWindow },
    "day",
    NO_BREAKDOWNS,
    readsWorkspaceToo,
    pickUsageScope(reach, "workspace"),
  )
  // Read in every scope, so it is on hand the moment a scope that shows it
  // is: any member of the workspace may read it.
  const spend = useWorkspaceSpend(viewer.workspaceId)
  // A member reads only their own rows, at Workspace too, so the failures
  // listed there are theirs and so is the count beside them, which the
  // workspace's totals would overstate.
  const isListingOwnFailures =
    scope === "workspace" && reach.isListingOwnWorkspaceFailures
  const failureFilters: UsageFilters = { ...monthFilters, status: "error" }
  const failures = useUsageLogs(failureFilters, 0, FAILURES_SHOWN, {
    enabled: isReady,
    usageScope: usageScope === "organization" ? "organization" : "caller",
  })
  const ownFailureCount = useUsageCount(
    failureFilters,
    isReady && isListingOwnFailures,
  )

  // What is on screen. While another scope or month loads, the last answers
  // stay up (each read keeps its previous data), so the page keeps describing
  // them, labels included, until the new ones land: new words never go over
  // old numbers. The switch shows the new choice at once, and the page says it
  // is busy.
  const isSettling =
    overview.isPlaceholderData ||
    summary.isPlaceholderData ||
    previous.isPlaceholderData ||
    failures.isPlaceholderData ||
    (readsWorkspaceToo && (workspace.isPlaceholderData || workspace.isPending))
  const [shown, setShown] = useState({
    scope,
    monthKey: month.key,
    isFallback,
  })
  const isShowing = shown.scope === scope && shown.monthKey === month.key
  if (!isSettling && (!isShowing || shown.isFallback !== isFallback)) {
    setShown({ scope, monthKey: month.key, isFallback })
  }
  const shownMonth =
    offeredMonths(now).find((one) => one.key === shown.monthKey) ?? month
  const shownScope = shown.scope
  const shownReadsWorkspace =
    shownScope === "you" && canReadWorkspaceTotals && !shown.isFallback
  const isShowingOwnFailures =
    shownScope === "workspace" && reach.isListingOwnWorkspaceFailures

  // Activity's search for the month's requests in this scope. Activity reads one
  // workspace, so across the organization there is none to give.
  const activityBase: DashboardSearch | undefined =
    shownScope === "organization"
      ? undefined
      : {
          start_date: shownMonth.start.toISOString(),
          end_date: shownMonth.end.toISOString(),
          // A manager's own requests; a member's are all Activity shows them.
          ...(shownReadsWorkspace && viewer.isManager ? { scope: "you" } : {}),
        }
  const failuresSearch = activityBase
    ? { ...activityBase, status: "error" }
    : undefined
  // A member at Workspace counts the workspace's failures but can open only
  // their own in Activity, so the workspace's figures link nowhere.
  const workspaceFailuresSearch =
    shownScope === "workspace" && !reach.canOpenWorkspaceActivity
      ? undefined
      : failuresSearch
  // The chart's bars are the workspace's at Workspace and at You (the reader's
  // share stacked under the rest). Where a member is not shown the workspace's
  // totals, or the server read their own usage instead, theirs stand alone.
  const isOwnOnly =
    shownScope === "you" &&
    (shown.isFallback || (!viewer.isManager && !shownReadsWorkspace))
  // Usage's search for the same scope and month, as a span it keeps.
  const usageSearch: DashboardSearch = {
    scope: shownScope,
    start_date: shownMonth.start.toISOString(),
    end_date: shownMonth.end.toISOString(),
  }

  // Every read goes again, the workspace's visibility with the overview that
  // carries it. The month's keys hold still within a month, so a new `now`
  // alone would move only "today" and the projection.
  const refresh = () => {
    setNow(new Date())
    void overview.refetch()
    void spend.refetch()
    if (isReady) {
      void summary.refetch()
      void previous.refetch()
      void failures.refetch()
      if (isListingOwnFailures) void ownFailureCount.refetch()
    }
    if (readsWorkspaceToo) void workspace.refetch()
  }

  return {
    viewer,
    scopes,
    /** The scope and month the URL asked for, which the switch and menu show. */
    requested,
    requestedMonth: month,
    /** The scope and month on screen: the last ones every read answered. */
    scope: shownScope,
    month: shownMonth,
    isFallback: shown.isFallback,
    /** A member whose workspace's managers keep its totals from members. */
    isHiddenFromMember: reach.isHiddenByAdmin,
    /**
     * Until a member's workspace says whether they are shown its totals, the
     * chart cannot say which one it is, so it waits rather than guess.
     */
    isAwaitingTotals: reach.isPending,
    /** The chart is the reader's own spend, with nothing measured against it. */
    isOwnOnly,
    /** A member at Workspace: the workspace's totals, and their own failures. */
    isListingOwnFailures: isShowingOwnFailures,
    /** How many of the month's requests failed among the reader's own, where the list is theirs alone. */
    ownFailureCount: isShowingOwnFailures
      ? ownFailureCount.data?.total
      : undefined,
    /** At Workspace the rail lists no keys: a member's would be other people's. */
    isHidingWorkspaceKeys:
      shownScope === "workspace" && !reach.canListWorkspaceKeys,
    /** The answers on screen are another scope's or month's, being replaced. */
    isStale: !isShowing,
    before: comparisonWindow(shownMonth, now),
    now,
    isReady,
    summary,
    previous,
    workspace: shownReadsWorkspace ? workspace : undefined,
    overview,
    spend,
    failures,
    activityBase,
    failuresSearch,
    /** Activity's search for the workspace's failures, where it can list them. */
    workspaceFailuresSearch,
    usageSearch,
    refresh,
    isFetching:
      summary.isFetching ||
      previous.isFetching ||
      overview.isFetching ||
      failures.isFetching ||
      (readsWorkspaceToo && workspace.isFetching),
    updatedAt: Math.max(
      summary.dataUpdatedAt,
      previous.dataUpdatedAt,
      overview.dataUpdatedAt,
      failures.dataUpdatedAt,
    ),
    error:
      pickReportedError(summary.error, usageScope) ??
      pickReportedError(previous.error, usageScope) ??
      overview.error ??
      spend.error ??
      (readsWorkspaceToo
        ? pickReportedError(workspace.error, pickUsageScope(reach, "workspace"))
        : null),
  }
}
