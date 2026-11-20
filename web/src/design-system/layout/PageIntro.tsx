import type { ReactNode } from "react"

/**
 * A page's opening: its title and the one action that belongs beside it.
 *
 * No sentence under the title explains the page. A page says what it is by its
 * title and its content; a fixed paragraph above every table was read once and
 * then scrolled past on every visit after. `detail` is the exception, for a
 * line that is not an explanation: a record's own facts, a warning about this
 * record, or the page's only content (a not-found, a sign-in finishing).
 *
 * Shared so the type of a page title is decided once rather than respelled on
 * every page. The title is `text-display`, the scale's 28/34 semibold step; the
 * weight axis has only 550 and 600, so an arbitrary utility asking for 600
 * lands on 550 instead. Do not quote an arbitrary size spelling anywhere in
 * this file, comments included: `foundation.test.ts` matches that spelling
 * against raw file contents without stripping comments first, so a quoted
 * example keeps the file on the offender list with nothing wrong to find.
 *
 * The action sits beside the title while both fit and wraps under it when
 * they do not, as one flex row that wraps rather than a breakpoint: what fits
 * depends on the content column (a rail open or closed, a long title, a page
 * with three controls), not on the viewport. The action keeps to the trailing
 * edge on either line, takes the whole width on a phone as it always has, and
 * its own controls wrap inside it once it is narrower than they are, so
 * nothing in the header can push past the page.
 *
 * `pb-5` rather than a gap on the parent, because a page is a stack of bands
 * that set their own rules and spacing, and a column gap would add air above
 * the first rule as well.
 */
export function PageIntro({
  title,
  leading,
  action,
  detail,
}: {
  title: string
  /** A mark at the title's leading edge, such as a record's logo. Decorative: the title names it. */
  leading?: ReactNode
  action?: ReactNode
  /** The line under the title, for what this page is about rather than what it is for. */
  detail?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 pb-5">
      <div className="min-w-0 max-w-[38.75rem]">
        {leading ? (
          <div className="flex items-center gap-3">
            {leading}
            <h1 className="min-w-0 text-display break-words">{title}</h1>
          </div>
        ) : (
          <h1 className="text-display">{title}</h1>
        )}
        {detail ? <p className="mt-1 text-sm text-muted">{detail}</p> : null}
      </div>
      {action ? (
        <div className="ml-auto min-w-0 max-w-full max-sm:w-full">{action}</div>
      ) : null}
    </header>
  )
}
