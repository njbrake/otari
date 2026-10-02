import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { entry } from "@/tests/activity"
import { CostCell, StatusCell } from "./activityCells"
import { PhoneRow } from "./PhoneRow"

function phone(overrides: Parameters<typeof entry>[0]) {
  return render(
    <PhoneRow entry={entry(overrides)} member={undefined} onOpen={() => {}} />,
  )
}

/** The outcome square's fill, wherever the layout draws it. */
function markFill(container: HTMLElement): string | undefined {
  const mark = container.querySelector("span[aria-hidden].h-1\\.5")
  return mark?.className.match(/\bbg-[\w-]+/)?.[0]
}

// The phone and the desk read a row's outcome and cost through the same
// helpers, so each case here pins what both of them show.
describe("PhoneRow", () => {
  it("shows a recovered attempt as the desk does: a neutral mark and no cost", () => {
    const row = { status: "absorbed" as const, status_code: 529, cost: 0.02 }
    const { container, unmount } = phone(row)
    expect(markFill(container)).toBe("bg-text-subtle")
    expect(screen.queryByText(/\$/)).toBeNull()
    expect(screen.getByText(/529 Overloaded/)).toBeInTheDocument()
    unmount()

    const desk = render(
      <>
        <StatusCell entry={entry(row)} />
        <CostCell entry={entry(row)} />
      </>,
    )
    expect(markFill(desk.container)).toBe("bg-text-subtle")
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it("keeps a served request's mark green when a fallback recovered it", () => {
    const { container } = phone({ status_code: 200, absorbed_attempts: 1 })
    expect(markFill(container)).toBe("bg-success")
    expect(screen.getByText(/\$/)).toBeInTheDocument()
    expect(screen.getByText(/1 recovered/)).toHaveClass("text-warning")
  })

  it("reads a failure in danger, with its reason and no cost", () => {
    const { container } = phone({
      status: "error",
      status_code: 429,
      cost: null,
    })
    expect(markFill(container)).toBe("bg-danger")
    expect(screen.queryByText(/\$/)).toBeNull()
    expect(screen.getByText(/429 Rate limited/)).toBeInTheDocument()
  })

  it("says a subscription paid on the time line, leaving the sender its room", () => {
    phone({ source: "claude_code" })
    const subscription = screen.getByText("· Subscription")
    // The time line, not the sender line: at 375px a chip beside the sender
    // truncated the name it qualifies.
    expect(subscription.parentElement).toHaveTextContent(/ago/)
    expect(subscription.parentElement).not.toHaveTextContent(/Claude Code/)
  })

  it("says unpriced where a served request carries no price", () => {
    phone({ cost: null })
    expect(screen.getByText("unpriced")).toBeInTheDocument()
  })
})
