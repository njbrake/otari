import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { FiKey, FiLayers, FiList, FiMinusCircle } from "react-icons/fi"
import { RefreshButton } from "@/design-system/actions/RefreshButton"
import { RowMenu, type RowMenuAction } from "@/design-system/actions/RowMenu"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { useIsMobile } from "@/design-system/hooks/useIsMobile"
import { PageIntro } from "@/design-system/layout/PageIntro"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import { Sparkline } from "@/design-system/metrics/charts"
import { KpiCell } from "@/design-system/metrics/KpiCell"
import { KpiStrip } from "@/design-system/metrics/KpiStrip"
import { TrendChip } from "@/design-system/metrics/TrendChip"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import {
  HOME_CUTS,
  type HomeCut,
  rowExclusion,
  rowFilter,
} from "@/features/home/breakdownCuts"
import { FigureLinks } from "@/features/home/FigureLinks"
import { failureSeverity, spendSplit } from "@/features/home/homeFigures"
import {
  HOME_CHART_URL,
  HomeWindowPicker,
  homeWindow,
  labelFromRows,
} from "@/features/home/homeWindow"
import { canOpenInKeys } from "@/features/home/keyAccess"
import { MemberAttentionBand } from "@/features/home/MemberAttentionBand"
import { MemberFirstRun } from "@/features/home/MemberFirstRun"
import { MonthBudget } from "@/features/home/MonthBudget"
import {
  hasActiveKey,
  isSpendRefusal,
  lowerLimitNote,
  memberLimit,
  memberLimitLabel,
  rosterRowOf,
  unseenLimitLines,
} from "@/features/home/memberHomeModel"
import { hasProviderSlot, ProviderSlot } from "@/features/home/ProviderSlot"
import { RecentFailures } from "@/features/home/RecentFailures"
import { RowOpenLink } from "@/features/home/RowOpenLink"
import { ShareCell } from "@/features/home/ShareCell"
import { ShareDialog } from "@/features/home/ShareDialog"
import { shareCardOf } from "@/features/home/shareCard"
import { ToolsBreakdown } from "@/features/home/ToolsBreakdown"
import {
  UsageBreakdownChart,
  useBreakdownChart,
} from "@/features/home/UsageBreakdownChart"
import { metricFromUrl } from "@/features/home/usageChartModel"
import { useHomeRefresh } from "@/features/home/useHomeRefresh"
import { useMemberAttention } from "@/features/home/useMemberAttention"
import { useSpendDetail } from "@/features/home/useSpendDetail"
import { useCanCreateKey } from "@/features/organization/access"
import { useCurrentOwner } from "@/features/organization/attribution"
import { wholePct } from "@/features/spend/limits"
import {
  comparedWith,
  DEFAULT_PERIOD,
  figureLabel,
  periodFromUrl,
  sessionsSearchFor,
  windowOf,
  windowSpan,
  windowWords,
} from "@/features/spend/period"
import { usePageClock } from "@/features/spend/usePageClock"
import {
  isFoldRow,
  type ReadState,
  readState,
  type SpendRow,
  spendFigures,
  useSpend,
} from "@/features/spend/useSpend"
import {
  BreakdownSortSelect,
  breakdownFigureColumns,
  breakdownSortProps,
  MODEL_P95_NOTE,
  NotChargedLine,
} from "@/features/usage/BreakdownColumns"
import { fittedColumns } from "@/features/usage/breakdownFit"
import {
  sortFromUrl,
  sortRows,
  sortToUrl,
} from "@/features/usage/breakdownSort"
import { TopModelCell } from "@/features/usage/TopModelCell"
import { billedTokenTotal, cacheSums } from "@/features/usage/usageTotals"
import { useTopModels } from "@/features/usage/useTopModels"
import { useKeys } from "@/shared/api/apiKeys"
import {
  useOrganizationContext,
  useOrganizationMembers,
} from "@/shared/api/organizations"
import { useTraceCount } from "@/shared/api/traces"
import { useRefusedUsage, useUsageSummary } from "@/shared/api/usage"
import { useWorkspaceBudgetDefaults } from "@/shared/api/workspaces"
import {
  deltaFraction,
  formatNumber,
  formatPct,
  formatRelative,
  formatTokens,
  formatUsd,
} from "@/shared/helpers/format"
import { useUrlState } from "@/shared/helpers/urlState"
import { useSurfaces } from "@/shared/hooks/useDeployment"
import { useElementWidth } from "@/shared/hooks/useElementWidth"

