/**
 * The request log.
 *
 * A table of our own rather than `DataTable`, for three things the log needs
 * that a react-aria grid cannot express: group rows whose summary spans several
 * columns, a routed request's earlier attempts nested under the row that
 * served it, and headers that hold both a sort control and a filter menu. What
 * `DataTable` would have brought is kept by hand: the `.otari-table` row states
 * (a hairline at rest, `surface-muted` on hover, `primary-subtle` selected),
 * `aria-sort` on the sorted column, and rows reachable from the keyboard, where
 * Enter opens one and the page's arrow keys step through them. Its selection
 * column is not needed: bulk actions act on the filter, not on picked rows.
 */

import { Fragment, type ReactNode } from "react"
import { FiChevronDown, FiChevronRight } from "react-icons/fi"
import type { UsageActivityGroup, UsageEntry } from "@/client"
import { TextButton } from "@/design-system/actions/TextButton"
import { Dot } from "@/design-system/indicators/Dot"
import {
  formatLatency,
  formatNumber,
  formatPct,
  formatTokens,
  formatUsd,
  formatUtcMinute,
  formatUtcTime,
} from "@/shared/helpers/format"
import {
  CostCell,
  LatencyCell,
  ModelCell,
  PolicyCell,
  SourceCell,
  StatusCell,
  TimeCell,
  TokensCell,
} from "./activityCells"
import { buildTokenComposition, describeRowSource } from "./activityModel"
import { type ColumnKey, STATUS_LABELS, type Status } from "./activityQuery"
import { GROUP_PREVIEW } from "./activityRows"
import { ValueFilter } from "./ValueFilter"

const CELL = "relative px-4 py-1.5 align-middle"
const DITTO = (
  <span className="text-subtle">
    <span aria-hidden>″</span>
    <span className="sr-only">Same as above</span>
  </span>
)

/** When a group was active: its times, with the day once it spans more than one. */
function describeGroupSpan(first: string, last: string): string {
  const isSameDay = first.slice(0, 10) === last.slice(0, 10)
  return isSameDay
    ? `${formatUtcTime(first)}–${formatUtcTime(last)} UTC`
    : `${formatUtcMinute(first)} – ${formatUtcMinute(last)} UTC`
}

interface ActivityGroupView {
  key: string
  title: string
  isMono: boolean
  group: UsageActivityGroup
  isOpen: boolean
  /** The group's first rows, once opened and loaded. */
  rows: UsageEntry[] | undefined
  /** Whether the group can become a filter: a group of rows with no value cannot. */
  canShowAll: boolean
}

