import { Modal } from "@heroui/react"
import type { ReactNode } from "react"
import { FiChevronLeft, FiSliders } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { Segmented } from "@/design-system/navigation/Segmented"
import { isSameSort, NEWEST_FIRST } from "@/shared/api/usage"
import { formatNumber } from "@/shared/helpers/format"
import { ActivityChips } from "./ActivityChips"
import { ActivitySearch } from "./ActivitySearch"
import { ActivityTotals } from "./ActivityTotals"
import { valueFilterModel } from "./activityFilters"
import { type ActivityUrl, readNumber } from "./activityQuery"
import { PHONE_BATCH } from "./activityRows"
import { barSpanMs, describeSpan, PHONE_BARS, phoneBars } from "./chartBars"
import { FilterSheet, PHONE_SORTS, type SheetSection } from "./FilterSheet"
import { MissingRequest } from "./MissingRequest"
import { PhoneChart } from "./PhoneChart"
import { PhoneRow } from "./PhoneRow"
import { RequestPanel } from "./RequestPanel"
import { ScopeSwitch } from "./ScopeSwitch"
import type { ActivityActions } from "./useActivityActions"
import type { ActivityLog, GroupList } from "./useActivityLog"
import { WorkspaceBudget } from "./WorkspaceBudget"

/**
 * Activity on a phone: the same log, filters and URL as the desk, arranged
 * for a thumb. Rows instead of a table, one sheet for sort and filters instead
 * of column headers, bars to tap instead of a range to drag, and a request read
 * full screen over the list, which stays where it was underneath. Grouping,
 * live updates, the in-flight list and bulk actions are left to the desk; a
 * link carrying them still opens here.
 */
