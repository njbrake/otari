import type { ReactNode } from "react"
import { Button } from "@/design-system/actions/Button"
import { DismissChip } from "@/design-system/indicators/DismissChip"
import type { ActivityChip } from "./activityQuery"

/**
 * The row above the table: the search box, what the log is filtered to (each
 * removable on its own), and how it is grouped.
 *
 * Filters are applied from the column headers and from any cell, so this row
 * only reports them; there is no separate picker to open.
 */
export function ActivityToolbar({
  search,
  timeChip,
  chips,
  onClearChip,
  onClearAll,
  trailing,
}: {
  search: ReactNode
  /** The brushed span, when there is one. */
  timeChip: { value: string; onDismiss: () => void } | undefined
  chips: ActivityChip[]
  onClearChip: (chip: ActivityChip) => void
  onClearAll: () => void
  trailing: ReactNode
}) {
  return (
    <div className="flex min-h-13 flex-wrap items-center gap-2 border-b border-border py-2.5">
      {search}
      {timeChip ? (
        <DismissChip
          label="Time"
          value={timeChip.value}
          onDismiss={timeChip.onDismiss}
        />
      ) : null}
      {chips.map((chip) => (
        <DismissChip
          key={chip.key}
          label={chip.label}
          value={chip.value}
          onDismiss={() => onClearChip(chip)}
        />
      ))}
      {chips.length || timeChip ? (
        <Button size="sm" onPress={onClearAll}>
          Clear all
        </Button>
      ) : null}
      <span className="ml-auto flex items-center gap-2">{trailing}</span>
    </div>
  )
}
