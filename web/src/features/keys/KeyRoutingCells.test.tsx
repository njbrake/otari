import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { KeyRouting } from "@/client"

import { KeyModelsCell, KeyMostUsedCell } from "./KeyRoutingCells"

const LONG = ["thymeline-anthropic", "fireworks", "another-very-long-instance"]

describe("KeyModelsCell", () => {
  it("is one button that ends in an ellipsis rather than growing past its column", () => {
    const onOpen = vi.fn()
    render(
      <KeyModelsCell
        summary={{
          kind: "selected",
          providers: LONG,
          counts: new Map([["fireworks", 4]]),
          total: 12,
        }}
        onOpen={onOpen}
      />,
    )

    // One control, not a button inside a wrapper that also reports as one: the
    // wrapper sized to its text, so nothing capped it to the column.
    const [button] = screen.getAllByRole("button")
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(button).toHaveTextContent(LONG.join(", "))
    expect(button).toHaveClass("block", "max-w-full", "truncate")
    // The tooltip, with the whole list, is anchored on it.
    expect(button).toHaveAttribute("data-slot", "tooltip-trigger")
    button.click()
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe("KeyModelsCell for a key that reaches nothing", () => {
  it("says so in the danger color, not the link's", () => {
    render(<KeyModelsCell summary={{ kind: "none" }} onOpen={() => {}} />)

    // Both classes set the color and `.text-link` wins on order, so the danger
    // tone has to replace it rather than sit beside it.
    const link = screen.getByRole("button", { name: "No models" })
    expect(link).toHaveClass("text-danger")
    expect(link).not.toHaveClass("text-link")
  })
})

describe("KeyMostUsedCell", () => {
  it("keeps the whole name on hover when the column cuts it short", () => {
    const routing = {
      api_key_id: "k",
      model_count: 3,
      no_backup_count: 0,
      policies: [],
      models: [
        {
          name: "a-very-long-routing-policy-name-for-production",
          requests: 10,
          kind: "policy",
          backup: "has_backup",
          reason: null,
          provider: null,
        },
      ],
    } as KeyRouting
    render(<KeyMostUsedCell routing={routing} />)

    const name = screen.getByText(
      "a-very-long-routing-policy-name-for-production",
    )
    expect(name).toHaveClass("truncate")
    expect(name).toHaveAttribute(
      "title",
      "a-very-long-routing-policy-name-for-production and 2 more",
    )
  })
})
