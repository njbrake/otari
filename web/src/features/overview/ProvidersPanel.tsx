import type { ProviderHealth } from "@/client"
import { Dot } from "@/design-system/indicators/Dot"
import { HEALTH_LABELS, healthState } from "@/features/providers/providerHealth"

/**
 * The deployment's providers and whether each answers, for its operator. A
 * provider that answers but lists no models is told apart from one that is
 * down, in the words the Providers page uses.
 */
export function ProvidersPanel({
  providers,
  isError,
}: {
  providers: ProviderHealth[] | undefined
  isError: boolean
}) {
  return (
    <div className="mb-6 flex flex-col">
      <h2 className="text-title">Providers</h2>
      <span className="text-caption text-subtle">
        Reachability, as of the gateway&rsquo;s last check.
      </span>
      {isError ? (
        <p className="mt-2 text-caption">
          Provider health could not be loaded.
        </p>
      ) : providers && providers.length === 0 ? (
        <p className="mt-2 text-caption">No providers configured.</p>
      ) : (
        <ul className="mt-2 flex flex-col">
          {(providers ?? []).map((provider) => {
            const state = healthState(provider)
            return (
              <li
                key={provider.instance}
                className="flex items-center gap-2 border-t border-border-subtle py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-mono-caption">
                  {provider.instance}
                </span>
                <Dot className={provider.ok ? "bg-success" : "bg-danger"} />
                <span
                  className={`text-mono-caption ${
                    state === "unreachable" ? "text-danger" : "text-muted"
                  }`}
                >
                  {HEALTH_LABELS[state]}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
