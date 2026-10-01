import type { UsageMutationSelection } from "@/client"
import { ConfirmDialog } from "@/design-system/feedback/ConfirmDialog"
import {
  type ManualRates,
  SetPriceDialog,
} from "@/features/models/SetPriceDialog"
import { formatNumber } from "@/shared/helpers/format"

export type ActivityDialog =
  | { kind: "price"; modelKey: string }
  | {
      kind: "recost" | "delete"
      count: number
      /** The rows `count` was taken over, fixed as the dialog opened. */
      selection: UsageMutationSelection
    }

/**
 * The operator's three writes from the log. Setting a model's price changes
 * what later requests cost; recosting and deleting reach the imported rows the
 * filters match, and never a gateway row.
 *
 * Each dialog mounts when it opens, so every open starts from a blank form.
 */
export function ActivityDialogs({
  dialog,
  onClose,
  onSetModelPrice,
  onRecost,
  onDelete,
  isDeleting,
  deleteError,
}: {
  dialog: ActivityDialog | undefined
  onClose: () => void
  onSetModelPrice: (rates: ManualRates, modelKey: string) => Promise<unknown>
  onRecost: (
    selection: UsageMutationSelection,
    rates: ManualRates,
  ) => Promise<unknown>
  onDelete: (selection: UsageMutationSelection) => void
  isDeleting: boolean
  deleteError: Error | null
}) {
  if (!dialog) return null
  const onOpenChange = (isOpen: boolean) => {
    if (!isOpen) onClose()
  }
  if (dialog.kind === "price") {
    return (
      <SetPriceDialog
        isOpen
        onOpenChange={onOpenChange}
        onSubmit={onSetModelPrice}
        submitLabel="Set price"
        collectModelKey
        initialModelKey={dialog.modelKey}
        title="Set model price"
        description={() =>
          "Requests from now on are costed at these rates and count toward budgets. Rows already logged keep their cost."
        }
      />
    )
  }
  const rows = `${formatNumber(dialog.count)} imported ${dialog.count === 1 ? "row" : "rows"}`
  if (dialog.kind === "recost") {
    return (
      <SetPriceDialog
        isOpen
        onOpenChange={onOpenChange}
        targetCount={dialog.count}
        onSubmit={(rates) => onRecost(dialog.selection, rates)}
        submitLabel={`Recost ${rows}`}
        title="Recost imported rows"
        description={() =>
          `Recalculates the equivalent cost of ${rows} matching the current filters. Gateway rows keep the cost they were served with.`
        }
      />
    )
  }
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={onOpenChange}
      heading={`Delete ${rows}?`}
      body="Removes every imported row matching the current filters. Gateway rows aren't touched. This can't be undone."
      confirmLabel="Delete rows"
      isPending={isDeleting}
      error={deleteError}
      onConfirm={() => onDelete(dialog.selection)}
    />
  )
}
