import { Link } from "@tanstack/react-router"
import type { DashboardSearch } from "@/shared/helpers/search"

/**
 * Counts under a figure that open the requests they count. A count the
 * deployment has no Requests page for reads as plain text.
 */
export function FigureLinks({
  links,
  fallback,
  onOpen,
}: {
  links: { text: string; search: DashboardSearch; isShown: boolean }[]
  fallback: string
  onOpen?: () => void
}) {
  const shown = links.filter((link) => link.isShown)
  if (shown.length === 0) return <>{fallback}</>
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {shown.map((link, index) => (
        <span key={link.text} className="inline-flex items-center gap-x-2">
          {index > 0 ? (
            <span aria-hidden className="text-subtle">
              ·
            </span>
          ) : null}
          <Link
            to="/requests"
            search={link.search}
            onClick={onOpen}
            className="text-link underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
          >
            {link.text}
          </Link>
        </span>
      ))}
    </span>
  )
}
