import { Link } from "@tanstack/react-router"
import type { MouseEvent } from "react"
import { FiChevronRight } from "react-icons/fi"

/**
 * What a breakdown row ran, one press away and named on the row: "Sessions",
 * "Requests", "People". The rows of "Where it went" are not pressable
 * themselves, so this link (and a name that links to its own page) is the
 * whole of what a row offers beyond its menu, and nothing needs a caption to
 * explain it.
 *
 * A real link, so a middle-click or a long-press opens a new tab. `onOpen`
 * replaces the plain click where opening first has to pick the workspace the
 * destination lists.
 */
export function RowOpenLink({
  to,
  search,
  label,
  subject,
  onOpen,
  isCompact = false,
}: {
  to: "/sessions" | "/requests" | "/"
  search: Record<string, string | string[]>
  label: string
  /** The row's name, so the link is told apart from its neighbors. */
  subject: string
  onOpen?: () => void
  /** Caption-sized, for a link under a row's name rather than in its own lane. */
  isCompact?: boolean
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen()
  }
  return (
    <Link
      to={to}
      search={search}
      onClick={onClick}
      aria-label={`${label} for ${subject}`}
      className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-link underline max-sm:min-h-11 ${isCompact ? "text-xs" : "text-sm"}`}
    >
      {label}
      <FiChevronRight aria-hidden className="size-3.5" />
    </Link>
  )
}