export function ActivityPhone({
  url,
  log,
  act,
  viewsMenu,
  currentView,
  workspaceName,
  isSheetOpen,
  onSheetOpen,
  onPriceModel,
  empty,
}: {
  url: ActivityUrl
  log: ActivityLog
  act: ActivityActions
  /** The saved views menu, in its compact form. */
  viewsMenu: ReactNode
  currentView: string | undefined
  workspaceName: string
  isSheetOpen: boolean
  onSheetOpen: (isOpen: boolean) => void
  onPriceModel: ((modelKey: string) => void) | undefined
  empty: ReactNode
}) {
  const { isManager } = log.viewer
  // A manager's scope switch takes the room a month would, so the month is
  // left to members, whose label beside it is short.
  const windows = Object.keys(PHONE_BARS).filter(
    (key) => key !== "30d" || !isManager,
  )
  const bars = phoneBars(log.series, log.time.range, log.time.now)
  const barMs = barSpanMs(bars)
  const { sort, open, chips } = log
  // The columns a phone filters by value: the desk's, less what it cannot fit.
  const section = (
    column: "status" | "member" | "source" | "model" | "policy",
    list?: GroupList,
  ): SheetSection => ({
    ...valueFilterModel(url, column, {
      groups: list?.groups,
      totals: log.totals,
      memberName: log.memberName,
    }),
    more: list?.more,
    isError: list?.isError,
  })
  const sections: SheetSection[] = [
    section("status"),
    ...(log.isMulti ? [section("member", log.sheet.member)] : []),
    section("source", log.sheet.source),
    section("model", log.sheet.model),
    ...(log.isMulti ? [section("policy", log.sheet.policy)] : []),
  ]
  const cost = readNumber(url, "cost_gt")
  const isSorted = !isSameSort(sort, NEWEST_FIRST)
  const sortLabel =
    PHONE_SORTS.find((option) => isSameSort(option.sort, sort))?.label ??
    "Sorted"
  const filterCount = chips.length + (act.span ? 1 : 0)

  return (
    <>
      <div inert={open !== undefined} className="-mx-4 -mt-5 flex flex-col">
        <div className="flex items-center gap-1 border-b border-border py-1 pr-2 pl-4">
          <span className="min-w-0 flex-1">
            <h1 className="text-title">Activity</h1>
            <span className="block truncate text-mono-micro text-subtle">
              {workspaceName || "All workspaces"} ·{" "}
              {currentView ?? "Unsaved view"}
            </span>
          </span>
          {viewsMenu}
        </div>

        <ErrorBanner error={log.error} />
        {log.isOpenMissing ? (
          <MissingRequest
            id={url.get("request")}
            onClose={() => act.openRequest(undefined)}
          />
        ) : null}

        <div className="flex flex-col gap-3 border-b border-border px-4 pt-3 pb-2.5">
          <div className="flex items-center gap-2">
            <ScopeSwitch
              isManager={isManager}
              canNarrowToOwn={log.canNarrowToOwn}
              scope={log.scope}
              onScope={act.scope}
              ownLabel="Yours"
            />
            <span className="ml-auto">
              <Segmented
                label="Window"
                value={log.time.range}
                onChange={act.range}
                options={windows.map((value) => ({ value, label: value }))}
              />
            </span>
          </div>
          <PhoneChart bars={bars} span={act.span} onSpan={act.setSpan} />
          <WorkspaceBudget spend={log.spend} isFullWidth />
        </div>

        {/* Pinned under the shell's header while the list scrolls, so the
            search, the filters and what they add up to stay in view. */}
        <div className="sticky top-0 z-10 border-b border-border bg-background">
          <div className="flex gap-2 px-4 pt-2.5 pb-2">
            <ActivitySearch
              value={url.get("q")}
              onCommit={act.search}
              placeholder={
                log.isMulti
                  ? "ID, member, source, model"
                  : "Request ID, source, model"
              }
              className="min-w-0 flex-1"
            />
            <Button
              aria-label="Filter and sort"
              onPress={() => onSheetOpen(true)}
              className="min-h-11 shrink-0"
            >
              <FiSliders aria-hidden className="size-3.5" />
              {filterCount ? formatNumber(filterCount) : null}
            </Button>
          </div>
          {filterCount || isSorted ? (
            <div className="flex gap-2 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none]">
              <ActivityChips
                sort={
                  isSorted
                    ? {
                        value: sortLabel,
                        onDismiss: () => act.sort(NEWEST_FIRST),
                      }
                    : undefined
                }
                span={
                  act.span
                    ? {
                        value: describeSpan(act.span.from, act.span.to, barMs),
                        onDismiss: () => act.setSpan(undefined),
                      }
                    : undefined
                }
                chips={chips}
                onClearChip={(chip) => act.refine(chip.clear)}
              />
            </div>
          ) : null}
          <ActivityTotals totals={log.totals} variant="phone" />
        </div>

        {log.isLoadingRows ? (
          <div className="p-6">
            <EmptyMessage>Loading…</EmptyMessage>
          </div>
        ) : log.rows.length ? (
          log.rows.map((entry) => (
            <PhoneRow
              key={entry.id}
              entry={entry}
              member={
                log.isMulti
                  ? log.memberName(entry.user_id, entry.user_alias)
                  : undefined
              }
              onOpen={() => act.openRequest(entry)}
            />
          ))
        ) : (
          <div className="p-6">{empty}</div>
        )}
        {log.hasMore ? (
          <div className="px-4 pt-4 pb-12">
            <Button fullWidth className="h-11" onPress={log.loadMore}>
              Load {PHONE_BATCH} more
            </Button>
          </div>
        ) : (
          <div className="h-10" />
        )}
      </div>

      {/* Over the whole screen, shell included, as a pushed view is. A modal,
          so focus stays in it and the page underneath leaves the tab order. */}
      <Modal
        isOpen={open !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen) act.openRequest(undefined)
        }}
      >
        {/* Driven from state; the trigger slot is filled and hidden, as the
            design system's dialogs do. */}
        <Modal.Trigger aria-hidden className="hidden">
          Request
        </Modal.Trigger>
        <Modal.Backdrop>
          <Modal.Container size="full" className="p-0">
            <Modal.Dialog
              aria-label="Request"
              data-request-view
              className="flex h-dvh flex-col rounded-none bg-surface p-0 pt-[env(safe-area-inset-top)]"
              // HeroUI's full size still caps the width inside a margin, in an
              // unlayered rule no utility can outrank, and a pushed view spans
              // the screen.
              style={{ width: "100%", maxWidth: "none" }}
            >
              <div className="flex h-11 shrink-0 items-center border-b border-border px-2">
                {/* A pushed view's way back: a link's face at the touch floor. */}
                <button
                  type="button"
                  onClick={() => act.openRequest(undefined)}
                  className="flex h-11 items-center gap-0.5 px-2 text-link focus-visible:otari-focus-ring"
                >
                  <FiChevronLeft aria-hidden className="size-[1.125rem]" />
                  Activity
                </button>
              </div>
              {open ? (
                <div className="flex min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
                  <RequestPanel
                    entry={open}
                    isOverlaid
                    position={log.position}
                    memberName={log.memberName}
                    showsMember={log.isMulti}
                    onPrevious={() => act.step(-1)}
                    onNext={() => act.step(1)}
                    onClose={() => act.openRequest(undefined)}
                    onFilter={act.panelFilter}
                    onPriceModel={onPriceModel}
                  />
                </div>
              ) : null}
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {isSheetOpen ? (
        <FilterSheet
          isOpen={isSheetOpen}
          onOpenChange={onSheetOpen}
          sort={sort}
          onSort={act.sort}
          sections={sections}
          onRefine={act.refine}
          cost={cost}
          onCost={(value) =>
            act.refine({ cost_gt: value === undefined ? "" : String(value) })
          }
          count={log.total ?? undefined}
          onReset={chips.length || act.span ? act.clearFilters : undefined}
        />
      ) : null}
    </>
  )
}
