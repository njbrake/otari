import type { Meta, StoryObj } from "@storybook/react-vite"

import { LoadingBar } from "./LoadingBar"

/**
 * A thin indeterminate bar along the bottom edge of the top bar while the page
 * waits on a read. It fades in after 200ms, so a fast read never shows it, and
 * holds still under `prefers-reduced-motion`.
 */
const meta = {
  title: "Design system/Feedback/LoadingBar",
  component: LoadingBar,
  parameters: { layout: "padded" },
  args: { isActive: true },
} satisfies Meta<typeof LoadingBar>

export default meta

type Story = StoryObj<typeof meta>

/** Laid over the rule under a stand-in for the top bar. */
export const InTheTopBar: Story = {
  render: (args) => (
    <div className="relative flex h-14 w-[40rem] items-center border-b border-border px-4 text-sm">
      Usage
      <LoadingBar {...args} />
    </div>
  ),
}
