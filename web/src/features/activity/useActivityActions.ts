import { useEffect, useEffectEvent } from "react"
import type { UsageEntry } from "@/client"
import type { UsageSort } from "@/shared/api/usage"
import {
  type ActivityUrl,
  CLEAR_FILTERS,
  type ColumnKey,
  cellFilterPatch,
  type Patch,
  panelFilterPatch,
  toolPatch,
  unpricedPatch,
} from "./activityQuery"
import type { Span } from "./chartBars"
import type { ActivityLog } from "./useActivityLog"

/**
 * What the page's controls do to the URL, shared by both layouts, and the
 * page's keys: while a request is open, up and down (or j and k) step through
 * the list and Escape closes it; otherwise Escape clears a brushed span. Not
 * while typing, not while a menu or a dialog has the keyboard, and not from a
 * control that takes the arrows itself (a segmented picker, a chart).
 *
 * Every change that narrows the log starts it again from its first page.
 */
export function useActivityActions(url: ActivityUrl, log: ActivityLog) {
  const refine = (changes: Patch) => url.patch({ ...changes, page: "0" })
  const openRequest = (entry: UsageEntry | undefined) =>
    url.patch({ request: entry?.id ?? "" })
  const step = (delta: number) => {
    if (!log.navList.length) return
    const index =
      log.openIndex < 0
        ? 0
        : Math.max(0, Math.min(log.navList.length - 1, log.openIndex + delta))
    openRequest(log.navList[index])
  }
  const setSpan = (span: Span | undefined) =>
    refine({
      start_date: span ? new Date(span.from).toISOString() : "",
      end_date: span ? new Date(span.to).toISOString() : "",
    })
  const span: Span | undefined =
    log.time.hasSpan && log.time.list.start
      ? {
          from: Date.parse(log.time.list.start),
          to: log.time.list.end ? Date.parse(log.time.list.end) : log.time.now,
        }
      : undefined

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    // A chord is the browser's or the system's (Ctrl+K, Cmd+J), not a step.
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (
      target?.closest(
        "input, textarea, select, [role=dialog]:not([data-request-view]), [role=radiogroup], [role=slider]",
      )
    )
      return
    if (log.open && (event.key === "ArrowDown" || event.key === "j")) {
      event.preventDefault()
      step(1)
    } else if (log.open && (event.key === "ArrowUp" || event.key === "k")) {
      event.preventDefault()
      step(-1)
    } else if (event.key === "Escape") {
      if (url.get("request")) openRequest(undefined)
      else if (span) setSpan(undefined)
    }
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])

  return {
    refine,
    span,
    setSpan,
    openRequest,
    step,
    clearFilters: () => refine(CLEAR_FILTERS),
    search: (q: string) => refine({ q }),
    sort: (sort: UsageSort) => refine({ sort: sort.key, order: sort.order }),
    scope: (next: "workspace" | "you") =>
      refine({
        scope: next === "you" ? "you" : "",
        user_id: [],
        exclude_user_id: [],
        ...(log.group === "member" ? { group: "" } : {}),
      }),
    range: (range: string) => refine({ range, start_date: "", end_date: "" }),
    cellFilter: (
      column: ColumnKey,
      entry: UsageEntry,
      mode: "include" | "exclude",
    ) => {
      const change = cellFilterPatch(url, column, entry, mode)
      if (change) refine(change)
    },
    panelFilter: (filter: "session" | "source" | "model" | "tool") => {
      if (!log.open) return
      const change = panelFilterPatch(url, filter, log.open)
      if (change) refine({ ...change, request: "" })
    },
    tools: (tools: string[]) => refine(toolPatch(tools)),
    unpriced: () => refine(unpricedPatch(url, true)),
  }
}

export type ActivityActions = ReturnType<typeof useActivityActions>
