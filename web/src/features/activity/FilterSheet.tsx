import { Drawer } from "@heroui/react"
import type { ReactNode } from "react"
import { FiX } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { Checkbox } from "@/design-system/forms/Checkbox"
import type { UsageSort } from "@/shared/api/usage"
import { formatNumber, formatUsd } from "@/shared/helpers/format"
import { THRESHOLD_FILTERS, type ValueOption } from "./activityQuery"

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

export interface SheetSection {
  title: string
  options: ValueOption[]
  picked: string[]
  /** Values left out; unchecked, and marked so, since tapping one lifts that. */
  excluded: string[]
  onToggle: (value: string) => void
  isMono?: boolean
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

function Choice({
  isOn,
  onPress,
  isMono,
  children,
}: {
  isOn: boolean
  onPress: () => void
  isMono?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={isOn}
      onClick={onPress}
      className={`min-h-11 border px-3 focus-visible:otari-focus-ring ${isMono ? "text-mono-caption" : "text-sm"} ${
        isOn
          ? "border-foreground bg-foreground text-background"
          : "border-control-border bg-surface text-foreground"
      }`}
    >
      {children}
    </button>
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
                <div className="flex flex-wrap gap-2 pb-2">
                  {PHONE_SORTS.map((option) => (
                    <Choice
                      key={option.label}
                      isOn={
                        option.sort.key === sort.key &&
                        option.sort.order === sort.order
                      }
                      onPress={() => onSort(option.sort)}
                    >
                      {option.label}
                    </Choice>
                  ))}
                </div>
              </Section>
              {sections.map((section) =>
                section.options.length || section.isError ? (
                  <Section key={section.title} title={section.title}>
                    {section.options.map((option) => {
                      const isOn = section.picked.includes(option.value)
                      return (
                        <div
                          key={option.value}
                          className="flex min-h-11 items-center gap-3"
                        >
                          <Checkbox
                            isSelected={isOn}
                            onChange={() => section.onToggle(option.value)}
                            hasTouchTarget
                          >
                            <span
                              className={`break-all ${section.isMono ? "text-mono-caption" : ""}`}
                            >
                              {option.label}
                            </span>
                          </Checkbox>
                          <span className="ml-auto flex gap-2 text-mono-micro text-subtle">
                            {section.excluded.includes(option.value) ? (
                              <span className="text-danger">excluded</span>
                            ) : null}
                            {option.count !== undefined
                              ? formatNumber(option.count)
                              : null}
                          </span>
                        </div>
                      )
                    })}
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
                <div className="flex flex-wrap gap-2 pb-2">
                  {COST_STEPS.map((step) => (
                    <Choice
                      key={step}
                      isMono
                      isOn={cost === step}
                      onPress={() => onCost(cost === step ? undefined : step)}
                    >
                      &gt; {formatUsd(step)}
                    </Choice>
                  ))}
                </div>
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
