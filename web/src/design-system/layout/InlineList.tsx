import { Children, type ReactNode } from "react"

/**
 * Short facts on one line, divided by middots, that wrap without leaving a
 * middot hanging at the end of a line or leading the next one.
 *
 * Each item carries its middot in front of it, and the row is shifted left by
 * one middot's width and clipped there: whichever item starts a line, the
 * first included, has its middot cut off, while the rest show theirs. Only the
 * inline axis is clipped, so a focus ring or a 44px touch target above and
 * below an item is untouched.
 *
 * `children` are the items; empty ones (`null`, `false`, `""`) are dropped
 * rather than given a middot of their own.
 */
export function InlineList({
  children,
  className = "",
  isNowrapItems = true,
}: {
  children: ReactNode
  className?: string
  /** Keep each item on one line; off for an item long enough to wrap itself. */
  isNowrapItems?: boolean
}) {
  // `toArray` already drops `null`, `undefined` and booleans.
  const items = Children.toArray(children).filter((child) => child !== "")
  return (
    <span className={`flex min-w-0 overflow-x-clip ${className}`}>
      <span className="-ml-4 flex min-w-0 flex-wrap items-center">
        {items.map((item, index) => (
          <span
            key={index}
            className={`inline-flex min-w-0 items-center ${isNowrapItems ? "whitespace-nowrap" : ""}`}
          >
            <span aria-hidden className="w-4 shrink-0 text-center text-subtle">
              ·
            </span>
            {item}
          </span>
        ))}
      </span>
    </span>
  )
}
