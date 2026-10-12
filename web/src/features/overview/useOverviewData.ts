import { useState } from "react"
import type { UsageFilters } from "@/client"
import { readScope, scopesFor } from "@/features/usage/usageQuery"
import { useUsageViewer } from "@/features/usage/useUsageData"
import { useWorkspaceSpend } from "@/shared/api/budgets"
import { useOverviewSummary } from "@/shared/api/overview"
import {
  NO_BREAKDOWNS,
  useUsageLogs,
  useUsageSummary,
} from "@/shared/api/usage"
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
export const FAILURES_SHOWN = 5

/**
 * Every read the Overview makes, for the scope and month the URL names: the
 * month's daily series, the same stretch of the month before, the workspace's
 * own series where the chart sets the caller's share against it, the
 * server-judged attention list and limits, the workspace budget, and the
 * month's latest failures.
 */
export function useOverviewData(url: OverviewUrl) {
  const viewer = useUsageViewer()
  // A manager whose own requests cannot be told apart reads the workspace only.
  const scopes = scopesFor(viewer).filter(
    (scope) =>
      scope !== "you" ||
      !viewer.isManager ||
      viewer.ownUserId !== undefined ||
      viewer.isFindingOwnUserId,
  )
  const requested = readScope(url, scopes)

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
  const scope = served ?? requested
  const isFallback = served !== undefined && served !== requested

  // "You" reads nothing until the roster says which requests are the caller's,
  // or it would read the whole workspace under a label saying otherwise. A
  // fallback is the server's answer for a member, which it narrows itself.
  const isReady =
    isFallback ||
    !(scope === "you" && viewer.isManager && viewer.ownUserId === undefined)

  const base = scopeFilters({
    scope,
    workspaceId,
    ownUserId: viewer.ownUserId,
    isManager: viewer.isManager && !isFallback,
  })
  const monthWindow = windowFilters(month.start, month.end)
  const monthFilters: UsageFilters = { ...base, ...monthWindow }
  const usageScope = scope === "organization" ? "organization" : "caller"
  // The workspace's own series beside a manager's: the rest of the workspace in
  // the chart, measured against the workspace's budget.
  const readsWorkspaceToo = scope === "you" && viewer.isManager && !isFallback

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
  )
  // Read in every scope, so it is on hand the moment a scope that shows it
  // is: any member of the workspace may read it.
  const spend = useWorkspaceSpend(viewer.workspaceId)
  const failures = useUsageLogs(
    { ...monthFilters, status: "error" },
    0,
    FAILURES_SHOWN,
    { enabled: isReady, usageScope },
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
    (readsWorkspaceToo && workspace.isPlaceholderData)
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
    shownScope === "you" && viewer.isManager && !shown.isFallback

  // Activity's search for the month's requests in this scope. Activity reads one
  // workspace, so across the organization there is none to give.
  const activityBase: DashboardSearch | undefined =
    shownScope === "organization"
      ? undefined
      : {
          start_date: shownMonth.start.toISOString(),
          end_date: shownMonth.end.toISOString(),
          ...(shownReadsWorkspace ? { scope: "you" } : {}),
        }
  const failuresSearch = activityBase
    ? { ...activityBase, status: "error" }
    : undefined

  // Every read goes again. The month's keys hold still within a month, so a
  // new `now` alone would move only "today" and the projection.
  const refresh = () => {
    setNow(new Date())
    void overview.refetch()
    void spend.refetch()
    if (isReady) {
      void summary.refetch()
      void previous.refetch()
      void failures.refetch()
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
      summary.error ??
      previous.error ??
      overview.error ??
      spend.error ??
      (readsWorkspaceToo ? workspace.error : null),
  }
}

export type OverviewData = ReturnType<typeof useOverviewData>
