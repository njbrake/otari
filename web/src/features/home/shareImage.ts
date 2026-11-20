/**
 * Home's figures and usage chart drawn as a PNG, in the browser alone: the
 * card is painted onto a canvas from the numbers already on the page, so
 * nothing is uploaded, rendered remotely or sent anywhere to make it.
 */

export interface ShareFigure {
  label: string
  value: string
  subline?: string
}

export interface ShareSeries {
  key: string
  label: string
  /** A CSS color, normally a `var(--color-chart-*)` slot. */
  color: string
}

export interface ShareCard {
  title: string
  /** The scope and window under the title. */
  detail: string
  figures: ShareFigure[]
  chart: {
    /** What the bars measure: "Cost by models". */
    title: string
    series: ShareSeries[]
    /** One stack per bucket, values under each series key. */
    bars: Record<string, number>[]
    /** The first and last bucket's names, under the bars' ends. */
    firstLabel: string
    lastLabel: string
    /** The tallest bar's total, as it reads. */
    peakLabel: string
  }
}

export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 675
const PAD = 56
const FIGURES_TOP = 150
const FIGURES_HEIGHT = 110
const CHART_TOP = 310
const CHART_BOTTOM = CARD_HEIGHT - 110
const LEGEND_Y = CARD_HEIGHT - 62

export interface BarRect {
  x: number
  y: number
  width: number
  height: number
  color: string
}

/**
 * Where each segment of each bar lands on the card, bottom up in series
 * order, scaled so the tallest bar fills the plot. Pure, so it is tested
 * without a canvas.
 */
export function barRects(
  chart: Pick<ShareCard["chart"], "series" | "bars">,
  box: { left: number; top: number; width: number; height: number },
): BarRect[] {
  const count = chart.bars.length
  if (count === 0) return []
  const totals = chart.bars.map((bar) =>
    chart.series.reduce((sum, one) => sum + Math.max(0, bar[one.key] ?? 0), 0),
  )
  const peak = Math.max(...totals)
  if (!(peak > 0)) return []
  const slot = box.width / count
  const gap = slot > 6 ? 2 : 0
  const width = Math.max(1, slot - gap)
  const rects: BarRect[] = []
  chart.bars.forEach((bar, index) => {
    let base = box.top + box.height
    for (const one of chart.series) {
      const value = Math.max(0, bar[one.key] ?? 0)
      if (value <= 0) continue
      const height = (value / peak) * box.height
      base -= height
      rects.push({
        x: box.left + index * slot + gap / 2,
        y: base,
        width,
        height,
        color: one.color,
      })
    }
  })
  return rects
}

/** "otari-usage-2026-11-01-to-2026-11-20.png", from the window's ISO bounds. */
export function shareFilename(startIso: string, endIso: string): string {
  const day = (iso: string) => (iso.length >= 10 ? iso.slice(0, 10) : "")
  const from = day(startIso)
  const to = day(endIso)
  if (!from) return "otari-usage.png"
  return !to || from === to
    ? `otari-usage-${from}.png`
    : `otari-usage-${from}-to-${to}.png`
}

/** Whether this page may put an image on the clipboard. */
export function canCopyImages(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  )
}

/**
 * The value a `var(--name)` color stands for on this page: a canvas takes no
 * custom properties, so each is read off the root before it is painted.
 */
function resolveColor(color: string, root: CSSStyleDeclaration): string {
  const match = /^var\((--[\w-]+)\)$/.exec(color.trim())
  if (!match) return color
  return root.getPropertyValue(match[1]).trim() || "gray"
}

/** Text cut to `width` with an ellipsis, as measured in the current font. */
function clipText(
  context: CanvasRenderingContext2D,
  text: string,
  width: number,
) {
  if (context.measureText(text).width <= width) return text
  let cut = text
  while (cut.length > 1 && context.measureText(`${cut}…`).width > width) {
    cut = cut.slice(0, -1)
  }
  return `${cut}…`
}

