import { useState } from "react"
import { TextButton } from "@/design-system/actions/TextButton"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import type { ManualRates } from "@/features/models/SetPriceDialog"
import { useSetPricing } from "@/shared/api/pricing"
import { useDeleteUsage, useSetUsagePrice } from "@/shared/api/usage"
import { useUrlState } from "@/shared/helpers/urlState"
import { useIsPhone } from "@/shared/hooks/useIsPhone"
import { ActivityDesk } from "./ActivityDesk"
import { type ActivityDialog, ActivityDialogs } from "./ActivityDialogs"
import { ActivityPhone } from "./ActivityPhone"
import {
  ACTIVITY_URL_DEFAULTS,
  type ColumnKey,
  toSelection,
} from "./activityQuery"
import { SavedViewsMenu } from "./SavedViewsMenu"
import { useActivityActions } from "./useActivityActions"
import { useActivityLog } from "./useActivityLog"
import { useActivityViewer } from "./useActivityViewer"
import { useActivityViews } from "./useActivityViews"

/**
 * The request log: what the gateway served, filtered, sorted and grouped from
 * the table itself, with any request opened beside it.
 *
 * Everything that decides what is shown lives in the URL (`activityQuery.ts`),
 * so a view is a link and a saved view a query string. `useActivityLog` reads
 * it and `useActivityActions` writes it; this holds what the URL does not (live
 * mode, open menus and groups, dialogs) and hands both to the layout for the
 * viewport.
 */
export function ActivityPage() {
  const url = useUrlState(ACTIVITY_URL_DEFAULTS)
  const viewer = useActivityViewer()
  const isPhone = useIsPhone()
  const [isLive, setIsLive] = useState(true)
  const [openMenu, setOpenMenu] = useState<ColumnKey>()
  // The open column menu's search, which starts over with each menu.
  const [menuSearch, setMenuSearch] = useState("")
  const onMenu = (column: ColumnKey | undefined) => {
    setOpenMenu(column)
    setMenuSearch("")
  }
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [isSheetOpen, setIsSheetOpen] = useState(false)
  const [dialog, setDialog] = useState<ActivityDialog>()

  const log = useActivityLog({
    url,
    viewer,
    isPhone,
    isLive,
    openMenu,
    expanded,
    menuSearch,
    isSheetOpen,
  })
  const act = useActivityActions(url, log)
  const views = useActivityViews({
    url,
    workspaceId: viewer.workspaceId,
    hasSpan: log.time.hasSpan,
    onApplied: () => setExpanded(new Set()),
  })
  const viewsMenu = (isCompact: boolean) => (
    <SavedViewsMenu
      isCompact={isCompact}
      views={views.views}
      current={views.current}
      matching={views.matching}
      isDirty={views.isDirty}
      canShare={viewer.isManager}
      onApply={views.apply}
      onSave={views.save}
      onDelete={(view) => views.remove(view.id)}
      isSaving={views.isSaving}
      error={views.error}
      onClose={views.clearError}
    />
  )

  // ---------- the operator's writes ----------
  const deleteUsage = useDeleteUsage()
  const recost = useSetUsagePrice()
  const setModelPrice = useSetPricing()
  const onPriceModel = viewer.isOperator
    ? (modelKey: string) => setDialog({ kind: "price", modelKey })
    : undefined
  const selection = toSelection(log.filters)

  const empty = (
    <EmptyMessage>
      {log.isFiltered ? (
        <>
          No requests match these filters.{" "}
          <TextButton onPress={act.clearFilters}>Clear filters</TextButton>
        </>
      ) : (
        "No requests recorded yet."
      )}
    </EmptyMessage>
  )

  return (
    <>
      {isPhone ? (
        <ActivityPhone
          url={url}
          log={log}
          act={act}
          viewsMenu={viewsMenu(true)}
          currentView={views.current}
          workspaceName={viewer.workspaceName}
          isSheetOpen={isSheetOpen}
          onSheetOpen={setIsSheetOpen}
          onPriceModel={onPriceModel}
          empty={empty}
        />
      ) : (
        <ActivityDesk
          url={url}
          log={log}
          act={act}
          viewsMenu={viewsMenu(false)}
          isLive={isLive}
          onLive={setIsLive}
          openMenu={openMenu}
          onMenu={onMenu}
          menuSearch={menuSearch}
          onMenuSearch={setMenuSearch}
          expanded={expanded}
          onExpanded={setExpanded}
          onPriceModel={onPriceModel}
          onManageImported={(kind) =>
            setDialog({ kind, count: log.importedCount })
          }
          empty={empty}
        />
      )}
      <ActivityDialogs
        dialog={dialog}
        onClose={() => {
          setDialog(undefined)
          deleteUsage.reset()
        }}
        onSetModelPrice={(rates: ManualRates, modelKey: string) =>
          setModelPrice.mutateAsync(
            {
              model_key: modelKey,
              input_price_per_million: rates.input_price_per_million,
              output_price_per_million: rates.output_price_per_million,
              cache_read_price_per_million:
                rates.cache_read_price_per_million ?? null,
              cache_write_price_per_million:
                rates.cache_write_price_per_million ?? null,
            },
            { onSuccess: () => setDialog(undefined) },
          )
        }
        onRecost={(rates) =>
          recost.mutateAsync(
            { ...selection, ...rates },
            { onSuccess: () => setDialog(undefined) },
          )
        }
        onDelete={() =>
          deleteUsage.mutate(selection, {
            onSuccess: () => setDialog(undefined),
          })
        }
        isDeleting={deleteUsage.isPending}
        deleteError={deleteUsage.error}
      />
    </>
  )
}
