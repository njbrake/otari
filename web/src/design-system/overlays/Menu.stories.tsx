import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import {
  FiChevronDown,
  FiDollarSign,
  FiFilter,
  FiSlash,
  FiTrash2,
} from "react-icons/fi"

import { Button } from "../actions/Button"
import { Menu, MenuButton, MenuItem, MenuSection, MenuSubmenu } from "./Menu"
import { Popover } from "./Popover"

/**
 * A list of actions or choices the arrow keys move through: react-aria's menu
 * in the dashboard's rows.
 *
 * `MenuButton` is the menu a button opens and nothing else; `Menu` is the same
 * list laid inline, for a panel that holds more than a menu. Either way an
 * item that selects reports through `onAction` and the caller owns which are
 * chosen.
 */
const meta = {
  title: "Design system/Overlays/Menu",
  component: MenuButton,
  // Placeholders: every story renders its own menu.
  args: { trigger: <Button>Open</Button>, label: "Menu", children: null },
  parameters: { layout: "centered" },
} satisfies Meta<typeof MenuButton>

export default meta

type Story = StoryObj<typeof meta>

/** Actions, each with a glyph, under a sentence saying what they reach. */
export const Actions: Story = {
  render: () => (
    <MenuButton
      label="Manage imported rows"
      width="md"
      trigger={
        <Button size="sm">
          Manage 12 imported rows
          <FiChevronDown aria-hidden className="size-3.5" />
        </Button>
      }
      header={
        <p className="px-3 pt-2 pb-1.5 text-caption text-subtle">
          Applies to every imported row matching the current filters.
        </p>
      }
    >
      <MenuItem id="recost" icon={FiDollarSign}>
        Recost imported rows…
      </MenuItem>
      <MenuItem id="delete" icon={FiTrash2}>
        Delete imported rows…
      </MenuItem>
    </MenuButton>
  ),
}

function GroupByStory() {
  const [value, setValue] = useState("none")
  const options = [
    { value: "none", label: "None" },
    { value: "source", label: "API key" },
    { value: "model", label: "Model" },
  ]
  return (
    <MenuButton
      label="Group by"
      selectionMode="single"
      selectedKeys={[value]}
      onAction={setValue}
      trigger={
        <Button size="sm">
          <span className="text-subtle">Group by</span>
          {options.find((option) => option.value === value)?.label}
          <FiChevronDown aria-hidden className="size-3.5" />
        </Button>
      }
    >
      {options.map((option) => (
        <MenuItem key={option.value} id={option.value}>
          {option.label}
        </MenuItem>
      ))}
    </MenuButton>
  )
}

/** One choice of several: the chosen row is checked in a lane every row keeps. */
export const SingleChoice: Story = {
  render: () => <GroupByStory />,
}

/** Inline, in sections, with a trailing detail on a row. */
export const InlineSections: Story = {
  render: () => (
    <div className="w-[18.75rem] border border-control-border bg-surface">
      <Menu label="Saved views" selectionMode="single" selectedKeys={["all"]}>
        <MenuSection title="Built in">
          <MenuItem id="all">All requests</MenuItem>
          <MenuItem id="failures">Failures this week</MenuItem>
        </MenuSection>
        <MenuSection title="Shared in this workspace">
          <MenuItem
            id="fallbacks"
            trailing={
              <span className="text-mono-micro text-subtle">Jordan</span>
            }
          >
            Fallbacks
          </MenuItem>
        </MenuSection>
      </Menu>
    </div>
  ),
}

/**
 * Centered under its trigger, with a label set in more than plain text:
 * `textValue` gives the item the name a screen reader reads and type-ahead
 * matches.
 */
export const RichLabels: Story = {
  render: () => (
    <MenuButton
      label="Filter by gpt-4o"
      placement="bottom"
      trigger={<Button size="sm">Filter</Button>}
    >
      <MenuItem id="include" icon={FiFilter} textValue="Only gpt-4o">
        Only <b className="font-medium text-foreground">gpt-4o</b>
      </MenuItem>
      <MenuItem id="exclude" icon={FiSlash} textValue="Exclude gpt-4o">
        Exclude <b className="font-medium text-foreground">gpt-4o</b>
      </MenuItem>
    </MenuButton>
  ),
}

/**
 * Laid in a panel that holds more than the menu. Inline, a menu leaves the
 * panel open unless `closesOnAction` says otherwise, as the second one here
 * does; the submenu moves a long run of actions one level down.
 */
export const InPopover: Story = {
  render: () => (
    <Popover
      label="Saved views"
      padding="none"
      trigger={<Button size="sm">Views</Button>}
    >
      <div className="flex w-[18.75rem] flex-col">
        <p className="px-3 pt-2 text-caption text-subtle">
          Choosing a view leaves this open; copying the link closes it.
        </p>
        <Menu label="Views" selectionMode="single" selectedKeys={["all"]}>
          <MenuItem id="all">All requests</MenuItem>
          <MenuItem id="slow">Slow calls</MenuItem>
        </Menu>
        <Menu label="View actions" closesOnAction>
          <MenuItem id="copy">Copy link to this view</MenuItem>
          <MenuSubmenu
            id="delete"
            label="Delete a view"
            icon={FiTrash2}
            onAction={() => {}}
          >
            <MenuItem id="slow">Slow calls</MenuItem>
          </MenuSubmenu>
        </Menu>
      </div>
    </Popover>
  ),
}
