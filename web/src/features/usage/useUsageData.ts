import { useState } from "react"
import type { UsageBucket, UsageFilters } from "@/client"
import { useActivityViewer } from "@/features/activity/useActivityViewer"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { canManage } from "@/features/organization/roles"
import { useWorkspaceSpend } from "@/shared/api/budgets"
import { useOrganizationContext } from "@/shared/api/organizations"
import {
  NO_BREAKDOWNS,
  useUsageBreakdown,
  useUsageGroupedSeries,
  useUsageSummary,
} from "@/shared/api/usage"
import { bucketForWindow, isoAgo } from "@/shared/helpers/timeRange"
import { rankByFor, readMetric } from "./usageModel"
import {
  DIMENSIONS,
  dimensionsFor,
  readDimension,
  readFilters,
  readPreset,
  readScope,
  readSort,
  scopesFor,
  toUsageFilters,
  type UsageContext,
  type UsageUrl,
} from "./usageQuery"

/**
 * Who is reading, and what the page offers them. A member reads their own
 * usage, which the server decides. Someone who manages the workspace also
 * reads everyone's in it and can narrow to their own, and someone who manages
 * the organization can read across its workspaces. Each is the client half of a
 * check the server makes.
 */
export function useUsageViewer() {
  const viewer = useActivityViewer()
  const context = useOrganizationContext()
  return {
    ...viewer,
    canReadOrganization: canManage(context.data),
    memberLabels: useMemberAttributionLabels(),
  }
}

type UsageViewer = ReturnType<typeof useUsageViewer>

/**
 * Every read the page makes, and what it derives from the URL to make them:
 * the scope, the window or span, the breakdown, and the filters that apply in
 * this scope (the rest wait in the URL for a scope that has them).
 */
export function useUsageData(url: UsageUrl, viewer: UsageViewer) {
  const scopes = scopesFor(viewer)
  const scope = readScope(url, scopes)
  // "You" reads nothing until the roster says which requests are the caller's,
  // or it would read the whole workspace under a label saying otherwise.
  const isReady = !(
    scope === "you" &&
    viewer.isManager &&
    viewer.ownUserId === undefined
  )
  const dimension = readDimension(url, scope)
  const offered = dimensionsFor(scope)
  const allFilters = readFilters(url)
  const filters = allFilters.filter((filter) =>
    offered.includes(filter.dimension),
  )
  const idleFilters = allFilters.filter(
    (filter) => !offered.includes(filter.dimension),
  )
  const metric = readMetric(url.get("metric"))
  // The setting is offered with cost only, so it has no effect anywhere while
  // another metric is on screen (the share card included).
  const withSubscription =
    metric !== "cost" || url.get("subscription") !== "exclude"
  const sort = readSort(url)
  const preset = readPreset(url)

  // A rolling window's start, taken when the window is picked and on refresh
  // rather than each render: recomputed on render, "now" would mint a new query
  // key, and a new request, every time anything re-rendered.
  const [anchor, setAnchor] = useState(() => ({
    range: preset.key,
    start: isoAgo(preset.seconds ?? 0),
  }))
  if (anchor.range !== preset.key) {
    setAnchor({ range: preset.key, start: isoAgo(preset.seconds ?? 0) })
  }
  const spanStart = url.get("start_date")
  const spanEnd = url.get("end_date")
  const hasSpan = spanStart !== "" && spanEnd !== ""
  const window = hasSpan
    ? { start: spanStart, end: spanEnd }
    : { start: anchor.start, end: undefined }
  const bucket: UsageBucket = hasSpan
    ? bucketForWindow(spanStart, spanEnd)
    : preset.bucket

  const context: UsageContext = {
    scope,
    workspaceId: viewer.workspaceId || undefined,
    ownUserId: viewer.ownUserId,
    isManager: viewer.isManager,
  }
  const usageFilters = toUsageFilters(filters, window, context)
  // The window of equal length just before this one, for the tiles' growth.
  // None for a span: a stretch dragged out of the chart has no "before".
  const previousFilters: UsageFilters = {
    ...usageFilters,
    start_date: new Date(
      Date.parse(anchor.start) - (preset.seconds ?? 0) * 1000,
    ).toISOString(),
    end_date: anchor.start,
  }
  const usageScope: "organization" | "caller" =
    scope === "organization" ? "organization" : "caller"
  const def = DIMENSIONS[dimension]
  const rankBy = rankByFor(metric, withSubscription)

  const breakdown = useUsageBreakdown(
    usageFilters,
    bucket,
    def.summary,
    rankBy,
    { enabled: isReady, usageScope },
  )
  const previous = useUsageSummary(
    previousFilters,
    bucket,
    NO_BREAKDOWNS,
    isReady && !hasSpan,
    usageScope,
  )
  const grouped = useUsageGroupedSeries(
    usageFilters,
    bucket,
    def.series,
    rankBy,
    isReady,
    usageScope,
  )
  const spend = useWorkspaceSpend(
    scope === "organization" ? "" : viewer.workspaceId,
  )

  // A rolling window moves on to now, which is a new key and so one new read
  // of each; a span's window stays where it is, so its reads go again.
  const refresh = () => {
    if (!hasSpan) {
      setAnchor({ range: preset.key, start: isoAgo(preset.seconds ?? 0) })
      return
    }
    void breakdown.refetch()
    void grouped.refetch()
  }

  // While another breakdown loads, the last one's answer keeps the totals and
  // the chart's window on screen; its rows are that breakdown's, so none show.
  const answer = breakdown.data
  const isCurrent = answer?.dimension === def.summary

  return {
    scopes,
    scope,
    context,
    dimension,
    offered,
    filters,
    idleFilters,
    metric,
    withSubscription,
    sort,
    preset,
    window,
    hasSpan,
    bucket,
    usageFilters,
    usageScope,
    summary: answer?.summary,
    rows: isCurrent ? (def.rows(answer.summary) ?? []) : [],
    previous: hasSpan ? undefined : previous.data?.totals,
    grouped: grouped.data,
    spend: spend.data ?? undefined,
    isLoading: !isReady || (!isCurrent && !breakdown.error),
    isFetching: breakdown.isFetching || breakdown.isPlaceholderData,
    updatedAt: breakdown.dataUpdatedAt,
    error: breakdown.error ?? grouped.error,
    refresh,
  }
}
