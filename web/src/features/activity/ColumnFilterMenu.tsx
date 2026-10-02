import { FiX } from "react-icons/fi"
import { Divider } from "@/design-system/layout/Divider"
import { Menu, MenuItem, MenuSection } from "@/design-system/overlays/Menu"
import { formatNumber } from "@/shared/helpers/format"
import { ActivitySearch } from "./ActivitySearch"
import type { ValueFilterModel } from "./activityFilters"
import type { Patch, ValueOption } from "./activityQuery"
import { ValueChecklist } from "./ValueChecklist"

// Past this many values the list gets a box to narrow it.
const SEARCHABLE_AFTER = 5

/**
 * A column's filters, in the order the column needs them: a checklist of its
 * values, each of which can also be excluded, or thresholds to show only rows
 * above, then whatever else the column alone can say (the aliases callers sent
 * under Model, unpriced rows under Cost, recovered attempts under Status), and
 * a way to clear what is set.
 *
 * The values come from the server, which orders and searches them: the box
 * hands its settled term up (`onSearch`) rather than filtering what one read
 * returned, and `more` says how many the window holds past those listed.
 */
export function ColumnFilterMenu({
  title,
  values,
  onRefine,
  isLoading,
  isError = false,
  more = 0,
  search = "",
  onSearch,
  thresholds,
  aliases,
  extras,
  onClear,
}: {
  title: string
  /** The column's checklist, for a column filtered by its values. */
  values?: ValueFilterModel
  onRefine: (patch: Patch) => void
  isLoading?: boolean
  isError?: boolean
  more?: number
  /** The term the values were searched for; set with `onSearch`. */
  search?: string
  onSearch?: (term: string) => void
  thresholds?: {
    presets: { value: number; label: string }[]
    current: number | undefined
    onPick: (value: number) => void
  }
  /** The names callers sent that resolved to these values, checked like them. */
  aliases?: {
    options: ValueOption[]
    picked: string[]
    onToggle: (value: string) => void
  }
  extras?: {
    label: string
    isChecked: boolean
    onPress: () => void
    trailing?: string
  }[]
  /** Set while the column is filtered. */
  onClear?: () => void
}) {
  const options = values?.options
  const isSearchable =
    onSearch !== undefined &&
    ((options?.length ?? 0) > SEARCHABLE_AFTER || Boolean(search) || more > 0)
  const heading = (text: string) => (
    <div className="px-3 pt-2 pb-1 text-overline">{text}</div>
  )
  return (
    <div className="flex w-[16.5rem] flex-col py-1">
      {values && options ? (
        <>
          {heading(`Filter ${title.toLowerCase()}`)}
          {isSearchable && onSearch ? (
            <div className="px-3 pb-1.5">
              <ActivitySearch
                label={`Search ${title.toLowerCase()} values`}
                placeholder="Search values"
                value={search}
                onCommit={onSearch}
              />
            </div>
          ) : null}
          <div className="max-h-72 overflow-y-auto">
            <ValueChecklist
              density="menu"
              options={options}
              picked={values.picked}
              excluded={values.excluded}
              isMono={values.isMono}
              onToggle={(value) => onRefine(values.toggle(value))}
              onExclude={(value) => onRefine(values.exclude(value))}
            />
            {isError ? (
              <p className="px-3 py-1.5 text-caption text-danger">
                These values could not be loaded.
              </p>
            ) : !options.length ? (
              <p className="px-3 py-1.5 text-caption text-subtle">
                {isLoading
                  ? "Loading…"
                  : search
                    ? "Nothing matches."
                    : "Nothing in this window."}
              </p>
            ) : null}
            {more > 0 && !isError ? (
              <p className="px-3 py-1.5 text-caption text-subtle">
                {formatNumber(more)} more, search to narrow
              </p>
            ) : null}
          </div>
        </>
      ) : null}
      {aliases?.options.length ? (
        <>
          {heading("Requested as alias")}
          <ValueChecklist
            density="menu"
            options={aliases.options}
            picked={aliases.picked}
            isMono={values?.isMono}
            onToggle={aliases.onToggle}
          />
        </>
      ) : null}
      {thresholds ? (
        <Menu
          label={`Show only ${title.toLowerCase()} above`}
          selectionMode="single"
          selectedKeys={
            thresholds.current === undefined ? [] : [String(thresholds.current)]
          }
          onAction={(key) => thresholds.onPick(Number(key))}
        >
          <MenuSection title="Show only">
            {thresholds.presets.map((preset) => (
              <MenuItem key={preset.value} id={String(preset.value)}>
                {preset.label}
              </MenuItem>
            ))}
          </MenuSection>
        </Menu>
      ) : null}
      {extras?.length ? (
        <>
          <Divider weight="subtle" className="my-1" />
          <Menu
            label={`More ${title.toLowerCase()} filters`}
            selectionMode="multiple"
            selectedKeys={extras
              .filter((extra) => extra.isChecked)
              .map((extra) => extra.label)}
            onAction={(key) =>
              extras.find((extra) => extra.label === key)?.onPress()
            }
          >
            {extras.map((extra) => (
              <MenuItem
                key={extra.label}
                id={extra.label}
                trailing={
                  extra.trailing ? (
                    <span className="text-mono-micro text-subtle">
                      {extra.trailing}
                    </span>
                  ) : undefined
                }
              >
                {extra.label}
              </MenuItem>
            ))}
          </Menu>
        </>
      ) : null}
      {onClear ? (
        <>
          <Divider weight="subtle" className="my-1" />
          <Menu
            label={`Clear ${title.toLowerCase()} filters`}
            onAction={onClear}
          >
            <MenuItem id="clear" icon={FiX}>
              Clear {title.toLowerCase()} filters
            </MenuItem>
          </Menu>
        </>
      ) : null}
    </div>
  )
}
