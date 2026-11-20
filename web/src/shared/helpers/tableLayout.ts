/**
 * A table's column layout as a person left it: the widths they dragged and the
 * columns they hid. Stored on the server as the dashboard's own document, so
 * anything read back is checked here before a table is given it.
 */

/** One column a table offers to size and hide. */
export interface TableLayoutColumn {
  id: string
  /** What the Columns control calls it. */
  label: string
  /** The row's identity and its actions are always shown. */
  isHideable: boolean
  /** Its default width in pixels, or none for a column that shares what is left. */
  width?: number
  minWidth: number
  maxWidth?: number
}

export interface TableLayout {
  /** Pixel widths by column id, only for the columns a person sized. */
  widths: Record<string, number>
  /** Hidden column ids, in the table's column order. */
  hidden: string[]
}

/** The version of the stored document this build writes and reads. */
export const TABLE_LAYOUT_VERSION = 1
/** The widest any column may be dragged, whatever it declares. */
export const MAX_COLUMN_WIDTH = 1200

export const DEFAULT_TABLE_LAYOUT: TableLayout = { widths: {}, hidden: [] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** `width` held to what `column` allows, in whole pixels. */
export function clampWidth(column: TableLayoutColumn, width: number): number {
  const max = Math.min(column.maxWidth ?? MAX_COLUMN_WIDTH, MAX_COLUMN_WIDTH)
  return Math.round(Math.min(max, Math.max(column.minWidth, width)))
}

/** The widths in `widths` that name a column of `columns`, each clamped to its bounds. */
export function sanitizeWidths(
  widths: Record<string, unknown>,
  columns: readonly TableLayoutColumn[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const column of columns) {
    const width = widths[column.id]
    if (typeof width === "number" && Number.isFinite(width)) {
      out[column.id] = clampWidth(column, width)
    }
  }
  return out
}

/**
 * `widths` without the ones still at their column's default, so a later change
 * to a default reaches someone who never sized that column.
 */
export function withoutDefaultWidths(
  widths: Record<string, number>,
  columns: readonly TableLayoutColumn[],
): Record<string, number> {
  const defaults = new Map(columns.map((column) => [column.id, column.width]))
  return Object.fromEntries(
    Object.entries(widths).filter(([id, width]) => defaults.get(id) !== width),
  )
}

/**
 * The layout a stored document describes, for these columns.
 *
 * Anything it cannot use is dropped rather than refused: a column this build no
 * longer has, a width that is not a number, a hidden column that may not be
 * hidden. A document of another version, or none, is the default layout.
 */
export function readTableLayout(
  value: unknown,
  columns: readonly TableLayoutColumn[],
): TableLayout {
  if (!isRecord(value) || value.version !== TABLE_LAYOUT_VERSION) {
    return DEFAULT_TABLE_LAYOUT
  }
  const widths = isRecord(value.widths)
    ? sanitizeWidths(value.widths, columns)
    : {}
  const hiddenIds = new Set(
    Array.isArray(value.hidden)
      ? value.hidden.filter((id): id is string => typeof id === "string")
      : [],
  )
  const hidden = columns
    .filter((column) => column.isHideable && hiddenIds.has(column.id))
    .map((column) => column.id)
  return { widths, hidden }
}

/** The document a layout is stored as. */
export function tableLayoutDocument(layout: TableLayout) {
  return {
    version: TABLE_LAYOUT_VERSION,
    widths: layout.widths,
    hidden: layout.hidden,
  }
}

/** Whether a layout differs from the default one. */
export const isCustomLayout = (layout: TableLayout) =>
  layout.hidden.length > 0 || Object.keys(layout.widths).length > 0
