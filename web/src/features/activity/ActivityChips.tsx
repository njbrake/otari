import { DismissChip } from "@/design-system/indicators/DismissChip"
import type { ActivityChip } from "./activityQuery"

/**
 * What the log is narrowed by, each removable on its own: the sort where the
 * layout has no header to show it, the brushed span, then every filter. Bare
 * chips, so each layout sets them in a row of its own.
 */
export function ActivityChips({
  sort,
  span,
  chips,
  onClearChip,
}: {
  /** An order other than newest first, where no column header says it. */
  sort?: { value: string; onDismiss: () => void }
  /** The brushed span, when there is one. */
  span: { value: string; onDismiss: () => void } | undefined
  chips: ActivityChip[]
  onClearChip: (chip: ActivityChip) => void
}) {
  return (
    <>
      {sort ? (
        <DismissChip
          label="Sort"
          value={sort.value}
          onDismiss={sort.onDismiss}
        />
      ) : null}
      {span ? (
        <DismissChip
          label="Time"
          value={span.value}
          onDismiss={span.onDismiss}
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
    </>
  )
}
