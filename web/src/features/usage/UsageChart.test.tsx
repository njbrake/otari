import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { UsageChart } from "./UsageChart"

const HOUR = 3_600_000
const START = Date.parse("2026-01-15T00:00:00Z")

describe("UsageChart", () => {
  it("sets each axis label under the middle of the bar it names", () => {
    // A day of hour bars, labeled every third: the last label names 21:00
    // and belongs under that bar, not at the plot's end.
    render(
      <UsageChart
        starts={Array.from({ length: 24 }, (_, index) => START + index * HOUR)}
        barMs={HOUR}
        folded={{ series: [], points: [], colorOf: () => "" }}
        formatValue={String}
        axisFor={() => ({ top: 1, format: String })}
        span={undefined}
        onSpan={vi.fn()}
      />,
    )
    expect(screen.getByText("21:00")).toHaveStyle({
      left: `${(21.5 / 24) * 100}%`,
      transform: `translateX(-${(21.5 / 24) * 100}%)`,
    })
    expect(screen.getByText("00:00")).toHaveStyle({
      left: `${(0.5 / 24) * 100}%`,
    })
    expect(screen.queryByText("23:00")).toBeNull()
  })
})
