import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { InlineList } from "@/design-system/layout/InlineList"

/**
 * Where a middot goes is geometry jsdom does not have, so the structure that
 * keeps one from hanging at a wrap is pinned instead, and the strip was
 * checked in a browser at 1280 and 390.
 */
describe("InlineList", () => {
  it("puts each item's middot in front of it, in a row shifted and clipped by one middot", () => {
    const { container } = render(
      <InlineList>
        <span>HIGH</span>
        <span>12 failed</span>
      </InlineList>,
    )
    const outer = container.firstElementChild as HTMLElement
    const row = outer.firstElementChild as HTMLElement
    expect(outer).toHaveClass("overflow-x-clip")
    expect(row).toHaveClass("-ml-4", "flex-wrap")
    for (const item of [...row.children]) {
      const [dot] = [...item.children]
      expect(dot).toHaveAttribute("aria-hidden", "true")
      expect(dot.textContent).toBe("·")
      expect(dot).toHaveClass("w-4")
    }
  })

  it("gives nothing a middot of its own when it is empty", () => {
    const { container } = render(
      <InlineList>
        {null}
        {""}
        {false}
        <span>Used 2h ago</span>
      </InlineList>,
    )
    const row = container.firstElementChild?.firstElementChild as HTMLElement
    expect(row.children).toHaveLength(1)
    expect(screen.getByText("Used 2h ago")).toBeVisible()
  })
})
