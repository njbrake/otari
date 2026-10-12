import { Link } from "@tanstack/react-router"
import { Dot } from "@/design-system/indicators/Dot"
import type { AttentionLine } from "./overviewModel"

/**
 * What needs acting on now, one line across the page: each item says what is
 * wrong and links to where it is fixed. Absent when nothing is, so its
 * presence is the signal. A labeled region rather than an alert, which would
 * be announced again on every switch and refresh; the dot is danger when any
 * item is an alert and warning otherwise.
 */
export function OverviewAttention({
  items,
  isAlert,
  isBusy,
}: {
  /** Each line, keyed by `attentionKey`. */
  items: (AttentionLine & { key: string })[]
  /** At least one item is an alert rather than a warning. */
  isAlert: boolean
  /** The items are another scope's or month's, being replaced. */
  isBusy: boolean
}) {
  if (items.length === 0) return null
  return (
    <section
      aria-label="Needs attention"
      aria-busy={isBusy || undefined}
      className={`flex flex-col gap-2 border-t border-border py-3 text-sm transition-opacity sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2.5 ${
        isBusy ? "opacity-60" : ""
      }`}
    >
      <span className="flex items-center gap-2 font-semibold text-foreground">
        <Dot className={isAlert ? "bg-danger" : "bg-warning"} />
        Needs attention
      </span>
      {items.map((item, index) => (
        <span key={item.key} className="flex items-center gap-2.5 text-muted">
          {index > 0 ? (
            <span aria-hidden className="max-sm:hidden text-subtle">
              ·
            </span>
          ) : null}
          {item.to ? (
            <Link
              to={item.to}
              search={item.search}
              className="underline underline-offset-2 hover:decoration-2 focus-visible:otari-focus-ring"
            >
              {item.text}
            </Link>
          ) : (
            <span>{item.text}</span>
          )}
        </span>
      ))}
    </section>
  )
}
