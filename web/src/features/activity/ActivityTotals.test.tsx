import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { usageTotals } from "@/tests/fixtures"
import { ActivityTotals } from "./ActivityTotals"

const totals = usageTotals({
  request_count: 12,
  error_count: 2,
  absorbed_count: 1,
  cost: 3,
  imported_cost: 1,
  unpriced_requests: 4,
  billed_input_tokens: 1000,
  billed_output_tokens: 500,
  cache_read_tokens: 250,
})

describe("ActivityTotals", () => {
  it("adds up the rows at a desk, the tokens and their cache share included", () => {
    render(<ActivityTotals totals={totals} isFiltered onUnpriced={vi.fn()} />)
    expect(screen.getByText("12 filtered requests")).toBeInTheDocument()
    expect(screen.getByText("2 failed")).toHaveClass("text-danger")
    expect(screen.getByText("1 recovered")).toBeInTheDocument()
    expect(screen.getByText("$2.00 billed")).toBeInTheDocument()
    expect(screen.getByText("$1.00 subscription")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "4 unpriced" }),
    ).toBeInTheDocument()
    expect(screen.getByText(/tokens \(25% cached\)/)).toBeInTheDocument()
  })

  it("keeps a phone's line to the count, the failures and the two costs", () => {
    render(<ActivityTotals totals={totals} variant="phone" />)
    expect(screen.getByText("12 requests")).toBeInTheDocument()
    expect(screen.getByText("2 failed")).toBeInTheDocument()
    expect(screen.getByText("$2.00 billed")).toBeInTheDocument()
    expect(screen.queryByText(/recovered/)).toBeNull()
    expect(screen.queryByText(/unpriced/)).toBeNull()
    expect(screen.queryByText(/tokens/)).toBeNull()
  })
})
