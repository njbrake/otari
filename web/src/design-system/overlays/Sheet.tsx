import { Drawer } from "@heroui/react"
import type { ReactElement, ReactNode } from "react"
import { FiChevronLeft, FiX } from "react-icons/fi"
import { Button } from "../actions/Button"
import { IconButton } from "../actions/IconButton"

// Literal classes, so Tailwind emits each one.
const SIZES = {
  sm: "w-72",
  md: "w-[26.25rem]",
  lg: "w-[36rem]",
} as const

const FRAMES = {
  right: "h-full max-w-[85vw] border-l border-control-border",
  bottom: "max-h-[82dvh] border-t border-control-border",
  full: "h-dvh w-full max-w-none pt-[env(safe-area-inset-top)]",
} as const

/**
 * A panel that slides over the page from an edge: from the right beside what
 * it is about, from the bottom as a phone's sheet, or over the whole screen
 * as a phone's pushed view.
 *
 * The line against `Dialog`: a dialog interrupts with one task in the middle
 * of the screen, a sheet holds a place to read or adjust while the page it
 * came from stays where it was.
 *
 * With a `title` it draws its own header: the heading, any `actions`, and a
 * Close. A pushed view takes `back` instead, the way back named for where it
 * returns to. Without either the body owns the whole panel, for content that
 * brings its own header.
 *
 * Controlled, like the dialogs, unless it is given a `trigger`, which is
 * rendered as-is and has to be our `Button` or `IconButton`.
 */
export function Sheet({
  isOpen,
  onOpenChange,
  label,
  placement = "right",
  size = "md",
  title,
  description,
  actions,
  back,
  footer,
  trigger,
  id,
  children,
}: {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  /** The panel's accessible name. */
  label: string
  placement?: "right" | "bottom" | "full"
  /** A right sheet's width. */
  size?: keyof typeof SIZES
  title?: ReactNode
  description?: ReactNode
  /** Header controls set before the Close. */
  actions?: ReactNode
  /** For a pushed view: the way back, in place of a header. */
  back?: { label: string; onPress: () => void }
  footer?: ReactNode
  /** The control that opens it, when one inside the sheet's own tree does. */
  trigger?: ReactElement
  /** For a page that has to tell this panel's keys from another dialog's. */
  id?: string
  children: ReactNode
}) {
  const close = () => onOpenChange(false)
  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange}>
      {trigger ?? (
        // Driven from state; the trigger slot is filled and hidden, as the
        // dialogs do. Empty rather than named: the drawer's trigger is a
        // button that drops `aria-hidden`, so a name here would be a second
        // control answering to the one that opens the sheet.
        <Drawer.Trigger className="hidden" />
      )}
      <Drawer.Backdrop className="bg-backdrop/30">
        {/* The content is the full-width lane the dialog slides in on; the
            width belongs to the dialog, or the lane shrinks and the panel
            lands at the left. */}
        <Drawer.Content placement={placement === "bottom" ? "bottom" : "right"}>
          <Drawer.Dialog
            id={id}
            aria-label={label}
            className={`flex flex-col bg-surface p-0 ${FRAMES[placement]} ${
              placement === "right" ? SIZES[size] : ""
            }`}
          >
            {back ? (
              <div className="flex shrink-0 items-center border-b border-border p-1.5">
                <Button onPress={back.onPress} className="gap-0.5 pl-1.5">
                  <FiChevronLeft aria-hidden className="size-[1.125rem]" />
                  {back.label}
                </Button>
              </div>
            ) : title !== undefined ? (
              <Drawer.Header className="flex flex-row items-start gap-2 border-b border-border py-2 pr-2 pl-4">
                <div className="flex min-w-0 flex-1 flex-col gap-1 py-2">
                  <Drawer.Heading className="text-title">
                    {title}
                  </Drawer.Heading>
                  {description ? (
                    <div className="text-sm text-muted">{description}</div>
                  ) : null}
                </div>
                {actions ? (
                  <div className="flex items-center gap-2 py-px">{actions}</div>
                ) : null}
                <IconButton label="Close" onPress={close}>
                  <FiX aria-hidden className="size-4" />
                </IconButton>
              </Drawer.Header>
            ) : null}
            <Drawer.Body className="m-0 flex min-h-0 flex-1 flex-col overflow-y-auto p-0 text-foreground">
              {children}
            </Drawer.Body>
            {footer ? (
              <Drawer.Footer className="border-t border-border px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {footer}
              </Drawer.Footer>
            ) : null}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  )
}
