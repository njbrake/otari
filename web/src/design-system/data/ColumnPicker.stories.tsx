import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { ColumnPicker, type ColumnPickerColumn } from "./ColumnPicker"

/**
 * The Columns control over a table: a checkbox per column, the row's identity
 * always shown, and a reset back to the default layout.
 */
const meta = {
  title: "Design system/Data/ColumnPicker",
  component: ColumnPicker,
  // Placeholders: the story renders its own `ColumnPicker`.
  args: {
    columns: [],
    hidden: [],
    onHiddenChange: () => {},
    onReset: () => {},
    canReset: false,
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof ColumnPicker>

export default meta

type Story = StoryObj<typeof meta>

const COLUMNS: ColumnPickerColumn[] = [
  { id: "time", label: "Time", isHideable: true },
  { id: "model", label: "Model", isHideable: false },
  { id: "routing", label: "Routing", isHideable: true },
  { id: "cost", label: "Cost", isHideable: true },
  { id: "status", label: "Status", isHideable: true },
]

/** One column hidden, so the reset is offered. */
export const Default: Story = {
  render: () => {
    const [hidden, setHidden] = useState<string[]>(["routing"])
    return (
      <ColumnPicker
        columns={COLUMNS}
        hidden={hidden}
        onHiddenChange={(id, isHidden) =>
          setHidden((current) =>
            isHidden
              ? [...current, id]
              : current.filter((other) => other !== id),
          )
        }
        onReset={() => setHidden([])}
        canReset={hidden.length > 0}
        className="self-end"
      />
    )
  },
}
