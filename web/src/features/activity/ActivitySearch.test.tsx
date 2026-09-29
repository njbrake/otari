import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { ActivitySearch } from "./ActivitySearch"

/** The search box over a committed value, as the page's URL holds it. */
function Harness({ onCommit }: { onCommit: (term: string) => void }) {
  const [value, setValue] = useState("")
  return (
    <>
      <ActivitySearch
        value={value}
        onCommit={(term) => {
          onCommit(term)
          setValue(term)
        }}
        placeholder="Search"
      />
      <button type="button" onClick={() => setValue("from outside")}>
        Apply a view
      </button>
    </>
  )
}

describe("ActivitySearch", () => {
  it("commits a term once typing settles, not per keystroke", async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    await user.type(screen.getByLabelText("Search requests"), "gpt")
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("gpt"))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it("follows a term changed from outside without committing the old one back", async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    await user.click(screen.getByRole("button", { name: "Apply a view" }))
    expect(screen.getByLabelText("Search requests")).toHaveValue("from outside")
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(onCommit).not.toHaveBeenCalled()
  })
})
