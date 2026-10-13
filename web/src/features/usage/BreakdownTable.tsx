import { type ReactNode, useState } from "react"
import type { SortDescriptor } from "react-aria-components"
import { FiArrowUpRight } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { Chip } from "@/design-system/indicators/Chip"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import { Tooltip } from "@/design-system/overlays/Tooltip"
import { ValueFilter } from "@/features/activity/ValueFilter"
import type { UsageBreakdownRow } from "@/shared/api/usage"
import {
  formatLatency,
  formatNumber,
  formatPct,
  formatTokens,
  formatUsd,
} from "@/shared/helpers/format"
import {
  billedOf,
  isSubscriptionOnly,
  type Metric,
  metricOf,
  type RowName,
} from "./usageModel"
import {
  canExclude,
  DIMENSIONS,
  type DimensionKey,
  type Mode,
  type SortKey,
  type TableSort,
} from "./usageQuery"

// The rows a table shows before "Show all".
const TOP = 10
const OTHER_ROW = "__other__"
const NONE_ROW = "__none__"

const rowKey = (row: UsageBreakdownRow) =>
  row.is_other ? OTHER_ROW : (row.key ?? NONE_ROW)

// What the money columns and the p95 mean, said under the table rather than in
// a header: a header is the column's sort button, and a tooltip trigger inside
// it would be a second tab stop nested in the first.
const DEFINITIONS =
  "Billed counts toward limits · Subscription is priced at API rates, not billed · p95 latency: 95% of requests were faster"

/**
 * One row per value of the breakdown, every column the question needs, each
 * header sorting. A row's square repeats its color in the chart above. A value
 * can be picked or left out from its own cell, and the whole row opens its
 * requests in Activity where Activity can show them.
 */
