import type { LogGroupBy } from "@/client"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import { groupOptions } from "./requestGroups"

/**
 * The Requests toolbar's "Group by". A column sort has no stretch of time to
 * group, so while one holds the chosen grouping reads as paused in the control
 * itself, and picking a grouping then returns the log to newest first.
 */
export function GroupByControl({
  value,
  isPaused,
  offersPerson,
  onChange,
}: {
  value: LogGroupBy | undefined
  isPaused: boolean
  offersPerson: boolean
  onChange: (value: LogGroupBy | "") => void
}) {
  const options = groupOptions(offersPerson).map((option) =>
    isPaused && option.value !== "" && option.value === value
      ? { ...option, label: `${option.label}, paused by sort` }
      : option,
  )
  return (
    <FilterSelect
      ariaLabel="Group by"
      value={value ?? ""}
      options={options}
      onChange={(next) => onChange(next as LogGroupBy | "")}
    />
  )
}
