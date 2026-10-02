import { useState } from "react"
import {
  FiBookmark,
  FiChevronDown,
  FiLink,
  FiPlus,
  FiTrash2,
} from "react-icons/fi"
import type { SavedView } from "@/client"
import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { Field } from "@/design-system/forms/Field"
import { copyToClipboard } from "@/design-system/helpers/clipboard"
import { Dot } from "@/design-system/indicators/Dot"
import { Divider } from "@/design-system/layout/Divider"
import {
  Menu,
  MenuItem,
  MenuSection,
  MenuSubmenu,
} from "@/design-system/overlays/Menu"
import { Popover } from "@/design-system/overlays/Popover"
import { BUILT_IN_VIEWS, type BuiltInView } from "./activityQuery"

// A built-in view is known by its name, a saved one by its id: a saved view
// may share a built-in's name.
const builtInKey = (view: BuiltInView) => `built-in:${view.name}`
const savedKey = (view: SavedView) => `saved:${view.id}`

/**
 * The views menu beside the page title: the built-in views, the caller's own,
 * and those shared in the workspace, plus saving the current one, copying its
 * link and deleting one.
 *
 * A view is the page's query string under a name, so the menu only ever
 * reports a query to apply; the page owns the URL. `current` is the view the
 * page is showing, and `isDirty` marks one that has been changed since.
 *
 * A popover rather than a `MenuButton`, because the save form opens inside it:
 * the views and the actions are menus within it.
 */
