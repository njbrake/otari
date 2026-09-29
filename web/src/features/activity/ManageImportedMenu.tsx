import { useState } from "react"
import { FiChevronDown, FiDollarSign, FiTrash2 } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { Popover } from "@/design-system/overlays/Popover"
import { formatNumber } from "@/shared/helpers/format"
import { MenuRow } from "./MenuRow"

/**
 * The operator's bulk actions on imported rows. They act on the filter rather
 * than on picked rows, so they reach every matching imported row however many
 * pages it spans, and gateway rows are never touched.
 */
export function ManageImportedMenu({
  count,
  onRecost,
  onDelete,
}: {
  count: number
  onRecost: () => void
  onDelete: () => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const run = (action: () => void) => () => {
    setIsOpen(false)
    action()
  }
  return (
    <Popover
      label="Manage imported rows"
      placement="bottom end"
      padding="none"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      trigger={
        <Button size="sm">
          Manage {formatNumber(count)} imported {count === 1 ? "row" : "rows"}
          <FiChevronDown aria-hidden className="size-3.5" />
        </Button>
      }
    >
      <div className="flex w-[18.75rem] flex-col py-1">
        <p className="px-3 pt-2 pb-1.5 text-caption text-subtle">
          Applies to every imported row matching the current filters. Gateway
          rows aren't touched.
        </p>
        <MenuRow icon={FiDollarSign} onPress={run(onRecost)}>
          Recost imported rows…
        </MenuRow>
        <MenuRow icon={FiTrash2} onPress={run(onDelete)}>
          Delete imported rows…
        </MenuRow>
      </div>
    </Popover>
  )
}
