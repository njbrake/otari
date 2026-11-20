import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { LoadingBar } from "./LoadingBar"

describe("LoadingBar", () => {
  it("draws a bar hidden from assistive tech while active", () => {
    const { container } = render(<LoadingBar isActive />)
    const bar = container.querySelector(".otari-loading-bar")
    expect(bar).not.toBeNull()
    expect(bar).toHaveAttribute("aria-hidden", "true")
  })

  it("draws nothing once the wait is over", () => {
    const { container } = render(<LoadingBar isActive={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
