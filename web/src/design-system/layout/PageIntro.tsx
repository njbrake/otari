import type { ReactNode } from "react"

import { DocsLink } from "../navigation/DocsLink"

/**
 * A page's opening: its title, the paragraph under it, and the one action that
 * belongs beside rather than below them.
 *
 * Shared so the type of a page title is decided once rather than respelled on
 * every page. The title is `text-display`, the scale's 28/34 semibold step; the
 * weight axis has only 550 and 600, so an arbitrary utility asking for 600
 * lands on 550 instead. Do not quote an arbitrary size spelling anywhere in
 * this file, comments included: `foundation.test.ts` matches that spelling
 * against raw file contents without stripping comments first, so a quoted
 * example keeps the file on the offender list with nothing wrong to find.
 *
 * `pb-5` rather than a gap on the parent, because a page is a stack of bands
 * that set their own rules and spacing, and a column gap would add air above
 * the first rule as well.
 *
 * The row is decided by the width of the content pane, not the viewport: a
 * container query against `<main>`, which the app makes a container for the
 * band's `100cqw`. On a tablet the rail takes a third of a 768px screen, and a
 * viewport breakpoint put two actions beside a paragraph squeezed to a
 * 200px column and pushed the second action past the edge. Where no container
 * encloses it (a story), the header stays stacked.
 */
export function PageIntro({
  title,
  beside,
  action,
  docsHref,
  children,
}: {
  title: string
  /**
   * A control that belongs to the title rather than to the page, set on the
   * title's line: which saved view of the page is showing, say.
   */
  beside?: ReactNode
  action?: ReactNode
  /**
   * Trails the description rather than sitting in `action`: a link to the
   * manual is not the one thing the page exists to do, and putting it in the
   * action slot is how a page ends up with two things competing to be that.
   */
  docsHref?: string
  children?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-4 pb-5 @2xl:flex-row @2xl:items-start @2xl:justify-between">
      <div className="max-w-[38.75rem]">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-display">{title}</h1>
          {beside}
        </div>
        {children || docsHref ? (
          <p className="mt-1 text-sm text-muted">
            {children}
            {docsHref ? (
              <>
                {children ? " " : null}
                <DocsLink href={docsHref} />
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  )
}
