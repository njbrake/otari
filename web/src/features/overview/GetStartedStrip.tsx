import { buttonVariants } from "@heroui/react"
import { Link } from "@tanstack/react-router"
import { Dot } from "@/design-system/indicators/Dot"
import { Section } from "@/design-system/layout/Section"
import { useSurfaces } from "@/shared/hooks/useDeployment"

/**
 * Where an operator adds a provider credential on this deployment: `/providers`
 * is where a fresh gateway is set up, and hosted and a control plane serve no
 * such page, so they get the organization's.
 */
function useAddProviderRoute(): "/providers" | "/organization/provider-keys" {
  const serves = useSurfaces()
  return serves("providers") ? "/providers" : "/organization/provider-keys"
}

const ACTIONS = {
  provider: "Add your first provider",
  "organization-provider-key": "Add a provider key",
} as const

/**
 * Nothing to route to and no usage yet: the one thing to do first. The
 * operator adds a provider, an organization's owner or admin a provider key,
 * and a member, who may do neither, is told whom to ask and given no link.
 */
export function GetStartedStrip({
  description = "Add a provider to begin serving models. Once it is configured, this page will show your gateway\u2019s traffic, spend, and health.",
  action = "provider",
}: {
  description?: string
  /** The link to the step, or "" for a caller who may not take it. */
  action?: keyof typeof ACTIONS | ""
}) {
  const addProviderRoute = useAddProviderRoute()

  return (
    <Section
      className="border-t border-border py-5"
      contentClassName="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <Dot className="mt-2.5 bg-accent" />
        <div>
          <h2 className="text-display-sub">Get started with Otari</h2>
          <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
      </div>
      {action ? (
        <Link
          to={
            action === "provider"
              ? addProviderRoute
              : "/organization/provider-keys"
          }
          className={`${buttonVariants({ variant: "primary" })} shrink-0`}
        >
          {ACTIONS[action]}
        </Link>
      ) : null}
    </Section>
  )
}
