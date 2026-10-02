import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"

import { savedView } from "@/tests/activity"
import { BUILT_IN_VIEWS } from "./activityQuery"
import { SavedViewsMenu } from "./SavedViewsMenu"

function renderMenu(
  props: Partial<ComponentProps<typeof SavedViewsMenu>> = {},
) {
  const handlers = {
    onApply: vi.fn(),
    onSave: vi.fn(async () => undefined),
    onDelete: vi.fn(),
  }
  render(
    <SavedViewsMenu
      views={[
        savedView({ id: "mine", name: "Slow calls" }),
        savedView({
          id: "theirs",
          name: "Fallbacks",
          shared: true,
          is_mine: false,
          owner_name: "Jordan M.",
        }),
      ]}
      current="All requests"
      matching={BUILT_IN_VIEWS[0]}
      isDirty={false}
      canShare={false}
      canSave
      isSaving={false}
      error={null}
      onClose={vi.fn()}
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

describe("SavedViewsMenu", () => {
  it("names the view on screen, and marks one changed since it was applied", () => {
    renderMenu({ current: "Expensive calls", isDirty: true })
    const trigger = screen.getByRole("button", {
      name: "Saved views: Expensive calls, changed since saved",
    })
    expect(trigger).toHaveTextContent("Expensive calls")
  })

  it("lists the built-in views, the caller's own, and those shared with who shared them", async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole("button", { name: /Saved views/ }))
    for (const view of BUILT_IN_VIEWS) {
      expect(
        screen.getByRole("menuitemradio", { name: view.name }),
      ).toBeInTheDocument()
    }
    expect(
      screen.getByRole("menuitemradio", { name: "Slow calls" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitemradio", { name: /Fallbacks/ }),
    ).toHaveTextContent("Jordan M.")
  })

  it("checks the view the page matches", async () => {
    const user = userEvent.setup()
    renderMenu({ matching: BUILT_IN_VIEWS[1] })
    await user.click(screen.getByRole("button", { name: /Saved views/ }))
    expect(
      screen.getByRole("menuitemradio", { name: BUILT_IN_VIEWS[1].name }),
    ).toHaveAttribute("aria-checked", "true")
    expect(
      screen.getByRole("menuitemradio", { name: BUILT_IN_VIEWS[0].name }),
    ).toHaveAttribute("aria-checked", "false")
  })

  it("applies a view", async () => {
    const user = userEvent.setup()
    const { onApply } = renderMenu()
    await user.click(screen.getByRole("button", { name: /Saved views/ }))
    await user.click(
      screen.getByRole("menuitemradio", { name: "Failures this week" }),
    )
    expect(onApply).toHaveBeenCalledWith(BUILT_IN_VIEWS[1])
  })

  it("deletes the caller's own view, and never another person's unless they manage the workspace", async () => {
    const user = userEvent.setup()
    const { onDelete } = renderMenu()
    await user.click(screen.getByRole("button", { name: /Saved views/ }))
    await user.click(screen.getByRole("menuitem", { name: "Delete a view" }))
    const deletable = screen.getByRole("menu", { name: "Delete a view" })
    expect(
      within(deletable).queryByRole("menuitem", { name: "Fallbacks" }),
    ).not.toBeInTheDocument()
    await user.click(
      within(deletable).getByRole("menuitem", { name: "Slow calls" }),
    )
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mine" }),
    )
    // The panel stays open, where a refused delete is reported.
    expect(
      screen.getByRole("dialog", { name: "Saved views" }),
    ).toBeInTheDocument()
  })

  it("saves the current view under a trimmed name, shared only where it may be", async () => {
    const user = userEvent.setup()
    const { onSave } = renderMenu({ canShare: true })
    await user.click(screen.getByRole("button", { name: /Saved views/ }))
    await user.click(
      screen.getByRole("menuitem", { name: "Save current view…" }),
    )
    await user.type(screen.getByLabelText("View name"), "  Failures  ")
    await user.click(
      screen.getByRole("checkbox", { name: "Share with the workspace" }),
    )
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("Failures", true)
  })

  it("offers no sharing to someone who cannot share", async () => {
    const user = userEvent.setup()
    renderMenu({ canShare: false })
    await user.click(screen.getByRole("button", { name: /Saved views/ }))
    await user.click(
      screen.getByRole("menuitem", { name: "Save current view…" }),
    )
    expect(
      screen.queryByRole("checkbox", { name: "Share with the workspace" }),
    ).not.toBeInTheDocument()
  })

  it("offers no save with no workspace to keep the view in", async () => {
    const user = userEvent.setup()
    renderMenu({ canSave: false })
    await user.click(screen.getByRole("button", { name: /Saved views/ }))
    expect(
      screen.queryByRole("menuitem", { name: /Save current view/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: "Copy link to this view" }),
    ).toBeInTheDocument()
  })
})