export function ActivityTable({
  columns,
  header,
  rows,
  attempts,
  groups,
  groupColumn,
  selectedId,
  onOpen,
  onToggleGroup,
  onShowGroup,
  memberName,
  onValueFilter,
  onTool,
  minWidthRem,
  empty,
}: {
  columns: ColumnKey[]
  header: ReactNode
  rows: UsageEntry[]
  /** Each served row's earlier failed attempts, keyed by request group, when they are shown. */
  attempts: ReadonlyMap<string, UsageEntry[]>
  groups: ActivityGroupView[] | undefined
  /** The column the log is grouped by, which rows inside a group need not repeat. */
  groupColumn: ColumnKey | undefined
  selectedId: string | undefined
  onOpen: (entry: UsageEntry) => void
  onToggleGroup: (key: string) => void
  onShowGroup: (group: ActivityGroupView) => void
  memberName: (userId: string | null, alias?: string | null) => string
  onValueFilter: (
    column: ColumnKey,
    entry: UsageEntry,
    mode: "include" | "exclude",
  ) => void
  onTool: (tools: string[]) => void
  minWidthRem: number
  empty: ReactNode
}) {
  const maxTokens = Math.max(
    1,
    ...rows.map((entry) => buildTokenComposition(entry)?.total ?? 0),
    ...(groups ?? []).flatMap((group) =>
      (group.rows ?? []).map(
        (entry) => buildTokenComposition(entry)?.total ?? 0,
      ),
    ),
  )
  const showsPolicy = columns.includes("policy")

  const valueCell = (
    column: ColumnKey,
    entry: UsageEntry,
    label: string,
    children: ReactNode,
  ) => {
    const content = (
      <>
        <div className="min-w-0">{children}</div>
        <ValueFilter
          value={label}
          onFilter={(mode) => onValueFilter(column, entry, mode)}
        />
      </>
    )
    // The model names the request, so it is the row's header: what a screen
    // reader announces as it moves along the row.
    return column === "model" ? (
      <th
        key={column}
        scope="row"
        className={`${CELL} group/cell text-left font-normal`}
      >
        {content}
      </th>
    ) : (
      <td key={column} className={`${CELL} group/cell`}>
        {content}
      </td>
    )
  }

  const cell = (
    column: ColumnKey,
    entry: UsageEntry,
    isNested: boolean,
    isAttempt: boolean,
  ): ReactNode => {
    if (isNested && column === groupColumn) {
      return (
        <td key={column} className={CELL}>
          {DITTO}
        </td>
      )
    }
    switch (column) {
      case "time":
        return (
          <td
            key={column}
            className={`${CELL} whitespace-nowrap ${
              isNested
                ? "pl-[1.625rem] shadow-[inset_2px_0_0_var(--color-border-strong)]"
                : ""
            }`}
          >
            <TimeCell entry={entry} isAttempt={isAttempt} />
          </td>
        )
      case "member": {
        if (isAttempt) {
          return (
            <td key={column} className={CELL}>
              {DITTO}
            </td>
          )
        }
        const name = memberName(entry.user_id, entry.user_alias)
        return valueCell(
          column,
          entry,
          name,
          <span
            title={entry.user_id ?? undefined}
            className={`block truncate ${name === "You" ? "text-subtle" : ""}`}
          >
            {name}
          </span>,
        )
      }
      case "model":
        return valueCell(
          column,
          entry,
          entry.model,
          <ModelCell entry={entry} showsPolicy={showsPolicy} onTool={onTool} />,
        )
      case "policy":
        return valueCell(
          column,
          entry,
          entry.policy_name ?? "Direct",
          <PolicyCell entry={entry} isAttempt={isAttempt} />,
        )
      case "source":
        if (isAttempt) {
          return (
            <td key={column} className={CELL}>
              {DITTO}
            </td>
          )
        }
        return valueCell(
          column,
          entry,
          describeRowSource(entry),
          <SourceCell entry={entry} />,
        )
      case "tokens":
        return (
          <td key={column} className={`${CELL} text-right`}>
            <TokensCell entry={entry} maxTokens={maxTokens} />
          </td>
        )
      case "cost":
        return (
          <td key={column} className={`${CELL} text-right`}>
            <CostCell entry={entry} />
          </td>
        )
      case "latency":
        return (
          <td key={column} className={`${CELL} text-right`}>
            <LatencyCell entry={entry} />
          </td>
        )
      case "status":
        return valueCell(
          column,
          entry,
          Object.hasOwn(STATUS_LABELS, entry.status)
            ? STATUS_LABELS[entry.status as Status]
            : entry.status,
          <StatusCell entry={entry} />,
        )
    }
  }

  const row = (entry: UsageEntry, isNested: boolean) => {
    const isSelected = entry.id === selectedId
    const recovered = entry.request_group_id
      ? (attempts.get(entry.request_group_id) ?? [])
      : []
    return (
      <Fragment key={entry.id}>
        <tr
          aria-current={isSelected || undefined}
          tabIndex={0}
          onClick={() => onOpen(entry)}
          // Only from the row itself: an Enter on a control inside it (the tool
          // badge, a cell's filter) is that control's.
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target === event.currentTarget)
              onOpen(entry)
          }}
          className={`cursor-pointer border-b border-border-subtle focus-visible:otari-focus-ring ${
            isSelected ? "bg-primary-subtle" : "hover:bg-surface-alt"
          }`}
        >
          {columns.map((column) => cell(column, entry, isNested, false))}
        </tr>
        {recovered.map((attempt) => (
          <tr
            key={attempt.id}
            tabIndex={0}
            onClick={() => onOpen(entry)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.target === event.currentTarget)
                onOpen(entry)
            }}
            className="cursor-pointer border-b border-border-subtle hover:bg-surface-alt focus-visible:otari-focus-ring"
          >
            {columns.map((column) => cell(column, attempt, true, true))}
          </tr>
        ))}
      </Fragment>
    )
  }

  const spanUntil = Math.max(
    1,
    columns.findIndex((column) => column === "tokens" || column === "cost"),
  )
  const groupRow = (view: ActivityGroupView) => {
    const { group } = view
    const billed = Math.max(0, group.cost - group.imported_cost)
    const cached = group.cache_read_tokens / Math.max(1, group.input_tokens)
    const models =
      groupColumn === "model"
        ? ""
        : ` · ${group.models.slice(0, 2).join(", ")}${
            group.model_count > 2 ? ` +${group.model_count - 2}` : ""
          }`
    const Chevron = view.isOpen ? FiChevronDown : FiChevronRight
    const rest = columns.slice(spanUntil).map((column) => {
      switch (column) {
        case "tokens":
          return (
            <td key={column} className={`${CELL} text-right`}>
              <div className="text-mono-caption">
                {formatTokens(group.input_tokens + group.output_tokens)}
              </div>
              <div className="text-mono-micro text-subtle">
                {formatPct(cached, 0)} cached
              </div>
            </td>
          )
        case "cost":
          return (
            <td key={column} className={`${CELL} text-right`}>
              {billed > 0 ? (
                <div className="text-mono-caption">{formatUsd(billed)}</div>
              ) : null}
              {group.imported_cost > 0 ? (
                <div
                  className={`whitespace-nowrap text-subtle ${
                    billed > 0 ? "text-mono-micro" : "text-mono-caption"
                  }`}
                >
                  {billed > 0 ? "+" : ""}
                  {formatUsd(group.imported_cost)}
                  {billed > 0 ? " sub" : ""}
                </div>
              ) : null}
              {!billed && group.imported_cost > 0 ? (
                <div className="text-mono-micro text-subtle">not billed</div>
              ) : null}
              {!billed && !group.imported_cost ? (
                <div className="text-mono-caption text-subtle">—</div>
              ) : null}
            </td>
          )
        case "latency":
          return (
            <td key={column} className={`${CELL} text-right`}>
              <div className="text-mono-caption">
                {formatLatency(group.latency_ms) ?? "—"}
              </div>
              <div className="text-mono-micro text-subtle">model time</div>
            </td>
          )
        case "status":
          return (
            <td key={column} className={CELL}>
              {group.errors ? (
                <span className="flex items-center gap-2 text-mono-caption text-danger">
                  <Dot className="bg-danger" />
                  {formatNumber(group.errors)} failed
                </span>
              ) : (
                <span className="flex items-center gap-2 text-mono-caption text-subtle">
                  <Dot className="bg-success" />
                  none failed
                </span>
              )}
            </td>
          )
        default:
          return <td key={column} className={CELL} />
      }
    })
    return (
      <Fragment key={view.key}>
        {/* The whole row toggles for a pointer; the button in it is what a
            keyboard and a screen reader reach, and it carries the state. */}
        <tr
          onClick={() => onToggleGroup(view.key)}
          className="cursor-pointer border-b border-border-subtle hover:bg-surface-alt"
        >
          <td colSpan={spanUntil} className={CELL}>
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-expanded={view.isOpen}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleGroup(view.key)
                }}
                className={`flex items-center gap-2 font-medium whitespace-nowrap focus-visible:otari-focus-ring ${view.isMono ? "text-mono-caption" : ""}`}
              >
                <Chevron aria-hidden className="size-3.5 shrink-0" />
                {view.title}
              </button>
              <span className="text-mono-micro whitespace-nowrap text-subtle">
                {formatNumber(group.requests)}{" "}
                {group.requests === 1 ? "request" : "requests"}
              </span>
            </div>
            <div className="truncate pl-[1.375rem] text-mono-micro text-subtle">
              {describeGroupSpan(group.first_at, group.last_at)}
              {models}
            </div>
          </td>
          {rest}
        </tr>
        {view.isOpen
          ? (view.rows ?? []).map((entry) => row(entry, true))
          : null}
        {view.isOpen && view.canShowAll && group.requests > GROUP_PREVIEW ? (
          <tr className="border-b border-border-subtle">
            <td
              colSpan={columns.length}
              className="py-2 pr-4 pl-9 shadow-[inset_2px_0_0_var(--color-border-strong)]"
            >
              <span className="text-sm">
                <TextButton onPress={() => onShowGroup(view)}>
                  Show all {formatNumber(group.requests)} as a filtered list
                </TextButton>
              </span>
            </td>
          </tr>
        ) : null}
      </Fragment>
    )
  }

  const isEmpty = groups ? groups.length === 0 : rows.length === 0
  return (
    <table
      aria-label="Activity log"
      className="w-full table-fixed border-collapse text-sm"
      style={{ minWidth: `${minWidthRem}rem` }}
    >
      <thead>
        <tr className="border-b border-border text-left">{header}</tr>
      </thead>
      <tbody>
        {isEmpty ? (
          <tr>
            {/* A log row's height, so the first rows replace it without a jump. */}
            <td colSpan={columns.length} className="h-[3.25rem]">
              {empty}
            </td>
          </tr>
        ) : groups ? (
          groups.map(groupRow)
        ) : (
          rows.map((entry) => row(entry, false))
        )}
      </tbody>
    </table>
  )
}
