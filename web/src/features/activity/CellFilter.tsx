import { Dropdown } from "@heroui/react"
import type { ReactNode } from "react"
import { FiFilter, FiSlash } from "react-icons/fi"

import { RowMenuItemContent } from "@/design-system/actions/RowMenuItemContent"
import type { CellFilterMode } from "./cellFilters"

/**
 * A cell's value with a filter on it beside: only the rows with this value, or
 * every row but those. The control shows while the pointer is over the cell or
 * the control has focus, and always under a finger, which has no hover.
 *
 * It is a menu trigger, not a second row action: the table hands a press on a
 * button to the button, so opening it never opens the request, and the grid's
 * arrow keys reach it inside the cell as they reach a row menu.
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
  return (
    <span className="relative flex min-w-0 items-center gap-1">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Dropdown>
        <Dropdown.Trigger
          aria-label={`Only or exclude ${label}`}
          className="otari-cell-filter"
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
