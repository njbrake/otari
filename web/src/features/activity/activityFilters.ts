/**
 * A value column's filter as both layouts offer it: the desk in the column's
 * header menu, the phone as a section of its filter sheet. One model, so the
 * two cannot come to list different values, label them differently or write
 * different keys.
 */

import type { UsageActivityGroup, UsageTotals } from "@/client"
import { shortId } from "./activityModel"
import {
  type ActivityUrl,
  COLUMN_LABELS,
  groupOptions,
  type Patch,
  statusOptions,
  togglePatch,
  VALUE_FILTERS,
  type ValueColumn,
  type ValueOption,
  valuePatch,
} from "./activityQuery"

export interface ValueFilterModel {
  column: ValueColumn
  title: string
  options: ValueOption[]
  picked: string[]
  /** Values left out: unchecked, and marked so, since pressing one lifts that. */
  excluded: string[]
  /** Values that are identifiers (models, policies), set in mono. */
  isMono: boolean
  /** Check or uncheck a value, or lift its exclusion. */
  toggle: (value: string) => Patch
  /** Leave a value out: every row but those carrying it. */
  exclude: (value: string) => Patch
}

/**
 * What a column's checklist holds and writes. Status lists its three outcomes,
 * counted from the totals; every other column lists `groups`, the window's
 * values for it, busiest first, under the name each resolves to.
 */
export function valueFilterModel(
  url: ActivityUrl,
  column: ValueColumn,
  {
    groups,
    totals,
    memberName,
  }: {
    groups: readonly UsageActivityGroup[] | undefined
    totals: UsageTotals | undefined
    memberName: (userId: string | null, alias?: string | null) => string
  },
): ValueFilterModel {
  const { include, exclude } = VALUE_FILTERS[column]
  return {
    column,
    title: COLUMN_LABELS[column],
    options: valueOptions(url, column, groups, totals, memberName),
    picked: url.getAll(include),
    excluded: url.getAll(exclude),
    isMono: column === "model" || column === "policy",
    toggle: (value) => togglePatch(url, column, value),
    exclude: (value) => valuePatch(url, column, value, "exclude"),
  }
}

function valueOptions(
  url: ActivityUrl,
  column: ValueColumn,
  groups: readonly UsageActivityGroup[] | undefined,
  totals: UsageTotals | undefined,
  memberName: (userId: string | null, alias?: string | null) => string,
): ValueOption[] {
  switch (column) {
    case "status":
      return statusOptions(url, totals)
    case "member":
      return groupOptions(groups, (group) => memberName(group.key, group.label))
    case "source":
      return groupOptions(groups, (group) => group.label ?? shortId(group.key))
    default:
      return groupOptions(groups, (group) => group.label ?? group.key)
  }
}
