import { FiChevronDown, FiDollarSign, FiTrash2 } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { MenuButton, MenuItem } from "@/design-system/overlays/Menu"
import { formatNumber } from "@/shared/helpers/format"

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
  return (
    <MenuButton
      label="Manage imported rows"
      width="md"
      onAction={(key) => (key === "recost" ? onRecost() : onDelete())}
      trigger={
        <Button size="sm">
          Manage {formatNumber(count)} imported {count === 1 ? "row" : "rows"}
          <FiChevronDown aria-hidden className="size-3.5" />
        </Button>
      }
      header={
        <p className="px-3 pt-2 pb-1.5 text-caption text-subtle">
          Applies to every imported row matching the current filters. Gateway
          rows aren't touched.
        </p>
      }
    >
      <MenuItem id="recost" icon={FiDollarSign}>
        Recost imported rows…
      </MenuItem>
      <MenuItem id="delete" icon={FiTrash2}>
        Delete imported rows…
      </MenuItem>
    </MenuButton>
  )
}
