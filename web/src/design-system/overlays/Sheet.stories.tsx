import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { Button } from "../actions/Button"
import { Sheet } from "./Sheet"

/**
 * A panel that slides over the page from an edge: the right, beside what it
 * is about; the bottom, as a phone's sheet; or the whole screen, as a phone's
 * pushed view.
 *
 * A `title` gives it a header with a Close; a pushed view takes `back`
 * instead; with neither, the body owns the panel. Controlled, unless a
 * `trigger` inside its own tree opens it.
 */
const meta = {
  title: "Design system/Overlays/Sheet",
  component: Sheet,
  // Placeholders: every story renders its own sheet.
  args: {
    isOpen: false,
    onOpenChange: () => {},
    label: "Sheet",
    children: null,
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof Sheet>

export default meta

type Story = StoryObj<typeof meta>

function RightStory({ size }: { size: "sm" | "md" | "lg" }) {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      label={`Use this model (${size})`}
      size={size}
      title="Use gpt-4o"
      description={
        <>
          Send <code className="text-mono-caption">gpt-4o</code> as{" "}
          <code className="text-mono-caption">model</code>.
        </>
      }
      trigger={<Button size="sm">Open {size}</Button>}
    >
      <p className="px-4 py-3 text-sm">
        The body scrolls under the header and owns its own padding.
      </p>
    </Sheet>
  )
}

/** From the right, opened by its own trigger, at each of its widths. */
export const Right: Story = {
  render: () => (
    <div className="flex gap-2">
      <RightStory size="sm" />
      <RightStory size="md" />
      <RightStory size="lg" />
    </div>
  ),
}

function BottomStory() {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <>
      <Button onPress={() => setIsOpen(true)}>Filter and sort</Button>
      <Sheet
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        placement="bottom"
        label="Filter and sort"
        title="Filter and sort"
        actions={<Button size="sm">Reset</Button>}
        footer={
          <Button variant="primary" fullWidth onPress={() => setIsOpen(false)}>
            Show 25 requests
          </Button>
        }
      >
        <p className="px-4 py-3 text-sm">Sort and filter controls.</p>
      </Sheet>
    </>
  )
}

/** A phone's sheet: header actions beside the Close, and a footer. */
export const Bottom: Story = {
  render: () => <BottomStory />,
}

function FullStory() {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <>
      <Button onPress={() => setIsOpen(true)}>Open a request</Button>
      <Sheet
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        placement="full"
        label="Request"
        back={{ label: "Activity", onPress: () => setIsOpen(false) }}
      >
        <p className="px-4 py-3 text-sm">
          A pushed view: the way back names where it returns to.
        </p>
      </Sheet>
    </>
  )
}

/** The whole screen, as a pushed view, with a way back instead of a Close. */
export const Full: Story = {
  render: () => <FullStory />,
}
