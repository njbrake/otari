# Overlays

Several components put something on top of the page, and picking the wrong one is
the most common mistake here, so start with the question rather than the list.

```text
Does the operator need to interact with what appears?
 ├── No, it is a label for the thing they are pointing at
 │    └── Tooltip                  (hover/focus, no focus of its own)
 └── Yes
      ├── Is it about the control that opened it?
      │    └── Yes -> Popover      (anchored, takes focus, not modal)
      │         or MenuButton      (when all it holds is actions or choices)
      ├── Is it a place to read or adjust beside the page, which stays put?
      │    └── Yes -> Sheet        (from the right, or a phone's bottom or full screen)
      └── Does it want the whole screen's attention?
           └── Yes -> FormDialog   (a place to work: creating or editing)
                or ConfirmDialog   (one question: are you sure)
                or Dialog          (neither: a guided step, a receipt)
```

Three, not five: the tree names three dialogs and they are one answer between
them. A dialog is the answer to "does it want the whole screen's attention",
and which of the three is a second question, asked in the section below.

The dialogs live in [feedback.md](feedback.md)'s directory rather than this one,
because a dialog is nearly always feedback about an action; they are listed here
because they are the third answer to the same question.

## Tooltip

**A tooltip is never the only channel.** It does not exist on a phone, so
anything only it says is unsaid for a touch operator. That is the rule from
[motion-and-access.md](motion-and-access.md) applied at its hardest, and it
leaves exactly two honest uses:

- **A repetition.** Spelling out an icon-only control that already carries an
  `aria-label`, so a pointer user and a screen reader get the same sentence.
- **Precision beside a rounded value.** An exact timestamp next to "6m ago".

Anything an operator needs in order to *act* goes on the page. A description
under a field, a caption under a value, or a `Badge` on the row: all three are
readable on a phone and none of them needs a pointer.

It takes its trigger as `children` rather than as a prop, so the trigger keeps
its own type: an `IconButton` inside one is still an `IconButton`, with its
required label and its 44px box intact.

**It opens after 300ms, not HeroUI's 1.5s.** The library reads `--tooltip-delay`
off the document root and ships it at react-aria's warmup default, which is long
enough that a lane of icon actions reads as having no labels at all. The
component sets the delay itself, so a call site never has to.

**Which of the two forms you want depends on whether the trigger takes DOM
props.** HeroUI's own trigger is a `div` the library gives `role="button"` and
`tabIndex=0`, which is what makes a non-interactive trigger reachable at all and
is wrong around a real `<button>`: it announces "Delete button" inside "Delete
button", takes a tab stop of its own, and gives every `getByRole("button")` two
matches instead of one. Hand the function form a native control instead, and it
spreads the props it is given onto that control, so the trigger and the control
are one element. `RowAction`'s glyph is the worked example.

A HeroUI `Button` (so `IconButton` too) is the exception and keeps the wrapper:
its props are react-aria's rather than the DOM's, so the trigger's `onClick` and
`onPointerEnter` do not typecheck against it, let alone reach an element. Its 44px
box and required label are unharmed by the wrapper; the duplicate name is the
cost, and #2123 is where that is written down rather than solved.

```tsx
// Correct: a native control takes the trigger's props rather than a wrapper
<Tooltip content="Delete">
  {(props) => (
    <button {...props} type="button" aria-label="Delete">
      <FiTrash2 aria-hidden className="h-3.5 w-3.5" />
    </button>
  )}
</Tooltip>

// Correct: a node that is not a control is wrapped, which is what gives it the
// keyboard reach it has none of on its own
<Tooltip content="2026-09-11 14:02:11 UTC">
  <span className="text-caption">6m ago</span>
</Tooltip>

// Incorrect: the reason a control is refused has to be reachable without a
// pointer, and a disabled control takes no focus, so this reaches nobody who
// needs it. Put it in the accessible name (see RowAction's ariaLabel), which is
// what `RowAction` does for its own glyphs, with a native `title` beside it for
// the pointer the tooltip cannot reach.
<Tooltip content="An organization owner manages this key">
  <RowAction isDisabled onPress={revoke}>Revoke</RowAction>
</Tooltip>
```

## Popover

Anchored to its trigger, takes focus, and is dismissed deliberately. Right for a
column picker, a small confirm about one row, a panel of detail about the thing
that opened it.

The default panel owns its padding. For sectioned content with full-width
rules, use `padding="none"` and put padding on each child section. Use
`placement="bottom end"` to align the panel's right edge with its trigger.

`label` is required and names the panel. A heading drawn inside it does not
supply that name, so without `label` the dialog is announced unnamed.

