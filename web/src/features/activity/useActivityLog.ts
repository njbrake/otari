import type {
  UsageActivityGroup,
  UsageActivityGroups,
  UsageEntry,
  UsageFilters,
} from "@/client"
import { PAGE_SIZE_OPTIONS } from "@/design-system/data/TablePagination"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { userDisplay } from "@/features/users/userDisplay"
import { useWorkspaceSpend } from "@/shared/api/budgets"
import { useLiveClock } from "@/shared/api/liveClock"
import {
  NEWEST_FIRST,
  useActivityGroups,
  useActivityTotals,
  useInFlightRequests,
  useLiveUsageCount,
  useUsageBatches,
  useUsageCount,
  useUsageLogs,
  useUsagePreviews,
  useUsageRow,
} from "@/shared/api/usage"
import { formatNumber } from "@/shared/helpers/format"
import { shortId } from "./activityModel"
import {
  type ActivityUrl,
  activityChips,
  type ColumnKey,
  GROUPS,
  readGroup,
  readSort,
  toUsageFilters,
  VALUE_FILTERS,
} from "./activityQuery"
import {
  GROUP_PREVIEW,
  groupFilters,
  keyNames,
  nestAttempts,
  PHONE_BATCH,
  PHONE_LIMIT_MAX,
} from "./activityRows"
import { phoneBarSpec } from "./chartBars"
import type { useActivityViewer } from "./useActivityViewer"
import { useActivityWindow } from "./useActivityWindow"

// How often live mode brings the window up to now. The phone has no live mode,
// so it does so only on a return to the tab, once its window is this old.
const LIVE_POLL_MS = 10_000
const PHONE_REFRESH_MS = 60_000

// The column menus that list what the window holds, and the grouping each reads.
const OPTION_GROUP_BY = {
  member: "user",
  model: "model",
  source: "api_key",
  policy: "policy",
} as const

// A menu's values as the server returned them, busiest first, and how many more
// the window holds past the page it sent.
export interface GroupList {
  groups: UsageActivityGroup[] | undefined
  more: number
  isLoading: boolean
  isError: boolean
}

function groupList(read: {
  data: UsageActivityGroups | undefined
  isFetching: boolean
  isError: boolean
}): GroupList {
  const groups = read.data?.groups
  return {
    groups,
    more: Math.max(0, (read.data?.total ?? 0) - (groups?.length ?? 0)),
    isLoading: read.isFetching,
    isError: read.isError,
  }
}

/**
 * Everything the Activity page reads, for whichever layout draws it.
 *
 * The page's state lives in the URL, so this derives the requests from it,
 * runs them, and hands back the rows, totals, groups and names both layouts
 * render. A few things it deliberately waits for or widens:
 *
 * - "You" narrows to the id the caller's own requests carry, which comes from
 *   the roster. Until it answers nothing is read, so the page never shows the
 *   workspace under "You"; a manager with no such id is shown the workspace.
 * - The aggregates (totals, groups, column counts) always send a start. With
 *   none the server's summary reads its last 30 days while the list reads all
 *   time, so "All" sends the chart's year-long extent instead.
 * - Live mode brings the windows up to now on a clock (`useLiveClock`), which
 *   moves every key once a tick, and holds still while the reader pages back,
 *   has a request open, or is looking at a window that has ended.
 */
