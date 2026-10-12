import { Button } from "@/design-system/actions/Button"
import { DismissChip } from "@/design-system/indicators/DismissChip"
import { DIMENSIONS, type UsageFilter } from "./usageQuery"

/**
 * The applied filters as chips, each clearing only itself, shown once there
 * is one. A filter the scope cannot use (Member, read as You) stays in the URL
 * and applies again in a scope that has it, so it is shown grayed rather than
 * dropped.
 */
export function UsageFilterChips({
  filters,
  idleFilters,
  span,
  valueName,
  onClear,
  onClearSpan,
  onClearAll,
}: {
  filters: readonly UsageFilter[]
  idleFilters: readonly UsageFilter[]
  /** The dragged span, as its chip says it. */
  span: string | undefined
  valueName: (filter: UsageFilter, value: string) => string
  onClear: (filter: UsageFilter) => void
  onClearSpan: () => void
  onClearAll: () => void
}) {
  if (!filters.length && !idleFilters.length && !span) return null
  const chip = (filter: UsageFilter) => (
    <DismissChip
      label={`${DIMENSIONS[filter.dimension].label}${filter.mode === "exclude" ? " is not" : ""}`}
      value={filter.values.map((value) => valueName(filter, value)).join(", ")}
      onDismiss={() => onClear(filter)}
    />
  )
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2 border-t border-border py-2">
      {span ? (
        <DismissChip label="Date" value={span} onDismiss={onClearSpan} />
      ) : null}
      {filters.map((filter) => (
        <span key={`${filter.dimension}:${filter.mode}`}>{chip(filter)}</span>
      ))}
      {idleFilters.map((filter) => (
        <span
          key={`${filter.dimension}:${filter.mode}`}
          className="inline-flex items-center gap-1.5 opacity-(--disabled-opacity)"
        >
          {chip(filter)}
          <span className="text-mono-micro text-subtle">not in this scope</span>
        </span>
      ))}
      <Button size="sm" onPress={onClearAll}>
        Clear all
      </Button>
      <span className="ml-auto text-caption text-subtle">
        Also applied in Activity
      </span>
    </div>
  )
}
