import { useState } from "react"
import { FiFilter, FiSlash } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { Popover } from "@/design-system/overlays/Popover"
import { MenuRow } from "./MenuRow"

/**
 * The filter a cell offers on its own value: only rows with it, or every row
 * but those. Revealed on hover beside the value, and shown outright where the
 * pointer is a finger, which has no hover.
 *
 * Left out of the tab order: a control in every cell would put three stops on
 * each row before the next one. The keyboard reaches the same filters through
 * the column's own menu in the header.
 */
export function ValueFilter({
  value,
  onFilter,
}: {
  value: string
  onFilter: (mode: "include" | "exclude") => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const pick = (mode: "include" | "exclude") => {
    setIsOpen(false)
    onFilter(mode)
  }
  return (
    // Stops the press reaching the row, which would open the request.
    // biome-ignore lint/a11y/noStaticElementInteractions: a containment boundary, not a control
    // biome-ignore lint/a11y/useKeyWithClickEvents: the controls inside handle their own keys
    <span
      onClick={(event) => event.stopPropagation()}
      className={`absolute top-1/2 right-1.5 z-[1] -translate-y-1/2 ${
        isOpen
          ? "opacity-100"
          : "opacity-0 group-hover/cell:opacity-100 pointer-coarse:opacity-100"
      }`}
    >
      <Popover
        label={`Filter by ${value}`}
        padding="none"
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        trigger={
          <Button
            size="sm"
            isIconOnly
            aria-label={`Filter by ${value}`}
            excludeFromTabOrder
            className="size-6 min-w-6"
          >
            <FiFilter aria-hidden className="size-3" />
          </Button>
        }
      >
        <div className="flex w-60 flex-col py-1">
          <MenuRow icon={FiFilter} onPress={() => pick("include")}>
            Only <b className="font-medium text-foreground">{value}</b>
          </MenuRow>
          <MenuRow icon={FiSlash} onPress={() => pick("exclude")}>
            Exclude <b className="font-medium text-foreground">{value}</b>
          </MenuRow>
        </div>
      </Popover>
    </span>
  )
}
