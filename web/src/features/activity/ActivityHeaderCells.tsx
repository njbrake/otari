import type { UsageActivityGroup, UsageTotals } from "@/client"
import type { UsageSort } from "@/shared/api/usage"
import { formatNumber } from "@/shared/helpers/format"
import { laneWidthRem } from "./activityColumns"
import { shortId } from "./activityModel"
import {
  type ActivityUrl,
  COLUMN_FILTER_KEYS,
  type ColumnKey,
  groupOptions,
  isColumnFiltered,
  nextSort,
  type Patch,
  readNumber,
  statusOptions,
  THRESHOLD_FILTERS,
  togglePatch,
  unpricedPatch,
  VALUE_FILTERS,
  type ValueColumn,
  type ValueOption,
} from "./activityQuery"
import { ColumnFilterMenu } from "./ColumnFilterMenu"
import { ColumnHeader } from "./ColumnHeader"
import type { GroupList } from "./useActivityLog"

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  time: "Time",
  member: "Member",
  model: "Model",
  policy: "Policy",
  source: "Source",
  tokens: "Tokens",
  cost: "Cost",
  latency: "Latency",
  status: "Status",
}

/**
 * The log's header row: each column's sort and its filter menu.
 *
 * A value column lists what the window holds for it, with counts, from the
 * grouping the page reads when its menu opens (`options`): busiest first, and
 * searched on the server, so a window with more values than one read returns
 * still reaches them all. Status counts come from the totals. A numeric column offers thresholds. Cost adds the unpriced rows,
 * Status the choice to list recovered attempts as rows, and Policy the requests
 * that named a model directly.
 */
export function ActivityHeaderCells({
  columns,
  url,
  sort,
  openMenu,
  onMenu,
  options,
  aliases,
  menuSearch,
  onMenuSearch,
  policyGroups,
  totals,
  memberName,
  onRefine,
}: {
  columns: ColumnKey[]
  url: ActivityUrl
  sort: UsageSort
  openMenu: ColumnKey | undefined
  onMenu: (column: ColumnKey | undefined) => void
  /** The open menu's values. */
  options: GroupList
  /** The aliases callers sent in the window, listed under Model. */
  aliases: GroupList
  menuSearch: string
  onMenuSearch: (term: string) => void
  /** The window's policies, for the count of requests that used none. */
  policyGroups: UsageActivityGroup[]
  totals: UsageTotals | undefined
  memberName: (userId: string | null, alias?: string | null) => string
  onRefine: (patch: Patch) => void
}) {
  const close = () => onMenu(undefined)
  const clear = (column: ColumnKey) =>
    isColumnFiltered(url, column)
      ? () => {
          onRefine(
            Object.fromEntries(
              COLUMN_FILTER_KEYS[column].map((key) => [key, ""]),
            ),
          )
          close()
        }
      : undefined

  const optionsFor = (column: ValueColumn): ValueOption[] => {
    switch (column) {
      case "status":
        return statusOptions(url, totals)
      case "member":
        return groupOptions(options.groups, (group) =>
          memberName(group.key, group.label),
        )
      case "source":
        return groupOptions(
          options.groups,
          (group) => group.label ?? shortId(group.key),
        )
      default:
        return groupOptions(options.groups, (group) => group.label ?? group.key)
    }
  }

  const menuFor = (column: ColumnKey) => {
    if (column === "time") return undefined
    if (column === "tokens" || column === "cost" || column === "latency") {
      const spec = THRESHOLD_FILTERS[column]
      const current = readNumber(url, spec.key)
      const isUnpriced = url.get("priced") === "false"
      return (
        <ColumnFilterMenu
          title={COLUMN_LABELS[column]}
          thresholds={{
            presets: spec.presets.map((value) => ({
              value,
              label: spec.describe(value),
            })),
            current,
            onPick: (value) => {
              onRefine({ [spec.key]: String(value) })
              close()
            },
          }}
          extras={
            column === "cost"
              ? [
                  {
                    label: "Unpriced only",
                    isChecked: isUnpriced,
                    onPress: () => {
                      onRefine(unpricedPatch(url, !isUnpriced))
                      close()
                    },
                    trailing: totals?.unpriced_requests
                      ? formatNumber(totals.unpriced_requests)
                      : undefined,
                  },
                ]
              : undefined
          }
          onClear={clear(column)}
        />
      )
    }
    const direct = policyGroups.find((group) => group.key === null)
    const extras =
      column === "status"
        ? [
            {
              label: "Show recovered attempts as rows",
              isChecked: url.get("recovered") === "show",
              onPress: () => {
                onRefine({
                  recovered: url.get("recovered") === "show" ? "" : "show",
                })
                close()
              },
            },
          ]
        : column === "policy"
          ? [
              {
                label: "Direct requests only",
                isChecked: url.get("routed") === "false",
                onPress: () => {
                  onRefine({
                    routed: url.get("routed") === "false" ? "" : "false",
                  })
                  close()
                },
                trailing: direct ? formatNumber(direct.requests) : undefined,
              },
            ]
          : undefined
    return (
      <ColumnFilterMenu
        title={COLUMN_LABELS[column]}
        options={optionsFor(column)}
        {...(column === "status"
          ? {}
          : {
              isLoading: options.isLoading,
              isError: options.isError,
              more: options.more,
              search: menuSearch,
              onSearch: onMenuSearch,
            })}
        isMono={column === "model" || column === "policy"}
        picked={url.getAll(VALUE_FILTERS[column].include)}
        excluded={url.getAll(VALUE_FILTERS[column].exclude)}
        onToggle={(value) => onRefine(togglePatch(url, column, value))}
        aliases={
          column === "model"
            ? {
                options: groupOptions(aliases.groups, (group) => group.key),
                picked: url.getAll("requested_model"),
                onToggle: (value) => {
                  const picked = url.getAll("requested_model")
                  onRefine({
                    requested_model: picked.includes(value)
                      ? picked.filter((name) => name !== value)
                      : [...picked, value],
                  })
                },
              }
            : undefined
        }
        extras={extras}
        onClear={clear(column)}
      />
    )
  }

  return columns.map((column, index) => (
    <ColumnHeader
      key={column}
      opensLeft={index >= columns.length - 2}
      column={column}
      label={COLUMN_LABELS[column]}
      align={
        column === "tokens" || column === "cost" || column === "latency"
          ? "end"
          : "start"
      }
      widthRem={laneWidthRem(column)}
      sort={sort}
      onSort={() => {
        const next = nextSort(column, sort)
        onRefine({ sort: next.key, order: next.order })
      }}
      isFiltered={isColumnFiltered(url, column)}
      menu={menuFor(column)}
      isMenuOpen={openMenu === column}
      onMenuOpen={(isOpen) => onMenu(isOpen ? column : undefined)}
    />
  ))
}
