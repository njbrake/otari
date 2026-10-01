import type { ReactNode } from "react"
import { FiArrowDown, FiArrowUp, FiFilter } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { Popover } from "@/design-system/overlays/Popover"
import type { UsageSort } from "@/shared/api/usage"
import {
  type ColumnKey,
  describeSort,
  firstOrder,
  SORT_KEYS,
} from "./activityQuery"

/**
 * One column's header: its name, which sorts by it, and a funnel that opens
 * its filters.
 *
 * Pressing the name steps through the column's first order, the other one,
 * and back to newest first; the arrow says which is on, and shows faintly on
 * hover which a press would pick. The funnel stays faintly visible at rest so
 * the filters are discoverable without a hint, and turns the accent while the
 * column is filtered.
 */
export function ColumnHeader({
  column,
  label,
  align = "start",
  sort,
  onSort,
  isFiltered,
  menu,
  isMenuOpen,
  onMenuOpen,
  widthRem,
  opensLeft = false,
}: {
  column: ColumnKey
  label: string
  align?: "start" | "end"
  sort: UsageSort
  onSort: () => void
  isFiltered: boolean
  /** The filter menu's content, or undefined for a column that has none. */
  menu: ReactNode | undefined
  isMenuOpen: boolean
  onMenuOpen: (isOpen: boolean) => void
  /** The lane's width; the lane without one takes what the others leave. */
  widthRem: number | undefined
  /** Open the menu leftward, as a right-aligned lane's does, so the last lanes' stay on the page. */
  opensLeft?: boolean
}) {
  const isSorted = sort.key === SORT_KEYS[column]
  const shownOrder = isSorted ? sort.order : firstOrder(column)
  const Arrow = shownOrder === "asc" ? FiArrowUp : FiArrowDown
  const ariaSort = isSorted
    ? sort.order === "asc"
      ? "ascending"
      : "descending"
    : undefined
  return (
    <th
      data-key={column}
      scope="col"
      aria-sort={ariaSort}
      style={widthRem ? { width: `${widthRem}rem` } : undefined}
      className={`group/header p-0 hover:bg-surface-alt ${isMenuOpen ? "bg-surface-alt" : ""}`}
    >
      <div
        className={`flex items-center gap-1 py-2.5 ${
          align === "end" ? "justify-end pr-1 pl-4" : "px-4"
        } ${isSorted || isFiltered ? "text-foreground" : ""}`}
      >
        <button
          type="button"
          onClick={onSort}
          title={
            isSorted
              ? `Sorted ${describeSort(column, sort.order)}. Click to change.`
              : `Sort ${describeSort(column, firstOrder(column))}`
          }
          className="inline-flex items-center gap-1 text-overline text-inherit focus-visible:otari-focus-ring"
        >
          {label}
          <Arrow
            aria-hidden
            className={`size-3 ${
              isSorted ? "" : "opacity-0 group-hover/header:opacity-50"
            }`}
          />
        </button>
        {menu ? (
          <Popover
            label={`Filter ${label}`}
            placement={align === "end" || opensLeft ? "bottom end" : "bottom"}
            padding="none"
            isOpen={isMenuOpen}
            onOpenChange={onMenuOpen}
            trigger={
              <Button
                size="sm"
                isIconOnly
                aria-label={`Filter ${label}`}
                className={`size-[1.125rem] min-w-[1.125rem] ${
                  isFiltered
                    ? "text-accent"
                    : isMenuOpen
                      ? ""
                      : "opacity-30 group-hover/header:opacity-90"
                }`}
              >
                <FiFilter aria-hidden className="size-3" />
              </Button>
            }
          >
            {menu}
          </Popover>
        ) : null}
      </div>
    </th>
  )
}
