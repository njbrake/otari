import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { BudgetChart, stepDay } from "@/features/home/BudgetChart"
import { monthAt } from "@/features/home/budgetMonth"

const at = (iso: string) => Date.parse(iso)

function renderChart({
  now = at("2026-11-04T00:00:00Z"),
  totals = [10, 20, 30, 30],
  cap = 125 as number | null,
  month = monthAt(2026, 10, now),
} = {}) {
  return render(
    <BudgetChart
      month={month}
      now={now}
      totals={totals}
      cap={cap ?? undefined}
      capLabel="Team budget"
      spendLabel="Charged so far"
    />,
  )
}

describe("BudgetChart", () => {
  it("draws the budget, today, and the day the pace crosses it", () => {
    renderChart()
    expect(screen.getByText("Team budget $125.00")).toBeInTheDocument()
    expect(screen.getByText("Today")).toBeInTheDocument()
    expect(screen.getByText("Over budget ~Nov 13")).toBeInTheDocument()
    expect(screen.getByText("Projected at this month's pace")).toBeVisible()
    expect(
      screen.getByRole("slider", {
        name: /Charged spend in November 2026, running total, against the \$125\.00 team budget/,
      }),
    ).toBeVisible()
  })

  it("says a crossing that has happened without a tilde", () => {
    renderChart({ totals: [10, 80, 130, 130], cap: 100 })
    expect(screen.getByText("Over budget Nov 3")).toBeInTheDocument()
  })

  it("reads a day out with the arrow keys, into the projected days", async () => {
    const user = userEvent.setup()
    renderChart()
    const slider = screen.getByRole("slider")
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Nov 4: Charged so far $30.00",
    )
    await user.click(slider)
    await user.keyboard("{ArrowLeft}")
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Nov 3: Charged so far $30.00",
    )
    await user.keyboard("{ArrowRight}{ArrowRight}")
    expect(slider).toHaveAttribute(
      "aria-valuetext",
      "Nov 5, projected: Projected $50.00",
    )
    await user.keyboard("{End}")
    expect(slider).toHaveAttribute("aria-valuenow", "30")
  })

  it("measures a past month against today's budget, with no projection or today", () => {
    const now = at("2026-11-04T00:00:00Z")
    const month = monthAt(2026, 9, now)
    renderChart({
      now,
      month,
      totals: Array.from({ length: 31 }, (_, index) => (index + 1) * 5),
    })
    expect(screen.getByText("Team budget today $125.00")).toBeInTheDocument()
    expect(screen.queryByText("Today")).toBeNull()
    expect(screen.queryByText(/Over budget/)).toBeNull()
    expect(screen.queryByText("Projected at this month's pace")).toBeNull()
    // Only the days there are to read.
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuemax", "31")
  })

  it("draws no budget line where none applies", () => {
    renderChart({ cap: null })
    expect(screen.queryByText(/Team budget/)).toBeNull()
    expect(screen.queryByText(/Over budget/)).toBeNull()
  })

  it("hangs the Today label left of its line late in the month", () => {
    const now = at("2026-11-28T00:00:00Z")
    renderChart({
      now,
      month: monthAt(2026, 10, now),
      totals: Array.from({ length: 28 }, () => 1),
    })
    expect(screen.getByText("Today")).toHaveClass("right-1.5")
  })
})

describe("stepDay", () => {
  it("moves a day each way, and jumps to either end", () => {
    expect(stepDay(3, "ArrowRight", 30)).toBe(4)
    expect(stepDay(3, "ArrowLeft", 30)).toBe(2)
    expect(stepDay(0, "ArrowLeft", 30)).toBe(0)
    expect(stepDay(29, "ArrowRight", 30)).toBe(29)
    expect(stepDay(12, "Home", 30)).toBe(0)
    expect(stepDay(12, "End", 30)).toBe(29)
    expect(stepDay(12, "a", 30)).toBeUndefined()
  })
})
