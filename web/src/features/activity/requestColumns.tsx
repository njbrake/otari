import type { UsageEntry } from "@/client"
import { Button } from "@/design-system/actions/Button"
import type { DataTableColumn } from "@/design-system/data/DataTable"
import { Dot } from "@/design-system/indicators/Dot"
import { formatDateTime, formatRelative } from "@/shared/helpers/format"
import {
  buildTokenComposition,
  displayStatus,
  formatTokenCount,
  formatTokenLane,
  formatToolUsage,
  formatUSD,
  formatUSDLane,
  isCompactCount,
  isCompactUSD,
  listToolUsage,
} from "./activityModel"
import { InputTokens } from "./InputTokens"
import { LaneValue } from "./LaneValue"
import { StatusMark } from "./StatusMark"

// The request log's columns that read nothing but the row. Activity and the
// Overview's recent requests both build on them, since the preview is the same
// log a few rows long, and `globals.css` sizes their lanes once for both.

type RequestColumn = DataTableColumn<UsageEntry>

export const apiKeyLabel = (entry: UsageEntry): string =>
  entry.api_key_id === null
    ? "—"
    : entry.api_key_name || `${entry.api_key_id.slice(0, 8)}…`

export const TIME_COLUMN: RequestColumn = {
  id: "time",
  header: "Time",
  // Relative time reads better in a scan than a full timestamp; the absolute
  // value stays available as a tooltip.
  cell: (entry) => (
    <span title={formatDateTime(entry.timestamp)} className="text-muted">
      {formatRelative(entry.timestamp)}
    </span>
  ),
}

/** The gateway-tool filter a row's tool marker writes: the one tool it ran, or any tool. */
export function toolFilterFor(entry: UsageEntry): string {
  const tools = listToolUsage(entry)
  const known = new Set(["web_search", "web_fetch", "code_execution"])
  return tools.length === 1 && known.has(tools[0].tool) ? tools[0].tool : "any"
}

/**
 * A row's model, with the marker for the gateway tools it ran. With `onTool`
 * the marker is a button that filters the log to those tools.
 */
export function modelCell(
  entry: UsageEntry,
  onTool?: (entry: UsageEntry) => void,
) {
  const tools = listToolUsage(entry)
  if (!tools.length) {
    return (
      <span className="block truncate" title={entry.model}>
        {entry.model}
      </span>
    )
  }
  const calls = tools.reduce((sum, tool) => sum + tool.billed + tool.errors, 0)
  const detail = tools.map(formatToolUsage).join(" · ")
  return (
    // The model keeps its width first; a narrow lane shortens the marker,
    // whose label still says it all.
    <span className="flex items-center gap-1.5">
      <span className="max-w-full shrink-0 truncate" title={entry.model}>
        {entry.model}
      </span>
      {/* A marker, not a badge: an accent dot and the count in mono
            uppercase, on the same terms as every other marker in the product.
            A generic span does not reliably expose aria-label, so it takes the
            img role; the label is the whole meaning and the count inside is a
            summary of it. */}
      {onTool ? (
        <Button
          size="sm"
          className="otari-tool-marker"
          aria-label={`Gateway tools: ${detail}`}
          onPress={() => onTool(entry)}
        >
          <Dot className="bg-accent" />
          <span className="truncate">
            {calls} {calls === 1 ? "tool" : "tools"}
          </span>
        </Button>
      ) : (
        <span
          role="img"
          className="inline-flex min-w-0 items-center gap-1.5 text-mono-overline text-muted"
          title={detail}
          aria-label={`Gateway tools: ${detail}`}
        >
          <Dot className="bg-accent" />
          <span className="truncate">
            {calls} {calls === 1 ? "tool" : "tools"}
          </span>
        </span>
      )}
    </span>
  )
}

export const MODEL_COLUMN: RequestColumn = {
  id: "model",
  header: "Model",
  isRowHeader: true,
  // The tool marker lives here rather than in a column of its own, which would
  // push the failure-forward Status pill off a narrow viewport.
  cell: (entry) => modelCell(entry),
}

export const API_KEY_COLUMN: RequestColumn = {
  id: "api_key",
  header: "API key",
  cell: (entry) => (
    // The title is the whole id when the label had to shorten it.
    <span
      className="block truncate text-muted"
      title={entry.api_key_name || entry.api_key_id || "—"}
    >
      {apiKeyLabel(entry)}
    </span>
  ),
}

export const INPUT_TOKENS_COLUMN: RequestColumn = {
  id: "input_tokens",
  header: "Input",
  align: "end",
  cell: (entry) => <InputTokens entry={entry} />,
}

export const OUTPUT_TOKENS_COLUMN: RequestColumn = {
  id: "output_tokens",
  header: "Output",
  align: "end",
  cell: (entry) => {
    const output =
      buildTokenComposition(entry)?.output ?? entry.completion_tokens
    return output !== null && isCompactCount(output) ? (
      <LaneValue
        display={formatTokenLane(output)}
        exact={formatTokenCount(output)}
      />
    ) : (
      formatTokenLane(output)
    )
  },
}

export const COST_COLUMN: RequestColumn = {
  id: "cost",
  header: "Cost",
  align: "end",
  cell: (entry) =>
    entry.cost !== null && isCompactUSD(entry.cost) ? (
      <LaneValue
        display={formatUSDLane(entry.cost)}
        exact={formatUSD(entry.cost)}
      />
    ) : (
      formatUSD(entry.cost)
    ),
}

export const STATUS_COLUMN: RequestColumn = {
  id: "status",
  header: "Status",
  cell: (entry) => <StatusMark status={displayStatus(entry)} />,
}
