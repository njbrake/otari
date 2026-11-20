import type { UsageGroupBy, UsageGroupRow } from "@/client"
import { DismissChip } from "@/design-system/indicators/DismissChip"
import {
  customWindow,
  type PeriodKey,
  type SpendWindow,
  windowOf,
} from "@/features/spend/period"
import { SpendPeriodPicker } from "@/features/spend/SpendPeriodPicker"
import { filterValues, type SpendRow } from "@/features/spend/useSpend"

/**
 * What Home's URL keeps beyond its window preset: a span dragged out on the
 * usage chart (`start`, `end`), the calendar month the budget chart reads, what
 * the usage chart draws, and whether it leaves out what no budget counted.
 */
export const HOME_CHART_URL = {
  start: "",
  end: "",
  month: "",
  chart: "",
  charged: "",
}

/** The page's window: a dragged span where the URL holds one, else the preset. */
export function homeWindow(
  period: PeriodKey,
  start: string,
  end: string,
  now: number,
): SpendWindow {
  return customWindow(start, end, now) ?? windowOf(period, now)
}

/** The usage series' `group_by` for one of Home's breakdowns. */
export const GROUP_BY: Record<string, UsageGroupBy> = {
  people: "user_id",
  keys: "api_key_id",
  models: "model",
  providers: "provider",
  workspaces: "workspace_id",
}

/**
 * A chart group's name as the table under it spells it: the row whose filter
 * holds the group's key, then the server's own label, then the key itself.
 */
export function labelFromRows(
  rows: readonly SpendRow[],
): (group: UsageGroupRow) => string {
  const names = new Map<string, string>()
  for (const row of rows) {
    for (const value of filterValues(row)) names.set(value, row.name)
  }
  return (group) =>
    (group.key !== null ? names.get(group.key) : undefined) ??
    group.label ??
    group.key ??
    "Unknown"
}

/**
 * The window picker, and beside it the span a drag on the chart chose, which
 * a press on its × or on any preset lets go of.
 */
export function HomeWindowPicker({
  period,
  window,
  onPeriod,
  onClearSpan,
}: {
  period: PeriodKey
  window: SpendWindow
  onPeriod: (next: string) => void
  onClearSpan: () => void
}) {
  const isSpan = window.kind === "custom"
  return (
    <>
      {isSpan ? (
        <DismissChip
          label="Window"
          value={window.label}
          onDismiss={onClearSpan}
          dismissLabel={`Clear the window ${window.label}`}
        />
      ) : null}
      <SpendPeriodPicker value={isSpan ? "" : period} onChange={onPeriod} />
    </>
  )
}
