import { useState } from "react"
import { FiChevronDown } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { Popover } from "@/design-system/overlays/Popover"
import { MenuRow } from "./MenuRow"

/** "Group by" and its choices, one of which is always "None". */
export function GroupMenu({
  value,
  options,
  onChange,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const current = options.find((option) => option.value === value) ?? options[0]
  return (
    <Popover
      label="Group by"
      placement="bottom end"
      padding="none"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      trigger={
        <Button size="sm" aria-label={`Group by: ${current.label}`}>
          <span className="text-subtle">Group by</span>
          {current.label}
          <FiChevronDown aria-hidden className="size-3.5" />
        </Button>
      }
    >
      <div className="flex w-56 flex-col py-1">
        {options.map((option) => (
          <MenuRow
            key={option.value}
            kind="check"
            isChecked={option.value === current.value}
            onPress={() => {
              onChange(option.value)
              setIsOpen(false)
            }}
          >
            {option.label}
          </MenuRow>
        ))}
      </div>
    </Popover>
  )
}
