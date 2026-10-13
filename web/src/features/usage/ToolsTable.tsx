import { FiArrowUpRight, FiGlobe } from "react-icons/fi"
import type { UsageToolRow } from "@/client"
import { TextButton } from "@/design-system/actions/TextButton"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import { describeTool } from "@/features/activity/activityModel"
import { formatNumber, formatUsd } from "@/shared/helpers/format"

type ToolRow = UsageToolRow

/**
 * Tools Otari ran itself, which bill per call rather than per token. A tool
 * with calls and no cost has no per-call price set, which is said outright,
 * since "$0.00" alone reads as free; an operator can set one from the row.
 */
export function ToolsTable({
  rows,
  onSetPrice,
  onOpen,
  isLoading,
}: {
  rows: readonly ToolRow[]
  /** Offered to an operator, who sets deployment prices. */
  onSetPrice: ((tool: string) => void) | undefined
  onOpen: ((tool: string) => void) | undefined
  isLoading: boolean
}) {
  const columns: DataTableColumn<ToolRow>[] = [
    {
      id: "tool",
      header: "Tool",
      isRowHeader: true,
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <FiGlobe aria-hidden className="size-3.5 text-muted" />
          {describeTool(row.tool)}
        </span>
      ),
    },
    {
      id: "calls",
      header: "Calls",
      align: "end",
      cell: (row) => (
        <span className="text-mono-caption">{formatNumber(row.calls)}</span>
      ),
    },
    {
      id: "failed",
      header: "Failed",
      align: "end",
      cell: (row) => (
        <span
          className={`text-mono-caption ${row.errors ? "text-danger" : "text-subtle"}`}
        >
          {formatNumber(row.errors)}
        </span>
      ),
    },
    {
      id: "requests",
      header: "Requests using it",
      align: "end",
      cell: (row) => (
        <span className="text-mono-caption">{formatNumber(row.requests)}</span>
      ),
    },
    {
      id: "spend",
      header: "Spend",
      align: "end",
      cell: (row) =>
        row.cost > 0 || row.calls === 0 ? (
          <span className="text-mono-caption">{formatUsd(row.cost)}</span>
        ) : (
          <span className="text-caption text-subtle">
            <span className="text-mono-caption">{formatUsd(0)}</span> · no
            per-call price set
            {onSetPrice ? (
              <>
                {" · "}
                <TextButton onPress={() => onSetPrice(row.tool)}>
                  Set
                </TextButton>
              </>
            ) : null}
          </span>
        ),
    },
    ...(onOpen
      ? [
          {
            id: "open",
            header: <span className="sr-only">Open in Activity</span>,
            align: "end" as const,
            width: 44,
            cell: () => (
              <FiArrowUpRight aria-hidden className="size-3.5 text-subtle" />
            ),
          },
        ]
      : []),
  ]
  return (
    <TableScrollFrame className="otari-breakdown">
      <DataTable
        ariaLabel="Gateway-run tools"
        columns={columns}
        rows={rows as ToolRow[]}
        getRowKey={(row) => row.tool}
        isLoading={isLoading}
        onRowAction={onOpen ? (key) => onOpen(String(key)) : undefined}
      />
    </TableScrollFrame>
  )
}
