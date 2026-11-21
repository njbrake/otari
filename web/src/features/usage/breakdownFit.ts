/**
 * The room each "Where it went" column takes at its narrowest, in pixels: the
 * lanes `globals.css` holds open, and the header or widest figure elsewhere.
 */
const COLUMN_WIDTHS: Record<string, number> = {
  name: 180,
  // Its share and what was not charged join it once their lanes give way.
  cost: 150,
  charged: 94,
  not_charged: 110,
  requests: 110,
  tokens: 110,
  failed: 100,
  p95: 88,
  model: 166,
  share: 176,
  limit: 272,
  actions: 64,
}
const OTHER_WIDTH = 100

/**
 * The columns that give way, first to last, when a table has less room than
 * its columns take: the figure derivable from two others, then the
 * descriptive lanes, then the figures, least read first. Anything not listed
 * (the row's name, its spend, its limit, its actions) always shows.
 */
const YIELD_ORDER = [
  "not_charged",
  "model",
  "share",
  "tokens",
  "charged",
  "p95",
  "failed",
  "requests",
] as const

/**
 * Which of `ids` a table `available` pixels wide shows, so it fits without
 * scrolling sideways: every column where there is room (or where the room is
 * not known yet), else without the ones `YIELD_ORDER` gives up first. The
 * column the table is sorted by is kept, so a sort never hides its own lane.
 */
export function fittedColumns(
  ids: readonly string[],
  available: number | undefined,
  {
    keep,
    widths = {},
  }: { keep?: string; widths?: Record<string, number> } = {},
): Set<string> {
  const shown = new Set(ids)
  if (available === undefined) return shown
  const widthOf = (id: string) => widths[id] ?? COLUMN_WIDTHS[id] ?? OTHER_WIDTH
  let total = ids.reduce((sum, id) => sum + widthOf(id), 0)
  for (const id of YIELD_ORDER) {
    if (total <= available) break
    if (id === keep || !shown.has(id)) continue
    shown.delete(id)
    total -= widthOf(id)
  }
  return shown
}
