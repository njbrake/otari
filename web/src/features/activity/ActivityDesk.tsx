import type { ReactNode } from "react"
import { Button } from "@/design-system/actions/Button"
import { RefreshButton } from "@/design-system/actions/RefreshButton"
import { TextButton } from "@/design-system/actions/TextButton"
import { TablePagination } from "@/design-system/data/TablePagination"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { PageIntro } from "@/design-system/layout/PageIntro"
import { ACTIVITY_GROUP_LIMIT, NEWEST_FIRST } from "@/shared/api/usage"
import { formatNumber } from "@/shared/helpers/format"
import { ActivityChartBand } from "./ActivityChartBand"
import { ActivityHeaderCells, COLUMN_LABELS } from "./ActivityHeaderCells"
import { ActivityScopeBar } from "./ActivityScopeBar"
import { ActivitySearch } from "./ActivitySearch"
import { ActivityTable } from "./ActivityTable"
import { ActivityToolbar } from "./ActivityToolbar"
import { ActivityTotals } from "./ActivityTotals"
import { activityColumns, tableMinWidthRem } from "./activityColumns"
import {
  type ActivityUrl,
  type ColumnKey,
  columnForSort,
  GROUP_KEYS,
  GROUPS,
} from "./activityQuery"
import { describeGroup, showGroupPatch } from "./activityRows"
import { describeSpan, windowBars } from "./chartBars"
import { GroupMenu } from "./GroupMenu"
import { LiveControl } from "./LiveControl"
import { ManageImportedMenu } from "./ManageImportedMenu"
import { MissingRequest } from "./MissingRequest"
import { RequestPanel } from "./RequestPanel"
import type { ActivityActions } from "./useActivityActions"
import type { ActivityLog } from "./useActivityLog"
import { useMainHeight } from "./useMainHeight"

// The column a grouping names, which rows inside a group need not repeat.
const GROUP_COLUMNS = {
  source: "source",
  session: undefined,
  model: "model",
  member: "member",
} as const

/**
 * Activity at a desk: the log as a table filtered from its own headers and
 * cells, with a request opened beside it rather than over it.
 */
