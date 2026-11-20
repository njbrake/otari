import { Link } from "@tanstack/react-router"
import { InlineList } from "@/design-system/layout/InlineList"
import type { DashboardSearch } from "@/shared/helpers/search"

/**
 * Counts under a figure that open the requests they count. A count with no
 * one Requests page to open reads as plain text.
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
    <InlineList>
      {shown.map((link) => (
        <Link
          key={link.text}
          to="/requests"
          search={link.search}
          onClick={onOpen}
          className="text-link underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
        >
          {link.text}
        </Link>
      ))}
    </InlineList>
  )
}
