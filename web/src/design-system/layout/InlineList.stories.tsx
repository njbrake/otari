import type { Meta, StoryObj } from "@storybook/react-vite"

import { InlineList } from "./InlineList"

/**
 * Short facts divided by middots that wrap with no middot left hanging at the
 * end of a line. Narrow the canvas to see a line break between two facts.
 */
const meta = {
  title: "Design system/Layout/InlineList",
  component: InlineList,
  args: { children: null },
  parameters: { layout: "padded" },
} satisfies Meta<typeof InlineList>

export default meta

type Story = StoryObj<typeof meta>

export const Wrapping: Story = {
  render: () => (
    <div className="w-48 text-caption">
      <InlineList>
        <span>Resets Dec 1</span>
        <span className="text-warning">Expires in 3 days</span>
        <span>Used 10s ago</span>
      </InlineList>
    </div>
  ),
}

/** Long items that may wrap inside themselves, as a KPI cell's line does. */
export const WrappingItems: Story = {
  render: () => (
    <div className="w-48 text-caption">
      <InlineList isNowrapItems={false}>
        <span>HIGH</span>
        <span>A sentence long enough to wrap inside its own item</span>
      </InlineList>
    </div>
  ),
}
