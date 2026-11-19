import { useState } from "react"
import { FiSlash } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { SearchField } from "@/design-system/forms/SearchField"
import { formatNumber } from "@/design-system/helpers/format"

/** One value a column can be filtered to, with how many rows carry it. */
export interface ColumnFilterOption {
  value: string
  label: string
  count?: number
}

// Past this many values the list gets a box to narrow it.
const SEARCHABLE_AFTER = 5

/**
 * A column's values as a checklist, for the panel a `ColumnFilter` opens.
 *
 * Each value is a checkbox, with how many rows carry it. `multiple` keeps any
 * number picked; `single` keeps one, so checking another replaces it. With
 * `excluded` each row also has a button to leave that value out instead, and an
 * excluded value says so; picking a value takes it off the excluded list and
 * excluding one unpicks it, so one press never leaves a value in both. A picked
 * or excluded value the options do not hold (a link named it, or the window
 * has none of its rows) is listed first under its own value, so it can be
 * cleared.
 *
 * Past five values a search box narrows the list: here, or on the server when
 * `onSearch` is given, which then owns the term and `more` says how many values
 * the list does not show. With `allowsCustom` a term that matches no value can
 * be committed as one, for an id the list does not offer.
 */
export function ColumnFilterList({
  label,
  title,
  options,
  selected,
  excluded,
  selectionMode = "multiple",
  onChange,
  search,
  onSearch,
  more = 0,
  isLoading = false,
  isError = false,
  allowsCustom = false,
  isMono = false,
  emptyLabel = "No values to filter by.",
}: {
  /** The list's accessible name: the dimension, "Model". */
  label: string
  /** A heading over the list, for a panel that carries more than one. */
  title?: string
  options: readonly ColumnFilterOption[]
  selected: readonly string[]
  /** The values left out, for a column that can exclude; omit for one that cannot. */
  excluded?: readonly string[]
  selectionMode?: "single" | "multiple"
  /** Both lists at once, so a change that moves a value from one to the other is one write. */
  onChange: (selected: string[], excluded: string[]) => void
  /** The term the server searched for; set with `onSearch`. */
  search?: string
  onSearch?: (term: string) => void
  /** How many values the server holds past those listed. */
  more?: number
  isLoading?: boolean
  isError?: boolean
  allowsCustom?: boolean
  /** Set the values in the monospace caption, for ids. */
  isMono?: boolean
  /** What an empty list says once loaded. */
  emptyLabel?: string
}) {
  const [localTerm, setLocalTerm] = useState("")
  const term = onSearch ? (search ?? "") : localTerm
  const setTerm = onSearch ?? setLocalTerm
  const out = excluded ?? []
  const known = new Set(options.map((option) => option.value))
  const all: ColumnFilterOption[] = [
    ...[...selected, ...out]
      .filter((value, index, values) => values.indexOf(value) === index)
      .filter((value) => !known.has(value))
      .map((value) => ({ value, label: value })),
    ...options,
  ]
  const needle = term.trim().toLowerCase()
  // The server already searched what it returned.
  const shown =
    needle && !onSearch
      ? all.filter(
          (option) =>
            option.label.toLowerCase().includes(needle) ||
            option.value.toLowerCase().includes(needle),
        )
      : all
  const isSearchable =
    all.length > SEARCHABLE_AFTER ||
    term !== "" ||
    more > 0 ||
    (allowsCustom && !isLoading && all.length === 0)
  const custom = term.trim()
  const offersCustom =
    allowsCustom && custom !== "" && !all.some((one) => one.value === custom)

  const pick = (value: string) => {
    const isPicked = selected.includes(value)
    const next = isPicked
      ? selected.filter((one) => one !== value)
      : selectionMode === "single"
        ? [value]
        : [...selected, value]
    onChange(
      next,
      out.filter((one) => one !== value),
    )
  }
  const exclude = (value: string) => {
    const isOut = out.includes(value)
    onChange(
      selected.filter((one) => one !== value),
      isOut ? out.filter((one) => one !== value) : [...out, value],
    )
  }
  const commitCustom = () => {
    pick(custom)
    setTerm("")
  }

  return (
    <div className="flex flex-col">
      {title ? (
        <div className="px-3 pt-2 pb-1 text-overline">{title}</div>
      ) : null}
      {isSearchable ? (
        // Enter in the box commits the term as a value when nothing matches it.
        // biome-ignore lint/a11y/noStaticElementInteractions: a key listener around the field, not a control of its own
        <div
          className="px-3 pt-1 pb-1.5"
          onKeyDown={(event) => {
            if (event.key === "Enter" && offersCustom) {
              event.preventDefault()
              commitCustom()
            }
          }}
        >
          <SearchField
            label={`Search ${label} values`}
            placeholder="Search values"
            value={term}
            onChange={setTerm}
          />
        </div>
      ) : null}
      {offersCustom ? (
        <Button
          size="sm"
          variant="ghost"
          className="mx-1 justify-start"
          onPress={commitCustom}
        >
          Filter by “{custom}”
        </Button>
      ) : null}
      <fieldset
        aria-label={label}
        className="m-0 max-h-72 min-w-0 overflow-y-auto border-0 p-0"
      >
        {shown.map((option) => {
          const isOut = out.includes(option.value)
          return (
            <div
              key={option.value}
              className="flex min-h-11 items-center gap-2 px-3 py-1 hover:bg-surface-alt md:min-h-8"
            >
              <Checkbox
                isSelected={selected.includes(option.value)}
                onChange={() => pick(option.value)}
                className="min-w-0"
              >
                <span
                  className={`break-all text-sm ${isMono ? "text-mono-caption" : ""}`}
                >
                  {option.label}
                </span>
              </Checkbox>
              <span className="ml-auto flex shrink-0 gap-2 text-mono-micro text-subtle">
                {isOut ? <span className="text-danger">excluded</span> : null}
                {option.count !== undefined ? formatNumber(option.count) : null}
              </span>
              {excluded ? (
                <IconButton
                  label={
                    isOut
                      ? `Stop excluding ${option.label}`
                      : `Exclude ${option.label}`
                  }
                  size="sm"
                  onPress={() => exclude(option.value)}
                  className={`-my-1 shrink-0 md:size-6 md:min-h-6 md:min-w-6 ${isOut ? "text-danger" : ""}`}
                >
                  <FiSlash aria-hidden className="size-3" />
                </IconButton>
              ) : null}
            </div>
          )
        })}
        {shown.length === 0 || isError ? (
          <p
            className={`px-3 py-1.5 text-caption ${isError ? "text-danger" : "text-subtle"}`}
          >
            {isError
              ? "These values could not be loaded."
              : isLoading
                ? "Loading…"
                : needle
                  ? "Nothing matches."
                  : emptyLabel}
          </p>
        ) : null}
        {more > 0 && !isError ? (
          <p className="px-3 py-1.5 text-caption text-subtle">
            {formatNumber(more)} more, search to narrow
          </p>
        ) : null}
      </fieldset>
    </div>
  )
}
