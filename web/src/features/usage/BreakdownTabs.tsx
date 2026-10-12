import { FiChevronDown } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { Tab, TabRow } from "@/design-system/navigation/TabRow"
import { MenuButton, MenuItem } from "@/design-system/overlays/Menu"
import { DIMENSIONS, type DimensionKey } from "./usageQuery"

// The breakdowns asked for on most visits get a tab each; the rest wait under
// More, which takes the picked one's name while it is the one on screen.
const TABBED = 4

/**
 * The one choice of breakdown that drives both the chart's stack and the
 * table under it.
 */
export function BreakdownTabs({
  dimensions,
  value,
  onChange,
}: {
  dimensions: readonly DimensionKey[]
  value: DimensionKey
  onChange: (dimension: DimensionKey) => void
}) {
  const tabs = dimensions.slice(0, TABBED)
  const more = dimensions.slice(TABBED)
  const inMore = more.includes(value)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-caption text-subtle">Break down by</span>
      <TabRow>
        {tabs.map((dimension) => (
          <Tab
            key={dimension}
            isActive={dimension === value}
            onPress={() => onChange(dimension)}
          >
            {DIMENSIONS[dimension].label}
          </Tab>
        ))}
      </TabRow>
      {more.length ? (
        <MenuButton
          label="More breakdowns"
          placement="bottom"
          selectionMode="single"
          selectedKeys={inMore ? [value] : []}
          onAction={(key) => onChange(key as DimensionKey)}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              aria-label={`More breakdowns${inMore ? `, ${DIMENSIONS[value].label}` : ""}`}
            >
              {inMore ? DIMENSIONS[value].label : "More"}
              <FiChevronDown aria-hidden className="size-3.5" />
            </Button>
          }
        >
          {more.map((dimension) => (
            <MenuItem key={dimension} id={dimension}>
              {DIMENSIONS[dimension].label}
            </MenuItem>
          ))}
        </MenuButton>
      ) : null}
    </div>
  )
}
