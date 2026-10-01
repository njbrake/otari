import type { Meta, StoryObj } from "@storybook/react-vite"

import { TextButton } from "./TextButton"

/**
 * An action inside a sentence. It takes the size of the text around it, so a
 * caption's action is caption-sized and a paragraph's is body-sized.
 */
const meta = {
  title: "Design system/Actions/TextButton",
  component: TextButton,
  args: { children: "Clear filters", onPress: () => {} },
  parameters: { layout: "padded" },
} satisfies Meta<typeof TextButton>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {}

/** Finishing a sentence, where a bordered button would outweigh it. */
export const InASentence: Story = {
  render: (args) => (
    <p className="text-sm text-muted">
      No requests match these filters. <TextButton {...args} />
    </p>
  ),
}
