import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { KpiCell } from "@/design-system/metrics/KpiCell"
import { KpiStrip } from "@/design-system/metrics/KpiStrip"

/** The grid's own element, which is the one inside `Section`'s band. */
function track(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement
}

describe("KpiStrip", () => {
  it("lays five tracks by default", () => {
    render(
      <KpiStrip isEmpty={false}>
        <span>cell</span>
      </KpiStrip>,
    )

    expect(track("cell")).toHaveClass("xl:grid-cols-5")
  })

  it("narrows to the number of cells the caller passed", () => {
    // A strip whose track count outruns its children leaves a blank column at
    // the end of the row, which is what the tenant Overview would get where it
    // withholds the budget cell from a member.
    render(
      <KpiStrip isEmpty={false} columns={4}>
        <span>cell</span>
      </KpiStrip>,
    )

    expect(track("cell")).toHaveClass("xl:grid-cols-4")
    expect(track("cell")).not.toHaveClass("xl:grid-cols-5")
  })

  it("rules a cell off from the one before it on its row, never at a row's end", () => {
    // jsdom lays nothing out, so this pins the rule rather than the pixels: each
    // breakpoint names the cells that start a row (2n+1 at two columns, 3n+1 at
    // three, the first at the widest) and only the others draw a left rule. A
    // right rule on every cell but the last ruled off the end of each wrapped
    // row against nothing.
    render(
      <KpiStrip isEmpty={false}>
        <KpiCell label="Spend" value="$1" />
        <KpiCell label="Requests" value="2" />
      </KpiStrip>,
    )

    const strip = track("Spend").parentElement as HTMLElement
    expect(strip).toHaveClass(
      "[&>*:nth-child(2n)]:border-l",
      "sm:[&>*:nth-child(3n+1)]:border-l-0",
      "sm:[&>*:not(:nth-child(3n+1))]:border-l",
      "xl:[&>*:not(:first-child)]:border-l",
    )
    for (const cell of strip.children) {
      expect(cell.className).not.toMatch(/border-r/)
    }
  })
})
