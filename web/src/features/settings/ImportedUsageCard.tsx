import {
  buttonVariants,
  Dropdown,
  Input,
  Label,
  TextField,
} from "@heroui/react"
import { useState } from "react"
import { FiChevronDown, FiDollarSign, FiTrash2 } from "react-icons/fi"

import type { UsageFilters } from "@/client"
import { RowMenuItemContent } from "@/design-system/actions/RowMenuItemContent"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { FormDialog } from "@/design-system/feedback/FormDialog"
import { InfoBanner } from "@/design-system/feedback/InfoBanner"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { SettingsGroup } from "@/design-system/layout/SettingsGroup"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import { SetPriceDialog } from "@/features/models/SetPriceDialog"
import { useUsageCount, useUsageValueGroups } from "@/shared/api/usage"
import { useDeleteUsage, useSetUsagePrice } from "@/shared/api/usageAdmin"
import { formatCount } from "@/shared/helpers/format"

/** The windows the card scopes to, in hours back from when one is picked; `all` is every row. */
const WINDOWS = [
  { value: "24", label: "Last 24 hours" },
  { value: "168", label: "Last 7 days" },
  { value: "720", label: "Last 30 days" },
  { value: "2160", label: "Last 90 days" },
  { value: "all", label: "All time" },
]

/** The word typed to confirm a delete. */
export const DELETE_CONFIRMATION = "delete"

/** Names of the import sources the gateway knows; any other shows its slug. */
const SOURCE_NAMES: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
}

/**
 * Where a window picked now starts, to the minute: fixed when it is picked, so
 * the count and the write it confirms read the same rows rather than a window
 * that slides between them.
 */
export function windowStart(
  period: string,
  now = Date.now(),
): string | undefined {
  if (period === "all") return undefined
  const start = new Date(now - Number(period) * 3_600_000)
  start.setUTCSeconds(0, 0)
  return start.toISOString()
}

/** "1 imported row", "1,204 imported rows". */
export function importedRows(count: number): string {
  return `${formatCount(count)} imported ${count === 1 ? "row" : "rows"}`
}

type Dialog = "recost" | "delete"

/**
 * The operator's bulk actions on imported usage: recost the rows at manual
 * rates, or delete them. Imported rows are the ones a usage import recorded
 * (Claude Code, Codex), which never counted toward a budget, so neither action
 * moves a budget's spend, and a row this gateway served is never touched.
 *
 * On Settings rather than beside the request log: both act on every matching
 * imported row however many pages it spans, scoped by the window, source and
 * pricing picked here, with the count they will reach shown before either runs.
 */
