import { useEffect, useState } from "react"

import { ColumnFilter } from "@/design-system/data/ColumnFilter"
import { ColumnFilterList } from "@/design-system/data/ColumnFilterList"
import { TOOL_OPTIONS } from "@/features/activity/activityModel"
import { useUsageSummary } from "@/shared/api/usage"
import { useSurfaces } from "@/shared/hooks/useDeployment"
import {
  CHANNEL_OPTIONS,
  EMPTY_LABELS,
  type EmptyField,
  type ExtraKey,
  type FilterSection,
  isSingleFor,
  type ObserveFilterState,
  type ObserveUrlKey,
  readThreshold,
  statusOptions,
  THRESHOLDS,
  useObserveFilterState,
  useObserveUsageFilters,
  useValueOptions,
  VALUE_KEYS,
  type ValueDimension,
  valuesOf,
} from "./observeFilters"
import type { ObserveView } from "./observeSearch"

const TITLES: Record<ValueDimension, string> = {
  model: "Model",
  user: "User",
  api_key: "API key",
  provider: "Provider",
  status: "Status",
  policy: "Routing policy",
  source: "Source",
}

// A filter beside a column's values: the URL key it writes, and its choices,
// one at a time, each the value that means it is on.
const EXTRAS: Record<
  ExtraKey,
  { key: ObserveUrlKey; choices: { on: string; label: string }[] }
> = {
  priced: {
    key: "priced",
    choices: [
      { on: "true", label: "Priced only" },
      { on: "false", label: "Unpriced only" },
    ],
  },
  // Who paid the provider: a hosted provider the deployment pays for, or the
  // organization's own keys and endpoints.
  paid: {
    key: "paid_by",
    choices: [
      { on: "true", label: "Hosted only" },
      { on: "false", label: "Own keys only" },
    ],
  },
  direct: {
    key: "routed",
    choices: [{ on: "false", label: "Direct requests only" }],
  },
  // Each request is listed once; this lists the attempts a routing policy
  // recovered from under the request they belong to.
  recovered: {
    key: "recovered",
    choices: [{ on: "show", label: "Show recovered attempts" }],
  },
}

// The gateway tools a request can be filtered to; "All" is no filter.
const TOOLS = TOOL_OPTIONS.filter((option) => option.value !== "")

// How long the search box waits for typing to stop before it asks the server.
const SEARCH_SETTLE_MS = 250

/** Whether a section applies to this view and caller. */
function offered(section: FilterSection, state: ObserveFilterState): boolean {
  if (section.kind !== "values") return state.isRequests
  if (section.dimension === "user") return !state.isMine
  if (
    section.dimension === "provider" ||
    section.dimension === "policy" ||
    section.dimension === "source"
  )
    return state.isRequests
  return true
}

/** The sections of a column this view and caller can apply. */
export const offeredSections = (
  sections: readonly FilterSection[],
  state: ObserveFilterState,
): FilterSection[] => sections.filter((section) => offered(section, state))

/**
 * The URL keys a column's sections write, each with its cleared value. The
 * empty-column filters share one key, so clearing a column takes only its own
 * fields out of it.
 */
export function clearedKeys(
  sections: readonly FilterSection[],
  state: ObserveFilterState,
): Record<string, string | string[]> {
  const cleared: Record<string, string | string[]> = Object.assign(
    {},
    ...sections.map(clearedKeysOf),
  )
  const emptied = sections.flatMap((section) =>
    section.kind === "empty" ? [section.field] : [],
  )
  if (emptied.length > 0) {
    cleared.is_null = state.url
      .getAll("is_null")
      .filter((field) => !emptied.includes(field as EmptyField))
  }
  return cleared
}

function clearedKeysOf(section: FilterSection): Record<string, string | []> {
  if (section.kind === "empty") return {}
  if (section.kind === "channel") return { channel: [] }
  if (section.kind === "threshold") return { [section.key]: "" }
  if (section.kind === "extra") return { [EXTRAS[section.key].key]: "" }
  if (section.kind === "tool") return { tool: "" }
  const keys = VALUE_KEYS[section.dimension]
  return {
    [keys.include]: [],
    ...(keys.exclude ? { [keys.exclude]: [] } : {}),
  }
}

/** Whether any of a column's sections narrows the rows. */
export const isFiltered = (
  sections: readonly FilterSection[],
  state: ObserveFilterState,
): boolean => sections.some((section) => isActive(section, state))

function isActive(section: FilterSection, state: ObserveFilterState): boolean {
  if (section.kind === "threshold")
    return readThreshold(state.url.get(section.key)) !== undefined
  if (section.kind === "extra") {
    const extra = EXTRAS[section.key]
    const value = state.url.get(extra.key)
    return extra.choices.some((choice) => choice.on === value)
  }
  if (section.kind === "tool") return state.url.get("tool") !== ""
  if (section.kind === "channel") return state.url.getAll("channel").length > 0
  if (section.kind === "empty")
    return state.url.getAll("is_null").includes(section.field)
  const { selected, excluded } = valuesOf(state, section.dimension)
  return selected.length > 0 || (state.isRequests && excluded.length > 0)
}

