import { useNavigate } from "@tanstack/react-router"
import { FiBarChart2, FiCalendar, FiChevronDown } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import {
  MenuButton,
  MenuItem,
  MenuSection,
} from "@/design-system/overlays/Menu"
import { formatUtcMonthName, formatUtcMonthYear } from "@/shared/helpers/format"
import type { Month } from "./overviewQuery"

const OTHER_RANGES = "other-ranges"

/**
 * Which calendar month the page reads: this one, or one of the eleven before
 * it. Any other stretch of time is Usage's, which the last row opens: an
 * action outside the choices, so it is no radio among them.
 */
export function MonthMenu({
  months,
  month,
  onMonth,
}: {
  /** The months offered, this one first. */
  months: readonly Month[]
  month: Month
  onMonth: (key: string) => void
}) {
  const navigate = useNavigate()
  const nameOf = (one: Month) =>
    one.isCurrent ? "This month" : formatUtcMonthYear(one.start.getTime())
  return (
    <MenuButton
      label="Month"
      placement="bottom"
      onAction={(key) => {
        if (key === OTHER_RANGES) void navigate({ to: "/usage" })
        else onMonth(key)
      }}
      trigger={
        <Button size="sm" aria-label={`Month: ${nameOf(month)}`}>
          <FiCalendar aria-hidden className="size-3.5" />
          {nameOf(month)}
          <FiChevronDown aria-hidden className="size-3.5" />
        </Button>
      }
    >
      <MenuSection selectionMode="single" selectedKeys={[month.key]}>
        {months.map((one) => (
          <MenuItem
            key={one.key}
            id={one.key}
            textValue={nameOf(one)}
            trailing={
              one.isCurrent ? (
                <span className="text-caption text-subtle">
                  {formatUtcMonthName(one.start.getTime())}
                </span>
              ) : undefined
            }
          >
            {nameOf(one)}
          </MenuItem>
        ))}
      </MenuSection>
      <MenuSection>
        <MenuItem id={OTHER_RANGES} icon={FiBarChart2}>
          Other ranges in Usage
        </MenuItem>
      </MenuSection>
    </MenuButton>
  )
}
