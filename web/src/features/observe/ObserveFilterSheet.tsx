import { useState } from "react"
import { FiX } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { ColumnFilterList } from "@/design-system/data/ColumnFilterList"
import { Dialog } from "@/design-system/feedback/Dialog"
import { Disclosure } from "@/design-system/navigation/Disclosure"
import { Segmented } from "@/design-system/navigation/Segmented"
import {
  readSort,
  readSortChoice,
  sortChoices,
  sortUrl,
} from "@/features/activity/requestSort"
import {
  clearedKeys,
  isFiltered,
  ObserveFilterSections,
  offeredSections,
} from "./ObserveColumnFilter"
import { OBSERVE_FILTER_COLUMNS } from "./observeColumnFilters"
import {
  type ObserveFilterState,
  readThreshold,
  THRESHOLDS,
  useObserveFilterState,
} from "./observeFilters"
import type { ObserveView } from "./observeSearch"

// "Model" reads as "model" mid-sentence; "API key" keeps its acronym.
const inSentence = (label: string) =>
  /^[A-Z]{2}/.test(label)
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1)

/**
 * A tab's column filters on a phone, where the table is a list of cards with
 * no headers to hang a funnel on. One section per filterable column, in the
 * table's order, each holding what that column's funnel holds on a desk, from
 * the same definitions (`OBSERVE_FILTER_COLUMNS`).
 *
 * A full-screen sheet below `sm` (the `Dialog` frame), which traps focus while
 * open and returns it to the control that opened it. Every change applies at
 * once, as a funnel's does, so Done only closes it. A section reads its values
 * when it is first expanded; one already filtered opens expanded, so what is set is
 * what the sheet shows first.
 */
export function ObserveFilterSheet({
  view,
  isOpen,
  onOpenChange,
  onClearAll,
  hasFilters,
}: {
  view: ObserveView
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  /** Clears every filter the chip row shows, as its own Clear all does. */
  onClearAll: () => void
  hasFilters: boolean
}) {
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Filters"
      description="Changes apply as you make them."
      actions={
        <>
          <Button onPress={onClearAll} isDisabled={!hasFilters}>
            Clear all
          </Button>
          <Button variant="primary" onPress={() => onOpenChange(false)}>
            Done
          </Button>
        </>
      }
    >
      <SheetSections view={view} />
    </Dialog>
  )
}

// Mounted only while the sheet is open, so each opening starts from what is
// filtered then.
function SheetSections({ view }: { view: ObserveView }) {
  const state = useObserveFilterState(view)
  const offered = OBSERVE_FILTER_COLUMNS[view]
    .map((column) => ({
      label: column.label,
      sections: offeredSections(column.sections, state),
    }))
    .filter((column) => column.sections.length > 0)
  // On Requests the column holding the cost threshold is drawn open as the
  // Cost section below the sort, its threshold as one row of choices, rather
  // than a second section of the same name.
  const isCost = (column: (typeof offered)[number]) =>
    state.isRequests &&
    column.sections.some(
      (section) => section.kind === "threshold" && section.key === "cost_gt",
    )
  const cost = offered.find(isCost)
  const columns = offered.filter((column) => !isCost(column))
  const [expanded, setExpanded] = useState(() =>
    columns
      .filter((column) => isFiltered(column.sections, state))
      .map((column) => column.label),
  )
  const sections = columns.map((column) => (
    <SheetSection
      key={column.label}
      view={view}
      state={state}
      label={column.label}
      sections={column.sections}
      isExpanded={expanded.includes(column.label)}
      onExpandedChange={(isExpanded) =>
        setExpanded((current) =>
          isExpanded
            ? [...current, column.label]
            : current.filter((label) => label !== column.label),
        )
      }
    />
  ))
  return state.isRequests ? (
    <>
      <SortSection state={state} />
      {cost ? (
        <CostSection
          view={view}
          state={state}
          rest={cost.sections.filter((section) => section.kind !== "threshold")}
        />
      ) : null}
      {sections}
    </>
  ) : (
    sections
  )
}

// The Cost column's thresholds, smallest first as a row of segments reads.
const COST = THRESHOLDS.cost_gt
const COST_STEPS = [...COST.presets].reverse()

/**
 * The cost a request has to pass to be listed, one tap away: the Cost
 * column's own thresholds, which a desk sets from that column's funnel.
 */
