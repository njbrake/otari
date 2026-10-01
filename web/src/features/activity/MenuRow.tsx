import type { ReactNode } from "react"
import type { IconType } from "react-icons"
import { FiCheck } from "react-icons/fi"

/**
 * One row of the page's popover menus (views, column filters, live updates):
 * a label with an optional leading mark and a trailing detail.
 *
 * A `check` row reserves the leading lane for a check on every row of a list,
 * so the chosen row's label stays in the column the others sit in. An `action`
 * row leads with its `icon`, if it has one.
 */
export function MenuRow({
  children,
  onPress,
  kind = "action",
  icon: Icon,
  isChecked = false,
  trailing,
  ariaLabel,
}: {
  children: ReactNode
  onPress: () => void
  kind?: "action" | "check"
  icon?: IconType
  /** For a `check` row: whether it is the one chosen. */
  isChecked?: boolean
  trailing?: ReactNode
  ariaLabel?: string
}) {
  const isCheck = kind === "check"
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={ariaLabel}
      aria-pressed={isCheck ? isChecked : undefined}
      className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-alt focus-visible:otari-focus-ring md:min-h-8 ${
        isChecked ? "font-medium text-foreground" : "text-muted"
      }`}
    >
      {isCheck ? (
        <span className="flex w-3.5 shrink-0">
          {isChecked ? <FiCheck aria-hidden className="size-3.5" /> : null}
        </span>
      ) : Icon ? (
        <Icon aria-hidden className="size-3.5 shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing}
    </button>
  )
}

/** The label over a run of menu rows, which is useless apart from them. */
export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-3 pt-2 pb-1 text-overline">{children}</div>
}
