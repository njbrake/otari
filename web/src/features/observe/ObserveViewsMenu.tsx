import { Header, ListBox, ListBoxItem, ListBoxSection } from "@heroui/react"
import { useState } from "react"
import type { IconType } from "react-icons"
import {
  FiBookmark,
  FiChevronDown,
  FiEdit2,
  FiLink,
  FiPlus,
  FiSave,
  FiShare2,
  FiTrash2,
  FiUsers,
} from "react-icons/fi"

import type { SavedView, SavedViewPage } from "@/client"
import { Button } from "@/design-system/actions/Button"
import { ConfirmDialog } from "@/design-system/feedback/ConfirmDialog"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { Field } from "@/design-system/forms/Field"
import { copyToClipboard } from "@/design-system/helpers/clipboard"
import { Dot } from "@/design-system/indicators/Dot"
import { Divider } from "@/design-system/layout/Divider"
import { Popover } from "@/design-system/overlays/Popover"
import { type ObserveViews, useObserveViews } from "./useObserveViews"

/**
 * The Views control in a Sessions tab's toolbar: the page's built-in views,
 * the caller's own and those shared in the workspace, and saving, renaming,
 * sharing, deleting and linking to them. A view is the page's query string
 * under a name, so applying one is a URL change and its link needs nothing
 * stored. Offered once a workspace is selected, which is where views are kept.
 */
export function ObserveViewsMenu({ page }: { page: SavedViewPage }) {
  const views = useObserveViews(page)
  return views.workspaceId ? <ViewsMenu views={views} /> : null
}

