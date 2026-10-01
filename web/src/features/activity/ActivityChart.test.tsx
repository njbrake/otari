import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ActivityChart } from "./ActivityChart"
import type { ChartBar } from "./chartBars"

const HOUR = 3_600_000
const START = Date.parse("2026-01-15T00:00:00Z")
const BARS: ChartBar[] = Array.from({ length: 4 }, (_, index) => ({
  start: START + index * HOUR,
  end: START + (index + 1) * HOUR,
  ok: index,
  failed: index === 2 ? 1 : 0,
}))

function slider() {
  return screen.getByRole("slider", { name: /Filter by time/ })
}

describe("ActivityChart", () => {
  it("scales the axis to the busiest bar", () => {
    render(<ActivityChart bars={BARS} span={undefined} onSpan={vi.fn()} />)
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("picks a stretch from the keyboard: arrows move, Shift extends, Enter applies", () => {
    const onSpan = vi.fn()
    render(<ActivityChart bars={BARS} span={undefined} onSpan={onSpan} />)
    fireEvent.keyDown(slider(), { key: "ArrowLeft" })
    fireEvent.keyDown(slider(), { key: "ArrowLeft", shiftKey: true })
    expect(slider()).toHaveAttribute("aria-valuetext", "01:00–03:00")
    fireEvent.keyDown(slider(), { key: "Enter" })
    expect(onSpan).toHaveBeenCalledWith({
      from: BARS[1].start,
      to: BARS[2].end,
    })
  })

  it("clears the span on Escape", () => {
    const onSpan = vi.fn()
    render(
      <ActivityChart
        bars={BARS}
        span={{ from: BARS[1].start, to: BARS[1].end }}
        onSpan={onSpan}
      />,
    )
    expect(slider()).toHaveAttribute("aria-valuetext", "01:00–02:00")
    fireEvent.keyDown(slider(), { key: "Escape" })
    expect(onSpan).toHaveBeenCalledWith(undefined)
  })

  it("hangs the span's label leftward past the middle, so it stays inside the plot", () => {
    render(
      <ActivityChart
        bars={BARS}
        span={{ from: BARS[3].start, to: BARS[3].end }}
        onSpan={vi.fn()}
      />,
    )
    const label = screen.getByText("03:00–04:00")
    expect(label).toHaveClass("-translate-x-full")
    expect(label).toHaveStyle({ left: "100%" })
  })

  it("keeps an early span's label rightward from its start", () => {
    render(
      <ActivityChart
        bars={BARS}
        span={{ from: BARS[0].start, to: BARS[0].end }}
        onSpan={vi.fn()}
      />,
    )
    const label = screen.getByText("00:00–01:00")
    expect(label).not.toHaveClass("-translate-x-full")
    expect(label).toHaveStyle({ left: "0%" })
  })

  it("hangs the hover tooltip leftward over the later bars", () => {
    render(<ActivityChart bars={BARS} span={undefined} onSpan={vi.fn()} />)
    vi.spyOn(slider(), "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 400,
    } as DOMRect)
    fireEvent.pointerEnter(slider())
    fireEvent.pointerMove(slider(), { clientX: 390 })
    const tooltip = screen.getByText("click to select · drag for a range")
      .parentElement as HTMLElement
    expect(tooltip).toHaveClass("-translate-x-full")

    fireEvent.pointerMove(slider(), { clientX: 10 })
    expect(
      (
        screen.getByText("click to select · drag for a range")
          .parentElement as HTMLElement
      ).className,
    ).not.toContain("-translate-x-full")
  })
})
