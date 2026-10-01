import { Drawer, ToggleButton, ToggleButtonGroup } from "@heroui/react"
import type { ReactNode } from "react"
import { FiX } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { isSameSort, type UsageSort } from "@/shared/api/usage"
import { formatNumber, formatUsd } from "@/shared/helpers/format"
import type { ValueFilterModel } from "./activityFilters"
import { type Patch, THRESHOLD_FILTERS } from "./activityQuery"
import { ValueChecklist } from "./ValueChecklist"

// The orders a phone offers, as whole phrases: there is no header to press.
export const PHONE_SORTS: { label: string; sort: UsageSort }[] = [
  { label: "Newest first", sort: { key: "timestamp", order: "desc" } },
  { label: "Oldest first", sort: { key: "timestamp", order: "asc" } },
  { label: "Highest cost", sort: { key: "cost", order: "desc" } },
  { label: "Most tokens", sort: { key: "tokens", order: "desc" } },
  { label: "Slowest", sort: { key: "latency", order: "desc" } },
  { label: "Failures first", sort: { key: "status", order: "desc" } },
]

// The Cost column's thresholds, smallest first as a row of chips reads.
const COST_STEPS = [...THRESHOLD_FILTERS.cost.presets].reverse()

export interface SheetSection extends ValueFilterModel {
  /** How many values the window holds past those listed, busiest first. */
  more?: number
  isError?: boolean
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-border-subtle px-4 pt-3.5 pb-1.5">
      <h3 className="text-overline">{title}</h3>
      {children}
    </section>
  )
}

/**
 * One choice out of a few, as a wrapping row of chips a thumb can hit: the
 * sort, or a cost threshold. `isRequired` keeps one chosen at all times;
 * without it, pressing the chosen chip again clears it.
 */
function ChoiceGroup({
  label,
  options,
  selected,
  onChange,
  isRequired = false,
  isMono = false,
}: {
  label: string
  options: { id: string; label: string }[]
  selected: string | undefined
  onChange: (id: string | undefined) => void
  isRequired?: boolean
  isMono?: boolean
}) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection={isRequired}
      selectedKeys={selected === undefined ? [] : [selected]}
      onSelectionChange={(keys) => {
        const [next] = [...keys]
        onChange(next === undefined ? undefined : String(next))
      }}
      isDetached
      className="flex-wrap gap-2 pb-2"
    >
      {options.map((option) => (
        <ToggleButton
          key={option.id}
          id={option.id}
          className={`h-auto min-h-11 border border-control-border bg-surface px-3 font-normal text-foreground data-[selected=true]:border-foreground data-[selected=true]:bg-foreground data-[selected=true]:text-background ${isMono ? "text-mono-caption" : "text-sm"}`}
        >
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

/**
 * The phone's sort and filters in one sheet, since there is no header row to
 * hang them on and no hover to reveal them. Every change applies at once; the
 * button at the foot says how many requests the list will show.
 */
export function FilterSheet({
  isOpen,
  onOpenChange,
  sort,
  onSort,
  sections,
  onRefine,
  cost,
  onCost,
  count,
  onReset,
}: {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  sort: UsageSort
  onSort: (sort: UsageSort) => void
  sections: SheetSection[]
  onRefine: (patch: Patch) => void
  cost: number | undefined
  onCost: (cost: number | undefined) => void
  count: number | undefined
  /** Set while anything is filtered. */
  onReset: (() => void) | undefined
}) {
  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Backdrop className="bg-backdrop/30">
        <Drawer.Content placement="bottom">
          <Drawer.Dialog
            aria-label="Filter and sort"
            className="flex max-h-[82dvh] flex-col border-t border-control-border bg-surface p-0"
          >
            <Drawer.Header className="flex flex-row items-center py-2 pr-2 pl-4">
              <Drawer.Heading className="flex-1 text-title">
                Filter and sort
              </Drawer.Heading>
              {onReset ? (
                <Button size="sm" onPress={onReset}>
                  Reset
                </Button>
              ) : null}
              <IconButton label="Close" onPress={() => onOpenChange(false)}>
                <FiX aria-hidden className="size-4" />
              </IconButton>
            </Drawer.Header>
            <Drawer.Body className="m-0 flex-1 overflow-y-auto p-0 pb-2 text-foreground">
              <Section title="Sort">
                <ChoiceGroup
                  label="Sort"
                  isRequired
                  options={PHONE_SORTS.map((option) => ({
                    id: option.label,
                    label: option.label,
                  }))}
                  selected={
                    PHONE_SORTS.find((option) => isSameSort(option.sort, sort))
                      ?.label
                  }
                  onChange={(id) => {
                    const picked = PHONE_SORTS.find(
                      (option) => option.label === id,
                    )
                    if (picked) onSort(picked.sort)
                  }}
                />
              </Section>
              {sections.map((section) =>
                section.options.length || section.isError ? (
                  <Section key={section.title} title={section.title}>
                    <ValueChecklist
                      density="sheet"
                      options={section.options}
                      picked={section.picked}
                      excluded={section.excluded}
                      isMono={section.isMono}
                      onToggle={(value) => onRefine(section.toggle(value))}
                    />
                    {section.isError ? (
                      <p className="pb-2 text-caption text-danger">
                        These values could not be loaded.
                      </p>
                    ) : section.more ? (
                      <p className="pb-2 text-caption text-subtle">
                        And {formatNumber(section.more)} more, less busy
                      </p>
                    ) : null}
                  </Section>
                ) : null,
              )}
              <Section title="Cost">
                <ChoiceGroup
                  label="Cost above"
                  isMono
                  options={COST_STEPS.map((step) => ({
                    id: String(step),
                    label: `> ${formatUsd(step)}`,
                  }))}
                  selected={cost === undefined ? undefined : String(cost)}
                  onChange={(id) =>
                    onCost(id === undefined ? undefined : Number(id))
                  }
                />
              </Section>
            </Drawer.Body>
            <Drawer.Footer className="border-t border-border px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <Button
                variant="primary"
                fullWidth
                className="h-12"
                onPress={() => onOpenChange(false)}
              >
                Show {count === undefined ? "" : `${formatNumber(count)} `}
                requests
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  )
}
