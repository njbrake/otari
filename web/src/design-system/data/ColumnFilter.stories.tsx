import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { ColumnFilter } from "./ColumnFilter"
import { ColumnFilterList, type ColumnFilterOption } from "./ColumnFilterList"

/**
 * A funnel in a column header that opens the column's filters: a checklist of
 * its values with counts, each of which can also be left out, thresholds, and
 * the column's own extras. Faint at rest, brighter on header hover, the accent
 * while the column is filtered.
 */
const meta = {
  title: "Design system/Data/ColumnFilter",
  component: ColumnFilter,
  // Placeholders: every story renders its own `ColumnFilter`.
  args: { label: "Model", isFiltered: false, children: null },
  parameters: { layout: "centered" },
} satisfies Meta<typeof ColumnFilter>

export default meta

type Story = StoryObj<typeof meta>

const MODELS: ColumnFilterOption[] = [
  { value: "gpt-5.6", label: "gpt-5.6", count: 18402 },
  { value: "claude-sonnet-5", label: "claude-sonnet-5", count: 4211 },
  { value: "gemini-3-pro", label: "gemini-3-pro", count: 87 },
]

/** A column header's funnel, opening a checklist whose values can be left out. */
export const Values: Story = {
  render: () => {
    const [picked, setPicked] = useState<string[]>([])
    const [excluded, setExcluded] = useState<string[]>(["gemini-3-pro"])
    return (
      <div className="group/column flex items-center gap-1 text-overline">
        Model
        <ColumnFilter
          label="Model"
          isFiltered={picked.length + excluded.length > 0}
          onClear={() => {
            setPicked([])
            setExcluded([])
          }}
          onOpenChange={() => {}}
        >
          <ColumnFilterList
            label="Model"
            options={MODELS}
            selected={picked}
            excluded={excluded}
            isMono
            onChange={(nextPicked, nextExcluded) => {
              setPicked(nextPicked)
              setExcluded(nextExcluded)
            }}
          />
        </ColumnFilter>
      </div>
    )
  },
}

/**
 * A long list searched on the server: the term is the caller's, and `more`
 * says how many values the page leaves out. A term that matches nothing can be
 * committed as an id with `allowsCustom`.
 */
export const SearchedOnTheServer: Story = {
  render: () => {
    const [term, setTerm] = useState("")
    const [picked, setPicked] = useState<string[]>([])
    const users = Array.from({ length: 8 }, (_, index) => ({
      value: `user-${index}`,
      label: `Person ${index}`,
      count: 100 - index,
    })).filter((user) => user.label.toLowerCase().includes(term.toLowerCase()))
    return (
      <ColumnFilter label="User" isFiltered={picked.length > 0}>
        <ColumnFilterList
          label="User"
          options={users}
          selected={picked}
          onChange={setPicked}
          search={term}
          onSearch={setTerm}
          more={term ? 0 : 42}
          allowsCustom
        />
      </ColumnFilter>
    )
  },
}

/**
 * Several lists in one panel, each titled: a single choice (the threshold,
 * where checking another replaces it) above an extra.
 */
export const ThresholdsAndExtras: Story = {
  render: () => {
    const [above, setAbove] = useState<string[]>(["0.1"])
    const [unpriced, setUnpriced] = useState<string[]>([])
    return (
      <ColumnFilter
        label="Cost"
        placement="bottom end"
        isFiltered={above.length + unpriced.length > 0}
        onClear={() => {
          setAbove([])
          setUnpriced([])
        }}
      >
        <ColumnFilterList
          label="Cost above"
          title="Show only"
          selectionMode="single"
          options={[
            { value: "0.4", label: "> $0.40" },
            { value: "0.1", label: "> $0.10" },
            { value: "0.01", label: "> $0.01" },
          ]}
          selected={above}
          onChange={setAbove}
        />
        <ColumnFilterList
          label="More cost filters"
          options={[{ value: "false", label: "Unpriced only" }]}
          selected={unpriced}
          onChange={setUnpriced}
        />
      </ColumnFilter>
    )
  },
}

/** What a list says while it loads, when it fails, and when it is empty. */
export const States: Story = {
  render: () => (
    <div className="flex w-[16.5rem] flex-col gap-4">
      <ColumnFilterList
        label="Loading"
        title="Loading"
        options={[]}
        selected={[]}
        onChange={() => {}}
        isLoading
      />
      <ColumnFilterList
        label="Failed"
        title="Failed"
        options={[]}
        selected={[]}
        onChange={() => {}}
        isError
      />
      <ColumnFilterList
        label="Empty"
        title="Empty"
        options={[]}
        selected={[]}
        onChange={() => {}}
        emptyLabel="Nothing in this window."
      />
    </div>
  ),
}
