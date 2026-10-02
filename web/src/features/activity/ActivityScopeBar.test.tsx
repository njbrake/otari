import { render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"

import { ActivityScopeBar } from "./ActivityScopeBar"

function renderBar(props: Partial<ComponentProps<typeof ActivityScopeBar>>) {
  return render(
    <ActivityScopeBar
      isManager
      canNarrowToOwn
      scope="workspace"
      onScope={vi.fn()}
      range="24h"
      onRange={vi.fn()}
      bounds={{}}
      now={Date.now()}
      spend={undefined}
      {...props}
    />,
  )
}

/** The hairline between the scope and the window, which is drawn, not named. */
function rules(container: HTMLElement) {
  return container.querySelectorAll("span[aria-hidden].w-px")
}

describe("ActivityScopeBar", () => {
  it("separates the scope switch from the window", () => {
    const { container } = renderBar({})
    expect(screen.getByRole("radio", { name: "You" })).toBeInTheDocument()
    expect(rules(container)).toHaveLength(1)
  })

  it("draws no rule for a manager with no switch to separate", () => {
    const { container } = renderBar({ canNarrowToOwn: false })
    expect(screen.queryByRole("radio", { name: "You" })).not.toBeInTheDocument()
    expect(rules(container)).toHaveLength(0)
  })
})