/**
 * The funnel in a Sessions or Requests column header, holding that column's
 * filters (see `ObserveFilterSections`). Under Mine a User funnel draws
 * nothing, since the scope already decided whose rows these are, and a
 * section the view cannot apply is left out.
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
  const shown = offeredSections(sections, state)
  if (shown.length === 0) return null

  return (
    <ColumnFilter
      label={label}
      placement={placement}
      isFiltered={isFiltered(shown, state)}
      onClear={() => state.patch(clearedKeys(shown, state))}
    >
      <ObserveFilterSections
        view={view}
        label={label}
        sections={shown}
        state={state}
      />
    </ColumnFilter>
  )
}

/**
 * One column's filters, as its header funnel and the phone's filter sheet both
 * show them: a checklist of its values, each of which can also be left out on
 * Requests, thresholds to show only the rows above, and what else the column
 * alone can say (priced or unpriced rows under Cost, direct requests under
 * Routing, a gateway tool under Model, the source under API key).
 *
 * Values load once this mounts, busiest first, searched on the server, so a
 * caller mounts it only while its column is open. `sections` are those the
 * view offers (`offeredSections`).
 */
export function ObserveFilterSections({
  view,
  label,
  sections,
  state,
}: {
  view: ObserveView
  /** The column's name, which names a list that has no title of its own. */
  label: string
  sections: readonly FilterSection[]
  state: ObserveFilterState
}) {
  const hasTitles = sections.length > 1
  return sections.map((section) => {
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
          onChange={(values) => state.patch({ [section.key]: values[0] ?? "" })}
        />
      )
    }
    if (section.kind === "tool") {
      return <ToolSection key="tool" view={view} state={state} />
    }
    if (section.kind === "channel") {
      return (
        <ColumnFilterList
          key="channel"
          label="Channel"
          title="Channel"
          options={CHANNEL_OPTIONS}
          selected={state.url.getAll("channel")}
          onChange={(values) => state.patch({ channel: values })}
        />
      )
    }
    if (section.kind === "empty") {
      const fields = state.url.getAll("is_null")
      const isOn = fields.includes(section.field)
      return (
        <ColumnFilterList
          key={`empty-${section.field}`}
          label={EMPTY_LABELS[section.field]}
          selectionMode="single"
          options={[{ value: "on", label: EMPTY_LABELS[section.field] }]}
          selected={isOn ? ["on"] : []}
          onChange={(values) =>
            state.patch({
              is_null:
                values.length > 0
                  ? [
                      ...fields.filter((one) => one !== section.field),
                      section.field,
                    ]
                  : fields.filter((one) => one !== section.field),
            })
          }
        />
      )
    }
    const extra = EXTRAS[section.key]
    const value = state.url.get(extra.key)
    return (
      <ColumnFilterList
        key={section.key}
        label={`More ${label} filters`}
        selectionMode="single"
        options={extra.choices.map((choice) => ({
          value: choice.on,
          label: choice.label,
        }))}
        selected={
          extra.choices.some((choice) => choice.on === value) ? [value] : []
        }
        onChange={(values) => state.patch({ [extra.key]: values.at(-1) ?? "" })}
      />
    )
  })
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
  const isSingle = isSingleFor(dimension, state.isRequests)
  // Provenance earns a list only once there is more than one source to choose
  // between: most gateways see only their own traffic. A source already
  // filtered on keeps it, so the filter stays clearable here.
  if (
    dimension === "source" &&
    selected.length + excluded.length === 0 &&
    (read.isLoading || read.options.length < 2)
  )
    return null
  return (
    <ColumnFilterList
      label={TITLES[dimension]}
      title={title}
      selectionMode={isSingle ? "single" : "multiple"}
      options={isFixed ? statusOptions(view) : read.options}
      selected={selected}
      excluded={canExclude ? excluded : undefined}
      onChange={(nextSelected, nextExcluded) =>
        state.patch({
          [keys.include]: isSingle ? (nextSelected.at(-1) ?? "") : nextSelected,
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
      allowsCustom={
        !isSingle && dimension !== "policy" && dimension !== "status"
      }
      isMono={dimension === "model"}
      emptyLabel="Nothing in this window."
    />
  )
}

/**
 * The gateway tool a request ran, one at a time. Offered once the window holds
 * tool usage, or a tool filter is already set: most gateways run no tools, and a
 * filter whose every choice returns nothing is noise.
 */
function ToolSection({
  view,
  state,
}: {
  view: ObserveView
  state: ObserveFilterState
}) {
  const hasSurface = useSurfaces()
  const filters = useObserveUsageFilters(view, "tool", true)
  const summary = useUsageSummary(
    filters,
    "day",
    TOOL_DIMENSION,
    hasSurface("usage") && state.isResolved,
  )
  const tool = state.url.get("tool")
  if (!tool && !summary.data?.by_tool?.length) return null
  return (
    <ColumnFilterList
      label="Gateway tool"
      title="Gateway tool"
      selectionMode="single"
      options={TOOLS}
      selected={tool ? [tool] : []}
      onChange={(values) => state.patch({ tool: values.at(-1) ?? "" })}
    />
  )
}

const TOOL_DIMENSION: "tool"[] = ["tool"]
