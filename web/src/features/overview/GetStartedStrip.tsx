import { buttonVariants } from "@heroui/react"
import { Link } from "@tanstack/react-router"
import { Dot } from "@/design-system/indicators/Dot"
import { Section } from "@/design-system/layout/Section"
import { useSurfaces } from "@/shared/hooks/useDeployment"

/**
 * Where "add a provider credential" lives on this deployment. Only the
 * operator reaches the strip that asks (`OverviewIndex` hands everyone else
 * the organization page), and `/providers` is where a fresh gateway is set up.
 * Hosted and a control plane serve no `providers` page, so they get the
 * organization's.
 */
function useAddProviderRoute(): "/providers" | "/organization/provider-keys" {
  const serves = useSurfaces()
  return serves("providers") ? "/providers" : "/organization/provider-keys"
}

/** A gateway with no provider and no usage yet: the one thing to do first. */
export function GetStartedStrip() {
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
          <p className="mt-1 text-sm text-muted">
            Add a provider to begin serving models. Once it is configured, this
            page will show your gateway&rsquo;s traffic, spend, and health.
          </p>
        </div>
      </div>
      <Link
        to={addProviderRoute}
        className={`${buttonVariants({ variant: "primary" })} shrink-0`}
      >
        Add your first provider
      </Link>
    </Section>
  )
}