export function useActivityLog({
  url,
  viewer,
  isPhone,
  isLive,
  openMenu,
  menuSearch,
  expanded,
  isSheetOpen,
}: {
  url: ActivityUrl
  viewer: ReturnType<typeof useActivityViewer>
  isPhone: boolean
  isLive: boolean
  openMenu: ColumnKey | undefined
  /** What the open column menu's search box holds, settled. */
  menuSearch: string
  expanded: ReadonlySet<string>
  /** The phone's filter sheet, which lists several columns' values at once. */
  isSheetOpen: boolean
}) {
  // The phone lists rows rather than paging them, so it is always on the first.
  const page = isPhone ? 0 : Math.max(0, url.getNumber("page"))
  const isFirstPageOfOpenWindow = page === 0 && !url.get("end_date")
  const liveClock = useLiveClock(
    (isLive || isPhone) && isFirstPageOfOpenWindow && !url.get("request"),
    isPhone ? PHONE_REFRESH_MS : LIVE_POLL_MS,
    { isPolling: !isPhone },
  )
  const time = useActivityWindow(url, liveClock)
  const memberLabels = useMemberAttributionLabels()

  // ---------- what is asked for ----------
  const wantsOwn = viewer.isManager && url.get("scope") === "you"
  const isReady = !(wantsOwn && viewer.isFindingOwnUserId)
  const scope: "workspace" | "you" =
    wantsOwn && viewer.ownUserId ? "you" : "workspace"
  const isMulti = viewer.isManager && scope === "workspace"
  const activityScope = {
    workspaceId: viewer.workspaceId || undefined,
    ownUserId: scope === "you" ? viewer.ownUserId : undefined,
  }
  const sort = readSort(url)
  // With no start, the summary reads its last 30 days, and so does a list in
  // any order but newest first, which the server bounds as it does the summary.
  // Under "All" both send the chart's year-long extent instead.
  const listed = toUsageFilters(url, time.list, activityScope)
  const withStart: UsageFilters = listed.start_date
    ? listed
    : { ...listed, start_date: time.chart.start }
  const filters = sort.key === NEWEST_FIRST.key ? listed : withStart
  const aggregateFilters = withStart
  const chartFilters = toUsageFilters(url, time.chart, activityScope)
  const group = readGroup(url, isMulti)
  // Groups follow time; a table sorted by cost has no stretch of time to group.
  const isGrouping = !isPhone && group !== undefined && sort.key === "timestamp"
  const groupBy = group ? GROUPS[group].groupBy : "model"
  // A hand-edited size snaps to the nearest one offered, so `size=0` cannot
  // reach the API as an invalid limit and `size=500` cannot slow every page.
  const rawSize = url.getNumber("size")
  const pageSize = PAGE_SIZE_OPTIONS.reduce((best, option) =>
    Math.abs(option - rawSize) < Math.abs(best - rawSize) ? option : best,
  )
  const openId = url.get("request")
  const isPaused = !isLive && isFirstPageOfOpenWindow
  const grain = isPhone ? phoneBarSpec(time.range).grain : time.chartGrain

  // ---------- reads ----------
  const logs = useUsageLogs(filters, page, pageSize, {
    sort,
    enabled: isReady && !isGrouping && !isPhone,
  })
  // The phone lists rows rather than paging them, a batch at a time.
  const batches = useUsageBatches(filters, PHONE_BATCH, PHONE_LIMIT_MAX, {
    sort,
    enabled: isReady && isPhone,
  })
  const count = useUsageCount(filters, isReady && !isGrouping)
  const totals = useActivityTotals(aggregateFilters, grain, {
    enabled: isReady,
    withP95: true,
  })
  const chart = useActivityTotals(chartFilters, grain, { enabled: isReady })
  const liveCount = useLiveUsageCount(filters, isReady && isPaused)
  const inFlight = useInFlightRequests(viewer.isOperator && !isPhone)
  const spend = useWorkspaceSpend(viewer.workspaceId)
  const importedCount = useUsageCount(
    { ...filters, counts_toward_budget: false },
    isReady && viewer.isOperator && !isPhone,
  )
  // Whether any of the window was routed decides whether the Policy column
  // shows, so it is read wherever the column could, with the column's own
  // filters left off: "Direct requests only" keeps the column that offers it.
  const policies = useActivityGroups(
    {
      ...aggregateFilters,
      policy_name: undefined,
      exclude_policy_name: undefined,
      routed: undefined,
    },
    "policy",
    { enabled: isReady && isMulti, order: "requests" },
  )
  // A column's values are listed with that column's own filter left off, so
  // its other values stay offered, busiest first and searched on the server.
  const without = (column: keyof typeof OPTION_GROUP_BY): UsageFilters => ({
    ...aggregateFilters,
    [VALUE_FILTERS[column].include]: undefined,
    [VALUE_FILTERS[column].exclude]: undefined,
  })
  const optionColumn =
    openMenu !== undefined && Object.hasOwn(OPTION_GROUP_BY, openMenu)
      ? (openMenu as keyof typeof OPTION_GROUP_BY)
      : undefined
  const options = useActivityGroups(
    optionColumn ? without(optionColumn) : aggregateFilters,
    optionColumn ? OPTION_GROUP_BY[optionColumn] : "model",
    {
      enabled: isReady && optionColumn !== undefined,
      search: menuSearch,
      order: "requests",
    },
  )
  // Only under Model, and only while its menu is open.
  const aliases = useActivityGroups(
    { ...aggregateFilters, requested_model: undefined },
    "alias",
    {
      enabled: isReady && openMenu === "model",
      search: menuSearch,
      order: "requests",
    },
  )
  // The phone's sheet lists members, keys and models together, and only while
  // it is open.
  const isSheetReading = isReady && isPhone && isSheetOpen
  const sheetMembers = useActivityGroups(without("member"), "user", {
    enabled: isSheetReading && isMulti,
    order: "requests",
  })
  const sheetKeys = useActivityGroups(without("source"), "api_key", {
    enabled: isSheetReading,
    order: "requests",
  })
  const sheetModels = useActivityGroups(without("model"), "model", {
    enabled: isSheetReading,
    order: "requests",
  })
  const groups = useActivityGroups(aggregateFilters, groupBy, {
    enabled: isReady && isGrouping,
  })
  const groupRows = groups.data?.groups ?? []
  const openGroups = isGrouping
    ? groupRows.filter((row) => expanded.has(row.key ?? ""))
    : []
  const previews = useUsagePreviews(
    openGroups.map((row) => groupFilters(filters, groupBy, row)),
    GROUP_PREVIEW,
  )
  const previewRows = new Map(
    openGroups.map((row, index) => [row.key ?? "", previews[index]?.data]),
  )

  const rowsRead = isGrouping ? groups : isPhone ? batches : logs

  // ---------- rows and names ----------
  const rows = (isPhone ? batches.data?.pages.flat() : logs.data) ?? []
  const { rows: topRows, attempts } = nestAttempts(rows)
  // The roster's name for a person, else the alias their requests carry, else
  // the id; the caller is "You".
  const memberName = (userId: string | null, alias?: string | null) => {
    if (userId === null) return "No member"
    if (userId === viewer.ownUserId) return "You"
    return userDisplay(userId, alias, memberLabels).label
  }
  const names = keyNames(rows, groupBy === "api_key" ? groupRows : [])
  const apiKeyName = (id: string) => names.get(id) ?? shortId(id)
  const chips = activityChips(url, { member: memberName, apiKey: apiKeyName })

  // ---------- the open request ----------
  const navList = isGrouping
    ? openGroups.flatMap((row) => previewRows.get(row.key ?? "") ?? [])
    : topRows
  const known = [...navList, ...rows]
  const fetched = useUsageRow(
    openId && !known.some((entry) => entry.id === openId) ? openId : undefined,
  )
  const open: UsageEntry | undefined =
    known.find((entry) => entry.id === openId) ?? fetched.data ?? undefined
  const isOpenMissing = Boolean(openId) && !open && fetched.isSuccess
  const openIndex = open
    ? navList.findIndex((entry) => entry.id === open.id)
    : -1

  const refresh = () => {
    void (isPhone ? batches : logs).refetch()
    void count.refetch()
    void totals.refetch()
    void chart.refetch()
    void spend.refetch()
    if (isPaused) void liveCount.refetch()
    if (isGrouping) void groups.refetch()
  }

  return {
    viewer,
    time,
    scope,
    isMulti,
    /** Whether the caller can narrow to their own requests. */
    canNarrowToOwn: viewer.ownUserId !== undefined || viewer.isFindingOwnUserId,
    filters,
    sort,
    group,
    groupBy,
    isGrouping,
    page,
    pageSize,
    rows: topRows,
    pageRows: rows,
    /** The phone's list: whether another batch is on offer, and asking for it. */
    hasMore: batches.hasNextPage,
    loadMore: () => void batches.fetchNextPage(),
    attempts,
    isLoadingRows: (rowsRead.isPending && !rowsRead.data) || !isReady,
    isFetchingRows: logs.isFetching,
    rowsUpdatedAt: logs.dataUpdatedAt,
    total: count.isSuccess ? count.data.total : null,
    totals: totals.data?.totals,
    series: chart.data?.series ?? [],
    spend: spend.data ?? undefined,
    inFlight:
      viewer.isOperator && !inFlight.isError ? inFlight.data : undefined,
    inFlightUpdatedAt: inFlight.dataUpdatedAt,
    importedCount: importedCount.data?.total ?? 0,
    newRows:
      isPaused && count.data && liveCount.data
        ? Math.max(0, liveCount.data.total - count.data.total)
        : 0,
    policyGroups: policies.data?.groups ?? [],
    /** A failed read leaves the column up rather than taking it away unsaid. */
    showsPolicies:
      isMulti &&
      (policies.isError ||
        (policies.data?.groups ?? []).some((row) => row.key !== null)),
    options: groupList(options),
    aliases: groupList(aliases),
    sheet: {
      member: groupList(sheetMembers),
      source: groupList(sheetKeys),
      model: groupList(sheetModels),
      policy: groupList(policies),
    },
    groupRows,
    groupTotal: groups.data?.total ?? groupRows.length,
    previewRows,
    memberName,
    chips,
    isFiltered: chips.length > 0 || time.hasSpan || Boolean(filters.q),
    open,
    /** A linked request that no longer exists, or that the caller cannot read. */
    isOpenMissing,
    openIndex,
    position:
      openIndex >= 0
        ? `${formatNumber(openIndex + 1)} / ${formatNumber(navList.length)}`
        : "",
    navList,
    refresh,
    // The menus say their own failures where they list values; everything else
    // is reported here.
    error:
      rowsRead.error ??
      count.error ??
      totals.error ??
      chart.error ??
      policies.error ??
      previews.find((preview) => preview.error)?.error ??
      spend.error ??
      importedCount.error ??
      fetched.error ??
      inFlight.error,
  }
}

export type ActivityLog = ReturnType<typeof useActivityLog>
