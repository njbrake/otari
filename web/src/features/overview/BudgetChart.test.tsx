import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { BudgetChart } from "./BudgetChart"
import { offeredMonths } from "./overviewQuery"

function renderOn(day: number) {
  const now = new Date(Date.UTC(2026, 9, day, 12))
  const [month] = offeredMonths(now)
  render(
    <BudgetChart
      month={month}
      now={now.getTime()}
      totals={Array.from({ length: day }, (_, index) => (index + 1) * 10)}
      cap={1000}
      marksCrossing
    />,
  )
  return screen.getByText("Today")
}

describe("BudgetChart's today line", () => {
  it("labels the line on its right early in the month", () => {
    const label = renderOn(5)
    expect(label).toHaveClass("left-1.5")
    expect(label).not.toHaveClass("right-1.5")
  })

  // At 320px the label on the right of a line this late ran past the page and
  // let a phone pan sideways, so it moves to the line's left, as the
  // over-budget label already does.
  it("labels the line on its left late in the month", () => {
    const label = renderOn(28)
    expect(label).toHaveClass("right-1.5")
    expect(label).not.toHaveClass("left-1.5")
  })
})