function CostSection({
  view,
  state,
  rest,
}: {
  view: ObserveView
  state: ObserveFilterState
  /** The column's other filters, such as priced or unpriced, listed under the threshold. */
  rest: ReturnType<typeof offeredSections>
}) {
  const current = readThreshold(state.url.get("cost_gt"))
  const value =
    current === undefined
      ? ""
      : COST_STEPS.includes(current)
        ? String(current)
        : "other"
  const options = [
    { value: "", label: "Any cost" },
    ...COST_STEPS.map((step) => ({
      value: String(step),
      label: COST.describe(step),
    })),
    // A threshold set elsewhere stays the choice shown until another is made.
    ...(value === "other" && current !== undefined
      ? [{ value: "other", label: COST.describe(current) }]
      : []),
  ]
  return (
    <div className="flex flex-col gap-2 border-border border-t px-6 py-3">
      <span className="text-body">Cost</span>
      <Segmented
        label="Cost above"
        isFullWidth
        value={value}
        options={options}
        onChange={(next) => {
          if (next !== "other") state.patch({ cost_gt: next })
        }}
      />
      {rest.length > 0 ? (
        <div className="-mx-3 flex flex-col">
          <ObserveFilterSections
            view={view}
            label="Cost"
            sections={rest}
            state={state}
          />
        </div>
      ) : null}
    </div>
  )
}

const SORT_CHOICES = sortChoices()

/**
 * The order the cards are listed in, which a desk sets by pressing a column's
 * header: the phone's cards have none to press.
 */
function SortSection({ state }: { state: ObserveFilterState }) {
  const current = readSort(state.url.get("sort"), state.url.get("order"))
  const [isExpanded, setIsExpanded] = useState(false)
  const value = `${current.sort}:${current.order}`
  const label =
    SORT_CHOICES.find((choice) => choice.value === value)?.label ??
    "Newest first"
  return (
    <div className="px-6">
      <Disclosure
        heading={
          <span className="flex min-w-0 items-center gap-2">
            Sort
            <span className="truncate text-caption">{label}</span>
          </span>
        }
        isExpanded={isExpanded}
        onExpandedChange={setIsExpanded}
      >
        <div className="-mx-3 flex flex-col">
          <ColumnFilterList
            label="Sort requests"
            selectionMode="single"
            options={SORT_CHOICES}
            selected={[value]}
            onChange={(values) =>
              state.patch(sortUrl(readSortChoice(values.at(-1) ?? value)))
            }
          />
        </div>
      </Disclosure>
    </div>
  )
}

function SheetSection({
  view,
  state,
  label,
  sections,
  isExpanded,
  onExpandedChange,
}: {
  view: ObserveView
  state: ObserveFilterState
  label: string
  sections: ReturnType<typeof offeredSections>
  isExpanded: boolean
  onExpandedChange: (isExpanded: boolean) => void
}) {
  const filtered = isFiltered(sections, state)
  // Kept mounted once opened, so collapsing animates the list rather than an
  // empty panel.
  const [hasOpened, setHasOpened] = useState(isExpanded)
  if (isExpanded && !hasOpened) setHasOpened(true)
  return (
    <div className="border-border border-t px-6">
      <Disclosure
        heading={
          <span className="flex min-w-0 items-center gap-2">
            {label}
            {filtered ? (
              <span className="text-caption text-accent">Filtered</span>
            ) : null}
          </span>
        }
        isExpanded={isExpanded}
        onExpandedChange={onExpandedChange}
      >
        {/* Mounted on first expand: the values read from the server when it
            mounts. The rows carry their own inset, so the list is pulled out
            by it to share the heading's edge. */}
        {hasOpened ? (
          <div className="-mx-3 flex flex-col">
            <ObserveFilterSections
              view={view}
              label={label}
              sections={sections}
              state={state}
            />
            {filtered ? (
              <Button
                size="sm"
                variant="ghost"
                className="mx-1 mt-1 justify-start"
                onPress={() => state.patch(clearedKeys(sections, state))}
              >
                <FiX aria-hidden className="size-3.5" />
                Clear {inSentence(label)} filters
              </Button>
            ) : null}
          </div>
        ) : null}
      </Disclosure>
    </div>
  )
}
