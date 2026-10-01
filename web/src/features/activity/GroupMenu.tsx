import { FiChevronDown } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { MenuButton, MenuItem } from "@/design-system/overlays/Menu"

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
  const current = options.find((option) => option.value === value) ?? options[0]
  return (
    <MenuButton
      label="Group by"
      selectionMode="single"
      selectedKeys={[current.value]}
      onAction={onChange}
      trigger={
        <Button size="sm" aria-label={`Group by: ${current.label}`}>
          <span className="text-subtle">Group by</span>
          {current.label}
          <FiChevronDown aria-hidden className="size-3.5" />
        </Button>
      }
    >
      {options.map((option) => (
        <MenuItem key={option.value} id={option.value}>
          {option.label}
        </MenuItem>
      ))}
    </MenuButton>
  )
}
