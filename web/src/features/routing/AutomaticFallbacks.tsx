import { Link } from "@tanstack/react-router"
import { Fragment } from "react"
import { FiArrowRight } from "react-icons/fi"

import type { AutomaticFallback, FallbackOffering } from "@/client"
import { CopyableValue } from "@/design-system/actions/CopyField"
import { TextButton } from "@/design-system/actions/TextButton"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { SettingsGroup } from "@/design-system/layout/SettingsGroup"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import { docsSourceHref } from "@/shared/helpers/docs"
import { formatNumber } from "@/shared/helpers/format"
import { providerDisplayName } from "@/shared/helpers/providers"

import { SentByCell, Warning } from "./PolicyCells"

/** Who runs the built-in tools on one offering, or nothing where nobody does. */
function toolsCaption(offering: FallbackOffering): string | undefined {
  if (offering.own_tools.length > 0) return "Own tools"
  if (offering.otari_tools.length > 0) return "Otari's tools"
  return undefined
}

/** Shorter than the shared display names, for a chain read across a row. */
const SHORT_NAMES: Record<string, string> = { bedrock: "Bedrock" }

function providerName(provider: string): string {
  return SHORT_NAMES[provider] ?? providerDisplayName(provider)
}

/**
 * One entry per provider, first offering kept: a provider's second offering
 * (Bedrock's US endpoint after its global one) reads as a repeat in a chain
 * about providers.
 */
function byProvider(offerings: FallbackOffering[]): FallbackOffering[] {
  return offerings.filter(
    (offering, index) =>
      offerings.findIndex((other) => other.provider === offering.provider) ===
      index,
  )
}

/** The providers a catalog ID tries, each with who runs its tools. */
function Chain({ offerings }: { offerings: FallbackOffering[] }) {
  return (
    <span className="flex flex-wrap items-start gap-x-2 gap-y-1">
      {byProvider(offerings).map((offering, index) => {
        const caption = toolsCaption(offering)
        return (
          <Fragment key={offering.selector}>
            {index > 0 ? (
              <FiArrowRight
                aria-label="then"
                className="mt-1 size-3 shrink-0 text-subtle"
              />
            ) : null}
            <span className="flex flex-col">
              <span
                className={`text-sm ${index === 0 ? "text-foreground" : "text-muted"}`}
              >
                {providerName(offering.provider)}
              </span>
              {caption ? (
                <span className="text-caption text-subtle">{caption}</span>
              ) : null}
            </span>
          </Fragment>
        )
      })}
    </span>
  )
}

/**
 * The order cell: the chain, or the one provider a model's traffic reaches and
 * a warning that it has no backup. Traffic that names one provider has none
 * even where the catalog offers more, marked "pinned" because the caller can
 * fix it by sending the catalog ID. A model counts as pinned once most of its
 * requests are, so a handful sent by catalog ID does not make it read covered.
 */
function OrderCell({
  row,
  onAddBackup,
}: {
  row: AutomaticFallback
  /** Start a policy on the one offering this model's traffic reaches. */
  onAddBackup?: (selector: string) => void
}) {
  const { offerings } = row
  const hasBackup = byProvider(offerings).length > 1
  const isPinned = hasBackup && row.pinned * 2 > row.requests
  if (hasBackup && !isPinned) {
    return <Chain offerings={offerings} />
  }
  const reached = isPinned
    ? (offerings.find(
        (offering) => offering.provider === row.pinned_provider,
      ) ?? offerings[0])
    : offerings[0]
  return (
    <span className="flex flex-wrap items-start gap-x-2">
      {reached ? <Chain offerings={[reached]} /> : null}
      <Warning>{isPinned ? "No backup · pinned" : "No backup"}</Warning>
      {reached && onAddBackup ? (
        <TextButton onPress={() => onAddBackup(reached.selector)}>
          Add a backup
        </TextButton>
      ) : null}
    </span>
  )
}

