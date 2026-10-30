import { type ReactNode, useEffect, useState } from "react"
import { FiArrowDown, FiArrowUp, FiPlus, FiX } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { TextButton } from "@/design-system/actions/TextButton"
import { OfferingPicker } from "@/features/models/OfferingPicker"

import { SelectorName } from "./PolicyCells"

let nextRowKey = 0
const newRowKey = () => {
  nextRowKey += 1
  return nextRowKey
}

/**
 * Models in the order a policy tries them, each with its role, what it did in
 * the last 30 days, and, while editable, arrows to move it and a remove.
 *
 * A row with no model yet is a picker; once one is picked it reads as the
 * model and its provider, so a list being reordered stays a list of names
 * rather than a stack of fields. The arrows stay on a phone, where there is
 * nothing to drag with. Rows are keyed by identity, so focus follows a moved
 * model onto the same arrow, or the other one at either end.
 */
export function ModelOrderList({
  label,
  models,
  roleOf,
  itemName = (index) => `model ${index + 1}`,
  statOf,
  extraOf,
  problems = [],
  onMove,
  onRemove,
  onPick,
  onAdd,
  addLabel,
  canAdd = true,
  addNote,
  minRows = 0,
}: {
  /** Names the list and each row's controls ("Move backup 2 up"). */
  label: string
  models: string[]
  /** The mark beside a row: MAIN, BACKUP 1, DEFAULT, MODEL. */
  roleOf: (index: number) => string
  /** A row's name in its controls' labels: "backup 2", "the main model". */
  itemName?: (index: number) => string
  /** What the row's model did in the last 30 days, in a few words. */
  statOf?: (selector: string, index: number) => ReactNode
  /** A control of the row's own, such as a share. */
  extraOf?: (index: number) => ReactNode
  /** Per row, why it cannot be saved, or "". */
  problems?: string[]
  /** Absent for a read-only list, which then has no controls at all. */
  onMove?: (from: number, to: number) => void
  onRemove?: (index: number) => void
  onPick?: (index: number, selector: string) => void
  onAdd?: () => void
  addLabel?: string
  canAdd?: boolean
  /** Why nothing more can be added, beside the disabled button. */
  addNote?: string
  /** Rows that cannot be removed below. */
  minRows?: number
}) {
  const isEditable = onMove !== undefined
  const [keys, setKeys] = useState<number[]>(() => models.map(newRowKey))
  // Every change made here keeps `keys` in step; a list replaced from outside
  // starts over with fresh rows.
  if (keys.length !== models.length) setKeys(models.map(newRowKey))
  const [moved, setMoved] = useState<{ key: number; up: boolean }>()
  // Rows whose model is being changed, by key: a picker until Done.
  const [editing, setEditing] = useState<ReadonlySet<number>>(new Set())
  const setEditingRow = (key: number, isEditing: boolean) =>
    setEditing((prev) => {
      const next = new Set(prev)
      if (isEditing) next.add(key)
      else next.delete(key)
      return next
    })

  useEffect(() => {
    if (moved === undefined) return
    const order = moved.up ? ["up", "down"] : ["down", "up"]
    const target = order
      .map((dir) =>
        document.querySelector<HTMLElement>(
          `[data-model-move="${moved.key}:${dir}"]`,
        ),
      )
      .find(
        (button) =>
          button !== null &&
          !button.matches(":disabled, [aria-disabled='true']"),
      )
    target?.focus()
    setMoved(undefined)
  }, [moved])

  const move = (from: number, to: number) => {
    const key = keys[from]
    setKeys((prev) => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      if (item !== undefined) next.splice(to, 0, item)
      return next
    })
    onMove?.(from, to)
    if (key !== undefined) setMoved({ key, up: to < from })
  }

  return (
    <div className="flex flex-col gap-3">
      {models.length > 0 ? (
        <ol
          aria-label={label}
          className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface"
        >
          {models.map((selector, index) => {
            const key = keys[index] ?? index
            const role = roleOf(index)
            const name = itemName(index)
            return (
              <li
                key={key}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              >
                <span className="w-4 shrink-0 text-caption tabular-nums">
                  {index + 1}
                </span>
                <span className="w-20 shrink-0 text-mono-overline text-subtle">
                  {role}
                </span>
                <div className="min-w-48 flex-1">
                  {onPick && (selector === "" || editing.has(key)) ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-48 flex-1">
                        <OfferingPicker
                          id={`model-${key}`}
                          label={`${name.charAt(0).toUpperCase()}${name.slice(1)}`}
                          value={selector}
                          // A row opened empty stays a picker once typing
                          // starts, until Done, rather than turning into the
                          // first letter typed.
                          onChange={(next) => {
                            if (!editing.has(key)) setEditingRow(key, true)
                            onPick(index, next)
                          }}
                          errorMessage={problems[index] ?? ""}
                          isRequired
                          autoFocus
                        />
                      </div>
                      {editing.has(key) && selector !== "" ? (
                        <TextButton onPress={() => setEditingRow(key, false)}>
                          Done
                        </TextButton>
                      ) : null}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <SelectorName selector={selector} />
                      {problems[index] ? (
                        <span className="text-caption text-danger">
                          {problems[index]}
                        </span>
                      ) : null}
                    </div>
                  )}
                </div>
                {isEditable &&
                onPick &&
                selector !== "" &&
                !editing.has(key) ? (
                  <TextButton onPress={() => setEditingRow(key, true)}>
                    <span aria-hidden>Change</span>
                    <span className="sr-only">{`Change ${name}`}</span>
                  </TextButton>
                ) : null}
                {extraOf ? extraOf(index) : null}
                {statOf && selector !== "" ? (
                  <span className="text-caption tabular-nums">
                    {statOf(selector, index)}
                  </span>
                ) : null}
                {isEditable ? (
                  <span className="flex shrink-0 gap-1">
                    <IconButton
                      data-model-move={`${key}:up`}
                      variant="ghost"
                      isIconOnly
                      label={`Move ${name} up`}
                      isDisabled={index === 0}
                      onPress={() => move(index, index - 1)}
                    >
                      <FiArrowUp aria-hidden />
                    </IconButton>
                    <IconButton
                      data-model-move={`${key}:down`}
                      variant="ghost"
                      isIconOnly
                      label={`Move ${name} down`}
                      isDisabled={index === models.length - 1}
                      onPress={() => move(index, index + 1)}
                    >
                      <FiArrowDown aria-hidden />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      isIconOnly
                      label={`Remove ${name}`}
                      isDisabled={models.length <= minRows}
                      onPress={() => {
                        setKeys((prev) => prev.filter((_, i) => i !== index))
                        onRemove?.(index)
                      }}
                    >
                      <FiX aria-hidden />
                    </IconButton>
                  </span>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}
      {isEditable && onAdd ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="ghost"
            isDisabled={!canAdd}
            onPress={() => {
              setKeys((prev) => [...prev, newRowKey()])
              onAdd()
            }}
          >
            <FiPlus aria-hidden />
            {addLabel}
          </Button>
          {!canAdd && addNote ? (
            <span className="text-caption">{addNote}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
