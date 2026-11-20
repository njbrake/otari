import { Dropdown } from "@heroui/react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { FiFilter, FiSlash } from "react-icons/fi"

import { RowMenuItemContent } from "@/design-system/actions/RowMenuItemContent"
import type { CellFilterMode } from "./cellFilters"

/** The keys that open a focused cell's filter, as `aria-keyshortcuts` spells them. */
export const CELL_FILTER_KEYS = "Shift+F10 ContextMenu"

const opensFilter = (event: KeyboardEvent) =>
  event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")

/**
 * A cell's value with a filter on it beside: only the rows with this value, or
 * every row but those. The control shows while the pointer is over the cell or
 * the control has focus, and always under a finger, which has no hover.
 *
 * It is a menu trigger, not a second row action: the table hands a press on a
 * button to the button, so opening it never opens the request. It takes no
 * Tab stop of its own, which a page of rows would multiply into hundreds: from
 * a cell the grid's arrow keys reach, the context-menu key or Shift+F10 opens
 * it (`CELL_FILTER_KEYS`), which the cell announces.
 */
export function CellFilter({
  value,
  label,
  onFilter,
  canExclude = true,
  children,
}: {
  /** What the menu names: the value as the cell shows it. */
  label: string
  /** The value the filter writes, kept apart from the label, which may be a name; null for an empty cell. */
  value: string | null
  onFilter: (value: string | null, mode: CellFilterMode) => void
  /** False where the column's filter cannot leave a value out. */
  canExclude?: boolean
  children: ReactNode
}) {
  const [isOpen, setIsOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  // The cell, not the control, holds focus as the grid's arrows move, so the
  // key is heard there; the cell also says it has the shortcut.
  useEffect(() => {
    const cell = anchor.current?.closest<HTMLElement>(
      '[role="gridcell"], [role="rowheader"]',
    )
    if (!cell) return
    cell.setAttribute("aria-keyshortcuts", CELL_FILTER_KEYS)
    const onKeyDown = (event: KeyboardEvent) => {
      if (!opensFilter(event)) return
      event.preventDefault()
      event.stopPropagation()
      setIsOpen(true)
    }
    cell.addEventListener("keydown", onKeyDown)
    return () => {
      cell.removeEventListener("keydown", onKeyDown)
      cell.removeAttribute("aria-keyshortcuts")
    }
  }, [])
  return (
    <span ref={anchor} className="relative flex min-w-0 items-center gap-1">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Dropdown isOpen={isOpen} onOpenChange={setIsOpen}>
        <Dropdown.Trigger
          aria-label={`Only or exclude ${label}`}
          className="otari-cell-filter"
          excludeFromTabOrder
        >
          <FiFilter aria-hidden className="size-3" />
        </Dropdown.Trigger>
        <Dropdown.Popover placement="bottom end" className="otari-row-menu">
          <Dropdown.Menu
            aria-label={`Only or exclude ${label}`}
            onAction={(key) =>
              onFilter(value, key === "exclude" ? "exclude" : "include")
            }
          >
            <Dropdown.Item id="include" textValue={`Only ${label}`}>
              <RowMenuItemContent
                icon={FiFilter}
                label={`Only ${label}`}
                hint={undefined}
                isRed={false}
              />
            </Dropdown.Item>
            {canExclude ? (
              <Dropdown.Item id="exclude" textValue={`Exclude ${label}`}>
                <RowMenuItemContent
                  icon={FiSlash}
                  label={`Exclude ${label}`}
                  hint={undefined}
                  isRed={false}
                />
              </Dropdown.Item>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </span>
  )
}
