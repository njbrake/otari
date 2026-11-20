import type { FilterSection } from "./observeFilters"
import type { ObserveView } from "./observeSearch"

/**
 * One column's filters: what its header funnel holds on a desk, and the
 * section the phone's filter sheet gives it.
 */
export interface ObserveFilterColumn {
  /** The column's name, as its header shows it and as the sheet heads its section. */
  label: string
  /**
   * The table columns whose headers carry the funnel, by column id, each under
   * the label its header shows when that differs. Tokens are one threshold over
   * input plus output, so the Input and Output columns carry the same one, and
   * the sheet lists it once.
   */
  headers: readonly { column: string; label?: string }[]
  sections: readonly FilterSection[]
  /** For a column near the right edge, so the funnel's panel stays on the page. */
  placement?: "bottom end"
}

/**
 * Every filterable column of each tab, in the table's column order. The header
 * funnels and the phone's sheet both render from this list, so the two can
 * never offer different values or write different URL keys.
 */
export const OBSERVE_FILTER_COLUMNS: Record<
  ObserveView,
  readonly ObserveFilterColumn[]
> = {
  usage: [],
  requests: [
    {
      label: "User",
      headers: [{ column: "user" }],
      sections: [
        { kind: "values", dimension: "user" },
        { kind: "empty", field: "user" },
      ],
    },
    // The provider has no column, and the Model cell carries the tool marker,
    // so both are filtered here.
    {
      label: "Model",
      headers: [{ column: "model" }],
      sections: [
        { kind: "values", dimension: "model" },
        { kind: "values", dimension: "provider" },
        { kind: "tool" },
      ],
    },
    {
      label: "Routing",
      headers: [{ column: "routing" }],
      sections: [
        { kind: "values", dimension: "policy" },
        { kind: "extra", key: "direct" },
      ],
    },
    {
      label: "API key",
      headers: [{ column: "api_key" }],
      sections: [
        { kind: "values", dimension: "api_key" },
        { kind: "values", dimension: "source" },
        { kind: "channel" },
        { kind: "empty", field: "api_key" },
        { kind: "empty", field: "session" },
      ],
    },
    {
      label: "Tokens",
      headers: [
        { column: "input_tokens", label: "Input" },
        { column: "output_tokens", label: "Output" },
      ],
      sections: [{ kind: "threshold", key: "tokens_gt" }],
    },
    {
      label: "Cost",
      headers: [{ column: "cost" }],
      sections: [
        { kind: "threshold", key: "cost_gt" },
        { kind: "extra", key: "priced" },
      ],
    },
    {
      label: "Total time",
      headers: [{ column: "latency" }],
      sections: [{ kind: "threshold", key: "latency_ms_gt" }],
      placement: "bottom end",
    },
    {
      label: "Status",
      headers: [{ column: "status" }],
      sections: [
        { kind: "values", dimension: "status" },
        { kind: "extra", key: "recovered" },
      ],
      placement: "bottom end",
    },
  ],
  // Model and API key have no column here, so they are set on Requests and
  // carried across.
  sessions: [
    {
      label: "User",
      headers: [{ column: "user" }],
      sections: [{ kind: "values", dimension: "user" }],
    },
    {
      label: "Levels",
      headers: [{ column: "levels" }],
      sections: [{ kind: "values", dimension: "status" }],
    },
  ],
}

/** The funnel a column's header carries on a tab, or undefined for a column it filters nothing by. */
export function funnelFor(
  view: ObserveView,
  column: string,
):
  | {
      label: string
      sections: FilterSection[]
      placement?: "bottom end"
    }
  | undefined {
  for (const filter of OBSERVE_FILTER_COLUMNS[view]) {
    const header = filter.headers.find((one) => one.column === column)
    if (header)
      return {
        label: header.label ?? filter.label,
        sections: [...filter.sections],
        placement: filter.placement,
      }
  }
  return undefined
}
