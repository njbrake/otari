import { createFileRoute } from "@tanstack/react-router"

import { NewPolicyPage } from "@/features/routing/NewPolicyPage"

export const Route = createFileRoute("/routing/new")({
  component: NewPolicyPage,
})
