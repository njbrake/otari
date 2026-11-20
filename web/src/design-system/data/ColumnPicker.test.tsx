import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ColumnPicker, type ColumnPickerColumn } from "./ColumnPicker"

const COLUMNS: ColumnPickerColumn[] = [
  { id: "time", label: "Time", isHideable: true },
  { id: "model", label: "Model", isHideable: false },
  { id: "cost", label: "Cost", isHideable: true },
]

function renderPicker(props: Partial<Parameters<typeof ColumnPicker>[0]> = {}) {
  const onHiddenChange = vi.fn()
  const onReset = vi.fn()
  render(
    <ColumnPicker
      columns={COLUMNS}
      hidden={[]}
      onHiddenChange={onHiddenChange}
      onReset={onReset}
      canReset={false}
      {...props}
    />,
  )
  return { onHiddenChange, onReset }
}

describe("ColumnPicker", () => {
  it("lists every column, checked while shown, and the identity column cannot be unchecked", async () => {
    const user = userEvent.setup()
    renderPicker({ hidden: ["cost"] })
    await user.click(screen.getByRole("button", { name: "Columns, 1 hidden" }))

    expect(screen.getByRole("checkbox", { name: "Time" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Cost" })).not.toBeChecked()
    const model = screen.getByRole("checkbox", { name: "Model" })
    expect(model).toBeChecked()
    expect(model).toBeDisabled()
  })

  it("hides and shows a column", async () => {
    const user = userEvent.setup()
    const { onHiddenChange } = renderPicker({ hidden: ["cost"] })
    await user.click(screen.getByRole("button", { name: "Columns, 1 hidden" }))

    await user.click(screen.getByRole("checkbox", { name: "Time" }))
    expect(onHiddenChange).toHaveBeenLastCalledWith("time", true)
    await user.click(screen.getByRole("checkbox", { name: "Cost" }))
    expect(onHiddenChange).toHaveBeenLastCalledWith("cost", false)
  })

  it("offers a reset only once there is something to reset", async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole("button", { name: "Columns" }))
    expect(screen.getByRole("button", { name: "Reset columns" })).toBeDisabled()
  })

  it("resets the layout", async () => {
    const user = userEvent.setup()
    const { onReset } = renderPicker({ canReset: true })
    await user.click(screen.getByRole("button", { name: "Columns" }))
    await user.click(screen.getByRole("button", { name: "Reset columns" }))
    expect(onReset).toHaveBeenCalledOnce()
  })
})