export function ActivityDesk({
  url,
  log,
  act,
  viewsMenu,
  isLive,
  onLive,
  openMenu,
  onMenu,
  menuSearch,
  onMenuSearch,
  expanded,
  onExpanded,
  onPriceModel,
  onManageImported,
  empty,
}: {
  url: ActivityUrl
  log: ActivityLog
  act: ActivityActions
  viewsMenu: ReactNode
  isLive: boolean
  onLive: (isLive: boolean) => void
  openMenu: ColumnKey | undefined
  onMenu: (column: ColumnKey | undefined) => void
  menuSearch: string
  onMenuSearch: (term: string) => void
  expanded: ReadonlySet<string>
  onExpanded: (expanded: ReadonlySet<string>) => void
  onPriceModel: ((modelKey: string) => void) | undefined
  onManageImported: (action: "recost" | "delete") => void
  empty: ReactNode
}) {
  const { group, open } = log
  const { isManager, isOperator } = log.viewer
  const mainHeight = useMainHeight()
  const isCompact = open !== undefined
  const columns = activityColumns({
    isCompact,
    showsMembers: log.isMulti,
    showsPolicies: log.showsPolicies,
  })
  const bars = windowBars(
    log.series,
    log.time.chart,
    log.time.chartGrain,
    log.time.now,
  )
  const barMs = bars.length ? bars[0].end - bars[0].start : 0

  return (
    <div className="flex items-start">
      <div className="min-w-0 flex-1">
        <PageIntro
          title="Activity"
          beside={viewsMenu}
          action={
            <div className="flex items-center gap-2">
              {log.newRows > 0 ? (
                <Button size="sm" onPress={log.refresh}>
                  {formatNumber(log.newRows)} new · load
                </Button>
              ) : null}
              <LiveControl
                isLive={isLive}
                onLive={onLive}
                inFlight={log.inFlight}
                inFlightUpdatedAt={log.inFlightUpdatedAt}
              />
            </div>
          }
        >
          A per-request log of what the gateway served: tokens, cost, latency,
          and failures. No request or response content is stored.
        </PageIntro>

        <ErrorBanner error={log.error} />
        {log.isOpenMissing ? (
          <MissingRequest
            id={url.get("request")}
            onClose={() => act.openRequest(undefined)}
          />
        ) : null}

        <ActivityScopeBar
          isManager={isManager}
          canNarrowToOwn={log.canNarrowToOwn}
          scope={log.scope}
          onScope={act.scope}
          range={log.time.range}
          onRange={act.range}
          bounds={log.time.list}
          now={log.time.now}
          spend={log.spend}
          trailing={
            isLive ? null : (
              <RefreshButton
                onRefresh={log.refresh}
                isFetching={log.isFetchingRows}
                updatedAt={log.rowsUpdatedAt}
              />
            )
          }
        />

        <ActivityChartBand bars={bars} span={act.span} onSpan={act.setSpan} />

        <ActivityToolbar
          search={
            <ActivitySearch
              value={url.get("q")}
              onCommit={act.search}
              placeholder={
                log.isMulti
                  ? "Request ID, member, source or model"
                  : "Request ID, source or model"
              }
              className="w-[16.25rem]"
            />
          }
          timeChip={
            act.span
              ? {
                  value: describeSpan(act.span.from, act.span.to, barMs),
                  onDismiss: () => act.setSpan(undefined),
                }
              : undefined
          }
          chips={log.chips}
          onClearChip={(chip) => act.refine(chip.clear)}
          onClearAll={act.clearFilters}
          trailing={
            <>
              {group && !log.isGrouping ? (
                <span className="text-caption text-subtle">
                  Grouping pauses while sorted by{" "}
                  {COLUMN_LABELS[columnForSort(log.sort.key)].toLowerCase()} ·{" "}
                  <TextButton onPress={() => act.sort(NEWEST_FIRST)}>
                    Sort by time
                  </TextButton>
                </span>
              ) : null}
              <GroupMenu
                value={group ?? "none"}
                options={[
                  { value: "none", label: "None" },
                  ...GROUP_KEYS.filter(
                    (key) => key !== "member" || log.isMulti,
                  ).map((key) => ({ value: key, label: GROUPS[key].label })),
                ]}
                onChange={(value) => {
                  url.patch({ group: value === "none" ? "" : value })
                  onExpanded(new Set())
                }}
              />
            </>
          }
        />

        <ActivityTotals
          totals={log.totals}
          isFiltered={log.isFiltered}
          isCompact={isCompact}
          onUnpriced={act.unpriced}
          trailing={
            isOperator && !isCompact && log.importedCount > 0 ? (
              <ManageImportedMenu
                count={log.importedCount}
                onRecost={() => onManageImported("recost")}
                onDelete={() => onManageImported("delete")}
              />
            ) : undefined
          }
        />

        <div className="-mx-4 overflow-x-auto px-4 md:-mx-6 md:px-6">
          <ActivityTable
            columns={columns}
            header={
              <ActivityHeaderCells
                columns={columns}
                url={url}
                sort={log.sort}
                openMenu={openMenu}
                onMenu={onMenu}
                options={log.options}
                aliases={log.aliases}
                menuSearch={menuSearch}
                onMenuSearch={onMenuSearch}
                policyGroups={log.policyGroups}
                totals={log.totals}
                memberName={log.memberName}
                onRefine={act.refine}
              />
            }
            rows={log.rows}
            attempts={log.attempts}
            groups={
              log.isGrouping && group
                ? log.groupRows.map((row) => ({
                    key: row.key ?? "",
                    ...describeGroup(group, row, log.memberName),
                    group: row,
                    isOpen: expanded.has(row.key ?? ""),
                    rows: log.previewRows.get(row.key ?? ""),
                    canShowAll: row.key !== null,
                  }))
                : undefined
            }
            groupColumn={group ? GROUP_COLUMNS[group] : undefined}
            selectedId={open?.id}
            onOpen={act.openRequest}
            onToggleGroup={(key) => {
              const next = new Set(expanded)
              if (!next.delete(key)) next.add(key)
              onExpanded(next)
            }}
            onShowGroup={(view) => {
              if (!group || view.group.key === null) return
              url.patch(showGroupPatch(group, view.group.key))
              onExpanded(new Set())
            }}
            memberName={log.memberName}
            onValueFilter={act.cellFilter}
            onTool={act.tools}
            minWidthRem={tableMinWidthRem(columns, isCompact)}
            empty={
              log.isLoadingRows ? <EmptyMessage>Loading…</EmptyMessage> : empty
            }
          />
        </div>

        {log.isGrouping ? (
          <p className="py-3 text-right text-caption text-subtle">
            {formatNumber(log.groupTotal)} groups ·{" "}
            {formatNumber(log.totals?.request_count ?? 0)} requests
            {log.groupTotal > ACTIVITY_GROUP_LIMIT
              ? `. Showing the first ${ACTIVITY_GROUP_LIMIT}; narrow the filters to see the rest.`
              : ""}
          </p>
        ) : (
          <TablePagination
            page={log.page}
            pageSize={log.pageSize}
            total={log.total}
            rowsOnPage={log.pageRows.length}
            onPageChange={(next) => url.patch({ page: String(next) })}
            onPageSizeChange={(size) =>
              url.patch({ size: String(size), page: "0" })
            }
            isFetching={log.isFetchingRows}
            hasNextFallback={log.pageRows.length === log.pageSize}
          />
        )}
      </div>

      {open ? (
        <div
          className="sticky top-0 -my-6 -mr-6 ml-6"
          style={mainHeight ? { height: `${mainHeight}px` } : undefined}
        >
          <RequestPanel
            entry={open}
            position={log.position}
            memberName={log.memberName}
            showsMember={log.isMulti}
            onPrevious={() => act.step(-1)}
            onNext={() => act.step(1)}
            onClose={() => act.openRequest(undefined)}
            onFilter={act.panelFilter}
            onPriceModel={onPriceModel}
          />
        </div>
      ) : null}
    </div>
  )
}