const CUTS = (
  [
    "keys",
    "models",
    "providers",
    "sessions",
    "channels",
    "policies",
    "tools",
  ] satisfies HomeCut[]
).map((one) => HOME_CUTS[one])

const URL_DEFAULTS = {
  period: DEFAULT_PERIOD,
  by: "",
  sort: "",
  order: "",
  ...HOME_CHART_URL,
}

/**
 * Home for someone who uses the team rather than runs it: the owner's Home,
 * for one person. Four figures (spent, their limit, tokens, and sessions, or
 * failures where the deployment records no sessions), and where it went by
 * their keys or their models, all over their own requests in the selected
 * team. Nothing about anyone else, and no control the server would refuse them.
 */
export function MemberHome({
  workspaceId,
  workspace,
  notice,
}: {
  /** A band under the title, such as the first step on a fresh gateway. */
  notice?: ReactNode
  workspaceId: string
  workspace: string
}) {
  // One clock for the page's life, so its windows and query keys hold still.
  const [now, refreshClock] = usePageClock()
  const navigate = useNavigate()
  const { get, patch } = useUrlState(URL_DEFAULTS)
  const isMobile = useIsMobile()
  const [measureTable, tableWidth] = useElementWidth<HTMLDivElement>()
  const owner = useCurrentOwner()
  const me = owner.ownerId || undefined
  const canCreateKey = useCanCreateKey()
  const callerUserId =
    useOrganizationContext().data?.caller?.user_id ?? undefined
  const { refresh, isFetching } = useHomeRefresh(refreshClock)

  const period = periodFromUrl(get("period"))
  const window = homeWindow(period, get("start"), get("end"), now)
  // A deployment that records no sessions serves no route to count them, and
  // has none to open or to break spend down by.
  const hasSurface = useSurfaces()
  const hasSessions = hasSurface("traces")
  const cuts = CUTS.filter((one) => one.value !== "sessions" || hasSessions)
  const cut = cuts.find((one) => one.value === get("by")) ?? cuts[0]
  const sort = sortFromUrl(get("sort"), get("order"))

  const spend = useSpend(window, {
    workspaceId,
    userId: me,
    isEnabled: me !== undefined,
    resetEndedAt: now,
    breakdown: cut.dimension ? { dimension: cut.dimension, sort } : undefined,
  })
  const keys = useKeys(workspaceId)
  const attention = useMemberAttention({
    now,
    owner: { userId: me, isPending: owner.isPending, isFailed: owner.isFailed },
    workspaceId,
    keys,
    callerUserId,
  })
  const detail = useSpendDetail({
    window,
    now,
    workspaceId,
    userId: me,
    isEnabled: me !== undefined,
  })
  const members = useOrganizationMembers()
  const defaults = useWorkspaceBudgetDefaults(workspaceId)
  // Sessions cannot filter on a provider and the cuts after it, so their
  // rows open Requests.
  const canOpenRows = cut.to === "/sessions" ? hasSessions : hasSurface("usage")
  const sessions = useTraceCount(
    {
      workspaceId,
      start: window.start,
      end: window.end || undefined,
      q: "",
      userIds: me ? [me] : undefined,
    },
    hasSessions,
  )
  const ownKeys = new Map((keys.data ?? []).map((key) => [key.id, key]))
  // Rows the window spent on: keys with nothing spent are on Keys.
  const cutRows: Partial<Record<HomeCut, SpendRow[]>> = {
    keys: spend.keys,
    models: spend.models,
    providers: spend.providers,
    sessions: spend.sessions,
    channels: spend.channels,
    policies: spend.policies,
  }
  const rows: SpendRow[] = sortRows(cutRows[cut.value] ?? [], sort, {
    figuresOf: spendFigures,
    nameOf: (row) => row.name,
    isLast: isFoldRow,
  })
    .filter((row) => row.requests > 0 || row.cost > 0)
    .map((row) => {
      if (cut.value !== "keys") return row
      const key = row.filterKey ? ownKeys.get(row.filterKey) : undefined
      if (!key) return row
      return {
        ...row,
        detail: key.last_used_at
          ? `Used ${formatRelative(key.last_used_at)}`
          : "Never used",
      }
    })
  const hasTopModel = cut.value === "keys" || cut.value === "providers"
  const topModels = useTopModels({
    rows: hasTopModel ? rows : [],
    cut: cut.value === "providers" ? "providers" : "keys",
    window,
    workspaceId,
    userId: me,
  })
  const hasMarkSlot = cut.value === "providers" && hasProviderSlot(rows)

  const total = spend.totals?.cost ?? 0
  const requestCount = spend.totals?.request_count ?? 0
  const delta = deltaFraction(total, spend.previousCost)
  const cacheTotals = cacheSums(spend.series)
  // The count is the caller's once their id is in the request. Until one has
  // answered for it, an answer standing in from before is the workspace's.
  const [hasOwnCount, setHasOwnCount] = useState(false)
  if (!hasOwnCount && me && sessions.data && !sessions.isPlaceholderData) {
    setHasOwnCount(true)
  }
  const sessionCount =
    me && (hasOwnCount || !sessions.isPlaceholderData)
      ? sessions.data?.count
      : undefined
  const sessionsFailed =
    owner.isFailed ||
    (me !== undefined && sessions.isError && sessions.data === undefined)
  // What the spend figures stand on. A caller with no billing id has no
  // spend read for them at all.
  const usage: ReadState | "none" = owner.isFailed
    ? "failed"
    : owner.isPending
      ? "loading"
      : me
        ? spend.reads.usage
        : "none"
  const unreadLine =
    usage === "failed"
      ? "Could not load"
      : usage === "loading"
        ? "Loading"
        : undefined
  const words = windowWords(window)
  const isReading = !spend.totals && usage === "loading"
  const split = spendSplit(total, detail.charged)
  const hasNotCharged = split !== undefined
  // Charged and not charged lead, and stay whole: they reconcile Spent with
  // the person page's Charged. Today's spend only where nothing else is said.
  const spentFacts = split
    ? [
        `${formatUsd(split.charged)} charged`,
        `+${formatUsd(split.notCharged)} not charged`,
      ]
    : detail.today !== undefined
      ? [`${formatUsd(detail.today)} today`]
      : []
  const failed = spend.totals?.error_count ?? 0
  const hasRequests = hasSurface("usage")
  // A cell with no graphic still holds the row, or its figure drops off the
  // baseline of the cells beside it that have one.
  const hasGraphicRow = spend.series.length > 1 || Boolean(sessionCount)
  const slot = (graphic: ReactNode) =>
    graphic ?? (hasGraphicRow ? <span aria-hidden /> : undefined)
  const isFirstRun =
    !keys.isLoading && !hasActiveKey(keys.data ?? [], now) && sessionCount === 0
  const mySessions = {
    ...sessionsSearchFor(window),
    ...(me ? { user_id: me } : {}),
  }

  const limitReads = [readState(members), readState(defaults)]
  const limitRead: ReadState =
    owner.isFailed || limitReads.includes("failed")
      ? "failed"
      : limitReads.includes("loading")
        ? "loading"
        : "ready"
  const limit =
    limitRead === "ready"
      ? memberLimit({
          member: rosterRowOf(members.data ?? [], me),
          workspaceId,
          defaults: defaults.data ?? [],
          now,
        })
      : undefined
  // The note weighs the per-person figure against its own period, not the
  // window shown. Read from the refused requests themselves: the summary
  // counts every 403 alike, and only a spend refusal says the limit is why.
  // An unseen limit is only said to have refused the member over the window.
  const periodStart = limit?.kind === "default" ? limit.periodStart : ""
  const refusedSince = limit?.kind === "unseen" ? window.start : periodStart
  const refused = useRefusedUsage(
    { userIds: me ? [me] : undefined, workspaceId },
    refusedSince,
    100,
    me !== undefined && refusedSince !== "",
    limit?.kind === "unseen" ? window.end : "",
  )
  const spendRefusals =
    limit?.kind === "default"
      ? (refused.data ?? []).filter((row) => isSpendRefusal(row.error_message))
          .length
      : 0
  const periodSpend = useUsageSummary(
    {
      workspace_id: workspaceId,
      user_id: me ? [me] : undefined,
      start_date: periodStart,
    },
    "day",
    [],
    me !== undefined && spendRefusals > 0,
    "organization",
  )

  const unseen = unseenLimitLines({
    limit,
    // A caller with no billing id has no refused requests to read.
    refusals:
      me === undefined || refused.isError
        ? []
        : refused.data?.map((row) => row.error_message),
    words,
    workspace,
  })
  // An unseen limit reads as loading until its lines are known.
  const shown = limit?.kind === "unseen" && !unseen ? undefined : limit

  const limitWords =
    shown === undefined
      ? limitRead === "failed"
        ? "Could not load"
        : "Loading"
      : shown.kind === "own"
        ? isMobile
          ? `in ${workspace}, set by an owner or admin`
          : "Set by an owner or admin"
        : shown.kind === "default"
          ? `${shown.per ? `${shown.per}, ` : ""}for everyone in ${workspace}`
          : (unseen?.subline ?? "")

  const limitNote =
    (periodSpend.data && !periodSpend.isPlaceholderData
      ? lowerLimitNote({
          limit,
          since: periodSpend.data.start_date,
          spent: periodSpend.data.totals.cost,
          spendRefusals,
        })
      : undefined) ?? unseen?.note

  // A limit for each person that resets with the calendar month is the one a
  // month's running total can be read against.
  const monthCap =
    shown?.kind === "default" && shown.per === "a month" && shown.periodStart
      ? shown.amount
      : undefined
  // Only a limit the member can read is named; an unseen one is not "none".
  const noBudgetFact =
    shown?.kind === "default"
      ? `your limit is ${formatUsd(shown.amount)}${shown.per ? ` ${shown.per}` : ""}`
      : ""

  const metric = metricFromUrl(get("chart"))
  const isIncludingNotCharged = get("charged") !== "only"
  const chartView = useBreakdownChart({
    window,
    colorWindow: windowOf(period, now),
    now,
    workspaceId,
    userId: me,
    isEnabled: me !== undefined && !isFirstRun,
    groupBy: cut.groupBy,
    labelOf: labelFromRows(rows),
    metric,
    isIncludingNotCharged,
    totals: spend.series,
  })

  const openTo = cut.to === "/sessions" ? "/sessions" : "/requests"
  const searchFor = (row: SpendRow) => ({
    ...mySessions,
    ...rowFilter(cut.value, row),
  })
  const open = (row: SpendRow, to: "/sessions" | "/requests" = openTo) => {
    if (!rowFilter(cut.value, row)) return
    void navigate({ to, search: searchFor(row) })
  }

  const menuFor = (row: SpendRow): RowMenuAction[] => {
    const actions: RowMenuAction[] = []
    if (rowFilter(cut.value, row) && canOpenRows) {
      actions.push({
        id: "open",
        label: openTo === "/requests" ? "See its requests" : "See its sessions",
        hint: `What ran ${words}`,
        icon: FiLayers,
        run: () => open(row),
      })
      if (openTo === "/sessions" && hasSurface("usage")) {
        actions.push({
          id: "requests",
          label: "See its requests",
          hint: "Requests, only this",
          icon: FiList,
          run: () => open(row, "/requests"),
        })
      }
    }
    const exclusion = rowExclusion(cut.value, row)
    if (exclusion && hasSurface("usage")) {
      actions.push({
        id: "without",
        label: "See requests without it",
        hint: "Requests, this left out",
        icon: FiMinusCircle,
        run: () =>
          void navigate({
            to: "/requests",
            search: { ...mySessions, ...exclusion },
          }),
      })
    }
    if (cut.value === "keys" && canOpenInKeys(row.filterKey, keys.data ?? [])) {
      actions.push({
        id: "keys",
        label: "Open in API keys",
        hint: canCreateKey
          ? "Disable, edit or regenerate it"
          : "See its details",
        icon: FiKey,
        run: () => void navigate({ to: "/keys" }),
      })
    }
    return actions
  }

  const columns: DataTableColumn<SpendRow>[] = [
    {
      id: "name",
      header: cut.noun,
      isRowHeader: true,
      cell: (row) =>
        cut.value === "models" ? (
          <span
            className="line-clamp-2 text-mono-caption text-foreground [overflow-wrap:anywhere] md:max-w-[13rem] xl:max-w-[24rem]"
            title={row.spellings?.join("\n")}
          >
            {row.name}
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-3 md:max-w-[13rem]">
            {hasMarkSlot ? <ProviderSlot row={row} /> : null}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{row.name}</span>
              {row.detail ? (
                <span className="truncate text-caption">{row.detail}</span>
              ) : null}
            </span>
          </span>
        ),
    },
    {
      id: "cost",
      header: "Spent",
      align: "end",
      allowsSorting: true,
      cell: (row) => (
        <span className="flex flex-col items-end">
          <span className="text-mono-caption whitespace-nowrap text-foreground">
            {formatUsd(row.cost)}
            {(isMobile || !fit.has("share")) && total > 0 ? (
              <span className="text-muted">
                {" · "}
                {wholePct(row.cost / total)}
              </span>
            ) : null}
          </span>
          {hasNotCharged &&
          !isMobile &&
          !fit.has("charged") &&
          !fit.has("not_charged") ? (
            <NotChargedLine figures={spendFigures(row)} />
          ) : null}
        </span>
      ),
    },
    ...breakdownFigureColumns<SpendRow>({
      figuresOf: spendFigures,
      hasNotCharged,
      isP95Loading: spend.breakdown.isLoading,
      p95Note: cut.value === "models" ? MODEL_P95_NOTE : undefined,
    }),
    ...(hasTopModel
      ? ([
          {
            id: "model",
            header: "Top model",
            cell: (row) => (
              <TopModelCell
                state={topModels.get(row.id)}
                rowCost={row.cost}
                isInline={isMobile}
              />
            ),
          },
        ] satisfies DataTableColumn<SpendRow>[])
      : []),
    ...(isMobile
      ? []
      : ([
          {
            id: "share",
            header: "Share",
            cell: (row) => (
              <ShareCell share={total > 0 ? row.cost / total : undefined} />
            ),
          },
        ] satisfies DataTableColumn<SpendRow>[])),
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-3">
          {canOpenRows && rowFilter(cut.value, row) ? (
            <RowOpenLink
              to={openTo}
              search={searchFor(row)}
              label={openTo === "/requests" ? "Requests" : "Sessions"}
              subject={row.name}
            />
          ) : null}
          <RowMenu label={`Actions for ${row.name}`} actions={menuFor(row)} />
        </span>
      ),
    },
  ]
  // The lanes that fit the table's width, so it does not scroll sideways. Its
  // actions carry the row's link as well as its menu.
  const fit = fittedColumns(
    columns.map((column) => column.id),
    isMobile ? undefined : tableWidth,
    { keep: sort.key, widths: { actions: 190 } },
  )
  const fittedTable = columns.filter((column) => fit.has(column.id))
  // A sort whose lane gave way is still offered, from the phone's sort select.
  const hasDroppedSort = columns.some(
    (column) => column.allowsSorting && !fit.has(column.id),
  )

  // Only a window still under way can be spent in "yet".
  const nothingYet = `Nothing spent ${words}${
    period === "today" ? " yet" : ""
  }.`

  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title="Home"
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <RefreshButton
              onRefresh={refresh}
              isFetching={isFetching}
              updatedAt={now}
            />
            {isFirstRun ? null : (
              <ShareDialog
                isReady={spend.totals !== undefined && !chartView.isLoading}
                startIso={window.start}
                endIso={window.end || new Date(now).toISOString()}
                card={shareCardOf({
                  scope: `Your usage in ${workspace}`,
                  window,
                  chart: chartView.chart,
                  metric,
                  cutLabel: cut.label.toLowerCase(),
                  figures: [
                    {
                      label: figureLabel("Spent", window),
                      value: spend.totals ? formatUsd(total) : "—",
                      subline: spentFacts[0],
                    },
                    {
                      label: figureLabel("Tokens", window),
                      value: spend.totals
                        ? formatTokens(billedTokenTotal(spend.totals) ?? 0)
                        : "—",
                      subline: `${formatNumber(requestCount)} requests`,
                    },
                    {
                      label: figureLabel("Failures", window),
                      value: spend.totals
                        ? formatPct(
                            requestCount > 0
                              ? spend.totals.error_count / requestCount
                              : 0,
                          )
                        : "—",
                      subline: `${formatNumber(failed)} failed`,
                    },
                  ],
                })}
              />
            )}
            <HomeWindowPicker
              period={period}
              window={window}
              onPeriod={(next) => {
                refreshClock()
                patch({ period: next, start: "", end: "" })
              }}
              onClearSpan={() => patch({ start: "", end: "" })}
            />
          </div>
        }
      />
      {notice}
      <ErrorBanner error={spend.error} />
      {isFirstRun ? (
        <MemberFirstRun workspace={workspace} canCreateKey={canCreateKey} />
      ) : (
        <MemberAttentionBand attention={attention} />
      )}
      <KpiStrip isEmpty={false} columns={4}>
        <KpiCell
          label={figureLabel("Spent", window)}
          value={spend.totals ? formatUsd(total) : "—"}
          isLoading={isReading}
          delta={
            delta !== null ? (
              <TrendChip
                fraction={delta}
                polarity="neutral"
                caption={comparedWith(window)}
              />
            ) : undefined
          }
          subline={
            !spend.totals
              ? delta !== null
                ? undefined
                : unreadLine
              : spentFacts.length > 0
                ? spentFacts
                : delta !== null
                  ? undefined
                  : requestCount > 0
                    ? `${formatNumber(requestCount)} requests`
                    : "No requests yet"
          }
          graphic={slot(
            spend.series.length > 1 ? (
              <Sparkline
                values={spend.series.map((point) => point.cost)}
                ariaLabel={`Your spend per ${window.bucket} over the window`}
                height={40}
              />
            ) : undefined,
          )}
        />
        <KpiCell
          label={memberLimitLabel(limit, workspace)}
          value={
            shown === undefined
              ? "—"
              : shown.kind === "unseen"
                ? "Not shown"
                : formatUsd(shown.amount)
          }
          subline={isMobile ? undefined : limitWords}
          // A half-width cell would cut the subline short, and it is where the
          // workspace is named now that the label is not: on a phone the
          // words and the hint wrap together, under the figure, as far apart
          // as the desktop cell sets them (18px between the two lines, there
          // by the graphic row centering the hint).
          delta={
            isMobile && limitWords ? (
              <span className="flex flex-col gap-4.5 whitespace-normal">
                <span>{limitWords}</span>
                {limitNote ? <span>{limitNote}</span> : null}
              </span>
            ) : undefined
          }
          // On its own line, wrapping: the subline truncates, and this is the
          // sentence that must be read whole.
          graphic={
            limitNote && !isMobile ? (
              <span className="whitespace-normal text-caption">
                {limitNote}
              </span>
            ) : (
              slot(undefined)
            )
          }
        />
        <KpiCell
          label={figureLabel("Tokens", window)}
          value={
            spend.totals
              ? formatTokens(billedTokenTotal(spend.totals) ?? 0)
              : "—"
          }
          isLoading={isReading}
          subline={
            !spend.totals
              ? unreadLine
              : cacheTotals.input > 0
                ? `${formatPct(cacheTotals.read / cacheTotals.input)} of input from cache`
                : requestCount > 0
                  ? `${formatNumber(requestCount)} requests`
                  : "No requests yet"
          }
          graphic={slot(
            spend.series.length > 1 ? (
              <Sparkline
                values={spend.series.map(
                  (point) => point.input_tokens + point.output_tokens,
                )}
                ariaLabel={`Your billed tokens per ${window.bucket} over the window`}
                height={40}
              />
            ) : undefined,
          )}
        />
        {hasSessions ? (
          <KpiCell
            label="Your sessions"
            value={
              sessionCount === undefined ? "—" : formatNumber(sessionCount)
            }
            subline={
              sessionsFailed
                ? "Could not load"
                : `${windowSpan(window)} in ${workspace}`
            }
            graphic={slot(
              sessionCount ? (
                <Link
                  to="/sessions"
                  search={mySessions}
                  className="self-start text-xs text-link underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
                >
                  See your sessions
                </Link>
              ) : undefined,
            )}
          />
        ) : (
          // The owner's Home has this cell, so the strip keeps its four.
          <KpiCell
            label={figureLabel("Failures", window)}
            value={
              spend.totals
                ? formatPct(
                    requestCount > 0
                      ? spend.totals.error_count / requestCount
                      : 0,
                  )
                : "—"
            }
            isLoading={isReading}
            severity={
              spend.totals ? failureSeverity(failed, requestCount) : undefined
            }
            subline={
              spend.totals ? (
                <FigureLinks
                  links={[
                    {
                      text: `${formatNumber(failed)} failed`,
                      search: { ...mySessions, status: "error" },
                      isShown: hasRequests,
                    },
                    {
                      text: `${formatNumber(detail.unpriced ?? 0)} unpriced`,
                      search: {
                        ...mySessions,
                        status: "success",
                        priced: "false",
                      },
                      isShown: hasRequests && (detail.unpriced ?? 0) > 0,
                    },
                  ]}
                  fallback={`${formatNumber(failed)} failed`}
                />
              ) : (
                unreadLine
              )
            }
            graphic={slot(undefined)}
          />
        )}
      </KpiStrip>
      {isFirstRun ? null : (
        <MonthBudget
          monthKey={get("month")}
          onMonth={(next) => patch({ month: next })}
          now={now}
          workspaceId={workspaceId}
          userId={me}
          isEnabled={me !== undefined}
          budget={monthCap === undefined ? undefined : { cap: monthCap }}
          capLabel="Your limit"
          noBudgetFact={noBudgetFact}
        />
      )}
      <section aria-label="Where it went" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h2 className="text-title">Where it went</h2>
          <FilterSelect
            ariaLabel="Break down by"
            value={cut.value}
            onChange={(next) => patch({ by: next })}
            options={cuts}
          />
          {(isMobile || hasDroppedSort) && cut.value !== "tools" ? (
            <BreakdownSortSelect
              sort={sort}
              onSort={(next) => patch(sortToUrl(next))}
              hasNotCharged={hasNotCharged}
            />
          ) : null}
        </div>
        {isFirstRun || !cut.groupBy ? null : (
          <UsageBreakdownChart
            view={chartView}
            window={window}
            cutLabel={cut.label.toLowerCase()}
            metric={metric}
            onMetric={(next) => patch({ chart: next === "cost" ? "" : next })}
            isIncludingNotCharged={isIncludingNotCharged}
            onIncludeNotCharged={(next) =>
              patch({ charged: next ? "" : "only" })
            }
            hasNotCharged={split !== undefined}
            onSelectSpan={(span) => patch(span)}
          />
        )}
        {cut.value === "tools" ? (
          <ToolsBreakdown
            window={window}
            workspaceId={workspaceId}
            userId={me}
            isEnabled={me !== undefined}
            canOpen={hasSurface("usage")}
            emptyText={nothingYet}
          />
        ) : (
          <div ref={measureTable}>
            <TableScrollFrame className="otari-breakdown otari-spend-table flex flex-col gap-2">
              <DataTable
                key={cut.value}
                ariaLabel={`Your spend by ${cut.label.toLowerCase()}`}
                columns={fittedTable}
                rows={rows}
                getRowKey={(row) => row.id}
                isLoading={
                  spend.isLoading ||
                  ((cut.value === "sessions" ||
                    cut.value === "channels" ||
                    cut.value === "policies") &&
                    spend.breakdown.isLoading)
                }
                {...breakdownSortProps(sort, (next) => patch(sortToUrl(next)))}
                emptyContent={
                  <EmptyMessage>
                    {usage === "failed"
                      ? "Could not load"
                      : canCreateKey
                        ? `${nothingYet} Each ${cut.each} shows up here with what it spent.`
                        : nothingYet}
                  </EmptyMessage>
                }
                mobileLayout="cards"
              />
            </TableScrollFrame>
          </div>
        )}
        {rows.length > 0 && cut.value === "keys" && canCreateKey ? (
          <p className="text-sm text-muted">
            Keys that spent nothing {words} are on{" "}
            <Link to="/keys" className="text-link underline">
              API keys
            </Link>
            .
          </p>
        ) : null}
      </section>
      {hasRequests && me ? (
        <RecentFailures
          window={window}
          now={now}
          workspaceId={workspaceId}
          userId={me}
          total={spend.totals?.error_count}
        />
      ) : null}
    </div>
  )
}
