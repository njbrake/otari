import { useEffect, useState } from "react"
import {
  ACTIVITY_DEFAULT_KEY,
  ACTIVITY_PRESETS,
  findPreset,
} from "@/shared/helpers/timeRange"
import { resolveExtentWindow, resolveWindow } from "./activityModel"
import type { ActivityUrl } from "./activityQuery"
import { grainForSpan } from "./chartBars"

/**
 * The two windows the page reads: the list's (the preset, or a brushed span
 * inside it) and the chart's (the whole preset, so there is something to brush).
 *
 * Both are snapshots rather than recomputed each render, because a rolling
 * preset recomputed on render mints a new "now", a new query key and a new
 * request every time anything re-renders. They are taken again when the
 * selection in the URL changes, and on each new reading of the clock, and both
 * off one clock reading: taken separately they land a millisecond apart and the
 * list window reads as reaching outside the chart's.
 * A link opened on `?page=3` keeps its page, since mounting takes the first
 * snapshot rather than a second one.
 */
export function useActivityWindow(
  url: ActivityUrl,
  /** A clock whose each new reading takes both windows up to it. */
  liveClock: number | undefined,
) {
  const range = url.get("range")
  const startParam = url.get("start_date")
  const endParam = url.get("end_date")
  const selectionKey = `${range}|${startParam}|${endParam}`

  const take = (
    takenAt: number,
    extent?: { start?: string; end?: string },
  ) => ({
    selectionKey,
    range,
    takenAt,
    list: resolveWindow(range, startParam, endParam, takenAt),
    extent: extent ?? resolveExtentWindow(range, takenAt),
  })
  const [snapshot, setSnapshot] = useState(() => take(Date.now()))
  // A new selection takes a new snapshot, while rendering rather than in an
  // effect, so no render ever pairs the new URL with the old window. The extent
  // moves only with the preset, or with a live tick: brushing a span inside it
  // must leave the bars where they are. Only a reading newer than the snapshot
  // moves it, so a cached one, returned as the clock is enabled again, does not
  // take the window back.
  if (snapshot.selectionKey !== selectionKey) {
    setSnapshot(
      take(Date.now(), snapshot.range === range ? snapshot.extent : undefined),
    )
  } else if (liveClock !== undefined && liveClock > snapshot.takenAt) {
    setSnapshot(take(liveClock))
  }
  const { list, extent, takenAt } = snapshot

  // A range this page does not offer (a Usage-page key such as `90d` carried
  // over by hand, or `custom` with no bounds to be custom about) resolves to the
  // default window, so the URL is corrected to say so. Bounds win over a preset,
  // so a window carried in `start_date` and `end_date` is left alone.
  const patch = url.patch
  useEffect(() => {
    if (startParam || endParam) return
    if (findPreset(ACTIVITY_PRESETS, range)) return
    patch({ range: ACTIVITY_DEFAULT_KEY })
  }, [range, startParam, endParam, patch])

  // A drill-down can carry bounds reaching outside the preset the URL names.
  // The preset's extent cannot frame those, so the chart frames the window
  // itself. Either way a range with no grain of its own (`custom` beside
  // bounds) takes the finest its window's length allows.
  const outside = Boolean(
    list.start &&
      extent.start &&
      Date.parse(list.start) < Date.parse(extent.start),
  )
  const chart = outside ? list : extent
  const chartGrain =
    (!outside && findPreset(ACTIVITY_PRESETS, range)?.bucket) ||
    grainForSpan(
      (chart.end ? Date.parse(chart.end) : takenAt) -
        Date.parse(chart.start ?? ""),
    )

  return {
    range,
    list,
    chart,
    chartGrain,
    /** The moment both windows were taken, which an open window ends at. */
    now: takenAt,
    /** Whether the list is narrowed inside the window: a brushed span or a drill-down. */
    hasSpan: Boolean(startParam || endParam),
    /** Take both windows again, up to now: a refresh of a rolling window. */
    retake: () => setSnapshot(take(Math.max(Date.now(), takenAt + 1))),
  }
}
