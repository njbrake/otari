import { useState } from "react"
import { FiColumns, FiRotateCcw } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { Divider } from "@/design-system/layout/Divider"
import { Popover } from "@/design-system/overlays/Popover"

export interface ColumnPickerColumn {
  id: string
  label: string
  /** A column that is always shown (the row's identity) is listed, checked and disabled. */
  isHideable: boolean
}

/**
 * The Columns control over a table: which columns it shows, and a way back to
 * its default layout. Each column is a checkbox, checked while it is shown.
 *
 * It lists every column in the table's order, so a column that cannot be
 * hidden is still where the reader expects it, only disabled. "Reset columns"
 * restores the defaults for whatever the caller keeps, visibility and widths
 * alike, and closes the panel; it is disabled while there is nothing to reset.
 */
export function ColumnPicker({
  columns,
  hidden,
  onHiddenChange,
  onReset,
  canReset,
  className,
}: {
  columns: readonly ColumnPickerColumn[]
  hidden: readonly string[]
  onHiddenChange: (id: string, isHidden: boolean) => void
  onReset: () => void
  canReset: boolean
  /** Layout classes for the trigger, such as its alignment in a toolbar. */
  className?: string
}) {
  const hiddenIds = new Set(hidden)
  const [isOpen, setIsOpen] = useState(false)
  return (
    <Popover
      label="Columns"
      placement="bottom end"
      padding="none"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      trigger={
        <Button
          size="sm"
          className={className}
          aria-label={
            hiddenIds.size > 0 ? `Columns, ${hiddenIds.size} hidden` : "Columns"
          }
        >
          <FiColumns aria-hidden className="size-3.5" />
          Columns
        </Button>
      }
    >
      <div className="flex w-56 flex-col py-1">
        <fieldset className="flex flex-col px-3 py-1">
          <legend className="sr-only">Shown columns</legend>
          {columns.map((column) => (
            <Checkbox
              key={column.id}
              className="min-h-8 w-full items-center"
              isSelected={!column.isHideable || !hiddenIds.has(column.id)}
              isDisabled={!column.isHideable}
              onChange={(isShown) => onHiddenChange(column.id, !isShown)}
            >
              <span className="text-sm">{column.label}</span>
            </Checkbox>
          ))}
        </fieldset>
        <Divider weight="subtle" className="my-1" />
        <Button
          size="sm"
          variant="ghost"
          className="mx-1 justify-start"
          isDisabled={!canReset}
          onPress={() => {
            onReset()
            setIsOpen(false)
          }}
        >
          <FiRotateCcw aria-hidden className="size-3.5" />
          Reset columns
        </Button>
      </div>
    </Popover>
  )
}