export function SavedViewsMenu({
  views,
  current,
  matching,
  isDirty,
  canShare,
  canSave,
  onApply,
  onSave,
  onDelete,
  isSaving,
  error,
  onClose,
  isCompact = false,
}: {
  views: SavedView[]
  current: string | undefined
  /** The view the page matches, checked by identity: a saved view may share a built-in's name. */
  matching: BuiltInView | undefined
  isDirty: boolean
  canShare: boolean
  /** False with no workspace selected, which is where a view is kept. */
  canSave: boolean
  onApply: (view: BuiltInView) => void
  onSave: (name: string, shared: boolean) => Promise<unknown>
  onDelete: (view: SavedView) => void
  isSaving: boolean
  /** A save or a delete that failed, said inside the menu that made it. */
  error: unknown
  onClose: () => void
  /** A bare bookmark for a phone's header, where the current view is named beside it. */
  isCompact?: boolean
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [isNaming, setIsNaming] = useState(false)
  const [name, setName] = useState("")
  const [share, setShare] = useState(false)
  const [copied, setCopied] = useState<"copied" | "failed">()

  const own = views.filter((view) => view.is_mine && !view.shared)
  const shared = views.filter((view) => view.shared)
  const deletable = [
    ...own,
    ...shared.filter((view) => view.is_mine || canShare),
  ]
  const byKey = new Map<string, SavedView | BuiltInView>([
    ...BUILT_IN_VIEWS.map((view) => [builtInKey(view), view] as const),
    ...views.map((view) => [savedKey(view), view] as const),
  ])
  const matchingKey = [...byKey].find(([, view]) => view === matching)?.[0]
  // Closing by hand, as applying or saving does, skips `onOpenChange`, so both
  // ways out come through here.
  const close = () => {
    setIsOpen(false)
    setIsNaming(false)
    setCopied(undefined)
    onClose()
  }
  const apply = (key: string) => {
    const view = byKey.get(key)
    if (!view) return
    onApply(view)
    close()
  }
  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await onSave(trimmed, share)
    } catch {
      // The refusal arrives through `error` and is shown below the form, which
      // stays open with what was typed so it can be corrected.
      return
    }
    setName("")
    setShare(false)
    close()
  }
  const copyLink = async () =>
    setCopied(
      (await copyToClipboard(window.location.href)) ? "copied" : "failed",
    )
  const savedItem = (view: SavedView, owner?: string) => (
    <MenuItem
      key={view.id}
      id={savedKey(view)}
      textValue={view.name}
      trailing={
        owner ? (
          <span className="text-mono-micro text-subtle">{owner}</span>
        ) : undefined
      }
    >
      {view.name}
    </MenuItem>
  )

  return (
    <Popover
      label="Saved views"
      padding="none"
      isOpen={isOpen}
      onOpenChange={(open) => (open ? setIsOpen(true) : close())}
      trigger={
        isCompact ? (
          <IconButton label="Saved views">
            <FiBookmark aria-hidden className="size-4" />
          </IconButton>
        ) : (
          <Button
            size="sm"
            aria-label={`Saved views: ${current ?? "Unsaved view"}${isDirty ? ", changed since saved" : ""}`}
          >
            <FiBookmark aria-hidden className="size-3.5" />
            <span className="max-w-[12.5rem] truncate">
              {current ?? "Unsaved view"}
            </span>
            {isDirty ? <Dot className="bg-attention" /> : null}
            <FiChevronDown aria-hidden className="size-3.5" />
          </Button>
        )
      }
    >
      <div className="flex w-[18.75rem] flex-col">
        <Menu
          label="Views"
          selectionMode="single"
          selectedKeys={matchingKey ? [matchingKey] : []}
          onAction={apply}
        >
          <MenuSection title="Built in">
            {BUILT_IN_VIEWS.map((view) => (
              <MenuItem key={view.name} id={builtInKey(view)}>
                {view.name}
              </MenuItem>
            ))}
          </MenuSection>
          {own.length ? (
            <MenuSection title="Yours">
              {own.map((view) => savedItem(view))}
            </MenuSection>
          ) : null}
          {shared.length ? (
            <MenuSection title="Shared in this workspace">
              {shared.map((view) =>
                savedItem(
                  view,
                  view.is_mine ? "you" : (view.owner_name ?? undefined),
                ),
              )}
            </MenuSection>
          ) : null}
        </Menu>
        {own.length ? null : (
          <p className="px-3 pb-1.5 text-caption text-subtle">
            None of your own saved yet.
          </p>
        )}
        <Divider weight="subtle" />
        {canSave && isNaming ? (
          <form
            className="flex flex-col gap-2 px-3 py-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            {/* Inside a popover the reader just opened, so the keyboard is
                expected here rather than raised over a page load. */}
            <Field
              label="View name"
              value={name}
              onChange={setName}
              placeholder="Failures this week"
              autoFocus
            />
            {canShare ? (
              <Checkbox isSelected={share} onChange={setShare}>
                Share with the workspace
              </Checkbox>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              type="submit"
              isPending={isSaving}
              isDisabled={!name.trim()}
              className="self-start"
            >
              Save
            </Button>
          </form>
        ) : null}
        {error ? (
          <div className="px-3 pb-1.5">
            <ErrorBanner error={error} />
          </div>
        ) : null}
        <Menu
          label="View actions"
          onAction={(key) => {
            if (key === "save") setIsNaming(true)
            else if (key === "copy") void copyLink()
          }}
        >
          {canSave && !isNaming ? (
            <MenuItem id="save" icon={FiPlus}>
              {isDirty ? "Save changes as a new view…" : "Save current view…"}
            </MenuItem>
          ) : null}
          <MenuItem
            id="copy"
            icon={FiLink}
            textValue="Copy link to this view"
            trailing={
              copied ? (
                <span
                  aria-live="polite"
                  className={`text-mono-micro ${copied === "copied" ? "text-success" : "text-danger"}`}
                >
                  {copied === "copied" ? "copied" : "copy blocked"}
                </span>
              ) : null
            }
          >
            Copy link to this view
          </MenuItem>
          {deletable.length ? (
            <MenuSubmenu
              id="delete"
              label="Delete a view"
              icon={FiTrash2}
              onAction={(key) => {
                const view = deletable.find((one) => savedKey(one) === key)
                if (view) onDelete(view)
              }}
            >
              {deletable.map((view) => (
                <MenuItem key={view.id} id={savedKey(view)}>
                  {view.name}
                </MenuItem>
              ))}
            </MenuSubmenu>
          ) : null}
        </Menu>
      </div>
    </Popover>
  )
}
