import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { KpiCell } from "@/design-system/metrics/KpiCell"

/**
 * The cell's own column, pinned because the overflow it prevents is invisible
 * until the data is long enough and jsdom reports no geometry to catch it.
 *
 * A grid gives itself an `auto` column, whose floor is the widest child's
 * min-content, and the subline never wraps. Measured on the running strip with
 * a 59-character subline, an `auto` column came out 356px inside a 283px cell
 * and everything sized to it (the sparkline included) painted into the cell
 * beside it, by 129px at 1728 and 218px at 1280.
 */
describe("KpiCell", () => {
  const cell = (container: HTMLElement) =>
    container.firstElementChild as HTMLElement

  it("bounds its own column so a long child cannot widen it", () => {
    const { container } = render(
      <KpiCell label="Cache hit rate" value="13.1%" subline="239.3k read" />,
    )
    expect(cell(container)).toHaveClass("grid-cols-[minmax(0,1fr)]")
    expect(cell(container)).toHaveClass("min-w-0")
  })

  it("wraps a long subline rather than cutting it short", () => {
    const subline = "1,239,300.4k read · 70,000.0k written · 12,345 misses"
    const { container, getByText } = render(
      <KpiCell
        label="Cache hit rate"
        value="13.1%"
        delta={<a href="/keys">See their API keys</a>}
        subline={subline}
      />,
    )
    const line = cell(container).children[2] as HTMLElement
    expect(line.querySelector(".flex-wrap")).not.toBeNull()
    expect(line).not.toHaveClass("text-nowrap")
    expect(getByText(subline)).not.toHaveClass("truncate")
  })

  it("subgrids onto the strip's rows and is not itself a size container", () => {
    // A size container gets layout containment, and a subgrid inside an
    // independent formatting context computes to `none`: the cell's parts
    // would then split its height evenly instead of following the strip.
    const { container, getByText } = render(
      <KpiCell label="Spent this month" value="$12.00" subline="40 requests" />,
    )
    expect(cell(container)).toHaveClass("grid-rows-subgrid", "row-span-4")
    expect(cell(container).className).not.toMatch(/@container/)
    expect(getByText("$12.00").parentElement).toHaveClass("@container")
  })

  it("holds the figure and its line with placeholders while loading", () => {
    const { container, getByText, queryByText } = render(
      <KpiCell label="Spent" value="—" subline="Loading" isLoading />,
    )
    expect(cell(container)).toHaveAttribute("aria-busy", "true")
    expect(getByText("Loading")).toHaveClass("sr-only")
    expect(queryByText("—")).toBeNull()
  })

  it("keeps each fact of a listed subline whole", () => {
    const { getByText } = render(
      <KpiCell
        label="Spent"
        value="$2.88"
        subline={["$1.92 charged", "+$0.96 not charged"]}
      />,
    )
    expect(getByText("$1.92 charged")).toHaveClass("whitespace-nowrap")
    expect(getByText("+$0.96 not charged")).toHaveClass("whitespace-nowrap")
  })
})
