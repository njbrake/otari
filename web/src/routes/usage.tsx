import { createFileRoute, redirect } from "@tanstack/react-router"

import { retiredUsageTarget } from "@/shared/helpers/retiredPages"

export const Route = createFileRoute("/usage")({
  // Retired for Home. A bookmark or a link still pointing here opens the view
  // its filters describe: Home for a window and a breakdown, Requests once a
  // filter names rows, Sessions for a breakdown by session. In `beforeLoad`, so
  // the old page is never mounted and the dead path leaves no history entry.
  beforeLoad: ({ search }) => {
    throw redirect({ ...retiredUsageTarget(search), replace: true })
  },
})
