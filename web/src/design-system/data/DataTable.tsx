import { Spinner, Table } from "@heroui/react"
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Key, Selection, SortDescriptor } from "react-aria-components"
import {
  Button as AriaButton,
  Checkbox as AriaCheckbox,
} from "react-aria-components"
import { createPortal } from "react-dom"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { Checkbox, CheckboxVisual } from "@/design-system/forms/Checkbox"
import { useIsMobile } from "@/design-system/hooks/useIsMobile"

// react-aria's own Checkbox drives table row/all selection through
// `slot="selection"`. HeroUI's Checkbox splits the control across subcomponents
// and does not cleanly forward the selection slot, so the selection box is a
// small styled react-aria Checkbox that matches the --otari tokens.
//
// A row's checkbox stays out of the Tab order: the grid is one tab stop, and a
// tabbable checkbox in every row gave Tab a second stop inside the row it had
// just entered. Space on a focused row still selects it.
function SelectionCheckbox({
  ariaLabel,
  excludeFromTabOrder,
}: {
  ariaLabel: string
  excludeFromTabOrder?: boolean
}) {
  return (
    <AriaCheckbox
      slot="selection"
      aria-label={ariaLabel}
      excludeFromTabOrder={excludeFromTabOrder}
      className="group inline-flex items-center"
    >
      {({ isSelected, isIndeterminate, isDisabled }) => (
        <CheckboxVisual
          isSelected={isSelected}
          isIndeterminate={isIndeterminate}
          isDisabled={isDisabled}
        />
      )}
    </AriaCheckbox>
  )
}

// Shared data table for the dashboard, built on HeroUI v3's compound Table
// (a thin wrapper over react-aria-components). Selection, keyboard grid
// navigation, sort, and column resizing all come from the library, so pages
// declare columns + rows and opt into the behaviors they need rather than
// hand-rolling a <table>. Replaces the previous bespoke table and its custom
// column-resize code.

export interface DataTableColumn<Row> {
  /** Stable column id; also the `SortDescriptor.column` value when sortable. */
  id: string
  header: ReactNode
  cell: (row: Row) => ReactNode
  /** Right-align numeric columns (header and cells). */
  align?: "start" | "end"
  /** Marks the column react-aria announces as the row's header (usually the name). */
  isRowHeader?: boolean
  allowsSorting?: boolean
  /**
   * A control beside the header label, such as a `ColumnFilter`. It keeps its
   * own press, so pressing it never sorts the column, and arrowing onto the
   * header focuses it. A sortable column's label then becomes a button of its
   * own, so the keyboard can still reach the sort. Styled on hover of the
   * header through the `group/column` it sits in. The phone's cards have no
   * header row and leave it out.
   */
  headerAction?: ReactNode
  /**
   * Pixel width. In a resizable table it is the default a drag starts from, and
   * a column without one shares whatever width is left.
   */
  width?: number
  minWidth?: number
  /** The widest a resizable table lets this column be dragged. */
  maxWidth?: number
}

