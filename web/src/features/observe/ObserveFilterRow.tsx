import { useState } from "react"
import { FiSliders } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { ColumnPicker } from "@/design-system/data/ColumnPicker"
import { useIsMobile } from "@/design-system/hooks/useIsMobile"
import {
  type FilterChip,
  FilterChips,
} from "@/design-system/navigation/FilterChips"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import {
  describeSource,
  PRICED_OPTIONS,
  STATUS_OPTIONS,
  TOOL_OPTIONS,
} from "@/features/activity/activityModel"
import { providerDisplayName } from "@/shared/helpers/providers"
import { findPreset, localMidnightIso } from "@/shared/helpers/timeRange"
import { ObserveFilterSheet } from "./ObserveFilterSheet"
import { ObserveSearchBox } from "./ObserveSearchBox"
import { OBSERVE_FILTER_COLUMNS } from "./observeColumnFilters"
import {
  type ObserveUrlKey,
  readThreshold,
  THRESHOLDS,
  type ThresholdKey,
  useObserveFilterState,
  useValueOptions,
} from "./observeFilters"
import { type ObserveView, rangesFor } from "./observeSearch"
import {
  type LayoutView,
  OBSERVE_TABLE_LAYOUTS,
  useObserveTableLayout,
} from "./observeTableLayout"

const isLayoutView = (view: ObserveView): view is LayoutView =>
  Object.hasOwn(OBSERVE_TABLE_LAYOUTS, view)

/** The Columns control for a tab's table: which columns it shows, and a reset of its layout. */
function ObserveColumnsControl({ view }: { view: LayoutView }) {
  const layout = useObserveTableLayout(view)
  return (
    <ColumnPicker
      columns={OBSERVE_TABLE_LAYOUTS[view].columns}
      hidden={layout.hidden}
      onHiddenChange={layout.setHidden}
      onReset={layout.reset}
      canReset={layout.isCustomized}
      // Level with the select's box rather than its box and label.
      className="self-end"
    />
  )
}

const labelFrom = (
  options: { value: string; label: string }[],
  value: string,
) => options.find((option) => option.value === value)?.label ?? value

// The window select's own values for a window no preset names. Today is the
// caller's local day so far, offered on Usage, which buckets by day.
const TODAY = "today"
const CUSTOM = "custom"

// Every filter key this row clears, the window aside.
const CLEARED: Partial<Record<ObserveUrlKey, string | []>> = {
  scope: "",
  status: "",
  exclude_status: [],
  model: [],
  exclude_model: [],
  user_id: [],
  exclude_user_id: [],
  api_key_id: [],
  exclude_api_key_id: [],
  provider: "",
  policy_name: [],
  exclude_policy_name: [],
  routed: "",
  tokens_gt: "",
  cost_gt: "",
  latency_ms_gt: "",
  priced: "",
  tool: "",
  source: "",
  exclude_source: [],
  source_label: "",
  status_code: "",
  endpoint: "",
  q: "",
}

/**
 * The row over a Sessions tab's table: the window, and every filter applied, as
 * removable chips: those set from the table's column headers
 * (`ObserveColumnFilter`) and those only a link sets. It is the page's one
 * chip row. A filter
 * the current view cannot apply stays visible and removable, marked as not
 * applied, rather than being dropped silently.
 *
 * On a phone the table is a list of cards with no headers, so the row carries
 * a Filters button instead, counting the filters applied, which opens the same
 * column filters as a sheet (`ObserveFilterSheet`).
 */
