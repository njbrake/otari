import { Button } from "@heroui/react"
import { useNavigate } from "@tanstack/react-router"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { SummaryDimension, UsageEntry, UsageFilters } from "@/client"
import { RefreshButton } from "@/design-system/actions/RefreshButton"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import {
  PAGE_SIZE_OPTIONS,
  TablePagination,
} from "@/design-system/data/TablePagination"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { InfoBanner } from "@/design-system/feedback/InfoBanner"
import { PageLoading } from "@/design-system/feedback/PageLoading"
import { useIsMobile } from "@/design-system/hooks/useIsMobile"
import { PageIntro } from "@/design-system/layout/PageIntro"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import {
  type PricingUnit,
  pricingUnitForEndpoint,
} from "@/features/models/pricingUnit"
import {
  type ManualRates,
  SetPriceDialog,
} from "@/features/models/SetPriceDialog"
import { ObserveColumnFilter } from "@/features/observe/ObserveColumnFilter"
import { ObserveFilterRow } from "@/features/observe/ObserveFilterRow"
import { ObserveSearchBox } from "@/features/observe/ObserveSearchBox"
import { funnelFor } from "@/features/observe/observeColumnFilters"
import { readThreshold } from "@/features/observe/observeFilters"
import {
  laidOutColumns,
  useObserveTableLayout,
} from "@/features/observe/observeTableLayout"
import { useObserveScope } from "@/features/observe/useObserveScope"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { userDisplay } from "@/features/users/userDisplay"
import { useSetPricing } from "@/shared/api/pricing"
import {
  NEWEST_FIRST,
  useInFlightRequests,
  useLiveClock,
  useLiveUsageCount,
  useRequestGroups,
  useUsageCount,
  useUsageLogGroups,
  useUsageLogPreviews,
  useUsageLogs,
  useUsageScope,
  useUsageSummary,
} from "@/shared/api/usage"
import { formatNumber } from "@/shared/helpers/format"
import type { DashboardSearch } from "@/shared/helpers/search"
import {
  ACTIVITY_DEFAULT_KEY,
  ACTIVITY_PRESETS,
  bucketForWindow,
  CUSTOM_KEY,
  findPreset,
  type RangePreset,
} from "@/shared/helpers/timeRange"
import { useUrlState } from "@/shared/helpers/urlState"
import { useSelectedWorkspace } from "@/shared/hooks/SelectedWorkspace"
import { ActivityTimeline } from "./ActivityTimeline"
import {
  describeStatus,
  findGroupsMissingEarlierAttempts,
  findRequestOutcome,
  formatLatencyCell,
  getActivityRowClassName,
  getActivityRowKey,
  indexGroupOutcomes,
  resolveExtentWindow,
  resolveWindow,
} from "./activityModel"
import { CellFilter } from "./CellFilter"
import {
  applyCellFilter,
  type CellDimension,
  type CellFilterMode,
  groupsWithEarlierAttempts,
  nestRecoveredAttempts,
} from "./cellFilters"
import { GroupByControl } from "./GroupByControl"
import { GroupedRequests, groupId } from "./GroupedRequests"
import { InFlightControl } from "./InFlightControl"
import { LiveControl, type LivePause } from "./LiveControl"
import { PhoneRequestList } from "./PhoneRequestList"
import { RequestPeek } from "./RequestPeek"
import { RequestTotals } from "./RequestTotals"
import { RoutingCell } from "./RoutingCell"
import {
  API_KEY_COLUMN,
  apiKeyLabel,
  COST_COLUMN,
  INPUT_TOKENS_COLUMN,
  MODEL_COLUMN,
  modelCell,
  OUTPUT_TOKENS_COLUMN,
  STATUS_COLUMN,
  TIME_COLUMN,
  toolFilterFor,
} from "./requestColumns"
import {
  GROUP_PAGE,
  GROUP_PAGE_MAX,
  GROUP_PREVIEW,
  groupFilters,
  PHONE_BATCH,
  PHONE_LIMIT_MAX,
  readGroupBy,
  showGroupSearch,
} from "./requestGroups"
import {
  boundsWindow,
  nextSort,
  readSort,
  SORTABLE_COLUMNS,
  sortDescriptorFor,
  sortUrl,
} from "./requestSort"

// The timeline reads the summary's series and no breakdown.
const NO_BREAKDOWNS: SummaryDimension[] = []

const DEFAULT_PAGE_SIZE = 50

// How often live mode re-reads the newest rows and the count, and how often it
// brings the window, and with it the totals and the chart, up to now.
const LIVE_ROWS_MS = 10_000
const LIVE_AGGREGATES_MS = 60_000

const NONE_NESTED: ReadonlySet<string> = new Set()

// All filter + pagination state, with defaults, kept in the URL.
const URL_DEFAULTS = {
  range: ACTIVITY_DEFAULT_KEY,
  start_date: "",
  end_date: "",
  status: "",
  status_code: "",
  model: "",
  user_id: "",
  api_key_id: "",
  priced: "",
  source: "",
  source_label: "",
  endpoint: "",
  provider: "",
  tool: "",
  exclude_model: "",
  exclude_user_id: "",
  exclude_api_key_id: "",
  exclude_source: "",
  exclude_status: "",
  policy_name: "",
  exclude_policy_name: "",
  routed: "",
  tokens_gt: "",
  cost_gt: "",
  latency_ms_gt: "",
  // Free-text search, typed in the filter row above the table.
  q: "",
  // How a request came in, columns that must be empty, and whether each
  // request's recovered attempts are listed under it ("show").
  channel: "",
  is_null: "",
  recovered: "",
  // The column the log is ordered by and which way; absent is newest first.
  sort: "",
  order: "",
  // The column the log is grouped by; absent is a flat list.
  group: "",
  page: "0",
  size: String(DEFAULT_PAGE_SIZE),
  // The request open in the panel: a usage row's id, or the `Otari-Request-ID`
  // the request was answered under.
  request: "",
} as const

/**
 * Inside the Overview the page waits for its scope, so it never fetches the wrong one.
 *
 * It also waits for the workspace selection: mounted before it, the page would see
 * the workspace arrive as a filter change, which resets the page and drops a
 * linked `?request=`.
 */
export function ActivityPage({
  embedded = false,
}: {
  embedded?: boolean
} = {}) {
  const observe = useObserveScope(embedded)
  const workspace = useSelectedWorkspace()
  return observe.isResolved && workspace.isSettled ? (
    <ActivityPageContent embedded={embedded} observe={observe} />
  ) : (
    <PageLoading />
  )
}