export interface DataTableProps<Row> {
  /** Accessible name for the grid (required by react-aria). */
  ariaLabel: string
  columns: DataTableColumn<Row>[]
  rows: Row[]
  getRowKey: (row: Row) => string
  /** Shows a spinner in place of the body while the first page loads. */
  isLoading?: boolean
  emptyContent?: ReactNode
  selectionMode?: "none" | "multiple"
  selectedKeys?: Selection
  onSelectionChange?: (keys: Selection) => void
  /**
   * Rows that cannot be selected (e.g. enforced usage rows that bulk delete must
   * never touch). `disabledBehavior` is fixed to "selection", so a disabled row
   * still opens its detail on click; only its checkbox is inert.
   */
  disabledKeys?: Iterable<Key>
  sortDescriptor?: SortDescriptor
  onSortChange?: (descriptor: SortDescriptor) => void
  /** Fired when a row body is activated (click / Enter), for detail drill-in. */
  onRowAction?: (key: string) => void
  rowClassName?: (row: Row) => string | undefined
  /** Enables draggable column resize handles. */
  isResizable?: boolean
  /**
   * Pixel widths by column id, over each column's own `width`, for a resizable
   * table whose layout is kept elsewhere. Without it the table keeps what a
   * drag leaves for as long as it is mounted.
   */
  columnWidths?: Record<string, number>
  /**
   * Told the pixel width of every column a drag left sized, once it ends.
   * Columns still sharing the leftover width are not in it.
   */
  onColumnResizeEnd?: (widths: Record<string, number>) => void
  /**
   * Inline detail: when `detailKey` matches a row's key, `renderDetail(row)`
   * renders as a full-width row directly under that row (accordion style), so
   * the panel opens where the user clicked instead of below the table.
   *
   * The detail row is a portal-managed `<tr>` inserted next to the target row,
   * deliberately outside react-aria's collection: putting it in `items` made
   * every expand re-process the whole page of rows (~130 ms at 100 rows,
   * ~490 ms on a throttled CPU), which read as lag. Outside the collection it
   * costs O(1), never joins selection or keyboard navigation, and cannot fire
   * `onRowAction`. Keep `renderDetail` referentially stable like the other
   * render inputs.
   */
  detailKey?: string | null
  renderDetail?: (row: Row) => ReactNode
  /**
   * `"cards"` swaps the grid for one card per row on a phone-width viewport,
   * for a table too wide to read without a sideways scroll.
   */
  mobileLayout?: "table" | "cards"
}

const SELECTION_COLUMN_WIDTH = 44

// How long the optimistic row highlight survives with no panel. Long enough to
// cover the interaction render it stands in for, short enough that a row action
// which opens nothing does not leave a row lit indefinitely.
const DETAIL_OPENING_BACKSTOP_MS = 1500

// How far the pointer may travel between press and release and still count as a
// click. Cells are selectable, so a hand that drifts a pixel across a character
// boundary selects that character; this is the margin that keeps such a click a
// click, and it is far shorter than any deliberate highlight of an id.
const CLICK_SLOP_PX = 5

// Whether the document's text selection is a real (non-empty) one anchored inside
// `root`. A selection made elsewhere on the page is not anchored here.
function hasTextSelectionIn(root: HTMLElement | null): boolean {
  if (!root) return false
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.toString().trim() === "")
    return false
  return selection.anchorNode !== null && root.contains(selection.anchorNode)
}

// HeroUI's Table.Root is itself a card, so `.otari-table` in design-system.css is
// what neutralizes it: no fill, no radius, no padding, no column separators. A
// table is a region of the one surface, bounded by the section rules around it
// and by its own header and row hairlines.
//
// Those are the DEFAULTS, which is newer than it looks. The base used to paint a
// surface fill and a brand-tint header, and each of the sixteen per-table
// classes carried the same three declarations to undo it; the base is now the
// flat treatment and those forty-eight copies are gone. A per-table class
// carries only what is its own: row height, lane widths, its sticky column, its
// outer rules. `src/styles/foundation.test.ts` holds both halves of that.
//
// `overflow: hidden` stays on the root. It no longer clips a corner, but it is
// what keeps a wide table from painting outside the region it was given.

// Anything inside a card that is its own control keeps its own press, so a tap
// on Edit does not also open the card.
const OWN_PRESS =
  "button, a, input, select, textarea, label, [data-card-detail]"

const stopPress = (event: { stopPropagation: () => void }) =>
  event.stopPropagation()

function isSelected(selected: Selection | undefined, key: string): boolean {
  return selected === "all" || (selected?.has(key) ?? false)
}

/**
 * `DataTable`'s phone layout: one card per row. The row-header column is the
 * title, a column with id `actions` sits beside it, and every other column is a
 * label and value pair, so a row keeps its fields and its actions in the width
 * of the screen instead of in a horizontal scroll.
 *
 * Selection, a row action and an inline detail carry over. Sorting and column
 * resize do not: a phone has no header row to hang them on.
 */
