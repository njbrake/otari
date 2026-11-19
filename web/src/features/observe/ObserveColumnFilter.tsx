import { useEffect, useState } from "react"

import { ColumnFilter } from "@/design-system/data/ColumnFilter"
import { ColumnFilterList } from "@/design-system/data/ColumnFilterList"
import {
  type ExtraKey,
  type ObserveFilterState,
  type ObserveUrlKey,
  readThreshold,
  statusOptions,
  THRESHOLDS,
  type ThresholdKey,
  useObserveFilterState,
  useValueOptions,
  VALUE_KEYS,
  type ValueDimension,
  valuesOf,
} from "./observeFilters"
import type { ObserveView } from "./observeSearch"

/** One part of a column's filter panel. */
export type FilterSection =
  | { kind: "values"; dimension: ValueDimension }
  | { kind: "threshold"; key: ThresholdKey }
  | { kind: "extra"; key: ExtraKey }

const TITLES: Record<ValueDimension, string> = {
  model: "Model",
  user: "User",
  api_key: "API key",
  provider: "Provider",
  status: "Status",
  policy: "Routing policy",
}

// A filter beside a column's values, and the URL value that means it is on.
const EXTRAS: Record<
  ExtraKey,
  { label: string; key: ObserveUrlKey; on: string }
> = {
  unpriced: { label: "Unpriced only", key: "priced", on: "false" },
  direct: { label: "Direct requests only", key: "routed", on: "false" },
}

// How long the search box waits for typing to stop before it asks the server.
const SEARCH_SETTLE_MS = 250

/** Whether a section applies to this view and caller. */
function offered(section: FilterSection, state: ObserveFilterState): boolean {
  if (section.kind !== "values") return state.isRequests
  if (section.dimension === "user") return !state.isMine
  if (section.dimension === "provider" || section.dimension === "policy")
    return state.isRequests
  return true
}

/** The URL keys a section writes, each with its cleared value. */
function clearedKeys(section: FilterSection): Record<string, string | []> {
  if (section.kind === "threshold") return { [section.key]: "" }
  if (section.kind === "extra") return { [EXTRAS[section.key].key]: "" }
  const keys = VALUE_KEYS[section.dimension]
  return {
    [keys.include]: keys.isSingle ? "" : [],
    ...(keys.exclude ? { [keys.exclude]: [] } : {}),
  }
}

function isActive(section: FilterSection, state: ObserveFilterState): boolean {
  if (section.kind === "threshold")
    return readThreshold(state.url.get(section.key)) !== undefined
  if (section.kind === "extra") {
    const extra = EXTRAS[section.key]
    return state.url.get(extra.key) === extra.on
  }
  const { selected, excluded } = valuesOf(state, section.dimension)
  return selected.length > 0 || (state.isRequests && excluded.length > 0)
}

/**
 * The funnel in a Sessions or Requests column header, holding that column's
 * filters: a checklist of its values, each of which can also be left out on
 * Requests, thresholds to show only the rows above, and what else the column
 * alone can say (unpriced rows under Cost, direct requests under Routing).
 *
 * Values load when the panel opens, busiest first, searched on the server.
 * Under Mine a User funnel draws nothing, since the scope already decided whose
 * rows these are, and a section the view cannot apply is left out.
 */
export function ObserveColumnFilter({
  view,
  label,
  sections,
  placement,
}: {
  view: ObserveView
  /** The column's name, as its header shows it. */
  label: string
  sections: FilterSection[]
  placement?: "bottom" | "bottom end"
}) {
  const state = useObserveFilterState(view)
  const shown = sections.filter((section) => offered(section, state))
  if (shown.length === 0) return null
  const hasTitles = shown.length > 1

  return (
    <ColumnFilter
      label={label}
      placement={placement}
      isFiltered={shown.some((section) => isActive(section, state))}
      onClear={() => state.patch(Object.assign({}, ...shown.map(clearedKeys)))}
    >
      {shown.map((section) => {
        if (section.kind === "values") {
          return (
            <ValuesSection
              key={section.dimension}
              view={view}
              state={state}
              dimension={section.dimension}
              title={hasTitles ? TITLES[section.dimension] : undefined}
            />
          )
        }
        if (section.kind === "threshold") {
          const spec = THRESHOLDS[section.key]
          const current = readThreshold(state.url.get(section.key))
          return (
            <ColumnFilterList
              key={section.key}
              label={`${spec.label} above`}
              title="Show only"
              selectionMode="single"
              options={spec.presets.map((value) => ({
                value: String(value),
                label: spec.describe(value),
              }))}
              selected={current === undefined ? [] : [String(current)]}
              onChange={(values) =>
                state.patch({ [section.key]: values[0] ?? "" })
              }
            />
          )
        }
        const extra = EXTRAS[section.key]
        return (
          <ColumnFilterList
            key={section.key}
            label={`More ${label} filters`}
            options={[{ value: extra.on, label: extra.label }]}
            selected={state.url.get(extra.key) === extra.on ? [extra.on] : []}
            onChange={(values) => state.patch({ [extra.key]: values[0] ?? "" })}
          />
        )
      })}
    </ColumnFilter>
  )
}

function ValuesSection({
  view,
  state,
  dimension,
  title,
}: {
  view: ObserveView
  state: ObserveFilterState
  dimension: ValueDimension
  title: string | undefined
}) {
  const [term, setTerm] = useState("")
  const [search, setSearch] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => setSearch(term.trim()), SEARCH_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [term])
  // A session has two outcomes and no count of its own, so its list is fixed.
  const isFixed = dimension === "status" && !state.isRequests
  const read = useValueOptions(view, dimension, search, !isFixed)
  const keys = VALUE_KEYS[dimension]
  const { selected, excluded } = valuesOf(state, dimension)
  const canExclude = state.isRequests && keys.exclude !== undefined
  return (
    <ColumnFilterList
      label={TITLES[dimension]}
      title={title}
      selectionMode={keys.isSingle ? "single" : "multiple"}
      options={isFixed ? statusOptions(view) : read.options}
      selected={selected}
      excluded={canExclude ? excluded : undefined}
      onChange={(nextSelected, nextExcluded) =>
        state.patch({
          [keys.include]: keys.isSingle
            ? (nextSelected.at(-1) ?? "")
            : nextSelected,
          ...(canExclude && keys.exclude
            ? { [keys.exclude]: nextExcluded }
            : {}),
        })
      }
      search={isFixed || dimension === "status" ? undefined : term}
      onSearch={isFixed || dimension === "status" ? undefined : setTerm}
      more={read.more}
      isLoading={!isFixed && read.isLoading}
      isError={!isFixed && read.isError}
      allowsCustom={!keys.isSingle && dimension !== "policy"}
      isMono={dimension === "model"}
      emptyLabel="Nothing in this window."
    />
  )
}
