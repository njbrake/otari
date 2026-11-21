import { useId } from "react"
import { FiChevronRight } from "react-icons/fi"
import type { LogGroupBy, UsageEntry, UsageLogGroup } from "@/client"
import { Button } from "@/design-system/actions/Button"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import {
  formatLatency,
  formatNumber,
  formatTokens,
  formatUsd,
} from "@/shared/helpers/format"
import { getActivityRowKey } from "./activityModel"
import {
  describeGroup,
  describeGroupSpan,
  describeTopModels,
  GROUP_PREVIEW,
} from "./requestGroups"

/** A group's identity: its key, with the rows of no value under a key of their own. */
export const groupId = (group: UsageLogGroup): string =>
  group.key === null ? "\u0000none" : `v:${group.key}`

function GroupRow({
  group,
  groupBy,
  memberLabels,
  isOpen,
  onToggle,
  rows,
  isLoadingRows,
  columns,
  onOpenRequest,
  rowClassName,
  onShowAll,
}: {
  group: UsageLogGroup
  groupBy: LogGroupBy
  memberLabels: ReadonlyMap<string, string>
  isOpen: boolean
  onToggle: () => void
  rows: UsageEntry[] | undefined
  isLoadingRows: boolean
  columns: DataTableColumn<UsageEntry>[]
  onOpenRequest: (id: string) => void
  rowClassName: (entry: UsageEntry) => string | undefined
  onShowAll: () => void
}) {
  const panelId = useId()
  const { title, isMono } = describeGroup(groupBy, group, memberLabels)
  const latency = formatLatency(group.latency_ms)
  const models = groupBy === "model" ? "" : describeTopModels(group.top_models)
  return (
    <li className="border-border border-b last:border-b-0">
      <h3 className="m-0 text-title">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-h-11 w-full items-center gap-x-3 px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-surface-subtle focus-visible:otari-focus-ring motion-reduce:transition-none"
        >
          <FiChevronRight
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-subtle transition-transform duration-150 ease-out motion-reduce:transition-none ${
              isOpen ? "rotate-90" : ""
            }`}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                className={`truncate text-emphasis ${isMono ? "font-mono" : ""}`}
              >
                {title}
              </span>
              {models ? (
                <span className="truncate text-caption text-subtle">
                  {models}
                </span>
              ) : null}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-3 text-caption">
              <span className="text-foreground">
                {formatNumber(group.requests)}{" "}
                {group.requests === 1 ? "request" : "requests"}
              </span>
              {group.errors ? (
                <span className="text-danger">
                  {formatNumber(group.errors)} failed
                </span>
              ) : null}
              <span>{formatUsd(group.cost)}</span>
              <span>{formatTokens(group.tokens)} tokens</span>
              {latency ? <span>{latency} avg</span> : null}
            </span>
          </span>
          <span className="shrink-0 text-mono-caption text-subtle">
            {describeGroupSpan(group.first_at, group.last_at)}
          </span>
        </button>
      </h3>
      {/* Rendered closed too, so `aria-controls` always names an element. */}
      <div id={panelId} hidden={!isOpen} className="flex flex-col gap-2 pb-3">
        {isOpen ? (
          <>
            <TableScrollFrame className="otari-activity-table">
              <DataTable
                ariaLabel={`Newest requests, ${title}`}
                columns={columns}
                rows={rows ?? []}
                getRowKey={getActivityRowKey}
                isLoading={isLoadingRows && rows === undefined}
                emptyContent="No requests."
                onRowAction={onOpenRequest}
                rowClassName={rowClassName}
              />
            </TableScrollFrame>
            {group.requests > GROUP_PREVIEW ? (
              <div className="px-3">
                <Button size="sm" variant="ghost" onPress={onShowAll}>
                  Show all {formatNumber(group.requests)}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The request log grouped by one column: a row per group with what its
 * requests add up to, which opens to the group's newest requests, and a way to
 * turn a group into a filtered list of its own.
 */
export function GroupedRequests({
  groupBy,
  groups,
  total,
  isLoading,
  memberLabels,
  openGroups,
  onToggleGroup,
  previews,
  columns,
  onOpenRequest,
  rowClassName,
  onShowAll,
  onMore,
  isFetchingMore,
  emptyContent,
}: {
  groupBy: LogGroupBy
  groups: UsageLogGroup[] | undefined
  total: number
  isLoading: boolean
  memberLabels: ReadonlyMap<string, string>
  openGroups: ReadonlySet<string>
  onToggleGroup: (id: string) => void
  /** The open groups' newest rows, by `groupId`, and whether each is still loading. */
  previews: ReadonlyMap<
    string,
    { rows: UsageEntry[] | undefined; isLoading: boolean }
  >
  columns: DataTableColumn<UsageEntry>[]
  onOpenRequest: (id: string) => void
  rowClassName: (entry: UsageEntry) => string | undefined
  onShowAll: (group: UsageLogGroup) => void
  /** Reads the next page of groups, or is absent once every group is listed. */
  onMore: (() => void) | undefined
  isFetchingMore: boolean
  emptyContent: string
}) {
  if (isLoading && groups === undefined) {
    return (
      <div className="flex flex-col gap-3 py-3" aria-busy>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }
  if (!groups?.length) {
    return (
      <div className="py-6">
        <EmptyMessage>{emptyContent}</EmptyMessage>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col border-border border-y p-0">
        {groups.map((group) => {
          const id = groupId(group)
          const preview = previews.get(id)
          return (
            <GroupRow
              key={id}
              group={group}
              groupBy={groupBy}
              memberLabels={memberLabels}
              isOpen={openGroups.has(id)}
              onToggle={() => onToggleGroup(id)}
              rows={preview?.rows}
              isLoadingRows={preview?.isLoading ?? false}
              columns={columns}
              onOpenRequest={onOpenRequest}
              rowClassName={rowClassName}
              onShowAll={() => onShowAll(group)}
            />
          )
        })}
      </ul>
      {onMore ? (
        <div>
          <Button size="sm" onPress={onMore} isPending={isFetchingMore}>
            Show more groups ({formatNumber(total - groups.length)} left)
          </Button>
        </div>
      ) : null}
    </div>
  )
}
