import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import type { ApiKey } from "@/client"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { useIsMobile } from "@/design-system/hooks/useIsMobile"
import { Chip } from "@/design-system/indicators/Chip"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import { RowOpenLink } from "@/features/home/RowOpenLink"
import type { PersonRow } from "@/features/people/people"
import {
  type BreakdownRow,
  formatSpend,
  PERSON_CUTS,
  type PersonCut,
  personCutOf,
  rowFigures,
  splitRows,
} from "@/features/people/personBreakdown"
import type { PersonSpend } from "@/features/people/usePersonSpend"
import { useTheirWorkspace } from "@/features/people/useTheirWorkspace"
import {
  type SpendWindow,
  sessionsSearchFor,
  windowWords,
} from "@/features/spend/period"
import {
  BreakdownSortSelect,
  breakdownFigureColumns,
  breakdownSortProps,
} from "@/features/usage/BreakdownColumns"
import { type BreakdownSort, sortRows } from "@/features/usage/breakdownSort"
import { Band } from "@/shared/components/Band"
import { useSurfaces } from "@/shared/hooks/useDeployment"

/** Rows shown before the rest folds behind "Show all". */
const TOP_ROWS = 5

/**
 * Where a person's spend went over the window, by model, API key, provider,
 * source, session, channel or routing policy: each value's spend, and once any
 * of it is not, what was charged and what was not, then its requests, tokens,
 * failures and p95 latency, every column sorting the table. Each row links to
 * their sessions on that value, or their requests where Sessions cannot filter
 * on it.
 */
export function PersonBreakdown({
  person,
  userId,
  window,
  cut,
  onCutChange,
  sort,
  onSort,
  spend,
  keys,
}: {
  person: PersonRow
  userId: string
  window: SpendWindow
  cut: PersonCut
  onCutChange: (next: PersonCut) => void
  sort: BreakdownSort
  onSort: (next: BreakdownSort) => void
  spend: PersonSpend
  keys: readonly ApiKey[]
}) {
  const [isShowingAll, setShowingAll] = useState(false)
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const workspace = useTheirWorkspace(person)
  const hasSurface = useSurfaces()
  const shown = personCutOf(cut)
  const canOpen = hasSurface(shown.to === "/sessions" ? "traces" : "usage")
  // The rows of a cut or window still loading would be the last one's.
  const isLoading = spend.isLoading || spend.isStale
  const rows = isLoading
    ? []
    : sortRows(splitRows(cut, spend.breakdown, keys), sort, {
        figuresOf: rowFigures,
        nameOf: (row) => row.name,
        isLast: (row) => row.isOther,
      })
  const visible = isShowingAll ? rows : rows.slice(0, TOP_ROWS)
  // Columns for charged and not charged only once some is not charged.
  const hasExempt = (spend.exempt?.totals.request_count ?? 0) > 0
  const changeSort = (next: BreakdownSort) => {
    setShowingAll(false)
    onSort(next)
  }

  /** What a row filters on: its value, or the requests that recorded none. */
  const filterOf = (row: BreakdownRow): Record<string, string | string[]> => {
    if (row.filterValues.length === 0)
      return row.isNone ? (shown.none ?? {}) : {}
    // A model is every id it ran as; the request log's other filters here
    // take one value.
    return {
      [shown.filter]: cut === "models" ? row.filterValues : row.filterValues[0],
    }
  }
  const canOpenRow = (row: BreakdownRow) =>
    Object.keys(filterOf(row)).length > 0

  const searchFor = (row: BreakdownRow) => ({
    ...sessionsSearchFor(window),
    user_id: userId,
    ...filterOf(row),
  })
  const open = (row: BreakdownRow) => {
    const key =
      cut === "keys" ? keys.find((one) => one.id === row.filterValues[0]) : null
    if (key) workspace.select(key.workspace_id)
    else workspace.selectTheirs()
    void navigate({ to: shown.to, search: searchFor(row) })
  }

  const columns: DataTableColumn<BreakdownRow>[] = [
    {
      id: "name",
      header: shown.noun,
      isRowHeader: true,
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-1 md:max-w-[20rem]">
          <span
            className={`text-foreground ${cut === "models" ? "line-clamp-2 [overflow-wrap:anywhere]" : "truncate"}`}
            title={cut === "models" ? row.filterValues.join("\n") : undefined}
          >
            {row.name}
          </span>
          {row.isExemptKey ? <Chip>Exempt from budget</Chip> : null}
          {row.detail ? (
            <span className="truncate text-caption">{row.detail}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "cost",
      header: "Spent",
      align: "end",
      allowsSorting: true,
      cell: (row) => (
        <span className="text-mono-caption text-foreground">
          {formatSpend(row.budgeted + row.exempt)}
        </span>
      ),
    },
    ...breakdownFigureColumns<BreakdownRow>({
      figuresOf: rowFigures,
      hasNotCharged: hasExempt,
      isP95Loading: false,
      money: formatSpend,
    }),
    ...(canOpen
      ? ([
          {
            id: "actions",
            header: <span className="sr-only">Actions</span>,
            align: "end",
            cell: (row) =>
              canOpenRow(row) ? (
                <RowOpenLink
                  to={shown.to}
                  search={searchFor(row)}
                  label={shown.to === "/sessions" ? "Sessions" : "Requests"}
                  subject={row.name}
                  onOpen={() => open(row)}
                />
              ) : null,
          },
        ] satisfies DataTableColumn<BreakdownRow>[])
      : []),
  ]

  // A deployment that records no sessions names none, so it offers no cut by them.
  const cuts = PERSON_CUTS.filter(
    (one) => one.value !== "sessions" || hasSurface("traces"),
  )
  const pick = (next: string) => {
    setShowingAll(false)
    onCutChange(personCutOf(next).value)
  }

  return (
    <Band
      title="Where it went"
      action={
        <span className="flex flex-wrap items-center gap-2">
          <FilterSelect
            ariaLabel="Break down by"
            value={cut}
            onChange={pick}
            options={cuts}
          />
          {isMobile ? (
            <BreakdownSortSelect
              sort={sort}
              onSort={changeSort}
              hasNotCharged={hasExempt}
            />
          ) : null}
        </span>
      }
    >
      <ErrorBanner error={spend.error} />
      <TableScrollFrame className="otari-breakdown">
        <DataTable
          key={cut}
          ariaLabel={`${person.name}'s spend by ${shown.label.toLowerCase()}`}
          columns={columns}
          rows={visible}
          isLoading={isLoading}
          getRowKey={(row) => row.id}
          {...breakdownSortProps(sort, changeSort)}
          emptyContent={
            <EmptyMessage>
              {spend.error
                ? "Could not load"
                : window.kind === "6m"
                  ? `Nothing was spent ${windowWords(window)}.`
                  : `Nothing was spent ${windowWords(window)}. Pick a longer window above.`}
            </EmptyMessage>
          }
          mobileLayout="cards"
        />
      </TableScrollFrame>
      {rows.length > visible.length ? (
        <button
          type="button"
          onClick={() => setShowingAll(true)}
          className="self-start text-sm text-link underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
        >
          Show all {rows.length} {shown.label.toLowerCase()}
        </button>
      ) : null}
    </Band>
  )
}