export function ImportedUsageCard() {
  const [period, setPeriod] = useState("720")
  const [start, setStart] = useState(() => windowStart("720"))
  const [source, setSource] = useState("")
  const [unpricedOnly, setUnpricedOnly] = useState(false)
  const [dialog, setDialog] = useState<Dialog>()
  const [typed, setTyped] = useState("")
  const [outcome, setOutcome] = useState<string>()

  const filters: UsageFilters = {
    counts_toward_budget: false,
    ...(start ? { start_date: start } : {}),
    ...(source ? { source } : {}),
    ...(unpricedOnly ? { priced: false } : {}),
  }
  // Narrowed past the log's filter of the same name to rows not served here,
  // so this is the number the writes below can reach.
  const count = useUsageCount(filters)
  const sources = useUsageValueGroups(
    { counts_toward_budget: false, ...(start ? { start_date: start } : {}) },
    "source",
    "",
  )
  const recost = useSetUsagePrice()
  const remove = useDeleteUsage()

  const matching = count.data?.total ?? 0
  const selection = {
    by_filter: true,
    ...(start ? { start_date: start } : {}),
    ...(source ? { source } : {}),
    ...(unpricedOnly ? { priced: false } : {}),
  }
  const sourceOptions = [
    { value: "", label: "Every import source" },
    ...(sources.data?.groups ?? [])
      .map((group) => group.key)
      .filter((value): value is string => !!value && value !== "gateway")
      .map((value) => ({ value, label: SOURCE_NAMES[value] ?? value })),
  ]
  const rows = importedRows(matching)
  const closeDialog = () => {
    setDialog(undefined)
    setTyped("")
    remove.reset()
  }

  return (
    <SettingsGroup title="Imported usage">
      <div className="flex flex-col gap-4 py-4">
        <p className="max-w-3xl text-caption">
          Usage an import recorded, such as Claude Code or Codex sessions,
          rather than requests this gateway served. It never counts toward a
          budget, so recosting or deleting it leaves every budget's spend as it
          is, and a row the gateway served is never touched.
        </p>
        <ErrorBanner error={count.error ?? recost.error} />
        {outcome ? <InfoBanner>{outcome}</InfoBanner> : null}
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Window"
            value={period}
            onChange={(next) => {
              setPeriod(next)
              setStart(windowStart(next))
              setOutcome(undefined)
            }}
            options={WINDOWS}
          />
          <FilterSelect
            label="Source"
            value={source}
            onChange={(next) => {
              setSource(next)
              setOutcome(undefined)
            }}
            options={sourceOptions}
          />
          <Checkbox
            isSelected={unpricedOnly}
            onChange={(next) => {
              setUnpricedOnly(next)
              setOutcome(undefined)
            }}
          >
            Only rows with no cost
          </Checkbox>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-body tabular-nums" aria-live="polite">
            {count.isPending ? "Counting imported rows…" : `${rows} match.`}
          </p>
          <Dropdown>
            <Dropdown.Trigger
              isDisabled={count.isPending || matching === 0}
              className={buttonVariants({ size: "sm", variant: "secondary" })}
            >
              Manage imported usage
              <FiChevronDown aria-hidden className="size-3.5" />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end" className="otari-row-menu">
              <p className="px-3 pt-2 pb-1.5 text-caption text-subtle">
                Applies to the {rows} matching above.
              </p>
              <Dropdown.Menu
                aria-label="Manage imported usage"
                onAction={(id) => {
                  setOutcome(undefined)
                  recost.reset()
                  setDialog(id === "delete" ? "delete" : "recost")
                }}
              >
                <Dropdown.Item id="recost" textValue="Recost imported rows…">
                  <RowMenuItemContent
                    icon={FiDollarSign}
                    label="Recost imported rows…"
                    hint="Set their cost from rates you enter"
                    isRed={false}
                  />
                </Dropdown.Item>
                <Dropdown.Item
                  id="delete"
                  textValue="Delete imported rows…"
                  className="otari-row-menu-danger"
                >
                  <RowMenuItemContent
                    icon={FiTrash2}
                    label="Delete imported rows…"
                    hint="Removes them for good"
                    isRed
                  />
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </div>

      {dialog === "recost" ? (
        <SetPriceDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) closeDialog()
          }}
          title="Recost imported rows"
          submitLabel={`Recost ${rows}`}
          description={`Sets the cost of the ${rows} matching from these rates and each row's own tokens. Rows the gateway served keep the cost they were served with, and no budget's spend moves.`}
          onSubmit={async (rates) => {
            const result = await recost.mutateAsync({
              ...selection,
              input_price_per_million: rates.input_price_per_million,
              output_price_per_million: rates.output_price_per_million,
              cache_read_price_per_million:
                rates.cache_read_price_per_million ?? null,
              cache_write_price_per_million:
                rates.cache_write_price_per_million ?? null,
            })
            setOutcome(
              `Recosted ${importedRows(result.matched)}: ${formatCount(result.updated)} changed, ${formatCount(result.unchanged)} already at that cost.`,
            )
            closeDialog()
          }}
        />
      ) : null}

      <FormDialog
        isOpen={dialog === "delete"}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
        title={`Delete ${rows}?`}
        submitLabel={`Delete ${rows}`}
        isSubmitDisabled={typed.trim().toLowerCase() !== DELETE_CONFIRMATION}
        isDirty={typed !== ""}
        isPending={remove.isPending}
        error={remove.error}
        onSubmit={() =>
          remove.mutate(selection, {
            onSuccess: (result) => {
              setOutcome(`Deleted ${importedRows(result.deleted)}.`)
              closeDialog()
            },
          })
        }
      >
        <p className="text-body">
          Removes every imported row matching the window, source and pricing
          picked, from every view that reads usage. Rows the gateway served are
          not touched. This cannot be undone.
        </p>
        <TextField
          value={typed}
          onChange={setTyped}
          className="flex flex-col gap-1"
        >
          <Label className="text-body">
            Type <strong>{DELETE_CONFIRMATION}</strong> to confirm
          </Label>
          <Input autoComplete="off" />
        </TextField>
      </FormDialog>
    </SettingsGroup>
  )
}
