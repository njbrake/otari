import type { PreferenceKey } from "@/client"
import type { DataTableColumn } from "@/design-system/data/DataTable"
import type { TableLayoutColumn } from "@/shared/helpers/tableLayout"
import { useTableLayout } from "@/shared/hooks/useTableLayout"
import type { ObserveView } from "./observeSearch"

/** The two tabs whose table a person can size and trim. */
export type LayoutView = Extract<ObserveView, "sessions" | "requests">

/**
 * Each table's columns in their order, as the Columns control lists them, with
 * the width each starts at and the narrowest a drag may leave it. A column
 * with no `width` shares what the others leave. The defaults are the lanes the
 * tables' blocks in `globals.css` gave them before they could be dragged.
 */
export const OBSERVE_TABLE_LAYOUTS: Record<
  LayoutView,
  { key: PreferenceKey; columns: readonly TableLayoutColumn[] }
> = {
  requests: {
    key: "table:requests",
    columns: [
      { id: "time", label: "Time", isHideable: true, width: 84, minWidth: 64 },
      { id: "user", label: "User", isHideable: true, width: 128, minWidth: 72 },
      { id: "model", label: "Model", isHideable: false, minWidth: 120 },
      { id: "routing", label: "Routing", isHideable: true, minWidth: 96 },
      { id: "api_key", label: "API key", isHideable: true, minWidth: 96 },
      {
        id: "input_tokens",
        label: "Input",
        isHideable: true,
        width: 104,
        minWidth: 72,
      },
      {
        id: "output_tokens",
        label: "Output",
        isHideable: true,
        width: 104,
        minWidth: 72,
      },
      { id: "cost", label: "Cost", isHideable: true, width: 100, minWidth: 72 },
      {
        id: "latency",
        label: "Total time",
        isHideable: true,
        width: 124,
        minWidth: 80,
      },
      {
        id: "status",
        label: "Status",
        isHideable: true,
        width: 112,
        minWidth: 80,
      },
    ],
  },
  sessions: {
    key: "table:sessions",
    columns: [
      {
        id: "last_activity",
        label: "Last activity",
        isHideable: true,
        width: 182,
        minWidth: 120,
      },
      { id: "name", label: "Name", isHideable: false, minWidth: 160 },
      { id: "user", label: "User", isHideable: true, width: 200, minWidth: 96 },
      {
        id: "levels",
        label: "Levels",
        isHideable: true,
        width: 96,
        minWidth: 72,
      },
      {
        id: "latency",
        label: "Latency",
        isHideable: true,
        width: 96,
        minWidth: 72,
      },
      {
        id: "tokens",
        label: "Tokens",
        isHideable: true,
        width: 176,
        minWidth: 112,
      },
      {
        id: "cost",
        label: "Total cost",
        isHideable: true,
        width: 104,
        minWidth: 72,
      },
      { id: "tags", label: "Tags", isHideable: true, width: 96, minWidth: 64 },
    ],
  },
}

/** A tab's table layout, kept for the signed-in person. */
export function useObserveTableLayout(view: LayoutView) {
  const { key, columns } = OBSERVE_TABLE_LAYOUTS[view]
  return useTableLayout(key, columns)
}

/**
 * `columns` as a tab's table draws them on a desk: its hidden ones left out,
 * and each given its default width and bounds. A column the layout does not
 * list is drawn as it is.
 */
export function laidOutColumns<Row>(
  view: LayoutView,
  columns: DataTableColumn<Row>[],
  hidden: readonly string[],
): DataTableColumn<Row>[] {
  const specs = new Map(
    OBSERVE_TABLE_LAYOUTS[view].columns.map((spec) => [spec.id, spec]),
  )
  return columns
    .filter((column) => !hidden.includes(column.id))
    .map((column) => {
      const spec = specs.get(column.id)
      return spec
        ? {
            ...column,
            width: spec.width,
            minWidth: spec.minWidth,
            maxWidth: spec.maxWidth,
          }
        : column
    })
}