export function BreakdownTable({
  dimension,
  rows,
  sort,
  onSort,
  metric,
  withSubscription,
  nameOf,
  colorOf,
  onFilter,
  onOpen,
  canOpen,
  isLoading,
  isLoadingP95 = false,
  emptyContent,
}: {
  dimension: DimensionKey
  rows: readonly UsageBreakdownRow[]
  sort: TableSort
  onSort: (key: SortKey) => void
  metric: Metric
  withSubscription: boolean
  nameOf: (row: UsageBreakdownRow) => RowName
  colorOf: (row: UsageBreakdownRow) => string
  onFilter: (value: string, mode: Mode) => void
  /** Opens a row's requests in Activity. */
  onOpen: (row: UsageBreakdownRow) => void
  /** Whether Activity can show a row's requests; a row it cannot is inert. */
  canOpen: (row: UsageBreakdownRow) => boolean
  isLoading: boolean
  /** The rows are in and their p95 is still being read. */
  isLoadingP95?: boolean
  emptyContent: ReactNode
}) {
  const [isShowingAll, setIsShowingAll] = useState(false)
  const visible = isShowingAll ? rows : rows.slice(0, TOP)
  const total = rows.reduce(
    (sum, row) => sum + metricOf(row, metric, withSubscription),
    0,
  )
  const largest = Math.max(
    1e-9,
    ...rows.map((row) => metricOf(row, metric, withSubscription)),
  )
  const def = DIMENSIONS[dimension]
  const columns: DataTableColumn<UsageBreakdownRow>[] = [
    {
      id: "name",
      header: def.label,
      isRowHeader: true,
      allowsSorting: true,
      cell: (row) => {
        const name = nameOf(row)
        return (
          <div className="group/cell relative flex min-w-0 flex-col pr-7 pointer-coarse:pr-12">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0"
                style={{ background: colorOf(row) }}
              />
              <span
                className={`truncate ${name.isMono ? "text-mono-caption" : ""} ${name.isNone ? "text-muted" : "text-foreground"}`}
              >
                {name.prefix ? (
                  <span className="text-subtle">{name.prefix}</span>
                ) : null}
                {name.label}
              </span>
              {isSubscriptionOnly(row) ? (
                <Chip tone="info">Subscription</Chip>
              ) : null}
            </span>
            {name.detail ? (
              <span className="truncate pl-4 text-caption text-subtle">
                {name.detail}
              </span>
            ) : null}
            {!row.is_other && row.key !== null ? (
              <ValueFilter
                value={name.label}
                canExclude={canExclude(dimension)}
                isInTabOrder
                onFilter={(mode) => onFilter(row.key as string, mode)}
              />
            ) : null}
          </div>
        )
      },
    },
    {
      id: "value",
      header: "Share",
      allowsSorting: true,
      width: 150,
      cell: (row) => {
        const value = metricOf(row, metric, withSubscription)
        return (
          <span className="flex items-center gap-2">
            <span className="h-1 flex-1 bg-border-subtle">
              <span
                className="block h-1"
                style={{
                  width: `${(value / largest) * 100}%`,
                  background: colorOf(row),
                }}
              />
            </span>
            <span className="w-9 text-right text-mono-micro text-subtle">
              {formatPct(total > 0 ? value / total : 0, 0)}
            </span>
          </span>
        )
      },
    },
    {
      id: "requests",
      header: "Requests",
      align: "end",
      allowsSorting: true,
      cell: (row) => (
        <span className="text-mono-caption">{formatNumber(row.requests)}</span>
      ),
    },
    {
      id: "tokens",
      header: "Tokens",
      align: "end",
      allowsSorting: true,
      cell: (row) => (
        <span className="flex flex-col items-end">
          <span className="text-mono-caption">{formatTokens(row.tokens)}</span>
          <span className="text-mono-micro text-subtle">
            {formatPct(row.tokens ? row.cache_read_tokens / row.tokens : 0, 0)}{" "}
            cached
          </span>
        </span>
      ),
    },
    {
      id: "billed",
      header: "Billed",
      align: "end",
      allowsSorting: true,
      cell: (row) => {
        const billed = billedOf(row)
        return billed ? (
          <span className="text-mono-caption">{formatUsd(billed)}</span>
        ) : (
          <span className="text-subtle">—</span>
        )
      },
    },
    {
      id: "subscription",
      header: "Subscription",
      align: "end",
      allowsSorting: true,
      cell: (row) =>
        row.imported_cost ? (
          <Tooltip
            content={`${formatUsd(row.imported_cost)} at API prices, covered by subscription`}
          >
            <span className="text-mono-caption text-subtle">
              {formatUsd(row.imported_cost)}
            </span>
          </Tooltip>
        ) : (
          <span className="text-mono-caption text-subtle">—</span>
        ),
    },
    {
      id: "failed",
      header: "Failed",
      align: "end",
      allowsSorting: true,
      cell: (row) => (
        <span
          className={`text-mono-caption ${row.error_count ? "text-danger" : "text-subtle"}`}
        >
          {formatNumber(row.error_count)}
        </span>
      ),
    },
    {
      id: "p95",
      header: (
        <span>
          <span className="normal-case">p95</span> Latency
        </span>
      ),
      align: "end",
      allowsSorting: true,
      cell: (row) =>
        isLoadingP95 && !row.is_other ? (
          <Skeleton className="ml-auto h-3 w-12" />
        ) : (
          <span className="text-mono-caption">
            {formatLatency(row.p95_latency_ms) ?? (
              <span className="text-subtle">—</span>
            )}
          </span>
        ),
    },
    {
      id: "open",
      header: <span className="sr-only">Open in Activity</span>,
      align: "end",
      width: 44,
      cell: (row) =>
        canOpen(row) ? (
          <FiArrowUpRight aria-hidden className="size-3.5 text-subtle" />
        ) : null,
    },
  ]

  const sortDescriptor: SortDescriptor = {
    column: sort.key,
    direction: sort.order === "asc" ? "ascending" : "descending",
  }

  return (
    <TableScrollFrame className="otari-breakdown flex flex-col gap-2">
      <DataTable
        ariaLabel={`Usage by ${def.label}`}
        columns={columns}
        rows={visible as UsageBreakdownRow[]}
        getRowKey={rowKey}
        isLoading={isLoading}
        emptyContent={emptyContent}
        sortDescriptor={sortDescriptor}
        onSortChange={(descriptor) => onSort(descriptor.column as SortKey)}
        onRowAction={(key) => {
          const row = rows.find((one) => rowKey(one) === key)
          if (row) onOpen(row)
        }}
        isRowInert={(row) => !canOpen(row)}
      />
      <p className="pt-1 text-caption text-subtle">{DEFINITIONS}</p>
      {rows.length > TOP ? (
        <Button
          size="sm"
          className="self-start"
          onPress={() => setIsShowingAll((showing) => !showing)}
        >
          {isShowingAll ? `Show top ${TOP}` : `Show all ${rows.length}`}
        </Button>
      ) : null}
    </TableScrollFrame>
  )
}