function DataCardList<Row extends object>({
  ariaLabel,
  columns,
  rows,
  getRowKey,
  isLoading,
  emptyContent,
  showSelection,
  selectedKeys,
  onSelectionChange,
  disabledKeys,
  onRowAction,
  rowClassName,
  detailKey,
  renderDetail,
}: {
  ariaLabel: string
  columns: DataTableColumn<Row>[]
  rows: Row[]
  getRowKey: (row: Row) => string
  isLoading: boolean
  emptyContent: ReactNode
  showSelection: boolean
  selectedKeys?: Selection
  onSelectionChange?: (keys: Selection) => void
  disabledKeys?: Iterable<Key>
  onRowAction?: (key: string) => void
  rowClassName?: (row: Row) => string | undefined
  detailKey: string | null
  renderDetail?: (row: Row) => ReactNode
}) {
  const title = columns.find((col) => col.isRowHeader) ?? columns[0]
  const actions = columns.find((col) => col.id === "actions")
  const fields = columns.filter((col) => col !== title && col !== actions)
  const disabled = new Set(Array.from(disabledKeys ?? [], String))
  const selectable = rows.map(getRowKey).filter((key) => !disabled.has(key))
  const selectedCount = selectable.filter((key) =>
    isSelected(selectedKeys, key),
  ).length

  const toggle = (key: string, checked: boolean) => {
    const next = new Set<Key>(
      selectedKeys === "all" ? selectable : (selectedKeys ?? []),
    )
    if (checked) next.add(key)
    else next.delete(key)
    onSelectionChange?.(next)
  }

  if (rows.length === 0) {
    return (
      <section aria-label={ariaLabel}>
        <EmptyMessage>
          {isLoading ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size="sm" aria-hidden="true" /> Loading…
            </span>
          ) : (
            emptyContent
          )}
        </EmptyMessage>
      </section>
    )
  }

  return (
    <section aria-label={ariaLabel}>
      {showSelection ? (
        <div className="flex min-h-11 items-center border-b border-border-subtle">
          <Checkbox
            hasTouchTarget
            ariaLabel="Select all rows"
            isSelected={
              selectable.length > 0 && selectedCount === selectable.length
            }
            onChange={(checked) => {
              const next = new Set<Key>(
                selectedKeys === "all" ? [] : (selectedKeys ?? []),
              )
              for (const key of selectable) {
                if (checked) next.add(key)
                else next.delete(key)
              }
              onSelectionChange?.(next)
            }}
          >
            <span className="sr-only">Select all rows</span>
          </Checkbox>
          <span className="text-caption">
            {selectedCount > 0
              ? `${selectedCount} selected`
              : `${rows.length} ${rows.length === 1 ? "row" : "rows"}`}
          </span>
        </div>
      ) : null}
      <ul className="flex flex-col">
        {rows.map((row) => {
          const key = getRowKey(row)
          const open = detailKey === key && renderDetail != null
          const picked = isSelected(selectedKeys, key)
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the button below is the keyboard and screen-reader path; the card tap is a pointer shortcut
            <li
              key={key}
              data-key={key}
              onClick={
                onRowAction
                  ? (event: ReactMouseEvent<HTMLLIElement>) => {
                      if (
                        !(event.target as Element).closest(OWN_PRESS) &&
                        !hasTextSelectionIn(event.currentTarget)
                      )
                        onRowAction(key)
                    }
                  : undefined
              }
              className={[
                "flex flex-col gap-2 border-b border-border-subtle py-3",
                onRowAction ? "cursor-pointer" : null,
                picked ? "bg-primary-subtle" : null,
                rowClassName?.(row),
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="flex items-start gap-2">
                {showSelection ? (
                  <div className="flex min-h-11 shrink-0 items-center">
                    <Checkbox
                      hasTouchTarget
                      ariaLabel="Select row"
                      isSelected={picked}
                      isDisabled={disabled.has(key)}
                      onChange={(checked) => toggle(key, checked)}
                    >
                      <span className="sr-only">Select row</span>
                    </Checkbox>
                  </div>
                ) : null}
                <div className="flex min-h-11 min-w-0 flex-1 items-center">
                  {/* A long unbroken name (a domain, an id) wraps rather than
                      running under the actions beside it. */}
                  <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    {title.cell(row)}
                  </div>
                </div>
                {/* The title's 44px line, so a 32px row action centers on
                    the title. */}
                {actions ? (
                  <div className="flex min-h-11 shrink-0 items-center">
                    {actions.cell(row)}
                  </div>
                ) : null}
              </div>
              {fields.length > 0 ? (
                <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                  {fields.map((col) => (
                    <div
                      key={col.id}
                      className="col-span-2 grid grid-cols-subgrid items-baseline"
                    >
                      <dt className="text-overline">{col.header}</dt>
                      <dd className="min-w-0 text-sm">
                        {/* Shrunk to its content, so an end-aligned figure starts
                            in the value lane with the others and keeps its own
                            lines aligned to each other. */}
                        {col.align === "end" ? (
                          <div className="w-fit max-w-full">
                            {col.cell(row)}
                          </div>
                        ) : (
                          col.cell(row)
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {onRowAction ? (
                <button
                  type="button"
                  aria-expanded={renderDetail ? open : undefined}
                  className="sr-only focus-visible:not-sr-only focus-visible:text-caption"
                  onClick={() => onRowAction(key)}
                >
                  {renderDetail
                    ? open
                      ? "Hide details"
                      : "Show details"
                    : "Open"}
                </button>
              ) : null}
              {open ? <div data-card-detail>{renderDetail(row)}</div> : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function DataTable<Row extends object>(props: DataTableProps<Row>) {
  const isMobile = useIsMobile()
  if (props.mobileLayout === "cards" && isMobile) {
    return (
      <DataCardList
        ariaLabel={props.ariaLabel}
        columns={props.columns}
        rows={props.rows}
        getRowKey={props.getRowKey}
        isLoading={props.isLoading ?? false}
        emptyContent={props.emptyContent ?? "No rows."}
        showSelection={props.selectionMode === "multiple"}
        selectedKeys={props.selectedKeys}
        onSelectionChange={props.onSelectionChange}
        disabledKeys={props.disabledKeys}
        onRowAction={props.onRowAction}
        rowClassName={props.rowClassName}
        detailKey={props.detailKey ?? null}
        renderDetail={props.renderDetail}
      />
    )
  }
  return <DataTableGrid {...props} />
}

function DataTableGrid<Row extends object>({
  ariaLabel,
  columns,
  rows,
  getRowKey,
  isLoading = false,
  emptyContent = "No rows.",
  selectionMode = "none",
  selectedKeys,
  onSelectionChange,
  disabledKeys,
  sortDescriptor,
  onSortChange,
  onRowAction,
  rowClassName,
  isResizable = false,
  columnWidths,
  onColumnResizeEnd,
  detailKey = null,
  renderDetail,
}: DataTableProps<Row>) {
  const showSelection = selectionMode === "multiple"
  const Container = isResizable
    ? Table.ResizableContainer
    : Table.ScrollContainer
  const columnCount = columns.length + (showSelection ? 1 : 0)

  // While a drag runs, the widths it reports; once it ends, the caller's
  // (`columnWidths`), or this table's own when the caller keeps none. Widths
  // are controlled throughout, so the row cache is never rebuilt by a drag.
  const [dragWidths, setDragWidths] = useState<Record<string, number> | null>(
    null,
  )
  const [ownWidths, setOwnWidths] = useState<Record<string, number>>({})
  const widths = dragWidths ?? columnWidths ?? ownWidths
  const columnIds = new Set(columns.map((col) => col.id))
  const pixelWidths = (map: Map<Key, unknown>) => {
    const out: Record<string, number> = {}
    for (const [key, width] of map) {
      if (typeof width === "number" && columnIds.has(String(key)))
        out[String(key)] = width
    }
    return out
  }
  const resizeProps = isResizable
    ? {
        onResize: (map: Map<Key, unknown>) => setDragWidths(pixelWidths(map)),
        onResizeEnd: (map: Map<Key, unknown>) => {
          const ended = pixelWidths(map)
          setDragWidths(null)
          setOwnWidths(ended)
          onColumnResizeEnd?.(ended)
        },
      }
    : {}
  // Where each column starts, as `--table-column-start-<id>`, for a stylesheet
  // that pins a column: the offset follows a drag and a hidden column. Only
  // as far as every column before it has a pixel width.
  const columnStarts: Record<string, string> = {}
  if (isResizable) {
    let start: number | undefined = showSelection ? SELECTION_COLUMN_WIDTH : 0
    for (const col of columns) {
      if (start === undefined) break
      columnStarts[`--table-column-start-${col.id}`] = `${start}px`
      const width = widths[col.id] ?? col.width
      start = width === undefined ? undefined : start + width
    }
  }

  const rootRef = useRef<HTMLDivElement | null>(null)

  // The grid is as wide as its columns, so the empty message needs the visible
  // width to center in.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const sync = () =>
      root.style.setProperty("--table-viewport-width", `${root.clientWidth}px`)
    sync()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(sync)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])
  const [detailHost, setDetailHost] = useState<HTMLTableCellElement | null>(
    null,
  )
  const detailRow = useMemo(
    () =>
      detailKey != null && renderDetail
        ? (rows.find((row) => getRowKey(row) === detailKey) ?? null)
        : null,
    [detailKey, renderDetail, rows, getRowKey],
  )

  // The portal host, built once per table and reused. Identity has to survive
  // the effect below re-running, which it does on every row change: a fresh
  // element each time re-points the portal, and React answers that by
  // unmounting the panel and mounting it again into the new node. That replays
  // the reveal animation and throws away whatever state the panel held. The
  // activity page once rebuilt its rows array every two seconds, from a poll for
  // requests in flight, and an expanded row sat there flashing and re-opening on
  // a timer for as long as one was running. Any caller that re-derives its rows
  // on a timer would do the same.
  const hostRef = useRef<{
    row: HTMLTableRowElement
    cell: HTMLTableCellElement
  } | null>(null)
  // Stable identity: it only reads and writes a ref, so the effect below can
  // list it without re-running on every render.
  // Which row currently wears the optimistic highlight, and the backstop that
  // takes it off. The key rather than the element: a closure holding the <tr>
  // keeps a detached node alive for the length of the window when the table
  // filters or repaginates under it.
  const opening = useRef<
    { key: string; backstop: ReturnType<typeof setTimeout> } | undefined
  >(undefined)

  /** Take the highlight off whichever row has it, and cancel its backstop. */
  const clearOpening = useCallback(() => {
    const current = opening.current
    if (!current) return
    opening.current = undefined
    clearTimeout(current.backstop)
    rootRef.current
      ?.querySelector(`tbody tr[data-key="${CSS.escape(current.key)}"]`)
      ?.classList.remove("otari-detail-opening")
  }, [])

  useEffect(() => clearOpening, [clearOpening])

  const ensureHost = useCallback(() => {
    if (!hostRef.current) {
      const row = document.createElement("tr")
      row.className = "otari-detail-row"
      // Out of the grid semantics: without this the host is an implicit ARIA row
      // with the detail text as its name, confusing row counts and name lookups.
      // Its content stays in the accessibility tree as ordinary elements.
      row.setAttribute("role", "presentation")
      const cell = document.createElement("td")
      row.appendChild(cell)
      hostRef.current = { row, cell }
    }
    return hostRef.current
  }, [])

  // Host <tr> management: find the target row by its data-key and position the
  // host right after it. react-aria commits its real rows in a second render
  // pass, so the target may not exist yet when this effect first runs (e.g.
  // mounting with a detailKey already set); the MutationObserver finishes the
  // insertion as soon as the row appears. The deps re-run it (re-positioning
  // the host) whenever the row set, order, or target changes, and the host is
  // detached as soon as there is no target to sit under, so a vanished target
  // (filtered out, page flipped) leaves nothing behind.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows and sortDescriptor are the re-run triggers described above, not values read here
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || detailKey == null || !detailRow) {
      hostRef.current?.row.remove()
      setDetailHost(null)
      return
    }
    const { row: hostRow, cell: hostCell } = ensureHost()
    hostCell.colSpan = columnCount

    const tryInsert = (): boolean => {
      const target = root.querySelector(
        `tbody tr[data-key="${CSS.escape(detailKey)}"]`,
      )
      if (!target) return false
      // The optimistic highlight has served its purpose once the panel lands.
      clearOpening()
      // Only move it when it is not already there. Re-inserting an attached
      // node detaches and re-attaches its subtree, which cancels and restarts
      // the reveal animation running inside it.
      if (target.nextSibling !== hostRow) target.after(hostRow)
      setDetailHost(hostCell)
      return true
    }

    let observer: MutationObserver | null = null
    if (!tryInsert()) {
      observer = new MutationObserver(() => {
        if (tryInsert()) {
          observer?.disconnect()
          observer = null
        }
      })
      observer.observe(root, { childList: true, subtree: true })
    }
    return () => observer?.disconnect()
  }, [
    detailKey,
    detailRow,
    columnCount,
    rows,
    sortDescriptor,
    ensureHost,
    clearOpening,
  ])

  // Detach on unmount. Deliberately not part of the effect above, whose cleanup
  // runs on every dependency change: removing the host there is what made a
  // re-render remount the panel.
  useEffect(() => () => hostRef.current?.row.remove(), [])

  // Row activation with instant acknowledgment: the detail panel can only land
  // after react-aria's O(rows) interaction render (~1.6 ms/row), so the clicked
  // row is highlighted in the same frame; the insert effect clears the class
  // when the panel arrives, with a timeout backstop.
  const fireRowAction = useCallback(
    (key: string) => {
      if (!onRowAction) return
      if (renderDetail && key !== detailKey) {
        clearOpening()
        const target = rootRef.current?.querySelector(
          `tbody tr[data-key="${CSS.escape(key)}"]`,
        )
        // Written to the DOM rather than held in state on purpose: a state
        // update would be queued behind the same O(rows) render this is here to
        // cover, so the acknowledgment would arrive with the panel it stands in
        // for.
        target?.classList.add("otari-detail-opening")
        opening.current = {
          key,
          backstop: setTimeout(clearOpening, DETAIL_OPENING_BACKSTOP_MS),
        }
      }
      onRowAction(key)
    },
    [onRowAction, renderDetail, detailKey, clearOpening],
  )

  // The row key an event activates, or null when the event belongs to something
  // else: buttons, links, inputs, and the detail panel pass through untouched. A
  // row's checkbox passes a pointer through, which toggles it, but not Enter,
  // which a checkbox has no use for. Only meaningful for tables with a row action.
  const activatedRowKey = useCallback(
    (
      target: EventTarget | null,
      via: "pointer" | "keyboard",
    ): string | null => {
      if (!onRowAction || !(target instanceof Element)) return null
      const control = target.closest(
        "label[slot=selection], button, a, input, select, textarea, .otari-detail-row",
      )
      const isRowCheckbox =
        control?.closest("tbody label[slot=selection]") != null
      if (control && !(via === "keyboard" && isRowCheckbox)) return null
      return (
        target.closest("tbody tr[data-key]")?.getAttribute("data-key") ?? null
      )
    },
    [onRowAction],
  )

  // Where rows have a drill-in action, this component owns activation on data
  // cells instead of react-aria's row press, for three reasons:
  //
  //   1. Its toggle selection behavior stops activating rows once the selection
  //      is non-empty (useSelectableItem's hasPrimaryAction requires an empty
  //      selection manager): a click extends the selection instead, and Enter
  //      does nothing at all. Here the checkbox owns selection and a row keeps
  //      opening its drill-in by click or Enter (the Gmail convention).
  //   2. The press toggles selection on pointer *down*, and the re-render that
  //      causes lands mid-drag and discards a nascent text selection, so no id in
  //      a row could be highlighted by hand (issue #478).
  //   3. Taking the whole sequence keeps the action firing exactly once:
  //      react-aria never sees a press to fire it a second time.
  //
  // Tables with no row action keep react-aria's press as-is; there, only a
  // CopyableValue (which stops the press on itself) is drag-selectable.
  const pressOrigin = useRef<{ x: number; y: number } | undefined>(undefined)

  const startPress = (event: ReactPointerEvent | ReactMouseEvent) => {
    if (activatedRowKey(event.target, "pointer") == null) return
    // react-aria falls back to mouse events where PointerEvent is unavailable,
    // so both are stopped; the press (and its selection toggle) starts there.
    event.stopPropagation()
    pressOrigin.current = { x: event.clientX, y: event.clientY }
  }

  // Rows render through react-aria's items-collection path so each row element
  // is cached per row object: a selection toggle re-renders only the affected
  // row instead of the whole page of rows (which made checkbox clicks lag by
  // whole seconds at large page sizes). The cache is invalidated when any input
  // that changes row rendering does (the `dependencies` on Table.Body below),
  // so callers must keep `columns`, `getRowKey`, and `rowClassName` (if used)
  // referentially stable across unrelated re-renders for the cache to pay off;
  // an inline arrow for any of them rebuilds every row on each render.
  // A boolean, not `onRowAction` itself: every caller passes an inline arrow, and
  // depending on its identity would rebuild the row cache below on each render.
  const hasRowAction = onRowAction != null

  const renderRow = useCallback(
    (row: Row) => {
      const key = getRowKey(row)
      // A row with a drill-in action takes the pointer cursor. The base rule in
      // `globals.css` cannot reach it: nothing in the markup tells a row that
      // opens something from one that is inert.
      const className =
        [hasRowAction ? "cursor-pointer" : null, rowClassName?.(row)]
          .filter(Boolean)
          .join(" ") || undefined
      return (
        <Table.Row key={key} id={key} className={className}>
          {showSelection ? (
            <Table.Cell>
              <SelectionCheckbox ariaLabel="Select row" excludeFromTabOrder />
            </Table.Cell>
          ) : null}
          {/* A body cell's `data-key` is a generated collection key, unlike its
              header's, so `data-column` is what lets a stylesheet name its
              column. */}
          {columns.map((col) => (
            <Table.Cell
              key={col.id}
              data-column={col.id}
              className={
                col.align === "end" ? "text-right tabular-nums" : undefined
              }
            >
              {col.cell(row)}
            </Table.Cell>
          ))}
        </Table.Row>
      )
    },
    [getRowKey, rowClassName, showSelection, columns, hasRowAction],
  )

  return (
    <Table.Root
      ref={rootRef}
      className="otari-table"
      style={isResizable ? (columnStarts as CSSProperties) : undefined}
    >
      <Container
        {...resizeProps}
        className="overflow-x-auto"
        onPointerDownCapture={startPress}
        onMouseDownCapture={startPress}
        onClickCapture={(event: ReactMouseEvent) => {
          const key = activatedRowKey(event.target, "pointer")
          if (key == null) return
          // Swallowed either way, so react-aria's row press never fires a second
          // action. A click that ended a text drag inside the table is a
          // selection, not an activation: cells are selectable by design (see
          // design-system.css), and drilling in mid-highlight both loses the
          // selection and moves the page under the operator. A drag is a press
          // that travelled, or a double or triple click selecting a word or a
          // line; the selection alone does not say, since a click that wobbles
          // across a character boundary selects that character too.
          event.stopPropagation()
          const origin = pressOrigin.current
          pressOrigin.current = undefined
          const travelled =
            origin != null &&
            Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
              CLICK_SLOP_PX
          const dragged = travelled || event.detail > 1
          if (!(dragged && hasTextSelectionIn(rootRef.current)))
            fireRowAction(key)
        }}
        onKeyDownCapture={(event: ReactKeyboardEvent) => {
          // Enter opens the row from the row, any of its cells, or its checkbox,
          // whatever is selected. No selection check here: Enter is deliberate
          // even with an id still highlighted.
          if (
            event.key !== "Enter" ||
            event.repeat ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return
          const key = activatedRowKey(event.target, "keyboard")
          if (key == null) return
          event.preventDefault()
          event.stopPropagation()
          fireRowAction(key)
        }}
      >
        <Table.Content
          aria-label={ariaLabel}
          className="w-full text-sm"
          selectionMode={selectionMode}
          selectionBehavior="toggle"
          disabledBehavior="selection"
          selectedKeys={selectedKeys}
          onSelectionChange={onSelectionChange}
          disabledKeys={disabledKeys}
          sortDescriptor={sortDescriptor}
          onSortChange={onSortChange}
          onRowAction={
            onRowAction ? (key) => fireRowAction(String(key)) : undefined
          }
        >
          <Table.Header>
            {showSelection ? (
              <Table.Column
                width={SELECTION_COLUMN_WIDTH}
                minWidth={SELECTION_COLUMN_WIDTH}
              >
                <SelectionCheckbox ariaLabel="Select all rows" />
              </Table.Column>
            ) : null}
            {columns.map((col) => (
              <Table.Column
                key={col.id}
                id={col.id}
                isRowHeader={col.isRowHeader}
                allowsSorting={col.allowsSorting}
                width={widths[col.id] ?? col.width}
                minWidth={col.minWidth}
                maxWidth={col.maxWidth}
                className={`group/column${col.align === "end" ? " text-right" : ""}`}
              >
                {({ sortDirection }) => (
                  <div
                    className={`flex items-center gap-1 ${col.align === "end" ? "justify-end" : ""}`}
                  >
                    {col.allowsSorting && col.headerAction ? (
                      // A header with a control in it focuses that control, so
                      // the sort is a button of its own beside it. Its press
                      // does what the header's would: the other direction on
                      // the sorted column, ascending on any other.
                      <AriaButton
                        className="cursor-pointer text-inherit outline-none data-[focus-visible]:otari-focus-ring"
                        onPress={() =>
                          onSortChange?.({
                            column: col.id,
                            direction:
                              sortDescriptor?.column === col.id &&
                              sortDescriptor.direction === "ascending"
                                ? "descending"
                                : "ascending",
                          })
                        }
                      >
                        <Table.SortableColumnHeader
                          sortDirection={sortDirection}
                        >
                          {col.header}
                        </Table.SortableColumnHeader>
                      </AriaButton>
                    ) : col.allowsSorting ? (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {col.header}
                      </Table.SortableColumnHeader>
                    ) : (
                      <span>{col.header}</span>
                    )}
                    {col.headerAction ? (
                      // A press inside stays inside: without this a control
                      // that is not a react-aria pressable would also sort.
                      // Arrow keys still bubble, so the grid can leave it.
                      // biome-ignore lint/a11y/noStaticElementInteractions: stops events from the control inside, which is the interactive element
                      <span
                        className="inline-flex shrink-0"
                        onPointerDown={stopPress}
                        onMouseDown={stopPress}
                        onClick={stopPress}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ")
                            event.stopPropagation()
                        }}
                      >
                        {col.headerAction}
                      </span>
                    ) : null}
                    {isResizable ? (
                      // react-aria names the handle by this and by the
                      // header it sits in, so "Resize" reads "Resize Cost".
                      <Table.ColumnResizer
                        aria-label="Resize"
                        className="ml-auto cursor-col-resize px-1"
                      />
                    ) : null}
                  </div>
                )}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body
            items={isLoading && rows.length === 0 ? [] : rows}
            dependencies={[renderRow]}
            renderEmptyState={() => (
              <div className="sticky left-0 w-[var(--table-viewport-width,100%)]">
                <EmptyMessage>
                  {isLoading ? (
                    <span className="inline-flex items-center gap-2">
                      {/* Decorative beside its own label: HeroUI's spinner is a
                          role="status" region announcing "Loading" on its own. */}
                      <Spinner size="sm" aria-hidden="true" /> Loading…
                    </span>
                  ) : (
                    emptyContent
                  )}
                </EmptyMessage>
              </div>
            )}
          >
            {renderRow}
          </Table.Body>
        </Table.Content>
      </Container>
      {detailHost && detailRow && renderDetail
        ? createPortal(
            // Keyed by the row it belongs to. The host node is stable now, so
            // without this the panel would be reconciled across a jump from one
            // row to another and keep the previous row's state (RouterReadiness
            // seeds its user picker from its props once, at mount). A poll that
            // rebuilds `rows` leaves detailKey alone, so the fix above still
            // holds: only a different row remounts, which is also what replays
            // the reveal animation under the newly opened row.
            <div key={detailKey} className="otari-detail-reveal">
              <div>{renderDetail(detailRow)}</div>
            </div>,
            detailHost,
          )
        : null}
    </Table.Root>
  )
}
