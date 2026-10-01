import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { ChartBar } from "./chartBars"
import { PhoneChart } from "./PhoneChart"

const HOUR = 3_600_000
const START = Date.parse("2026-01-15T00:00:00Z")
const BARS: ChartBar[] = Array.from({ length: 4 }, (_, index) => ({
  start: START + index * HOUR,
  end: START + (index + 1) * HOUR,
  ok: index + 1,
  failed: index === 2 ? 1 : 0,
}))

// Four columns of 100px each, from x = 0.
function slider() {
  const element = screen.getByRole("slider", { name: "Filter by time" })
  element.getBoundingClientRect = () =>
    ({ left: 0, width: 400, top: 0, height: 76 }) as DOMRect
  return element
}

const barSpan = (index: number) => ({
  from: BARS[index].start,
  to: BARS[index].end,
})

describe("PhoneChart", () => {
  it("picks the bar whose column is tapped, gaps included", () => {
    const onSpan = vi.fn()
    render(<PhoneChart bars={BARS} span={undefined} onSpan={onSpan} />)
    fireEvent.pointerDown(slider(), { clientX: 199 })
    fireEvent.pointerUp(slider(), { clientX: 199 })
    expect(onSpan).toHaveBeenCalledWith(barSpan(1))
  })

  it("clears the picked bar when it is tapped again", () => {
    const onSpan = vi.fn()
    render(<PhoneChart bars={BARS} span={barSpan(1)} onSpan={onSpan} />)
    fireEvent.pointerDown(slider(), { clientX: 150 })
    fireEvent.pointerUp(slider(), { clientX: 150 })
    expect(onSpan).toHaveBeenCalledWith(undefined)
  })

  it("reads out the bar under a sliding finger, and applies it on release", () => {
    const onSpan = vi.fn()
    render(<PhoneChart bars={BARS} span={barSpan(1)} onSpan={onSpan} />)
    fireEvent.pointerDown(slider(), { clientX: 150 })
    fireEvent.pointerMove(slider(), { clientX: 250 })
    expect(screen.getByText("02:00–03:00")).toBeInTheDocument()
    expect(screen.getByText("release to filter")).toBeInTheDocument()
    // Back over the picked bar: a slide that ends there keeps it.
    fireEvent.pointerMove(slider(), { clientX: 150 })
    fireEvent.pointerUp(slider(), { clientX: 150 })
    expect(onSpan).toHaveBeenCalledWith(barSpan(1))
  })

  it("steps between bars with the arrow keys", () => {
    const onSpan = vi.fn()
    const { rerender } = render(
      <PhoneChart bars={BARS} span={undefined} onSpan={onSpan} />,
    )
    fireEvent.keyDown(slider(), { key: "ArrowLeft" })
    expect(onSpan).toHaveBeenLastCalledWith(barSpan(2))
    rerender(<PhoneChart bars={BARS} span={barSpan(2)} onSpan={onSpan} />)
    expect(slider()).toHaveAttribute(
      "aria-valuetext",
      "02:00–03:00: 3 succeeded, 1 failed",
    )
    fireEvent.keyDown(slider(), { key: "ArrowRight" })
    expect(onSpan).toHaveBeenLastCalledWith(barSpan(3))
  })
})