const BASE_COLUMNS: DataTableColumn<AutomaticFallback>[] = [
  {
    id: "model",
    header: "Model",
    isRowHeader: true,
    cell: (row) => (
      <span title={row.id}>
        <CopyableValue
          value={row.id}
          label="catalog ID"
          className="text-sm text-foreground"
        >
          {row.name}
        </CopyableValue>
      </span>
    ),
  },
  {
    id: "requests",
    header: "Requests (30d)",
    cell: (row) => (
      <span className="text-sm tabular-nums text-muted">
        {formatNumber(row.requests)}
      </span>
    ),
  },
  {
    id: "fellBack",
    header: "Fell back (30d)",
    cell: (row) => (
      <span
        className={`text-sm tabular-nums ${row.fell_back ? "text-foreground" : "text-subtle"}`}
      >
        {formatNumber(row.fell_back)}
      </span>
    ),
  },
  {
    id: "order",
    header: "Tried in order",
    cell: (row) => <OrderCell row={row} />,
  },
]

/**
 * The columns, with Sent by after the model where key names are at hand, and
 * an Add a backup on each row without one where a policy can be started.
 */
function columnsFor(
  keyLabelOf: ((apiKeyId: string) => string) | undefined,
  onAddBackup: ((selector: string) => void) | undefined,
): DataTableColumn<AutomaticFallback>[] {
  const columns = BASE_COLUMNS.map((column) =>
    column.id === "order" && onAddBackup
      ? {
          ...column,
          cell: (row: AutomaticFallback) => (
            <OrderCell row={row} onAddBackup={onAddBackup} />
          ),
        }
      : column,
  )
  if (!keyLabelOf) return columns
  const [model, ...rest] = columns
  return [
    model,
    {
      id: "sentBy",
      header: "Sent by",
      cell: (row) => (
        <SentByCell
          sentBy={row.sent_by.map((key) => ({
            apiKeyId: key.api_key_id,
            requests: key.requests,
          }))}
          labelOf={keyLabelOf}
        />
      ),
    },
    ...rest,
  ]
}

/**
 * The fallbacks a gateway gives with no policy: a model served on
 * several providers fails over between them when callers send its catalog ID.
 * A model on one provider is listed too, marked as having no backup.
 */
export function AutomaticFallbacks({
  fallbacks,
  toolsNote,
  keyLabelOf,
  onAddBackup,
  isLoading = false,
  error,
}: {
  fallbacks: AutomaticFallback[]
  /** Start a policy on a model with no backup; the link is left out without it. */
  onAddBackup?: (selector: string) => void
  /** A key's name, for the Sent by column; the column is left out without it. */
  keyLabelOf?: (apiKeyId: string) => string
  /** How the tools caption under each provider is decided, in one sentence. */
  toolsNote?: string
  isLoading?: boolean
  error?: unknown
}) {
  return (
    <SettingsGroup
      title="Automatic fallback"
      count={isLoading || error ? undefined : fallbacks.length}
      description="Models used in the last 30 days. Sent by catalog ID, they move to the next provider when one fails, no policy needed."
      docsHref={docsSourceHref("models.md", "catalog-spellings")}
    >
      {toolsNote ? (
        <p className="py-3 text-caption">
          {toolsNote}{" "}
          <Link to="/tools" className="text-link hover:underline">
            Change in Tools
          </Link>
        </p>
      ) : null}
      {error ? (
        <ErrorBanner error={error} />
      ) : (
        <TableScrollFrame className="otari-fallbacks-table">
          <DataTable
            ariaLabel="Automatic fallback"
            columns={columnsFor(keyLabelOf, onAddBackup)}
            rows={fallbacks}
            getRowKey={(row) => row.id}
            isLoading={isLoading}
            emptyContent="No traffic in the last 30 days."
          />
        </TableScrollFrame>
      )}
    </SettingsGroup>
  )
}