function ActivityPageContent({
  embedded = false,
  observe,
}: {
  embedded?: boolean
  observe: ReturnType<typeof useObserveScope>
}) {
  // Who the people behind the owner ids are. The log already carries the alias
  // the gateway was told; the roster is who the person is, so it wins.
  const memberLabels = useMemberAttributionLabels()
  // Filter + pagination state lives in the URL, so a filtered view is shareable
  // and survives the back button. `patch` batches related changes into one entry.
  const url = useUrlState(URL_DEFAULTS)
  const range = url.get("range")
  const startParam = url.get("start_date")
  const endParam = url.get("end_date")
  // One status, or a subset of them on Requests.
  const statusValues = url.getAll("status")
  const statusFilter = statusValues.length === 1 ? statusValues[0] : ""
  // The three entity filters hold sets: each is repeatable in the URL and on the
  // wire, so a comparison ("these two models") is one view rather than several, and
  // a drill-down from the analytics page can carry its whole selection across.
  const modelFilters = url.getAll("model")
  // Inside the Overview the scope decides this; elsewhere it is the URL's own.
  const { userIds: userFilters, scope: observeScope } = observe
  const apiKeyFilters = url.getAll("api_key_id")
  const pricedFilter = url.get("priced")
  // Provenance: gateway traffic vs an imported agent source. Set by its own select,
  // or by a drill-down (the pricing alarm links here scoped to gateway traffic).
  const sourceFilter = url.get("source")
  // Session, status code and endpoint have no select of their own: a link
  // carries them, shown as a chip so the scoping is visible and one click
  // removes it. The provider is filtered from the Model column header.
  const sessionFilter = url.get("source_label")
  const statusCodeFilter = url.get("status_code")
  const endpointFilter = url.get("endpoint")
  const providerFilter = url.get("provider")
  const toolFilter = url.get("tool")
  const search = url.get("q").trim()
  const sort = readSort(url.get("sort"), url.get("order"))
  const showRecovered = url.get("recovered") === "show"
  const groupBy = readGroupBy(url.get("group"))
  // A column sort has no stretch of time to group, so grouping waits it out.
  const groupPaused = groupBy !== undefined && sort.sort !== NEWEST_FIRST.sort
  // The phone lists its rows flat; a link carrying a grouping still opens there.
  const isMobile = useIsMobile()
  const isGrouped = groupBy !== undefined && !groupPaused && !isMobile
  // The server reads any order but time, and a substring search, over a bounded
  // window, an omitted start as the last 30 days. Under "All" those reads take
  // the year the timeline spans instead, so the rows match the bars above them.
  const boundedRead = boundsWindow(sort, search)
  const page = Math.max(0, url.getNumber("page"))
  // The request open in the panel: a usage row's id, or the request id.
  const requestId = url.get("request")
  // Snap URL-supplied sizes to the nearest offered option: an old bookmark
  // with size=500 must not render a page of 500 rows, and a hand-edited size=0
  // or size=-5 must not reach the API as an invalid limit (or leave the
  // rows-per-page select showing a value it does not offer).
  const rawPageSize = url.getNumber("size")
  const pageSize = PAGE_SIZE_OPTIONS.reduce((best, option) =>
    Math.abs(option - rawPageSize) < Math.abs(best - rawPageSize)
      ? option
      : best,
  )

  // Snapshot the window so a rolling preset does not recompute "now" every render
  // (which would churn the query key). Re-anchored when the range selection changes,
  // and by re-picking the active preset (see `pickPreset`).
  //
  // Both re-anchor effects skip their first run. The `useState` initializers have
  // already snapshotted the window, so re-anchoring on mount only moves `start` by
  // the milliseconds since, which changes `filters`, which trips the page reset
  // below: a bookmarked or shared `?page=3` URL would silently open on page 1.
  const selectionKey = `${range}|${startParam}|${endParam}`
  // One clock reading shared by both initial windows. Taken separately they differ
  // by the milliseconds between the two lines, and since `extentWin` is read second
  // its rolling start is the later one, which made the strict `<` in
  // `winOutsideExtent` true on an ordinary load: the page then framed the window
  // rather than the preset, so no preset was highlighted and a 24h extent bucketed
  // by day instead of by hour. Whether that happened came down to machine load.
  const [mountClock] = useState(Date.now)
  const [win, setWin] = useState(() =>
    resolveWindow(range, startParam, endParam, mountClock),
  )
  // The preset extent (ignoring any brushed bounds) that the timeline histogram
  // spans. Snapshotted like `win`, re-anchored when the preset changes: a brushed
  // sub-window must leave the extent alone, or zooming in would drag the frame
  // (and refetch the histogram) along with it.
  const [extentWin, setExtentWin] = useState(() =>
    resolveExtentWindow(range, mountClock),
  )
  // Both re-anchors share one effect so they also share one clock reading. As two
  // effects they ran in declaration order on a range change, leaving the list
  // window a millisecond behind the extent containing it, which is the same drift
  // described above. The guards are per-window and unchanged: `win` re-anchors for
  // any selection change, `extentWin` only when the preset itself moves.
  const prevSelectionKey = useRef(selectionKey)
  const prevRange = useRef(range)
  useEffect(() => {
    const clock = Date.now()
    if (prevSelectionKey.current !== selectionKey) {
      prevSelectionKey.current = selectionKey
      setWin(resolveWindow(range, startParam, endParam, clock))
    }
    if (prevRange.current !== range) {
      prevRange.current = range
      setExtentWin(resolveExtentWindow(range, clock))
    }
  }, [selectionKey, range, startParam, endParam])

  // An unrecognized `range` resolves to the default window (see `resolveWindow`),
  // so the URL has to be corrected to say what the page is actually showing. The
  // case that produces it is a Usage-page key: `90d` and `12mo` are presets there
  // and not here, so a hand-edited or hand-copied URL carries one across and the
  // address bar then claims ninety days over a list showing one. `patch` replaces
  // rather than pushes, because this is a correction to the entry rather than a
  // navigation, and writing the default drops the key entirely, which is the same
  // URL the page produces when it is opened with no range at all.
  //
  // Bounds win over a preset, so a window carried in `start_date`/`end_date` is
  // left alone: the range is not lying there, it is not being read.
  const patch = url.patch
  useEffect(() => {
    if (startParam || endParam) return
    if (range === CUSTOM_KEY || findPreset(ACTIVITY_PRESETS, range)) return
    patch({ range: ACTIVITY_DEFAULT_KEY })
  }, [range, startParam, endParam, patch])

  const priced =
    pricedFilter === "true"
      ? true
      : pricedFilter === "false"
        ? false
        : undefined

  // The refinements the column headers set: values left out, the routing
  // policy, and thresholds. Read as one set and keyed on its serialized form,
  // since each list is a fresh array per render.
  const refinementsKey = JSON.stringify({
    exclude_model: url.getAll("exclude_model"),
    exclude_user_id: url.getAll("exclude_user_id"),
    exclude_api_key_id: url.getAll("exclude_api_key_id"),
    exclude_source: url.getAll("exclude_source"),
    exclude_status: url.getAll("exclude_status"),
    policy_name: url.getAll("policy_name"),
    exclude_policy_name: url.getAll("exclude_policy_name"),
    routed: url.get("routed"),
    tokens_gt: readThreshold(url.get("tokens_gt")),
    cost_gt: readThreshold(url.get("cost_gt")),
    latency_ms_gt: readThreshold(url.get("latency_ms_gt")),
    statuses: statusValues.length > 1 ? statusValues : [],
    channel: url.getAll("channel"),
    is_null: url.getAll("is_null"),
  })
  const refinements: Partial<UsageFilters> = useMemo(() => {
    const read = JSON.parse(refinementsKey) as Record<string, unknown>
    const list = (key: string) => {
      const values = read[key] as string[]
      return values.length > 0 ? values : undefined
    }
    return {
      exclude_model: list("exclude_model"),
      exclude_user_id: list("exclude_user_id"),
      exclude_api_key_id: list("exclude_api_key_id"),
      exclude_source: list("exclude_source"),
      exclude_status: list("exclude_status") as UsageFilters["exclude_status"],
      policy_name: list("policy_name"),
      exclude_policy_name: list("exclude_policy_name"),
      routed: read.routed === "false" ? false : undefined,
      tokens_gt: read.tokens_gt as number | undefined,
      cost_gt: read.cost_gt as number | undefined,
      latency_ms_gt: read.latency_ms_gt as number | undefined,
      statuses: list("statuses") as UsageFilters["statuses"],
      channel: list("channel") as UsageFilters["channel"],
      is_null: list("is_null") as UsageFilters["is_null"],
    }
  }, [refinementsKey])
  const hasRefinements = Object.values(refinements).some(
    (value) => value !== undefined,
  )

  const { selected: workspace } = useSelectedWorkspace()
  // What every read of the window shares; the list and its count add one thing
  // (`filters`, below), and the totals read this as it is.
  const readFilters: UsageFilters = useMemo(
    () => ({
      // From the sidebar's switcher, not from a control on this page: it scopes
      // the whole shell, and the operator's own filters sit below it.
      workspace_id: workspace?.workspace_id,
      start_date: win.start ?? (boundedRead ? extentWin.start : undefined),
      end_date: win.end,
      status: statusFilter || undefined,
      model: modelFilters.length > 0 ? modelFilters : undefined,
      user_id: userFilters.length > 0 ? userFilters : undefined,
      api_key_id: apiKeyFilters.length > 0 ? apiKeyFilters : undefined,
      source: sourceFilter || undefined,
      source_label: sessionFilter || undefined,
      status_code: statusCodeFilter || undefined,
      endpoint: endpointFilter || undefined,
      provider: providerFilter || undefined,
      tool: (toolFilter || undefined) as UsageFilters["tool"],
      priced,
      q: search || undefined,
      ...refinements,
    }),
    [
      refinements,
      search,
      workspace,
      win,
      boundedRead,
      extentWin.start,
      toolFilter,
      statusFilter,
      modelFilters,
      userFilters,
      apiKeyFilters,
      sourceFilter,
      sessionFilter,
      statusCodeFilter,
      endpointFilter,
      providerFilter,
      priced,
    ],
  )

  // The log lists each request once, as the row that settled it: the attempts a
  // routing policy recovered from are counted in the totals and, with
  // "recovered" shown, listed under their request (`nestRecoveredAttempts`).
  const filters: UsageFilters = useMemo(
    () => ({ ...readFilters, include_absorbed: false }),
    [readFilters],
  )

  // Any change to the filter set returns to the first page, but not on mount,
  // so a shared URL keeps its page. A live re-anchor of the window changes the
  // set too, on a first page with nothing open, so it navigates nowhere.
  const filtersKey = JSON.stringify(filters)
  const prevFiltersKey = useRef(filtersKey)
  useEffect(() => {
    if (prevFiltersKey.current !== filtersKey) {
      prevFiltersKey.current = filtersKey
      if (page !== 0 || requestId !== "") url.patch({ page: 0, request: "" })
    }
  }, [filtersKey, url, page, requestId])

  // How many rows the phone has loaded, and which groups the desk lists and
  // has open. They start over when the reader changes the view, which a live
  // re-anchor of the window is not, so the key is the selection rather than
  // the instants it resolves to.
  const [phoneLimit, setPhoneLimit] = useState(PHONE_BATCH)
  const [groupLimit, setGroupLimit] = useState(GROUP_PAGE)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const viewKey = JSON.stringify({
    ...filters,
    start_date: undefined,
    end_date: undefined,
    selectionKey,
    sort,
    groupBy,
  })
  const [seenViewKey, setSeenViewKey] = useState(viewKey)
  if (seenViewKey !== viewKey) {
    setSeenViewKey(viewKey)
    setPhoneLimit(PHONE_BATCH)
    setGroupLimit(GROUP_PAGE)
    setOpenGroups(new Set())
  }

  // Live mode: on unless the reader paused it, and holding still on its own
  // while they read a later page, have a request open, sort by a column, or look at a window
  // that has ended, so no row moves under someone reading it.
  const [liveWanted, setLiveWanted] = useState(true)
  const sorted =
    sort.sort !== NEWEST_FIRST.sort || sort.order !== NEWEST_FIRST.order
  const livePause: LivePause = filters.end_date
    ? "ended"
    : requestId !== ""
      ? "request"
      : page > 0
        ? "page"
        : sorted
          ? "sort"
          : ""
  const isLive = liveWanted && livePause === ""
  const liveRefetch = isLive ? LIVE_ROWS_MS : false
  // The rows and the count re-read every ten seconds over the window they have;
  // once a minute the window itself is brought up to now, which re-reads the
  // totals and the chart with it. The first reading is the page's own mount, so
  // it re-anchors nothing.
  const liveClock = useLiveClock(isLive, LIVE_AGGREGATES_MS)
  const seenLiveClock = useRef(0)
  useEffect(() => {
    if (liveClock === 0) return
    const first = seenLiveClock.current === 0
    seenLiveClock.current = liveClock
    if (first) return
    setWin(resolveWindow(range, startParam, endParam, liveClock))
    setExtentWin(resolveExtentWindow(range, liveClock))
  }, [liveClock, range, startParam, endParam])

  // The phone reads its first `phoneLimit` rows; the desk a page, unless grouped.
  const usage = useUsageLogs(
    filters,
    isMobile ? 0 : page,
    isMobile ? phoneLimit : pageSize,
    !isGrouped,
    "caller",
    { sort, refetchInterval: liveRefetch },
  )
  const count = useUsageCount(filters, {
    sort: sort.sort,
    refetchInterval: liveRefetch,
  })

  // Which usage surface this caller reads, and with it the two things on this
  // page that stay the deployment operator's: the in-flight strip and the
  // per-row "price this model" button. The log and its aggregates are
  // organization-scoped for everyone else (otari#837), so the page is theirs;
  // these two are not.
  const scope = useUsageScope()

  // Requests in progress, read unfiltered: the endpoint has no filters, because a
  // request that has not finished has no outcome, cost, or token count to filter
  // on. Reported gateway-wide beside the refresh control, not as rows.
  //
  // Deployment-wide and left that way: its registry entries carry no workspace,
  // so there is nothing in them to scope to a tenant yet. A non-operator is not
  // shown a strip reporting somebody else's traffic, and does not ask for one.
  const inFlight = useInFlightRequests(scope.isDeploymentWide)

  // How far behind the frozen page has fallen. Polled while the count it is
  // compared against is not (see `useUsageCount`), so the difference is "rows that
  // have landed since this page was drawn".
  //
  // Only asked for where it can be acted on. On page 2 onward, refreshing does not
  // bring newer rows into view (they land at the top of page 1), so a badge
  // offering to load them would be a promise the button does not keep; a window
  // that ends in the past can gain no rows at all, so the poll would be pure cost.
  // While live the rows themselves catch up, so the badge has nothing to say,
  // and under a column sort newer rows land anywhere but the top.
  const newRowsRelevant = page === 0 && !filters.end_date && !isLive && !sorted
  const liveCount = useLiveUsageCount(filters, newRowsRelevant)

  // The timeline histogram spans the whole preset *extent* (the rolling preset
  // window, independent of any brushed sub-window), so the brush always has
  // context to zoom back out into. For the unbounded "All", `extentWin` carries an
  // explicit year-long start (see `resolveExtentWindow`) so the bars span a
  // deterministic window instead of the summary endpoint's hidden 30-day default;
  // the list stays all-time and the caption reflects the true list window, and the
  // brush still narrows it. Entity filters carry over so the bars match what's shown.
  const extentPreset =
    findPreset(ACTIVITY_PRESETS, range) ??
    findPreset(ACTIVITY_PRESETS, ACTIVITY_DEFAULT_KEY)
  // A window reaching outside the preset extent (a drill-down from the Usage
  // page carries its own bounds while the URL's `range` still holds a default)
  // cannot be framed by that extent: the histogram would show unrelated bars
  // and the preset would read as active. Frame the window itself instead, with
  // no preset highlighted; zoom-out falls back to the smallest broader preset.
  const winOutsideExtent = Boolean(
    win.start &&
      extentWin.start &&
      new Date(win.start).getTime() < new Date(extentWin.start).getTime(),
  )
  const extentKey = winOutsideExtent ? CUSTOM_KEY : range
  const extentBucket = winOutsideExtent
    ? bucketForWindow(win.start as string, win.end)
    : (extentPreset?.bucket ?? "day")
  const contextFilters: UsageFilters = useMemo(
    () => ({
      workspace_id: workspace?.workspace_id,
      start_date: winOutsideExtent ? win.start : extentWin.start,
      end_date: winOutsideExtent ? win.end : undefined,
      status: statusFilter || undefined,
      model: modelFilters.length > 0 ? modelFilters : undefined,
      user_id: userFilters.length > 0 ? userFilters : undefined,
      api_key_id: apiKeyFilters.length > 0 ? apiKeyFilters : undefined,
      source: sourceFilter || undefined,
      source_label: sessionFilter || undefined,
      status_code: statusCodeFilter || undefined,
      endpoint: endpointFilter || undefined,
      provider: providerFilter || undefined,
      tool: (toolFilter || undefined) as UsageFilters["tool"],
      priced,
      q: search || undefined,
      ...refinements,
    }),
    [
      refinements,
      search,
      workspace?.workspace_id,
      winOutsideExtent,
      toolFilter,
      win,
      extentWin,
      statusFilter,
      modelFilters,
      userFilters,
      apiKeyFilters,
      sourceFilter,
      sessionFilter,
      statusCodeFilter,
      endpointFilter,
      providerFilter,
      priced,
    ],
  )
  // The timeline reads `series`. Whether the window holds tool usage is the
  // Model funnel's own read, made when it opens.
  const contextSummary = useUsageSummary(
    contextFilters,
    extentBucket,
    NO_BREAKDOWNS,
  )
  // What the rows add up to over every page, for the strip above the table.
  // The summary reads an omitted start as the last 30 days, so under "All" the
  // totals take the year the chart spans, and the two agree.
  const totalsFilters = useMemo(
    () =>
      readFilters.start_date
        ? readFilters
        : { ...readFilters, start_date: extentWin.start },
    [readFilters, extentWin.start],
  )
  const totalsSummary = useUsageSummary(
    totalsFilters,
    "day",
    NO_BREAKDOWNS,
    true,
    "caller",
    { includeP95: true },
  )
  // The groups read the window the totals do, so the two add up alike.
  const logGroups = useUsageLogGroups(totalsFilters, groupBy ?? "model", {
    limit: groupLimit,
    enabled: isGrouped,
    refetchInterval: liveRefetch,
  })
  const groupRows = isGrouped ? logGroups.data?.groups : undefined
  const openGroupRows = (groupRows ?? []).filter((group) =>
    openGroups.has(groupId(group)),
  )
  const previewFilters = useMemo(
    () => ({ ...filters, start_date: totalsFilters.start_date }),
    [filters, totalsFilters.start_date],
  )
  const previewReads = useUsageLogPreviews(
    groupBy
      ? openGroupRows.map((group) =>
          groupFilters(previewFilters, groupBy, group.key),
        )
      : [],
    GROUP_PREVIEW,
    { refetchInterval: liveRefetch },
  )
  const previews = new Map(
    openGroupRows.map((group, index) => [
      groupId(group),
      {
        rows: previewReads[index]?.data,
        isLoading: previewReads[index]?.isLoading ?? false,
      },
    ]),
  )
  const previewRows = openGroupRows.flatMap(
    (_group, index) => previewReads[index]?.data ?? [],
  )
  const previewRowsKey = previewRows.map((row) => row.id).join(",")

  const timelineSeries = (contextSummary.data?.series ?? []).map((point) => ({
    bucketStart: point.bucket_start,
    requests: point.requests,
    // Failed requests render as a red segment on the strip, so dropped traffic
    // shows up while browsing, not only after filtering to status=error.
    errors: point.errors ?? 0,
  }))

  // What the panel walks and the outcomes are read for: the page, or the
  // open groups' newest rows in the order the groups are listed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the rows' ids, not the array each render builds
  const groupedRows = useMemo(() => previewRows, [previewRowsKey])
  const pageRows = isGrouped ? groupedRows : (usage.data ?? [])

  // What the live control may report. A failed poll leaves the list unknown, not
  // unchanged: TanStack keeps the last successful payload, so without the
  // `isError` arm the count would sit there with its waits climbing against a
  // frozen anchor, asserting that work is running which may have landed minutes
  // ago. That is the state `useInFlightRequests` already refuses to cache across
  // mounts, so it must not be reachable by this route either. The failure reaches
  // the operator through the page's error banner instead.
  const liveNow = inFlight.isError ? undefined : inFlight.data

  // What served each routed request on this page. Built from the page itself where
  // possible (a group's attempts are written milliseconds apart, so they are
  // usually adjacent in a newest-first list), and looked up for the groups whose
  // outcome row is missing: a page boundary splits a group, and filtering to the
  // `absorbed` status (the way an operator investigates fallovers) hides every
  // outcome row by construction, which is precisely when the answer is wanted.
  // A served row is looked up as well when its earlier attempts are off the page,
  // so it can still say what it spilled over from.
  const { pageOutcomes, unresolvedGroupIds } = useMemo(() => {
    const known = indexGroupOutcomes(pageRows)
    const missing = new Set([
      ...pageRows.flatMap((row) =>
        row.status === "absorbed" &&
        row.request_group_id &&
        !known.has(row.request_group_id)
          ? [row.request_group_id]
          : [],
      ),
      // A served row whose skipped or failed attempts fell on the next page.
      ...findGroupsMissingEarlierAttempts(pageRows),
      // With recovered attempts shown, every request that had one, to list them.
      ...(showRecovered ? groupsWithEarlierAttempts(pageRows) : []),
    ])
    return { pageOutcomes: known, unresolvedGroupIds: [...missing] }
  }, [pageRows, showRecovered])
  const unresolvedGroups = useRequestGroups(unresolvedGroupIds)
  const groupOutcomes = useMemo(() => {
    if (!unresolvedGroups.data?.length) return pageOutcomes
    return new Map([
      ...pageOutcomes,
      ...indexGroupOutcomes(unresolvedGroups.data),
    ])
  }, [pageOutcomes, unresolvedGroups.data])
  const { rows, nested } = useMemo(
    () =>
      showRecovered
        ? nestRecoveredAttempts(pageRows, unresolvedGroups.data ?? [])
        : { rows: pageRows, nested: NONE_NESTED },
    [showRecovered, pageRows, unresolvedGroups.data],
  )

  const totalIsExact = count.isSuccess && !count.isPlaceholderData
  const total = totalIsExact ? (count.data?.total ?? 0) : null

  // Rows that have landed since this page was drawn, as the gap between the polled
  // count and the pinned one. Clamped at zero because the gap can close from the
  // other side: a delete makes the live figure the smaller one, and "-14 new"
  // is not a thing to show an operator.
  //
  // Gated on the same condition as the poll: `page` is not part of the live count's
  // key, so disabling the query on page 2 stops it refetching but still hands back
  // the payload it cached on page 1. Without this the badge would follow the
  // operator forward and offer rows that pressing it cannot bring into view.
  const newRows =
    newRowsRelevant && total != null && liveCount.data
      ? Math.max(0, liveCount.data.total - total)
      : 0

  // Whether the page can still tell newer rows from none. The badge's absence
  // otherwise reads as "nothing has landed", which on a table that no longer moves
  // by itself makes a flooded gateway look identical to an idle one. Said in the
  // control strip rather than the error banner: the count failing costs the
  // operator a hint, not the log they came for, and `retry: false` means a single
  // blip would otherwise raise a page-level alarm the next poll silently clears.
  const newRowsUnknown = newRowsRelevant && liveCount.isError
  // Neither the default preset nor the unbounded "All" is itself a filter: only an
  // explicit sub-window or a bounded non-default preset narrows the window, so a
  // brand-new gateway reads "never used" on both its 24h default and on "All",
  // and only a real narrowing reads "filtered empty".
  const rangePreset = findPreset(ACTIVITY_PRESETS, range)
  const timeFiltered =
    Boolean(startParam || endParam) ||
    (range !== ACTIVITY_DEFAULT_KEY && rangePreset?.seconds != null)
  const anyFilter = Boolean(
    statusValues.length ||
      url.getAll("channel").length ||
      url.getAll("is_null").length ||
      modelFilters.length ||
      (observeScope === "everyone" && userFilters.length) ||
      apiKeyFilters.length ||
      pricedFilter ||
      sourceFilter ||
      sessionFilter ||
      statusCodeFilter ||
      endpointFilter ||
      providerFilter ||
      toolFilter ||
      search ||
      hasRefinements ||
      timeFiltered,
  )

  const setModelPrice = useSetPricing()
  // Bumped on every open of the price dialog and used as its key, so the
  // rates are cleared on the way in. Clearing them on close would blank the
  // fields while the dialog is still animating away, and these values set
  // money.
  const [priceOpenCount, setPriceOpenCount] = useState(0)
  // The model selector whose price is being set from a request detail, and
  // unset when that dialog is closed.
  const [modelPriceKey, setModelPriceKey] = useState<string>()
  const [modelPriceUnit, setModelPriceUnit] = useState<PricingUnit>("token")
  const priceModel = scope.isDeploymentWide
    ? (model: string, endpoint: string) => {
        setPriceOpenCount((count) => count + 1)
        setModelPriceUnit(pricingUnitForEndpoint(endpoint))
        setModelPriceKey(model)
      }
    : undefined

  // The open request lives in the URL, so it is linkable. Opening one from the
  // list is a history entry, so Back closes it; walking and closing replace it.
  const navigate = useNavigate()
  // Answered for this view: a query still disabled (its scope unresolved) is
  // neither loading nor fetching, and has answered nothing.
  const pageSettled = usage.isSuccess && !usage.isPlaceholderData
  const pageIndex = rows.findIndex((row) => row.id === requestId)
  // A link may name the request rather than one of its rows: the
  // `Otari-Request-ID` a caller got back is the `request_group_id` its rows share,
  // never a row's own id. Looked up once the page holds no such row, and opened on
  // the request's outcome row, whether or not that row is on this page.
  const linkedRequest = useRequestGroups(
    requestId !== "" && pageIndex < 0 && pageSettled ? [requestId] : [],
  )
  const linkedEntry =
    pageIndex < 0
      ? findRequestOutcome(linkedRequest.data ?? [], requestId)
      : undefined
  const openIndex =
    pageIndex >= 0
      ? pageIndex
      : rows.findIndex((row) => row.id === linkedEntry?.id)
  const openEntry = openIndex >= 0 ? rows[openIndex] : linkedEntry
  const openRequest = (id: string) => {
    if (id === requestId) return
    navigate({
      to: ".",
      search: (prev) => ({ ...(prev as DashboardSearch), request: id }),
    })
  }
  // Previous and next walk the loaded page only: J/K stop at its edges.
  const previousEntry = openIndex > 0 ? rows[openIndex - 1] : undefined
  const nextEntry =
    openIndex >= 0 && openIndex < rows.length - 1
      ? rows[openIndex + 1]
      : undefined
  // A link to a row that is not on this page, and names no request either, opens
  // nothing; say so rather than ignore it. Only once the page and the lookup have
  // both answered, or a loading page would flash it; a failed lookup is reported
  // in the error banner instead.
  const requestMissing =
    requestId !== "" &&
    openEntry === undefined &&
    pageSettled &&
    linkedRequest.isSuccess &&
    !linkedRequest.isPlaceholderData
  // Below md the panel covers the page, which then takes no focus or presses.
  // Stable per open row, so DataTable's row cache holds while the page polls.
  // `is-peeked` washes the cells (see globals.css) and composes with the row's
  // own failure tint.
  const openId = openEntry?.id ?? ""
  const rowClassName = useCallback(
    (entry: UsageEntry) =>
      [
        getActivityRowClassName(entry),
        entry.id === openId ? "is-peeked" : undefined,
        nested.has(entry.id) ? "is-nested" : undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    [openId, nested],
  )

  // Sets the model's own price (a ModelPricing row), which is what future
  // requests are billed at. Deliberately does not touch the rows already logged:
  // a gateway row's cost is what it was served at, and rewriting history from an
  // activity view would move spend that budgets were already enforced against.
  // Awaited by the dialog, which owns the pending and error state below its own
  // key: a refusal cannot then greet the next open. `mutateAsync`, so a
  // rejection reaches it rather than being reported from page state that
  // outlives the form.
  const onSetModelPrice = (rates: ManualRates, modelKey: string) =>
    setModelPrice.mutateAsync(
      rates.rates !== undefined
        ? { model_key: modelKey, rates: rates.rates }
        : {
            model_key: modelKey,
            input_price_per_million: rates.input_price_per_million,
            output_price_per_million: rates.output_price_per_million,
            cache_read_price_per_million:
              rates.cache_read_price_per_million ?? null,
            cache_write_price_per_million:
              rates.cache_write_price_per_million ?? null,
            unit: rates.unit ?? "token",
          },
      { onSuccess: () => setModelPriceKey(undefined) },
    )

  // Refresh means "same view, newer rows", so it deliberately does *not* re-anchor
  // a rolling preset's window. Re-anchoring recomputed "now", which changed
  // `filters`, which tripped the page reset below: pressing refresh on page 12
  // dropped the operator back onto page 1, making deep browsing unusable. The
  // window is instead re-anchored when the range selection changes (see
  // `pickPreset`). Every window-scoped query is refetched explicitly, since the
  // keys are unchanged by design here.
  const refresh = () => {
    void usage.refetch()
    void count.refetch()
    // Re-read alongside the count it is compared against, or the badge would keep
    // offering rows the refresh just loaded. Guarded because refetch() ignores
    // `enabled`.
    if (newRowsRelevant) {
      void liveCount.refetch()
    }
    void inFlight.refetch()
    void contextSummary.refetch()
    void totalsSummary.refetch()
  }

  // A rolling preset clears any explicit bounds; a timeline selection sets them
  // (the preset key is left as-is, since it still names the extent).
  const pickPreset = (preset: RangePreset) => {
    // Re-picking the preset that is already active is the explicit "re-anchor to
    // now" gesture. It leaves the URL untouched, so the effect that snapshots the
    // window never fires; do it here instead. (Going *to* a different preset, or
    // off an explicit range, changes the URL and that effect handles it, so
    // re-anchoring here as well would fire a second query for the same view.)
    if (preset.key === range && !startParam && !endParam) {
      // Both windows off one reading, for the same reason as at mount: two reads
      // would leave the list window a millisecond behind the extent it sits in.
      const clock = Date.now()
      setWin(resolveWindow(preset.key, "", "", clock))
      setExtentWin(resolveExtentWindow(preset.key, clock))
      return
    }
    url.patch({ range: preset.key, start_date: "", end_date: "" })
  }
  const pickCustom = (startIso: string, endIso: string) =>
    url.patch({ start_date: startIso, end_date: endIso })

  // Memoized on its per-render inputs (the roster labels and the routing
  // outcomes, both themselves memoized) so DataTable's per-row cache holds: a
  // fresh array every render would rebuild all rows per click.
  // Inside the Overview the filters are set from the headers: a funnel on each
  // column a filter reads (`OBSERVE_FILTER_COLUMNS`). Built apart from the
  // columns, so a funnel is the same element while the routing outcomes the
  // columns read come in.
  const funnels = useMemo(() => {
    const funnel = (column: string) => {
      const filter = embedded ? funnelFor("requests", column) : undefined
      return filter ? (
        <ObserveColumnFilter view="requests" {...filter} />
      ) : undefined
    }
    return {
      user: funnel("user"),
      model: funnel("model"),
      routing: funnel("routing"),
      apiKey: funnel("api_key"),
      input: funnel("input_tokens"),
      output: funnel("output_tokens"),
      cost: funnel("cost"),
      latency: funnel("latency"),
      status: funnel("status"),
    }
  }, [embedded])
  // A cell's own "only this" and "exclude" write the URL keys its column's
  // funnel writes, read off the search as it stands when pressed.
  const filterCell = useCallback(
    (dimension: CellDimension, value: string | null, mode: CellFilterMode) =>
      navigate({
        to: ".",
        search: (prev) =>
          applyCellFilter(prev as DashboardSearch, dimension, value, mode),
      }),
    [navigate],
  )
  const filterTool = useCallback(
    (entry: UsageEntry) =>
      navigate({
        to: ".",
        search: (prev) => {
          const {
            page: _page,
            request: _request,
            ...rest
          } = prev as DashboardSearch
          return { ...rest, tool: toolFilterFor(entry) }
        },
      }),
    [navigate],
  )
  // Under Mine the scope already decided whose rows these are.
  const filtersUsers = observeScope !== "mine"
  const columns = useMemo<DataTableColumn<UsageEntry>[]>(() => {
    const filterable = (
      dimension: CellDimension,
      value: string | null,
      label: string,
      shown: ReactNode,
    ) => (
      <CellFilter
        value={value}
        label={label}
        canExclude={value !== null}
        onFilter={(picked, mode) => filterCell(dimension, picked, mode)}
      >
        {shown}
      </CellFilter>
    )
    const built: DataTableColumn<UsageEntry>[] = [
      TIME_COLUMN,
      {
        id: "user",
        header: "User",
        headerAction: funnels.user,
        cell: (entry) => {
          const label =
            entry.user_id === null
              ? "No user"
              : userDisplay(entry.user_id, entry.user_alias, memberLabels).label
          const shown =
            entry.user_id === null ? (
              "—"
            ) : (
              <span className="block truncate" title={label}>
                {label}
              </span>
            )
          return filtersUsers
            ? filterable("user", entry.user_id, label, shown)
            : shown
        },
      },
      {
        ...MODEL_COLUMN,
        headerAction: funnels.model,
        cell: (entry) =>
          filterable(
            "model",
            entry.model,
            entry.model,
            modelCell(entry, filterTool),
          ),
      },
      {
        id: "routing",
        header: "Routing",
        headerAction: funnels.routing,
        // The policy the caller named, plus where this row sits in its plan and how
        // that turned out. The Model column keeps meaning the model that actually
        // ran (it is the join key for filters and for spend-by-model), so this is
        // additive: together they answer "what did I ask for, and what served it".
        cell: (entry) =>
          filterable(
            "policy",
            entry.policy_name ?? null,
            entry.policy_name ?? "Direct requests",
            <RoutingCell
              entry={entry}
              outcome={groupOutcomes.get(entry.request_group_id ?? "") ?? null}
            />,
          ),
      },
      {
        ...API_KEY_COLUMN,
        headerAction: funnels.apiKey,
        cell: (entry) =>
          filterable(
            "api_key",
            entry.api_key_id,
            entry.api_key_id === null ? "No API key" : apiKeyLabel(entry),
            API_KEY_COLUMN.cell(entry),
          ),
      },
      {
        ...INPUT_TOKENS_COLUMN,
        headerAction: funnels.input,
      },
      {
        ...OUTPUT_TOKENS_COLUMN,
        headerAction: funnels.output,
      },
      { ...COST_COLUMN, headerAction: funnels.cost },
      {
        id: "latency",
        header: "Total time",
        headerAction: funnels.latency,
        align: "end",
        cell: (entry) => formatLatencyCell(entry.latency_ms),
      },
      {
        ...STATUS_COLUMN,
        headerAction: funnels.status,
        cell: (entry) =>
          filterable(
            "status",
            entry.status,
            describeStatus(entry.status),
            STATUS_COLUMN.cell(entry),
          ),
      },
    ]
    // The server orders the whole window, so every column it can sort by
    // takes the press; the funnel and the resize handle keep their own.
    return built.map((column) =>
      SORTABLE_COLUMNS[column.id] ? { ...column, allowsSorting: true } : column,
    )
  }, [
    groupOutcomes,
    memberLabels,
    funnels,
    filterCell,
    filterTool,
    filtersUsers,
  ])
  // On a desk the person's own layout: their widths, without the columns they
  // hid. The phone's cards keep every field, since nothing there can bring a
  // hidden one back.
  const layout = useObserveTableLayout("requests")
  const shownColumns = useMemo(
    () =>
      isMobile ? columns : laidOutColumns("requests", columns, layout.hidden),
    [isMobile, columns, layout.hidden],
  )

  const emptyContent = anyFilter
    ? "No requests match these filters."
    : "No requests recorded yet."
  // Who sent a row, as the phone's second line names them: the person, or the
  // key where the list is the reader's own.
  const senderOf = (entry: UsageEntry) =>
    filtersUsers && entry.user_id !== null
      ? userDisplay(entry.user_id, entry.user_alias, memberLabels).label
      : apiKeyLabel(entry)
  // Picking a grouping while a column sort holds returns the log to newest
  // first, which is what lets the grouping apply.
  const pickGrouping = (next: string) =>
    url.patch({
      group: next,
      ...(next && groupPaused ? { sort: "", order: "" } : {}),
      page: 0,
      request: "",
    })

  // What says the log is still moving: the in-flight count, Live, the badge
  // while paused, and Refresh. Inside the Overview they sit at the end of the
  // filter row; on its own the page puts them beside the chart.
  const liveControls = (
    <span className="inline-flex items-center gap-2">
      {/* Both live signals sit here, beside the control that acts on them:
        the table below never moves on its own, so this strip is the only
        place the page says anything is still happening. */}
      {/* Rendered whenever the poll is answering at all, not only when it
        reports traffic: the control hides itself while idle, but has to
        stay mounted to keep an open list open across the moment the last
        request lands. It still goes on a failed poll, where `liveNow` is
        undefined, since there is nothing trustworthy left to report. */}
      {liveNow ? (
        <InFlightControl data={liveNow} updatedAt={inFlight.dataUpdatedAt} />
      ) : null}
      <LiveControl
        isWanted={liveWanted}
        pause={livePause}
        onChange={(wanted, resume) => {
          setLiveWanted(wanted)
          // Resuming clears what held it: the first page of the newest
          // requests, newest first, with nothing open.
          if (resume) url.patch({ page: 0, request: "", sort: "", order: "" })
        }}
      />
      {newRows > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          onPress={refresh}
          isDisabled={usage.isFetching}
        >
          {formatNumber(newRows)} new · load
        </Button>
      ) : null}
      {newRowsUnknown ? (
        <span
          className="text-caption"
          title="The row count could not be read, so this page cannot tell whether newer requests have landed. Refresh to load whatever is there."
        >
          Newer rows unknown
        </span>
      ) : null}
      <RefreshButton
        onRefresh={refresh}
        isFetching={usage.isFetching}
        updatedAt={usage.dataUpdatedAt}
      />
    </span>
  )

  return (
    <div className="flex flex-col">
      <div
        className="flex flex-col"
        inert={openEntry !== undefined && isMobile}
      >
        {/* Inside the Overview the layout owns the heading. */}
        {embedded ? null : <PageIntro title="Activity" />}
        {embedded ? (
          <ObserveFilterRow
            view="requests"
            controls={
              isMobile ? undefined : (
                <GroupByControl
                  value={groupBy}
                  isPaused={groupPaused}
                  offersPerson={filtersUsers}
                  onChange={pickGrouping}
                />
              )
            }
            search={
              <ObserveSearchBox
                value={url.get("q")}
                onCommit={(term) =>
                  url.patch({ q: term, page: 0, request: "" })
                }
              />
            }
            end={liveControls}
          />
        ) : null}

        {/* The timeline's summary error is included so a failed series request
          reads as a failure, not as an empty "No activity in this range" strip. */}
        {/* The in-flight error is last: a failure to read the log itself is the more
          important thing to say. It is here at all so a live view that has gone
          quiet is distinguishable from a gateway that has, since the rows are
          dropped on failure rather than left to go stale. */}
        <ErrorBanner
          error={
            usage.error ??
            linkedRequest.error ??
            count.error ??
            contextSummary.error ??
            totalsSummary.error ??
            inFlight.error
          }
        />

        <div className="flex flex-col gap-3">
          <ActivityTimeline
            presets={ACTIVITY_PRESETS}
            hidePresets={embedded}
            extentKey={extentKey}
            onPreset={pickPreset}
            onSelectRange={pickCustom}
            onSelectFull={() =>
              extentPreset ? pickPreset(extentPreset) : undefined
            }
            series={timelineSeries}
            bucket={extentBucket}
            windowStart={win.start}
            windowEnd={win.end}
            loading={contextSummary.isLoading}
            ariaLabel="Activity request volume over the selected window"
            action={embedded ? undefined : liveControls}
          />
        </div>

        <RequestTotals
          totals={totalsSummary.data?.totals}
          isLoading={totalsSummary.isPending && !totalsSummary.data}
          isPinned={isMobile}
        />

        <div className="flex flex-col gap-3">
          {requestMissing ? (
            <div className="flex flex-wrap items-center gap-3">
              <InfoBanner>
                That request is not in the current results.
              </InfoBanner>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => url.patch({ request: "" })}
              >
                Dismiss
              </Button>
            </div>
          ) : null}
          {isMobile ? (
            <PhoneRequestList
              rows={rows}
              isLoading={usage.isLoading}
              senderOf={senderOf}
              openId={openId}
              onOpen={openRequest}
              onMore={
                rows.length >= phoneLimit &&
                phoneLimit < PHONE_LIMIT_MAX &&
                (total === null || total > rows.length)
                  ? () =>
                      setPhoneLimit((limit) =>
                        Math.min(PHONE_LIMIT_MAX, limit + PHONE_BATCH),
                      )
                  : undefined
              }
              isFetchingMore={usage.isFetching && usage.isPlaceholderData}
              emptyContent={emptyContent}
            />
          ) : isGrouped && groupBy ? (
            <GroupedRequests
              groupBy={groupBy}
              groups={groupRows}
              total={logGroups.data?.total ?? 0}
              isLoading={logGroups.isLoading}
              memberLabels={memberLabels}
              openGroups={openGroups}
              onToggleGroup={(id) =>
                setOpenGroups((current) => {
                  const next = new Set(current)
                  if (!next.delete(id)) next.add(id)
                  return next
                })
              }
              previews={previews}
              columns={shownColumns}
              onOpenRequest={openRequest}
              rowClassName={rowClassName}
              onShowAll={(group) =>
                navigate({
                  to: ".",
                  search: (prev) =>
                    showGroupSearch(
                      prev as DashboardSearch,
                      groupBy,
                      group.key,
                    ),
                })
              }
              onMore={
                (groupRows?.length ?? 0) < (logGroups.data?.total ?? 0) &&
                groupLimit < GROUP_PAGE_MAX
                  ? () =>
                      setGroupLimit((limit) =>
                        Math.min(GROUP_PAGE_MAX, limit + GROUP_PAGE),
                      )
                  : undefined
              }
              isFetchingMore={
                logGroups.isFetching && logGroups.isPlaceholderData
              }
              emptyContent={emptyContent}
            />
          ) : (
            <>
              <TableScrollFrame className="otari-activity-table">
                <DataTable
                  ariaLabel="Activity log"
                  columns={shownColumns}
                  isResizable
                  sortDescriptor={sortDescriptorFor(sort)}
                  onSortChange={(descriptor) =>
                    url.patch({
                      ...sortUrl(nextSort(sort, String(descriptor.column))),
                      page: 0,
                      request: "",
                    })
                  }
                  columnWidths={layout.widths}
                  onColumnResizeEnd={layout.resize}
                  rows={rows}
                  getRowKey={getActivityRowKey}
                  isLoading={usage.isLoading}
                  emptyContent={emptyContent}
                  onRowAction={openRequest}
                  rowClassName={rowClassName}
                />
              </TableScrollFrame>

              <TablePagination
                page={page}
                pageSize={pageSize}
                total={total}
                rowsOnPage={rows.length}
                // Paging re-reads the count as well as the rows. The total is a property of
                // the filters, not of the page, so it is not in the count's key and a frozen
                // page would carry whichever value it loaded with. That understates a table
                // traffic has grown, and `TablePagination` derives `isLast` from the total
                // whenever it has one, so the operator hits a wall short of the real end and
                // the oldest rows sit past it, unreachable until a manual refresh. Paging is
                // a deliberate act, so re-reading here keeps the total describing a set the
                // operator can actually navigate, without putting a self-moving number under
                // a table that deliberately holds still.
                onPageChange={(next) => {
                  url.patch({ page: next, request: "" })
                  void count.refetch()
                }}
                onPageSizeChange={(size) =>
                  url.patch({ size, page: 0, request: "" })
                }
                isFetching={usage.isFetching}
                hasNextFallback={rows.length === pageSize}
              />
            </>
          )}
        </div>
      </div>

      {openEntry ? (
        <RequestPeek
          entry={openEntry}
          position={
            openIndex >= 0 ? `${openIndex + 1} / ${rows.length}` : undefined
          }
          onPriceModel={priceModel}
          onClose={() => url.patch({ request: "" })}
          onPrevious={
            previousEntry
              ? () => url.patch({ request: previousEntry.id })
              : undefined
          }
          onNext={
            nextEntry ? () => url.patch({ request: nextEntry.id }) : undefined
          }
        />
      ) : null}

      <SetPriceDialog
        key={`model-${priceOpenCount}`}
        isOpen={modelPriceKey !== undefined}
        onOpenChange={(open) =>
          setModelPriceKey(open ? (modelPriceKey ?? "") : undefined)
        }
        onSubmit={onSetModelPrice}
        submitLabel="Price this model"
        collectModelKey
        initialModelKey={modelPriceKey ?? ""}
        chooseUnit
        initialUnit={modelPriceUnit}
        title="Price this model"
        description="Set what this model costs, taken from the request you were looking at. Requests from now on are costed at these rates and counted against budgets; rows already logged keep the cost they were served with."
      />
    </div>
  )
}
