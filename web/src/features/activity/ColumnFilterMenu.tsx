import { useEffect, useState } from "react"
import { FiSlash, FiX } from "react-icons/fi"
import { IconButton } from "@/design-system/actions/IconButton"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { SearchField } from "@/design-system/forms/SearchField"
import { Divider } from "@/design-system/layout/Divider"
import { formatNumber } from "@/shared/helpers/format"
import { useDebounced } from "@/shared/hooks/useDebounced"
import type { ValueOption } from "./activityQuery"
import { MenuHeading, MenuRow } from "./MenuRow"

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
  options,
  picked,
  excluded,
  onToggle,
  onExclude,
  isLoading,
  isError = false,
  more = 0,
  search = "",
  onSearch,
  isMono,
  thresholds,
  aliases,
  extras,
  onClear,
}: {
  title: string
  options?: ValueOption[]
  picked?: string[]
  /** Values left out; unchecked, and marked so, since pressing one lifts that. */
  excluded?: string[]
  onToggle?: (value: string) => void
  /** Leave a value out: every row but those carrying it. */
  onExclude?: (value: string) => void
  isLoading?: boolean
  isError?: boolean
  more?: number
  /** The term the values were searched for; set with `onSearch`. */
  search?: string
  onSearch?: (term: string) => void
  /** Values that are identifiers (models, policies), set in mono. */
  isMono?: boolean
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
  const [text, setText] = useState(search)
  const settled = useDebounced(text)
  useEffect(() => {
    if (onSearch && settled === text && settled !== search) onSearch(settled)
  }, [settled, text, search, onSearch])
  const isSearchable =
    onSearch !== undefined &&
    ((options?.length ?? 0) > SEARCHABLE_AFTER || Boolean(search) || more > 0)
  const checkRow = (
    option: ValueOption,
    isPicked: boolean,
    isExcluded: boolean,
    toggle: (value: string) => void,
    exclude?: (value: string) => void,
  ) => (
    <div
      key={option.value}
      className="flex min-h-11 items-center gap-2 px-3 py-1.5 hover:bg-surface-alt md:min-h-8"
    >
      <Checkbox isSelected={isPicked} onChange={() => toggle(option.value)}>
        <span
          className={`text-sm break-all ${isMono ? "text-mono-caption" : ""}`}
        >
          {option.label}
        </span>
      </Checkbox>
      <span className="ml-auto flex gap-2 text-mono-micro text-subtle">
        {isExcluded ? <span className="text-danger">excluded</span> : null}
        {option.count !== undefined ? formatNumber(option.count) : null}
      </span>
      {exclude && !isExcluded ? (
        <IconButton
          label={`Exclude ${option.label}`}
          size="sm"
          onPress={() => exclude(option.value)}
          className="-my-1 shrink-0 md:size-6 md:min-h-6 md:min-w-6"
        >
          <FiSlash aria-hidden className="size-3" />
        </IconButton>
      ) : null}
    </div>
  )
  return (
    <div className="flex w-[16.5rem] flex-col py-1">
      {options ? (
        <>
          <MenuHeading>Filter {title.toLowerCase()}</MenuHeading>
          {isSearchable ? (
            <div className="px-3 pb-1.5">
              <SearchField
                label={`Search ${title.toLowerCase()} values`}
                placeholder="Search values"
                value={text}
                onChange={setText}
              />
            </div>
          ) : null}
          <div className="max-h-72 overflow-y-auto">
            {options.map((option) =>
              checkRow(
                option,
                picked?.includes(option.value) ?? false,
                excluded?.includes(option.value) ?? false,
                (value) => onToggle?.(value),
                onExclude,
              ),
            )}
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
          <MenuHeading>Requested as alias</MenuHeading>
          {aliases.options.map((option) =>
            checkRow(
              option,
              aliases.picked.includes(option.value),
              false,
              aliases.onToggle,
            ),
          )}
        </>
      ) : null}
      {thresholds ? (
        <>
          <MenuHeading>Show only</MenuHeading>
          {thresholds.presets.map((preset) => (
            <MenuRow
              key={preset.value}
              kind="check"
              isChecked={thresholds.current === preset.value}
              onPress={() => thresholds.onPick(preset.value)}
            >
              {preset.label}
            </MenuRow>
          ))}
        </>
      ) : null}
      {extras?.length ? (
        <>
          <Divider weight="subtle" className="my-1" />
          {extras.map((extra) => (
            <MenuRow
              key={extra.label}
              kind="check"
              isChecked={extra.isChecked}
              onPress={extra.onPress}
              trailing={
                extra.trailing ? (
                  <span className="text-mono-micro text-subtle">
                    {extra.trailing}
                  </span>
                ) : undefined
              }
            >
              {extra.label}
            </MenuRow>
          ))}
        </>
      ) : null}
      {onClear ? (
        <>
          <Divider weight="subtle" className="my-1" />
          <MenuRow icon={FiX} onPress={onClear}>
            Clear {title.toLowerCase()} filters
          </MenuRow>
        </>
      ) : null}
    </div>
  )
}
