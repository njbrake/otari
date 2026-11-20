import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef } from "react"
import type { PreferenceKey, UserPreference } from "@/client"
import {
  clearPreference,
  preferenceKey,
  putPreference,
  usePreference,
} from "@/shared/api/preferences"
import {
  isCustomLayout,
  readTableLayout,
  sanitizeWidths,
  type TableLayout,
  type TableLayoutColumn,
  tableLayoutDocument,
  withoutDefaultWidths,
} from "@/shared/helpers/tableLayout"

/** How long after the last change a layout is saved, so a drag sends one write and not one per frame. */
export const TABLE_LAYOUT_SAVE_DELAY_MS = 500

/**
 * A table's column layout, kept on the server for the signed-in person under
 * `key`, so it follows them to another browser.
 *
 * Every change applies at once, through the query cache, so each component
 * reading the same key (the table, and the Columns control above it) moves
 * together; the write follows `TABLE_LAYOUT_SAVE_DELAY_MS` after the last
 * change, and on unmount if one is still waiting. Until the read answers, or if
 * it fails, the table has its defaults and is never held back for it. A failed
 * write is not reported: the layout stays applied in this tab, and the next
 * change writes it again.
 */
export function useTableLayout(
  key: PreferenceKey,
  columns: readonly TableLayoutColumn[],
) {
  const queryClient = useQueryClient()
  const queryKey = preferenceKey(key)
  const stored = usePreference(key)
  const storedValue = stored.data?.value
  // Memoized because the table identity-checks what it is given: a fresh
  // object each render would rebuild every row.
  const layout = useMemo(
    () => readTableLayout(storedValue, columns),
    [storedValue, columns],
  )
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const save = useCallback(() => {
    pending.current = undefined
    const value = queryClient.getQueryData<UserPreference>(
      preferenceKey(key),
    )?.value
    if (!value) return
    putPreference(key, value).catch(() => {
      // Deliberately quiet; see the hook's comment.
    })
  }, [queryClient, key])

  // A change made just before leaving the page is still saved.
  useEffect(
    () => () => {
      if (pending.current === undefined) return
      clearTimeout(pending.current)
      save()
    },
    [save],
  )

  const apply = (next: TableLayout) => {
    // A read still in flight would land over the change.
    void queryClient.cancelQueries({ queryKey })
    queryClient.setQueryData<UserPreference>(queryKey, {
      key,
      value: tableLayoutDocument(next),
      updated_at: stored.data?.updated_at ?? null,
    })
    clearTimeout(pending.current)
    pending.current = setTimeout(save, TABLE_LAYOUT_SAVE_DELAY_MS)
  }

  return {
    widths: layout.widths,
    hidden: layout.hidden,
    isCustomized: isCustomLayout(layout),
    /** Keep the widths a drag left, beside those of the columns it did not reach. */
    resize: (widths: Record<string, number>) =>
      apply({
        ...layout,
        widths: withoutDefaultWidths(
          { ...layout.widths, ...sanitizeWidths(widths, columns) },
          columns,
        ),
      }),
    setHidden: (id: string, isHidden: boolean) => {
      const hidden = new Set(layout.hidden)
      if (isHidden) hidden.add(id)
      else hidden.delete(id)
      apply({
        ...layout,
        hidden: columns
          .filter((column) => column.isHideable && hidden.has(column.id))
          .map((column) => column.id),
      })
    },
    /** Back to the defaults, here and on the server. */
    reset: () => {
      clearTimeout(pending.current)
      pending.current = undefined
      void queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData<UserPreference>(queryKey, {
        key,
        value: null,
        updated_at: null,
      })
      clearPreference(key).catch(() => {
        // Quiet for the reason a failed save is.
      })
    },
  }
}
