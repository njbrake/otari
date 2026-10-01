import { useState } from "react"
import { FiBookmark, FiChevronDown, FiLink, FiPlus, FiX } from "react-icons/fi"
import type { SavedView } from "@/client"
import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { Field } from "@/design-system/forms/Field"
import { copyToClipboard } from "@/design-system/helpers/clipboard"
import { Divider } from "@/design-system/layout/Divider"
import { Popover } from "@/design-system/overlays/Popover"
import { BUILT_IN_VIEWS, type BuiltInView } from "./activityQuery"
import { MenuHeading, MenuRow } from "./MenuRow"

/**
 * The views menu beside the page title: the built-in views, the caller's own,
 * and those shared in the workspace, plus saving the current one and copying
 * its link.
 *
 * A view is the page's query string under a name, so the menu only ever
 * reports a query to apply; the page owns the URL. `current` is the view the
 * page is showing, and `isDirty` marks one that has been changed since.
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
  // Closing by hand, as applying or saving does, skips `onOpenChange`, so both
  // ways out come through here.
  const close = () => {
    setIsOpen(false)
    setIsNaming(false)
    setCopied(undefined)
    onClose()
  }
  const apply = (view: BuiltInView) => {
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
  const viewRow = (view: SavedView, canDelete: boolean, owner?: string) => (
    <div key={view.id} className="flex items-center">
      <MenuRow
        kind="check"
        isChecked={view === matching}
        onPress={() => apply(view)}
        trailing={
          owner ? (
            <span className="text-mono-micro text-subtle">{owner}</span>
          ) : undefined
        }
      >
        {view.name}
      </MenuRow>
      {canDelete ? (
        <button
          type="button"
          aria-label={`Delete ${view.name}`}
          onClick={() => onDelete(view)}
          className="flex min-h-11 w-11 shrink-0 items-center justify-center text-subtle hover:text-foreground focus-visible:otari-focus-ring md:min-h-8 md:w-8"
        >
          <FiX aria-hidden className="size-3" />
        </button>
      ) : null}
    </div>
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
            {isDirty ? (
              <span aria-hidden className="size-1.5 shrink-0 bg-attention" />
            ) : null}
            <FiChevronDown aria-hidden className="size-3.5" />
          </Button>
        )
      }
    >
      <div className="flex w-[18.75rem] flex-col py-1">
        <MenuHeading>Built in</MenuHeading>
        {BUILT_IN_VIEWS.map((view) => (
          <MenuRow
            key={view.name}
            kind="check"
            isChecked={view === matching}
            onPress={() => apply(view)}
          >
            {view.name}
          </MenuRow>
        ))}
        <Divider weight="subtle" className="my-1" />
        <MenuHeading>Yours</MenuHeading>
        {own.length ? (
          own.map((view) => viewRow(view, true))
        ) : (
          <p className="px-3 pt-0.5 pb-1.5 text-caption text-subtle">
            None saved yet.
          </p>
        )}
        {shared.length ? (
          <>
            <Divider weight="subtle" className="my-1" />
            <MenuHeading>Shared in this workspace</MenuHeading>
            {shared.map((view) =>
              viewRow(
                view,
                view.is_mine || canShare,
                view.is_mine ? "you" : (view.owner_name ?? undefined),
              ),
            )}
          </>
        ) : null}
        <Divider weight="subtle" className="my-1" />
        {!canSave ? null : isNaming ? (
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
        ) : (
          <MenuRow icon={FiPlus} onPress={() => setIsNaming(true)}>
            {isDirty ? "Save changes as a new view…" : "Save current view…"}
          </MenuRow>
        )}
        {error ? (
          <div className="px-3 pb-1.5">
            <ErrorBanner error={error} />
          </div>
        ) : null}
        <MenuRow
          icon={FiLink}
          onPress={async () =>
            setCopied(
              (await copyToClipboard(window.location.href))
                ? "copied"
                : "failed",
            )
          }
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
        </MenuRow>
      </div>
    </Popover>
  )
}
