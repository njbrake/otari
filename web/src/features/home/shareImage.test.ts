import { describe, expect, it } from "vitest"
import { shareCardOf } from "@/features/home/shareCard"
import { barRects, shareFilename } from "@/features/home/shareImage"
import { customWindow } from "@/features/spend/period"

const BOX = { left: 0, top: 0, width: 100, height: 50 }

describe("barRects", () => {
  const series = [
    { key: "a", label: "A", color: "var(--color-chart-cat-1)" },
    { key: "b", label: "B", color: "var(--color-chart-cat-2)" },
  ]

  it("stacks each bar bottom up, the tallest filling the plot", () => {
    const rects = barRects(
      {
        series,
        bars: [
          { a: 1, b: 1 },
          { a: 4, b: 0 },
        ],
      },
      BOX,
    )
    expect(rects).toEqual([
      { x: 1, y: 37.5, width: 48, height: 12.5, color: series[0].color },
      { x: 1, y: 25, width: 48, height: 12.5, color: series[1].color },
      { x: 51, y: 0, width: 48, height: 50, color: series[0].color },
    ])
  })

  it("draws nothing for a window with nothing in it", () => {
    expect(barRects({ series, bars: [{ a: 0 }, {}] }, BOX)).toEqual([])
    expect(barRects({ series, bars: [] }, BOX)).toEqual([])
  })
})

describe("shareFilename", () => {
  it("names the file for the window it shows", () => {
    expect(
      shareFilename("2026-11-01T04:00:00.000Z", "2026-11-20T18:00:00.000Z"),
    ).toBe("otari-usage-2026-11-01-to-2026-11-20.png")
    expect(shareFilename("2026-11-20T00:00:00Z", "2026-11-20T09:00:00Z")).toBe(
      "otari-usage-2026-11-20.png",
    )
    expect(shareFilename("", "")).toBe("otari-usage.png")
  })
})

describe("shareCardOf", () => {
  it("carries the page's figures and the chart's bars, and drops unread figures", () => {
    const window = customWindow(
      "2026-11-01T00:00:00Z",
      "2026-11-04T00:00:00Z",
      Date.parse("2026-11-20T00:00:00Z"),
    )!
    const card = shareCardOf({
      scope: "All workspaces",
      window,
      metric: "cost",
      cutLabel: "models",
      figures: [
        { label: "Spent", value: "$12.00" },
        { label: "Tokens", value: "—" },
      ],
      chart: {
        series: [{ key: "g0", label: "gpt", color: "red" }],
        points: [
          { x: "2026-11-01T00:00:00.000Z", g0: 2 },
          { x: "2026-11-02T00:00:00.000Z", g0: 10 },
        ],
      },
    })
    expect(card.title).toBe(`Usage, ${window.label}`)
    expect(card.figures).toEqual([{ label: "Spent", value: "$12.00" }])
    expect(card.chart).toMatchObject({
      title: "Cost per day by models",
      bars: [{ g0: 2 }, { g0: 10 }],
      firstLabel: "Nov 1",
      lastLabel: "Nov 2",
      peakLabel: "$10.00",
    })
  })
})
