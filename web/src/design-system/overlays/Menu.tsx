import { Dropdown, Header, Menu as HeroMenu } from "@heroui/react"
import type { ReactElement, ReactNode } from "react"
import type { IconType } from "react-icons"
import { FiCheck, FiChevronRight } from "react-icons/fi"

type SelectionMode = "none" | "single" | "multiple"

/**
 * A list of actions, or of choices, that the keyboard moves through with the
 * arrow keys: react-aria's menu, wearing the dashboard's rows.
 *
 * `selectionMode` decides what an item is. With none, each runs `onAction`;
 * with `single` or `multiple`, each is a choice whose check `selectedKeys`
 * says, and pressing one still reports it through `onAction`, so the caller
 * owns the state the way every control here does.
 *
 * This is the menu laid inline, for a panel that holds more than a menu (a
 * filter popover, a saved-views panel with a form in it). A menu that is the
 * whole of what a button opens is `MenuButton`.
 */
export function Menu({
  label,
  children,
  selectionMode = "none",
  selectedKeys,
  onAction,
  closesOnAction = false,
}: {
  /** The menu's accessible name: a heading drawn above it does not supply one. */
  label: string
  children: ReactNode
  selectionMode?: SelectionMode
  selectedKeys?: Iterable<string>
  onAction?: (key: string) => void
  /**
   * Whether pressing an item closes the overlay around the menu. Off for a
   * menu laid in a panel, which closes when the caller says, since the panel
   * holds more than the menu.
   */
  closesOnAction?: boolean
}) {
  return (
    <HeroMenu
      aria-label={label}
      selectionMode={selectionMode}
      selectedKeys={selectedKeys}
      onAction={(key) => onAction?.(String(key))}
      shouldCloseOnSelect={closesOnAction}
      className="gap-0 p-0 py-1"
    >
      {children}
    </HeroMenu>
  )
}

/**
 * A button that opens a menu: "Group by", a row's filter, a set of bulk
 * actions. The menu closes as an item is pressed and focus goes back to the
 * trigger, so a dialog an item opens hands focus back to something still
 * there.
 *
 * The trigger is rendered as-is, as `Popover`'s is, so it has to be a
 * react-aria pressable: our `Button` or `IconButton`. `header` is anything to
 * read before the items, such as what the actions apply to.
 */
export function MenuButton({
  trigger,
  label,
  placement = "bottom end",
  width = "sm",
  header,
  ...menu
}: Parameters<typeof Menu>[0] & {
  trigger: ReactElement
  placement?: "bottom" | "bottom end" | "top"
  /** `sm` for short labels, `md` for a menu with a sentence above it. */
  width?: "sm" | "md"
  header?: ReactNode
}) {
  return (
    <Dropdown>
      {trigger}
      <Dropdown.Popover
        placement={placement}
        className={`max-w-[calc(100vw-2rem)] p-0 ${width === "md" ? "w-[18.75rem]" : "w-60"}`}
      >
        {header}
        <Menu label={label} closesOnAction {...menu} />
      </Dropdown.Popover>
    </Dropdown>
  )
}

/**
 * One row of a menu: its label, an optional leading glyph, and a trailing
 * detail (a count, an owner, a note on what pressing it did).
 *
 * In a menu that selects, the leading lane is the check, reserved on every
 * row so a chosen row's label stays in the column the others sit in, and the
 * chosen row takes the foreground ink. `textValue` is what type-ahead and a
 * screen reader read, and is owed whenever `children` is not plain text.
 */
export function MenuItem({
  id,
  children,
  icon: Icon,
  trailing,
  textValue,
}: {
  id: string
  children: ReactNode
  icon?: IconType
  trailing?: ReactNode
  textValue?: string
}) {
  return (
    <HeroMenu.Item
      id={id}
      textValue={
        textValue ?? (typeof children === "string" ? children : undefined)
      }
      className="min-h-11 gap-2 px-3 py-1.5 text-sm text-muted hover:bg-surface-alt data-[focused=true]:bg-surface-alt data-[selected=true]:font-medium data-[selected=true]:text-foreground md:min-h-8"
    >
      {({ selectionMode, isSelected }) => (
        <>
          {selectionMode === "none" ? (
            Icon ? (
              <Icon aria-hidden className="size-3.5 shrink-0" />
            ) : null
          ) : (
            <span className="flex w-3.5 shrink-0">
              {isSelected ? <FiCheck aria-hidden className="size-3.5" /> : null}
            </span>
          )}
          <span className="min-w-0 flex-1">{children}</span>
          {trailing}
        </>
      )}
    </HeroMenu.Item>
  )
}

/** A titled run of items, ruled off from the run above it. */
export function MenuSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <HeroMenu.Section className="not-first:mt-1 not-first:border-t not-first:border-border-subtle not-first:pt-1">
      <Header className="px-3 pt-2 pb-1 text-overline">{title}</Header>
      {children}
    </HeroMenu.Section>
  )
}

/**
 * An item that opens a further menu beside it, for a set of actions that
 * would double the menu's length if listed inline: one per saved view, say.
 * Its own `onAction` reports the key of the item pressed inside, and
 * `closesOnAction` follows the menu it sits in.
 */
export function MenuSubmenu({
  id,
  label,
  icon,
  children,
  onAction,
  closesOnAction = false,
}: {
  id: string
  label: string
  icon?: IconType
  children: ReactNode
  onAction: (key: string) => void
  closesOnAction?: boolean
}) {
  return (
    <Dropdown.SubmenuTrigger>
      <MenuItem
        id={id}
        icon={icon}
        trailing={<FiChevronRight aria-hidden className="size-3.5 shrink-0" />}
      >
        {label}
      </MenuItem>
      <Dropdown.Popover className="w-60 max-w-[calc(100vw-2rem)] p-0">
        <Menu label={label} onAction={onAction} closesOnAction={closesOnAction}>
          {children}
        </Menu>
      </Dropdown.Popover>
    </Dropdown.SubmenuTrigger>
  )
}
