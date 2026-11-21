import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { FiDollarSign, FiLayers } from "react-icons/fi"
import type { UsageToolRow } from "@/client"
import { RowMenu, type RowMenuAction } from "@/design-system/actions/RowMenu"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { useIsMobile } from "@/design-system/hooks/useIsMobile"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import { describeTool } from "@/features/activity/requestPanelModel"
import { RowOpenLink } from "@/features/home/RowOpenLink"
import {
  type SpendWindow,
  sessionsSearchFor,
  usageRange,
} from "@/features/spend/period"
import { ToolRateForm } from "@/features/toolPricing/ToolRateForm"
import { GATEWAY_ROWS, toPerCall } from "@/features/toolPricing/toolRates"
import { useDeploymentOperator } from "@/shared/api/organizations"
import { usePricesInEffect } from "@/shared/api/pricing"
import { useUsageSummary } from "@/shared/api/usage"
import {
  formatNumber,
  formatPct,
  formatUnitRate,
  formatUsd,
} from "@/shared/helpers/format"

const CODE_EXECUTION = GATEWAY_ROWS.code_execution[0]

/** What a call cost on average: the spend over the calls billed, or none where nothing was. */
export function billedPerCall(row: UsageToolRow): number | undefined {
  return row.calls > 0 && row.cost > 0 ? row.cost / row.calls : undefined
}

/** The share of a tool's calls that failed, which no call was billed for. */
export function toolFailureRate(row: UsageToolRow): number {
  const attempted = row.calls + row.errors
  return attempted > 0 ? row.errors / attempted : 0
}

/**
 * "Where it went" by the tools Otari ran itself (web search, web fetch, code
 * execution), which bill per call rather than per token: each tool's calls,
 * failures and failure rate, what a call was billed on average and in all.
 * Each row opens the requests that ran it. A deployment operator sets a tool's
 * price from its row: code execution's here, and search and fetch on the Web
 * search page, where each search or fetch tool has a price of its own.
 */
export function ToolsBreakdown({
  window,
  workspaceId,
  userId,
  isEnabled = true,
  canOpen,
  onOpen,
  emptyText,
}: {
  window: SpendWindow
  workspaceId?: string
  userId?: string
  isEnabled?: boolean
  /** Whether the deployment serves Requests to open a row in. */
  canOpen: boolean
  /** Replaces a row link's plain click, where opening first picks a workspace. */
  onOpen?: (tool: string) => void
  emptyText: string
}) {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const { isOperator } = useDeploymentOperator()
  const [isPricing, setPricing] = useState(false)
  const summary = useUsageSummary(
    {
      workspace_id: workspaceId || undefined,
      user_id: userId ? [userId] : undefined,
      ...usageRange(window),
    },
    window.bucket,
    ["tool"],
    isEnabled,
    "organization",
  )
  const [codePrice] = usePricesInEffect([CODE_EXECUTION], isOperator)
  const rows = summary.isPlaceholderData ? [] : (summary.data?.by_tool ?? [])
  const isLoading = summary.data === undefined || summary.isPlaceholderData

  const searchFor = (tool: string) => ({ ...sessionsSearchFor(window), tool })

  const menuFor = (row: UsageToolRow): RowMenuAction[] => {
    const actions: RowMenuAction[] = []
    if (canOpen) {
      actions.push({
        id: "open",
        label: "See its requests",
        hint: "The requests that ran it",
        icon: FiLayers,
        run: () =>
          onOpen
            ? onOpen(row.tool)
            : void navigate({ to: "/requests", search: searchFor(row.tool) }),
      })
    }
    if (isOperator && row.tool === "code_execution") {
      actions.push({
        id: "price",
        label: "Set price per call…",
        hint: codePrice.data
          ? `Now ${formatUnitRate(toPerCall(codePrice.data.input_price_per_million))}`
          : "Not priced",
        icon: FiDollarSign,
        run: () => setPricing(true),
      })
    } else if (isOperator) {
      actions.push({
        id: "price",
        label: "Set prices in Web search",
        hint: "Each search and fetch tool has its own",
        icon: FiDollarSign,
        run: () => void navigate({ to: "/admin/web-search" }),
      })
    }
    return actions
  }

  const columns: DataTableColumn<UsageToolRow>[] = [
    {
      id: "name",
      header: "Tool",
      isRowHeader: true,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-foreground">
            {describeTool(row.tool)}
          </span>
          {canOpen && !isMobile ? (
            <span className="flex">
              <RowOpenLink
                to="/requests"
                search={searchFor(row.tool)}
                label="Requests"
                subject={describeTool(row.tool)}
                onOpen={onOpen ? () => onOpen(row.tool) : undefined}
                isCompact
              />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "calls",
      header: "Calls",
      align: "end",
      cell: (row) => (
        <span className="text-mono-caption text-foreground">
          {formatNumber(row.calls)}
        </span>
      ),
    },
    {
      id: "failed",
      header: "Failed",
      align: "end",
      cell: (row) => (
        <span
          className={`text-mono-caption ${row.errors > 0 ? "text-danger" : "text-muted"}`}
        >
          {formatNumber(row.errors)}
        </span>
      ),
    },
    {
      id: "rate",
      header: "Failure rate",
      align: "end",
      cell: (row) => (
        <span className="text-mono-caption text-foreground">
          {formatPct(toolFailureRate(row))}
        </span>
      ),
    },
    {
      id: "per_call",
      header: "Billed per call",
      align: "end",
      cell: (row) => {
        const perCall = billedPerCall(row)
        return (
          <span
            className={`text-mono-caption ${perCall === undefined ? "text-muted" : "text-foreground"}`}
          >
            {perCall === undefined ? "Not billed" : formatUnitRate(perCall)}
          </span>
        )
      },
    },
    {
      id: "cost",
      header: "Cost",
      align: "end",
      cell: (row) => (
        <span className="text-mono-caption text-foreground">
          {formatUsd(row.cost)}
        </span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-3">
          {canOpen && isMobile ? (
            <RowOpenLink
              to="/requests"
              search={searchFor(row.tool)}
              label="Requests"
              subject={describeTool(row.tool)}
              onOpen={onOpen ? () => onOpen(row.tool) : undefined}
            />
          ) : null}
          <RowMenu
            label={`Actions for ${describeTool(row.tool)}`}
            actions={menuFor(row)}
          />
        </span>
      ),
    },
  ]

  return (
    <>
      <TableScrollFrame className="otari-breakdown flex flex-col gap-2">
        <DataTable
          ariaLabel="Spend by tool"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.tool}
          isLoading={isLoading}
          emptyContent={
            <EmptyMessage>
              {summary.isError ? "Could not load" : emptyText}
            </EmptyMessage>
          }
          mobileLayout="cards"
        />
      </TableScrollFrame>
      {isPricing ? (
        <ToolRateForm
          row={CODE_EXECUTION}
          current={
            codePrice.data
              ? toPerCall(codePrice.data.input_price_per_million)
              : undefined
          }
          onClose={() => setPricing(false)}
        />
      ) : null}
    </>
  )
}
