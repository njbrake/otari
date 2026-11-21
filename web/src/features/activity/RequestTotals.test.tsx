import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderPage } from "@/tests/activity"
import { usageTotals } from "@/tests/fixtures"
import { cacheShare, RequestTotals, splitCost } from "./RequestTotals"

describe("RequestTotals", () => {
  it("reads every figure off the totals, in one line", async () => {
    renderPage(
      <RequestTotals
        totals={usageTotals({
          request_count: 1234,
          error_count: 5,
          absorbed_count: 3,
          cost: 12.5,
          imported_cost: 2.5,
          unpriced_requests: 7,
          billed_input_tokens: 800_000,
          billed_output_tokens: 200_000,
          cache_read_tokens: 200_000,
          p95_latency_ms: 2400,
        })}
        isLoading={false}
      />,
      "/requests?page=2&model=gpt-4o",
    )
    const strip = await screen.findByRole("region", { name: "Totals" })
    expect(strip).toHaveTextContent("1,234 requests")
    expect(strip).toHaveTextContent("5 failed")
    expect(strip).toHaveTextContent("3 recovered")
    expect(strip).toHaveTextContent("$10.00 billed")
    expect(strip).toHaveTextContent("$2.50 subscription (not charged)")
    expect(strip).toHaveTextContent("25.0% cached")
    expect(strip).toHaveTextContent("P95 2.40 s")
    // The unpriced figure opens those rows, keeping the other filters and
    // returning to the first page.
    const unpriced = screen.getByRole("link", { name: "7 unpriced" })
    const target = new URL(unpriced.getAttribute("href") ?? "", "http://x")
    expect(target.searchParams.get("priced")).toBe("false")
    expect(target.searchParams.get("model")).toBe("gpt-4o")
    expect(target.searchParams.has("page")).toBe(false)
  })

  it("pins the phone's line to the requests, failures, billed cost and tokens", async () => {
    renderPage(
      <RequestTotals
        totals={usageTotals({
          request_count: 1234,
          error_count: 5,
          cost: 12.5,
          imported_cost: 2.5,
          unpriced_requests: 7,
          billed_input_tokens: 800_000,
          billed_output_tokens: 200_000,
          p95_latency_ms: 2400,
        })}
        isLoading={false}
        isPinned
      />,
      "/requests",
    )
    const line = await screen.findByRole("region", { name: "Totals" })
    expect(line).toHaveTextContent(
      "1,234 requests · 5 failed · $10.00 billed · 1.0M tokens",
    )
    expect(line).not.toHaveTextContent("P95")
    expect(screen.queryByRole("link", { name: "7 unpriced" })).toBeNull()
  })

  it("leaves out the figures that are zero and say nothing", async () => {
    renderPage(
      <RequestTotals
        totals={usageTotals({ request_count: 1, cost: 0.5 })}
        isLoading={false}
      />,
    )
    const strip = await screen.findByRole("region", { name: "Totals" })
    expect(strip).toHaveTextContent("1 request")
    expect(strip).toHaveTextContent("0 failed")
    expect(strip).not.toHaveTextContent("recovered")
    expect(strip).not.toHaveTextContent("subscription")
    expect(strip).not.toHaveTextContent("unpriced")
    expect(strip).not.toHaveTextContent("P95")
  })

  it("holds its height with skeletons until the totals answer", async () => {
    renderPage(<RequestTotals totals={undefined} isLoading />)
    expect(await screen.findByText("Loading totals")).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Totals" })).toBeNull()
  })
})

describe("the totals' arithmetic", () => {
  it("splits the cost into billed and imported, and reads the cache share of input", () => {
    expect(splitCost(usageTotals({ cost: 3, imported_cost: 1 }))).toEqual({
      billed: 2,
      subscription: 1,
    })
    expect(cacheShare(usageTotals())).toBe(0)
    expect(
      cacheShare(
        usageTotals({ billed_input_tokens: 400, cache_read_tokens: 100 }),
      ),
    ).toBe(0.25)
  })
})
