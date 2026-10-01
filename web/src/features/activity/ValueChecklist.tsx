import { FiSlash } from "react-icons/fi"
import { IconButton } from "@/design-system/actions/IconButton"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { formatNumber } from "@/shared/helpers/format"
import type { ValueOption } from "./activityQuery"

/**
 * A column's values as a checklist, each with its count and, where it is left
 * out, a mark saying so. With `onExclude` a value can be left out from its
 * row. `density="menu"` is a header menu's, dense under a fine pointer;
 * `"sheet"` is the phone's, every row at the touch floor.
 */
export function ValueChecklist({
  options,
  picked,
  excluded = [],
  isMono = false,
  onToggle,
  onExclude,
  density,
}: {
  options: readonly ValueOption[]
  picked: readonly string[]
  excluded?: readonly string[]
  isMono?: boolean
  onToggle: (value: string) => void
  onExclude?: (value: string) => void
  density: "menu" | "sheet"
}) {
  const isMenu = density === "menu"
  return options.map((option) => {
    const isExcluded = excluded.includes(option.value)
    return (
      <div
        key={option.value}
        className={`flex min-h-11 items-center ${
          isMenu ? "gap-2 px-3 py-1.5 hover:bg-surface-alt md:min-h-8" : "gap-3"
        }`}
      >
        <Checkbox
          isSelected={picked.includes(option.value)}
          onChange={() => onToggle(option.value)}
          hasTouchTarget={!isMenu}
        >
          <span
            className={`break-all ${isMenu ? "text-sm" : ""} ${isMono ? "text-mono-caption" : ""}`}
          >
            {option.label}
          </span>
        </Checkbox>
        <span className="ml-auto flex gap-2 text-mono-micro text-subtle">
          {isExcluded ? <span className="text-danger">excluded</span> : null}
          {option.count !== undefined ? formatNumber(option.count) : null}
        </span>
        {onExclude && !isExcluded ? (
          <IconButton
            label={`Exclude ${option.label}`}
            size="sm"
            onPress={() => onExclude(option.value)}
            className="-my-1 shrink-0 md:size-6 md:min-h-6 md:min-w-6"
          >
            <FiSlash aria-hidden className="size-3" />
          </IconButton>
        ) : null}
      </div>
    )
  })
}