export function ObserveFilterRow({ view }: { view: ObserveView }) {
  const state = useObserveFilterState(view)
  const { url, patch, status, users, isMine, clearMine, isRequests } = state
  const excludedUsers = url.getAll("exclude_user_id")
  const keys = url.getAll("api_key_id")
  const excludedKeys = url.getAll("exclude_api_key_id")

  // Only read to name a chip: a user or key is shown by name where the window
  // has one for it.
  const userNames = useValueOptions(
    view,
    "user",
    "",
    (!isMine && users.length > 0) || excludedUsers.length > 0,
  )
  const isMobile = useIsMobile()
  const [isSheetOpen, setIsSheetOpen] = useState(false)
  const offersSheet = isMobile && OBSERVE_FILTER_COLUMNS[view].length > 0
  const keyNames = useValueOptions(
    view,
    "api_key",
    "",
    keys.length > 0 || excludedKeys.length > 0,
  )

  const range = url.get("range")
  const startParam = url.get("start_date")
  const endParam = url.get("end_date")
  const ranges = rangesFor(view)
  const midnight = localMidnightIso()
  const offersToday = view === "usage"
  const rangeValue =
    startParam || endParam
      ? offersToday && startParam === midnight && !endParam
        ? TODAY
        : CUSTOM
      : (findPreset(ranges.presets, range)?.key ?? ranges.defaultKey)
  const rangeOptions = [
    ...(offersToday ? [{ value: TODAY, label: "Today" }] : []),
    ...ranges.presets.map((preset) => ({
      value: preset.key,
      label: preset.label,
    })),
    // Shown only while it is the window: a dragged selection on the chart.
    ...(rangeValue === CUSTOM ? [{ value: CUSTOM, label: "Custom" }] : []),
  ]
  const pickRange = (value: string) => {
    if (value === CUSTOM) return
    patch(
      value === TODAY
        ? { range: "", start_date: localMidnightIso(), end_date: "" }
        : { range: value, start_date: "", end_date: "" },
    )
  }

  // A refinement only the request log reads says so anywhere else.
  const notApplied = ` (not applied to ${view})`
  const requestOnly = (value: string) =>
    isRequests ? value : `${value}${notApplied}`
  const valueChips = (
    label: string,
    param: ObserveUrlKey,
    display: (value: string) => string,
    { negate = false, onlyRequests = false } = {},
  ): FilterChip[] => {
    const values = url.getAll(param)
    return values.map((value) => {
      const shown = `${negate ? "not " : ""}${display(value)}`
      return {
        key: `${param}:${value}`,
        label,
        value: onlyRequests ? requestOnly(shown) : shown,
        // Several chips share a dimension, so the value has to be part of the name.
        clearLabel: `Remove ${label} filter ${shown}`,
        onClear: () =>
          patch({ [param]: values.filter((picked) => picked !== value) }),
      }
    })
  }
  const userName = (value: string) => labelFrom(userNames.options, value)
  const keyName = (value: string) => labelFrom(keyNames.options, value)
  const statusName = (value: string) => labelFrom(STATUS_OPTIONS, value)
  const thresholdChip = (key: ThresholdKey): FilterChip[] => {
    const value = readThreshold(url.get(key))
    if (value === undefined) return []
    const spec = THRESHOLDS[key]
    return [
      {
        key,
        label: spec.label,
        value: requestOnly(spec.describe(value)),
        onClear: () => patch({ [key]: "" }),
      },
    ]
  }
  // One value of a key only the request log reads.
  const singleChip = (
    param: ObserveUrlKey,
    label: string,
    display: (value: string) => string,
  ): FilterChip[] => {
    const value = url.get(param)
    return value
      ? [
          {
            key: param,
            label,
            value: requestOnly(display(value)),
            onClear: () => patch({ [param]: "" }),
          },
        ]
      : []
  }
  const chips: FilterChip[] = [
    ...(status
      ? [
          {
            key: "status",
            label: "Status",
            value: state.statusApplied
              ? statusName(status)
              : `${status}${notApplied}`,
            onClear: () => patch({ status: "" }),
          },
        ]
      : []),
    ...valueChips("Status", "exclude_status", statusName, {
      negate: true,
      onlyRequests: true,
    }),
    ...(isMine
      ? [
          {
            key: "mine",
            label: "User",
            value: "You",
            onClear: clearMine,
          },
        ]
      : valueChips("User", "user_id", userName)),
    ...valueChips("User", "exclude_user_id", userName, {
      negate: true,
      onlyRequests: true,
    }),
    ...valueChips("Model", "model", (value) => value),
    ...valueChips("Model", "exclude_model", (value) => value, {
      negate: true,
      onlyRequests: true,
    }),
    ...valueChips("API key", "api_key_id", keyName),
    ...valueChips("API key", "exclude_api_key_id", keyName, {
      negate: true,
      onlyRequests: true,
    }),
    ...(url.get("provider")
      ? [
          {
            key: "provider",
            label: "Provider",
            value: requestOnly(providerDisplayName(url.get("provider"))),
            onClear: () => patch({ provider: "" }),
          },
        ]
      : []),
    ...valueChips("Routing", "policy_name", (value) => value, {
      onlyRequests: true,
    }),
    ...valueChips("Routing", "exclude_policy_name", (value) => value, {
      negate: true,
      onlyRequests: true,
    }),
    ...(url.get("routed") === "false"
      ? [
          {
            key: "routed",
            label: "Routing",
            value: requestOnly("Direct requests only"),
            onClear: () => patch({ routed: "" }),
          },
        ]
      : []),
    ...singleChip("priced", "Priced", (value) =>
      labelFrom(PRICED_OPTIONS, value),
    ),
    ...singleChip("tool", "Tool", (value) => labelFrom(TOOL_OPTIONS, value)),
    ...singleChip("source", "Source", describeSource),
    ...valueChips("Source", "exclude_source", describeSource, {
      negate: true,
      onlyRequests: true,
    }),
    // Set by a link rather than a funnel: the session a request ran in, the
    // status code a failure was answered with, the endpoint it was called on.
    ...singleChip("source_label", "Session", (value) => value),
    ...singleChip("status_code", "Status code", (value) => value),
    ...singleChip("endpoint", "Endpoint", (value) => value),
    ...thresholdChip("tokens_gt"),
    ...thresholdChip("cost_gt"),
    ...thresholdChip("latency_ms_gt"),
  ] // The badge counts what the view applies; a chip marked not applied is left out.
  const appliedCount = chips.filter(
    (chip) => !chip.value.endsWith(notApplied),
  ).length

  const clearAll = () => patch(CLEARED)

  return (
    <div className="pb-3">
      <FilterChips
        chips={chips}
        start={
          <>
            <FilterSelect
              label="Time range"
              value={rangeValue}
              onChange={pickRange}
              options={rangeOptions}
            />
            {isRequests ? (
              <ObserveSearchBox
                value={url.get("q")}
                onCommit={(term) => patch({ q: term })}
              />
            ) : null}
            {/* The phone's cards have no columns to size or hide. */}
            {!isMobile && isLayoutView(view) ? (
              <ObserveColumnsControl view={view} />
            ) : null}
            {offersSheet ? (
              <Button
                size="sm"
                // Level with the select's box rather than its box and label.
                className="self-end"
                aria-haspopup="dialog"
                aria-label={
                  appliedCount > 0
                    ? `Filters, ${appliedCount} applied`
                    : "Filters"
                }
                onPress={() => setIsSheetOpen(true)}
              >
                <FiSliders aria-hidden className="size-3.5" />
                Filters
                {appliedCount > 0 ? (
                  <span
                    aria-hidden
                    className="rounded-full bg-primary-subtle px-1.5 text-mono-micro text-primary-subtle-foreground"
                  >
                    {appliedCount}
                  </span>
                ) : null}
              </Button>
            ) : null}
          </>
        }
        onClearAll={clearAll}
      />
      {offersSheet ? (
        <ObserveFilterSheet
          view={view}
          isOpen={isSheetOpen}
          onOpenChange={setIsSheetOpen}
          onClearAll={clearAll}
          hasFilters={chips.length > 0 || url.get("q") !== ""}
        />
      ) : null}
    </div>
  )
}