The trigger is rendered as-is, not wrapped, which is what keeps one button in
the accessibility tree rather than the two the Tooltip section describes. So it
has to be a react-aria pressable: `Button` or `IconButton`. A `<span>` or a
native `<button>` renders and never opens the panel, and nothing reports it.

Uncontrolled by default, which is the opposite of the dialogs and deliberate: a
popover's trigger is inside it, so it can own that state. Pass `isOpen` and
`onOpenChange` for the case where something else has to close it, such as a
route change or a mutation landing.

Its content is wrapped in HeroUI's popover dialog, which is what puts the panel
in the accessibility tree and traps focus while it is open. Without that it is a
div a keyboard operator tabs straight past, which is why the component does it
rather than leaving it to a call site.

**Dismiss it before reaching for the page behind it.** It holds focus while
open, which is also the thing that trips the Playwright suite; web/AGENTS.md
says the same about React Aria popovers under "Checks".

## Menu

A popover whose whole content is a list of actions or choices is a menu, and
it is `MenuButton` rather than a `Popover` of hand-rolled rows: react-aria's
menu brings the arrow keys, type-ahead, and the roles a screen reader
announces (`menuitem`, or `menuitemradio` and `menuitemcheckbox` for a menu
that selects), none of which a row of `<button>`s has. It closes as an item is
pressed and hands focus back to its trigger, which, like `Popover`'s, is
rendered as-is and has to be our `Button` or `IconButton`.

`selectionMode` says what an item is. With none, each runs `onAction`; with
`single` or `multiple`, each is a choice, its check is `selectedKeys`, and the
caller owns the state. A choice of one out of a small fixed set that filters a
page is still `FilterSelect` (see [forms.md](forms.md)); a menu that selects is
for a choice that rearranges rather than filters, such as "Group by".

A panel that holds more than a menu (a filter popover with a search box, a
views panel with a save form) stays a `Popover` and lays `Menu` inside it,
one per run of items. An inline menu does not close the panel by itself: the
caller closes it when an action is done. `MenuSubmenu` moves a run that would
double the menu's length (one item per saved view) one level down.

An item holds text, a leading glyph and a trailing detail, never a second
control: a button inside a `menuitem` is a nested interactive element no
assistive technology reads well. Where a row seems to need one, the action is
an item of its own or a submenu.

## Sheet

A panel that slides in from an edge while the page it came from stays where
it was: from the right beside what it is about (a request's detail, the way
in to a model), from the bottom as a phone's sheet (filters), or over the whole
screen as a phone's pushed view. One frame for all of them, so the backdrop,
the edge it draws against the page, the header and the safe-area padding are
decided once.

`title` gives it a header: the heading, any `actions`, and a Close, which is
an `IconButton` in every sheet. A pushed view takes `back` instead, a way back
named for where it returns to. With neither, the body owns the whole panel,
for content that brings its own header. The body owns its padding.

Controlled, like the dialogs, because a sheet usually opens from a row or a
link elsewhere on the page. A sheet with a trigger of its own (a phone's menu
button) passes it as `trigger`, which is rendered as-is and has to be our
`Button` or `IconButton`, as `Popover`'s is.

## The three dialogs

Modal. Three of them, and the question sorts them:

- **`FormDialog`** when the operator is creating or editing an object. Every
  create flow in the product, no exceptions. See [feedback.md](feedback.md).
- **`ConfirmDialog`** when the dialog's whole job is "are you sure", which
  includes every delete of a record.
- **`Dialog`** when it is neither: a guided step, a receipt, a thing to read and
  copy. It owns no submit and asks no question, which is exactly why the other
  two would be a lie about what the frame does.

`Dialog` is the plain frame and the newest of the three, and the one thing to
know about reaching for it is that "this is not a form" is not sufficient
reason: a create flow whose submit you would hand-roll in the footer still wants
`FormDialog`, which owns the submit, its pending state and its error surface.

There was a fourth, a bare `AlertDialog` shell the form pattern was built from.
It is gone: a form wants `FormDialog`, which is a `Modal`, because an alert
interrupts to ask one question and a form is a place to work, and once nothing
hand-rolled a form dialog the shell had no call sites left.

Both are controlled only, because a dialog opens from something elsewhere
on the page (a row's Edit, a heading row's Create) rather than from a trigger
inside itself. Both mount their body only while open, which is not an
optimization: the body of a form dialog holds controlled inputs, and leaving
them mounted carries one row's draft into the next row's dialog.

`isDismissable` is on by default. Turning it off takes away Escape and the
outside click, and there are two honest reasons. Unsaved work that would be
lost, where even then the better fix is usually to keep the dismiss and confirm
the discard. And a frame whose only dismissal is recorded on the server: the
first-run sheet retires on Skip and nothing else, so an Escape that put it away
for one page load would come back on the next one and read as a dismissal that
did not take. A frame with neither reason keeps its Escape.