/** Paints the card onto a canvas `CARD_WIDTH` by `CARD_HEIGHT` logical pixels. */
export function paintCard(
  context: CanvasRenderingContext2D,
  card: ShareCard,
  root: CSSStyleDeclaration,
  fontFamily: string,
): void {
  const color = (token: string) => resolveColor(`var(${token})`, root)
  const ink = color("--color-text") || "black"
  const muted = color("--color-text-subtle") || ink
  const border = color("--color-border-strong") || muted
  const font = (size: number, weight = 400) =>
    `${weight} ${size}px ${fontFamily}`

  context.fillStyle = color("--color-surface") || "white"
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  context.textBaseline = "alphabetic"

  context.fillStyle = ink
  context.font = font(32, 600)
  context.fillText(clipText(context, card.title, CARD_WIDTH - PAD * 2), PAD, 92)
  context.fillStyle = muted
  context.font = font(18)
  context.fillText(
    clipText(context, card.detail, CARD_WIDTH - PAD * 2),
    PAD,
    124,
  )

  const cells = card.figures.slice(0, 5)
  const cellWidth = (CARD_WIDTH - PAD * 2) / Math.max(cells.length, 1)
  cells.forEach((figure, index) => {
    const left = PAD + index * cellWidth
    const width = cellWidth - 24
    context.strokeStyle = border
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(left + 0.5, FIGURES_TOP)
    context.lineTo(left + 0.5, FIGURES_TOP + FIGURES_HEIGHT)
    context.stroke()
    context.fillStyle = muted
    context.font = font(15)
    context.fillText(
      clipText(context, figure.label, width),
      left + 16,
      FIGURES_TOP + 22,
    )
    context.fillStyle = ink
    context.font = font(34, 600)
    context.fillText(
      clipText(context, figure.value, width),
      left + 16,
      FIGURES_TOP + 66,
    )
    if (figure.subline) {
      context.fillStyle = muted
      context.font = font(14)
      context.fillText(
        clipText(context, figure.subline, width),
        left + 16,
        FIGURES_TOP + 94,
      )
    }
  })

  const { chart } = card
  context.fillStyle = ink
  context.font = font(18, 600)
  context.fillText(chart.title, PAD, CHART_TOP - 14)
  context.fillStyle = muted
  context.font = font(14)
  const peak = `Peak ${chart.peakLabel}`
  context.fillText(
    peak,
    CARD_WIDTH - PAD - context.measureText(peak).width,
    CHART_TOP - 14,
  )
  const plot = {
    left: PAD,
    top: CHART_TOP,
    width: CARD_WIDTH - PAD * 2,
    height: CHART_BOTTOM - CHART_TOP,
  }
  for (const rect of barRects(chart, plot)) {
    context.fillStyle = resolveColor(rect.color, root)
    context.fillRect(rect.x, rect.y, rect.width, rect.height)
  }
  context.strokeStyle = border
  context.beginPath()
  context.moveTo(PAD, CHART_BOTTOM + 0.5)
  context.lineTo(CARD_WIDTH - PAD, CHART_BOTTOM + 0.5)
  context.stroke()
  context.fillStyle = muted
  context.font = font(14)
  context.fillText(chart.firstLabel, PAD, CHART_BOTTOM + 22)
  context.fillText(
    chart.lastLabel,
    CARD_WIDTH - PAD - context.measureText(chart.lastLabel).width,
    CHART_BOTTOM + 22,
  )

  let x = PAD
  context.font = font(15)
  for (const one of chart.series) {
    const label = clipText(context, one.label, 200)
    const width = 14 + 8 + context.measureText(label).width + 24
    if (x + width > CARD_WIDTH - PAD) break
    context.fillStyle = resolveColor(one.color, root)
    context.fillRect(x, LEGEND_Y - 11, 12, 12)
    context.fillStyle = ink
    context.fillText(label, x + 20, LEGEND_Y)
    x += width
  }
}

/** The card as a PNG, at twice its logical size for a crisp image. */
export async function renderCard(card: ShareCard): Promise<Blob> {
  const canvas = document.createElement("canvas")
  const ratio = 2
  canvas.width = CARD_WIDTH * ratio
  canvas.height = CARD_HEIGHT * ratio
  const context = canvas.getContext("2d")
  if (!context) throw new Error("This browser cannot draw the image.")
  context.scale(ratio, ratio)
  // Fonts load lazily; one not yet loaded would be painted as a fallback.
  await document.fonts?.ready
  const root = getComputedStyle(document.documentElement)
  const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif"
  paintCard(context, card, root, fontFamily)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("The image could not be encoded."))
    }, "image/png")
  })
}

/** Saves `blob` under `filename` through a link the page clicks itself. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoked after the click has had time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Puts the image on the clipboard; false where the browser refuses. */
export async function copyImage(blob: Blob): Promise<boolean> {
  if (!canCopyImages()) return false
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    return true
  } catch {
    return false
  }
}
