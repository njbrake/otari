import { act, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

// The chart's touch handlers, as the strip hands them to Recharts. jsdom lays
// nothing out, so the test plays Recharts' part: it calls them with the bucket
// a touch is over, as Recharts reads it from the finger's position.
type TouchState = { activeTooltipIndex?: number | null }
type Handlers = {
  onTouchStart: (state: TouchState) => void
  onTouchMove: (state: TouchState) => void
  onTouchEnd: () => void
}
const chart: { handlers?: Handlers } = {}

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    BarChart: (props: Handlers) => {
      chart.handlers = props
      return <div />
    },
  }
})

const { StripChart } = await import("./StripChart")

const DATA = Array.from({ length: 6 }, (_, index) => ({
  x: `2026-11-20T0${index}:00:00Z`,
  requests: index + 1,
  errors: 0,
}))

function renderStrip(phone: boolean) {
  const onSelectRange = vi.fn()
  const onReading = vi.fn()
  render(
    <StripChart
      data={DATA}
      formatTick={(iso) => iso}
      ariaLabel="Requests"
      onSelectRange={onSelectRange}
      onReading={onReading}
      phone={phone}
      loading={false}
      emptyLabel="Nothing"
    />,
  )
  const touch = (type: "start" | "move", index: number | null) =>
    act(() => {
      const state = { activeTooltipIndex: index }
      if (type === "start") chart.handlers?.onTouchStart(state)
      else chart.handlers?.onTouchMove(state)
    })
  const lift = () => act(() => chart.handlers?.onTouchEnd())
  return { onSelectRange, onReading, touch, lift }
}

describe("StripChart on a phone", () => {
  it("reads out the bucket under a sliding finger and picks it on lift", () => {
    const { onSelectRange, onReading, touch, lift } = renderStrip(true)
    // A touch's own start can arrive before the bucket under it is known.
    touch("start", null)
    touch("move", 2)
    expect(onReading).toHaveBeenLastCalledWith({ lo: 2, hi: 2 })
    touch("move", 4)
    expect(onReading).toHaveBeenLastCalledWith({ lo: 4, hi: 4 })
    lift()
    expect(onSelectRange).toHaveBeenCalledExactlyOnceWith(4, 4)
    expect(onReading).toHaveBeenLastCalledWith(null)
  })

  it("picks nothing for a touch that never left its bucket", () => {
    const { onSelectRange, touch, lift } = renderStrip(true)
    touch("start", 3)
    touch("move", 3)
    lift()
    expect(onSelectRange).not.toHaveBeenCalled()
  })

  it("selects the range a slide crosses on a desk", () => {
    const { onSelectRange, touch, lift } = renderStrip(false)
    touch("start", 1)
    touch("move", 2)
    touch("move", 4)
    lift()
    expect(onSelectRange).toHaveBeenCalledExactlyOnceWith(1, 4)
  })
})
