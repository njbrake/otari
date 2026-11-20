import { useNavigate } from "@tanstack/react-router"
import type { ApiKey } from "@/client"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { useIsMobile } from "@/design-system/hooks/useIsMobile"
import { Chip } from "@/design-system/indicators/Chip"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import { Segmented } from "@/design-system/navigation/Segmented"
import { RowOpenLink } from "@/features/home/RowOpenLink"
import type { PersonRow } from "@/features/people/people"
import {
  type BreakdownRow,
  PERSON_CUTS,
  type PersonCut,
  personCutOf,
  splitRows,
} from "@/features/people/personBreakdown"
import type { PersonSpend } from "@/features/people/usePersonSpend"
import { useTheirWorkspace } from "@/features/people/useTheirWorkspace"
import {
  type SpendWindow,
  sessionsSearchFor,
  windowWords,
} from "@/features/spend/period"
import { Band } from "@/shared/components/Band"
import {
  formatCost,
  formatNumber,
  formatTokens,
  formatUsd,
} from "@/shared/helpers/format"
import { useSurfaces } from "@/shared/hooks/useDeployment"

/** A cent and up as dollars and cents; a fraction of one to its digits. */
const money = (value: number) =>
  value === 0 || value >= 0.01 ? formatUsd(value) : formatCost(value)

/**
 * Where a person's spend went over the window, by model, API key, provider or
 * source: each value's requests and tokens, what it spent against their
 * budgets, and, once any of it is, what it spent that is tracked and not
 * charged. Each row links to their sessions on that value, or their requests
 * where Sessions cannot filter on it.
 */
export function PersonBreakdown({
  person,
  userId,
  window,
  cut,
  onCutChange,
  spend,
  keys,
}: {
  person: PersonRow
  userId: string
  window: SpendWindow
  cut: PersonCut
  onCutChange: (next: PersonCut) => void
  spend: PersonSpend
  keys: readonly ApiKey[]
}) {
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
    : splitRows(cut, spend.budgeted, spend.exempt, keys)
  // A column for exempt spend only once there is some to put in it.
  const hasExempt = (spend.exempt?.totals.request_count ?? 0) > 0

  const searchFor = (row: BreakdownRow) => ({
    ...sessionsSearchFor(window),
    user_id: userId,
    // A model is every id it ran as; the request log's provider and source
    // filters take one value.
    [shown.filter]: cut === "models" ? row.filterValues : row.filterValues[0],
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
      id: "requests",
      header: "Requests",
      align: "end",
      cell: (row) => (
        <span className="text-mono-caption text-foreground">
          {formatNumber(row.requests)}
        </span>
      ),
    },
    {
      id: "tokens",
      header: "Tokens",
      align: "end",
      cell: (row) => (
        <span className="text-mono-caption text-foreground">
          {formatTokens(row.tokens)}
        </span>
      ),
    },
    {
      id: "spend",
      header: hasExempt ? "Budgeted" : "Spent",
      align: "end",
      cell: (row) => (
        <span className="text-mono-caption text-foreground">
          {money(row.budgeted)}
        </span>
      ),
    },
    ...(hasExempt
      ? ([
          {
            id: "exempt",
            header: "Exempt",
            align: "end",
            cell: (row) => (
              <span
                className={`text-mono-caption ${row.exempt > 0 ? "text-foreground" : "text-muted"}`}
              >
                {money(row.exempt)}
              </span>
            ),
          },
        ] satisfies DataTableColumn<BreakdownRow>[])
      : []),
    ...(canOpen
      ? ([
          {
            id: "actions",
            header: <span className="sr-only">Actions</span>,
            align: "end",
            cell: (row) =>
              row.filterValues.length > 0 ? (
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

  const pick = (next: string) => onCutChange(personCutOf(next).value)

  return (
    <Band
      title="Where it went"
      description={
        hasExempt
          ? "Budgeted spend counts toward their spend limits. Exempt spend is tracked and not charged, such as a key that records a subscription's usage."
          : undefined
      }
      action={
        // Four choices fill a track, and a phone fits three.
        isMobile ? (
          <FilterSelect
            ariaLabel="Break down by"
            value={cut}
            onChange={pick}
            options={PERSON_CUTS}
          />
        ) : (
          <Segmented
            label="Break down by"
            size="md"
            options={PERSON_CUTS}
            value={cut}
            onChange={pick}
          />
        )
      }
    >
      <ErrorBanner error={spend.error} />
      <TableScrollFrame className="otari-breakdown">
        <DataTable
          key={cut}
          ariaLabel={`${person.name}'s spend by ${shown.label.toLowerCase()}`}
          columns={columns}
          rows={rows}
          isLoading={isLoading}
          getRowKey={(row) => row.id}
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
    </Band>
  )
}
