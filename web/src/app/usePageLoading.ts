import { useIsFetching } from "@tanstack/react-query"
import { useLocation, useRouterState } from "@tanstack/react-router"
import { useEffect, useState } from "react"

/**
 * How long a page may take to start a read, once the router has it on screen,
 * before there is no wait to show.
 */
const START_MS = 1000
/**
 * How long every read must stay settled before the wait is over. A read that
 * answers often enables the next one (a scope, then the reads under it), and
 * the render between them has nothing in flight.
 */
const SETTLE_MS = 150

/**
 * Whether the page is still waiting on what the last move asked for: opening
 * the page, or changing its URL (a filter, a window, a tab). Loading the
 * page's own code counts, so a slow chunk neither hides the wait nor uses up
 * the time its reads have to start.
 *
 * Only a read with no answer of its own counts, which is a first load or a new
 * key. A poll refreshing a read that has one does not, and neither does
 * anything that starts once this wait is over: live mode re-reads on a clock,
 * and a bar that came back every ten seconds would be reporting nothing the
 * reader did.
 */
export function usePageLoading(): boolean {
  const href = useLocation({ select: (location) => location.href })
  const isRouting = useRouterState({ select: (state) => state.isLoading })
  const isFetching =
    useIsFetching({ predicate: (query) => query.state.status === "pending" }) >
    0
  const [wait, setWait] = useState({ href, isOpen: true, hasStarted: false })

  if (wait.href !== href) {
    setWait({ href, isOpen: true, hasStarted: isFetching })
  } else if (wait.isOpen && isFetching && !wait.hasStarted) {
    setWait({ ...wait, hasStarted: true })
  }

  useEffect(() => {
    if (!wait.isOpen || isFetching || isRouting) return
    const timer = setTimeout(
      () =>
        setWait((current) =>
          current.href === wait.href ? { ...current, isOpen: false } : current,
        ),
      wait.hasStarted ? SETTLE_MS : START_MS,
    )
    return () => clearTimeout(timer)
  }, [wait, isFetching, isRouting])

  return wait.isOpen && (isFetching || isRouting)
}