function ViewsMenu({ views }: { views: ObserveViews }) {
  const [isOpen, setIsOpen] = useState(false)
  const [form, setForm] = useState<"" | "save" | "rename">("")
  const [deleting, setDeleting] = useState<SavedView>()
  const [copied, setCopied] = useState<"copied" | "failed">()
  const { current, isChanged } = views

  const groups = [
    { title: "Built in", rows: views.views.filter((view) => view.built_in) },
    { title: "Yours", rows: views.views.filter((view) => view.is_mine) },
    {
      title: "Shared",
      rows: views.views.filter((view) => !view.built_in && !view.is_mine),
    },
  ].filter((group) => group.rows.length > 0)

  const close = () => {
    setIsOpen(false)
    setForm("")
    setCopied(undefined)
    views.resetErrors()
  }
  // A refused write keeps the form open with what was typed, and says why below it.
  const attempt = async (write: () => Promise<unknown>, after: () => void) => {
    try {
      await write()
    } catch {
      return
    }
    after()
  }
  const apply = (id: string) => {
    const view = views.views.find((one) => one.id === id)
    if (!view) return
    views.apply(view)
    close()
  }

  // What can be done to the page's view, and to the view it shows.
  const actions: { id: string; label: string; icon: IconType }[] = [
    { id: "save", label: "Save current view…", icon: FiPlus },
    ...(current && isChanged && current.can_edit
      ? [
          {
            id: "update",
            label: `Save changes to ${current.name}`,
            icon: FiSave,
          },
        ]
      : []),
    ...(current?.can_edit
      ? [{ id: "rename", label: `Rename ${current.name}…`, icon: FiEdit2 }]
      : []),
    // Someone who no longer manages the workspace may still stop sharing their view.
    ...(current?.is_mine && (views.canShare || current.shared)
      ? [
          {
            id: "share",
            label: current.shared
              ? `Stop sharing ${current.name}`
              : `Share ${current.name} with the workspace`,
            icon: FiShare2,
          },
        ]
      : []),
    ...(current?.can_delete
      ? [{ id: "delete", label: `Delete ${current.name}…`, icon: FiTrash2 }]
      : []),
    { id: "copy", label: "Copy link", icon: FiLink },
  ]
  const act = async (id: string) => {
    views.resetErrors()
    if (id === "save" || id === "rename") setForm(id)
    else if (id === "update" && current)
      await attempt(() => views.overwrite(current), close)
    else if (id === "share" && current)
      await attempt(
        () => views.setShared(current, !current.shared),
        () => undefined,
      )
    else if (id === "delete" && current) {
      close()
      setDeleting(current)
    } else if (id === "copy")
      setCopied(
        (await copyToClipboard(window.location.href)) ? "copied" : "failed",
      )
  }

  return (
    <>
      <Popover
        label="Views"
        padding="none"
        isOpen={isOpen}
        onOpenChange={(open) => (open ? setIsOpen(true) : close())}
        trigger={
          <Button
            size="sm"
            // One width whatever the name, so the controls after it never move.
            className="w-36 justify-start md:w-44"
            aria-label={
              current
                ? `Views: ${current.name}${isChanged ? ", changed" : ""}`
                : "Views"
            }
          >
            <FiBookmark aria-hidden className="size-3.5" />
            <span
              className="min-w-0 flex-1 truncate text-left"
              title={current?.name}
            >
              {current?.name ?? "Views"}
            </span>
            {isChanged ? <Dot className="rounded-full bg-attention" /> : null}
            <FiChevronDown aria-hidden className="size-3.5" />
          </Button>
        }
      >
        <div className="flex max-h-[min(36rem,75vh)] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto py-1">
          <ErrorBanner error={views.readError} />
          <ListBox
            aria-label="Views"
            selectionMode="single"
            selectedKeys={views.matchingId ? [views.matchingId] : []}
            onSelectionChange={(keys) => {
              if (keys !== "all") {
                const [key] = [...keys]
                if (key !== undefined) apply(String(key))
              }
            }}
          >
            {groups.map((group) => (
              <ListBoxSection key={group.title} aria-label={group.title}>
                <Header className="px-2 pt-1 pb-0.5 text-overline">
                  {group.title}
                </Header>
                {group.rows.map((view) => (
                  <ListBoxItem key={view.id} id={view.id} textValue={view.name}>
                    <span className="min-w-0 flex-1 truncate">{view.name}</span>
                    {view.is_mine && view.shared ? (
                      <FiUsers
                        aria-label="Shared"
                        className="size-3.5 shrink-0 text-subtle"
                      />
                    ) : null}
                    {!view.is_mine && view.owner_name ? (
                      <span className="max-w-[8rem] shrink-0 truncate text-mono-micro text-subtle">
                        {view.owner_name}
                      </span>
                    ) : null}
                    <ListBoxItem.Indicator />
                  </ListBoxItem>
                ))}
              </ListBoxSection>
            ))}
          </ListBox>
          <Divider weight="subtle" className="my-1" />
          {form === "save" ? (
            <NameForm
              label="View name"
              initial=""
              submitLabel="Save"
              isPending={views.isSaving}
              canShare={views.canShare}
              onCancel={() => setForm("")}
              onSubmit={(name, share) =>
                attempt(() => views.save(name, share), close)
              }
            />
          ) : form === "rename" && current ? (
            <NameForm
              label="New name"
              initial={current.name}
              submitLabel="Rename"
              isPending={views.isSaving}
              onCancel={() => setForm("")}
              onSubmit={(name) =>
                attempt(
                  () => views.rename(current, name),
                  () => setForm(""),
                )
              }
            />
          ) : (
            <ListBox
              aria-label="View actions"
              onAction={(key) => void act(String(key))}
            >
              {actions.map((action) => (
                <ListBoxItem
                  key={action.id}
                  id={action.id}
                  textValue={action.label}
                >
                  <action.icon aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {action.label}
                  </span>
                  {action.id === "copy" && copied ? (
                    <span
                      aria-live="polite"
                      className={`text-mono-micro ${copied === "copied" ? "text-success" : "text-danger"}`}
                    >
                      {copied === "copied" ? "Copied" : "Copy blocked"}
                    </span>
                  ) : null}
                </ListBoxItem>
              ))}
            </ListBox>
          )}
          {views.error ? (
            <div className="px-3 pt-1">
              <ErrorBanner error={views.error} />
            </div>
          ) : null}
        </div>
      </Popover>
      <ConfirmDialog
        isOpen={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(undefined)
            views.resetErrors()
          }
        }}
        heading={`Delete ${deleting?.name ?? "view"}?`}
        body={
          deleting?.shared
            ? "It is removed for everyone in the workspace."
            : "Only the view is removed; no requests or sessions change."
        }
        confirmLabel="Delete view"
        isPending={views.isRemoving}
        error={views.error}
        onConfirm={() => {
          if (!deleting) return
          void attempt(
            () => views.remove(deleting),
            () => setDeleting(undefined),
          )
        }}
      />
    </>
  )
}

function NameForm({
  label,
  initial,
  submitLabel,
  isPending,
  canShare = false,
  onSubmit,
  onCancel,
}: {
  label: string
  initial: string
  submitLabel: string
  isPending: boolean
  /** Offer sharing with the workspace, to someone who manages it. */
  canShare?: boolean
  onSubmit: (name: string, share: boolean) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const [share, setShare] = useState(false)
  return (
    <form
      className="flex flex-col gap-2 px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (name.trim()) onSubmit(name.trim(), share)
      }}
    >
      {/* Inside a popover the reader just opened, so the keyboard is expected here. */}
      <Field label={label} value={name} onChange={setName} autoFocus />
      {canShare ? (
        <Checkbox isSelected={share} onChange={setShare}>
          Share with the workspace
        </Checkbox>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          type="submit"
          isPending={isPending}
          isDisabled={!name.trim()}
        >
          {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
