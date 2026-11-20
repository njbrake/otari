import { createFileRoute, redirect } from "@tanstack/react-router"

import { retiredActivityTarget } from "@/shared/helpers/retiredPages"

export const Route = createFileRoute("/activity")({
  // Retired for the Requests tab. A bookmark or a link still pointing here
  // opens the same filtered view, under the names Requests reads. In
  // `beforeLoad`, so the old page is never mounted and the dead path leaves no
  // history entry.
  beforeLoad: ({ search }) => {
    throw redirect({ ...retiredActivityTarget(search), replace: true })
  },
})
