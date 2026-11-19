import type { ReactNode } from "react"
import { useState } from "react"
import { CheckboxContext } from "react-aria-components"
import { FiFilter, FiX } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { Divider } from "@/design-system/layout/Divider"
import { Popover } from "@/design-system/overlays/Popover"

// "Model" reads as "model" mid-sentence; "API key" keeps its acronym.
const inSentence = (label: string) =>
  /^[A-Z]{2}/.test(label)
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1)

/**
 * A funnel in a table column's header that opens that column's filters.
 *
 * Goes in `DataTableColumn.headerAction`. The funnel stays faintly visible at
 * rest, so the filter is discoverable without a hint, brightens while the
 * pointer is over the header (the `group/column` `DataTable` puts it in), and
 * takes the accent while the column is filtered, so a reader can tell which
 * columns narrowed the rows. On a coarse pointer it is at full strength and the
 * 44px touch floor, since there is no hover to find it by.
 *
 * `children` is the panel's content, usually one `ColumnFilterList` per thing
 * the column can be filtered by. `onClear` adds a "Clear … filters" row while
 * the column is filtered, which closes the panel.
 */
export function ColumnFilter({
  label,
  isFiltered,
  onClear,
  onOpenChange,
  placement = "bottom",
  children,
}: {
  /** The column's name, as its header shows it. The funnel is "Filter <label>". */
  label: string
  isFiltered: boolean
  onClear?: () => void
  /** Told when the panel opens and closes, so its options can load on open. */
  onOpenChange?: (isOpen: boolean) => void
  /** `bottom end` for a column near the right edge, so the panel stays on the page. */
  placement?: "bottom" | "bottom end"
  children: ReactNode
}) {
  const [isOpen, setIsOpen] = useState(false)
  const change = (open: boolean) => {
    setIsOpen(open)
    onOpenChange?.(open)
  }
  const tone = isFiltered
    ? "text-accent"
    : isOpen
      ? "text-foreground"
      : "text-muted opacity-50 group-hover/column:opacity-100 data-[focus-visible]:opacity-100 pointer-coarse:opacity-100"
  return (
    <Popover
      label={`Filter ${label}`}
      placement={placement}
      padding="none"
      isOpen={isOpen}
      onOpenChange={change}
      trigger={
        <Button
          size="sm"
          isIconOnly
          aria-label={`Filter ${label}`}
          className={`size-6 min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${tone}`}
        >
          <FiFilter aria-hidden className="size-3" />
        </Button>
      }
    >
      <div className="flex w-[16.5rem] flex-col py-1">
        {/* The panel renders in a portal but keeps the React context of the
            header it opened from, and a table's checkboxes take their slot
            from it. These checkboxes are the panel's own. */}
        <CheckboxContext.Provider value={null}>
          {children}
        </CheckboxContext.Provider>
        {isFiltered && onClear ? (
          <>
            <Divider weight="subtle" className="my-1" />
            <Button
              size="sm"
              variant="ghost"
              className="mx-1 justify-start"
              onPress={() => {
                onClear()
                change(false)
              }}
            >
              <FiX aria-hidden className="size-3.5" />
              Clear {inSentence(label)} filters
            </Button>
          </>
        ) : null}
      </div>
    </Popover>
  )
}
