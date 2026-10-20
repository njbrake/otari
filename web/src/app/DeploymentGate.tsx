import { useSyncExternalStore } from "react"
import App from "@/app/App"
import type { BootLoader } from "@/app/boot"
import { Button } from "@/design-system/actions/Button"
import { PageError } from "@/design-system/feedback/PageError"
import { PageLoading } from "@/design-system/feedback/PageLoading"

const UNREACHABLE = new Error(
  "Could not reach the gateway, so the dashboard does not know what it is connected to.",
)

/**
 * The app once the bootstrap has answered, and until then the reason it has
 * not. There is deliberately no deployment to fall back to: rendering a
 * management dashboard at a gateway that does not serve one is the failure the
 * bootstrap contract exists to prevent, so a failed read says so and keeps
 * asking, and the app mounts the moment an attempt succeeds.
 */
export function DeploymentGate({ loader }: { loader: BootLoader }) {
  const state = useSyncExternalStore(loader.subscribe, loader.getState)

  if (state.status === "ready") {
    return <App bootstrap={state.bootstrap} />
  }
  // `main.tsx` mounts after the first attempt settles, so this is only
  // reachable from a caller that mounts earlier.
  if (state.status === "loading") {
    return <PageLoading label="Loading the dashboard…" />
  }

  return (
    <PageError
      error={UNREACHABLE}
      action={
        <Button
          variant="primary"
          isPending={state.isAttempting}
          onPress={loader.retryNow}
        >
          Retry
        </Button>
      }
    >
      <span role="status">
        {state.isAttempting
          ? "Trying again…"
          : state.willRetry
            ? "Check that it is running. The dashboard keeps trying in the background and opens as soon as the gateway answers."
            : "The gateway refused the request. Check that it is running and that this address serves its dashboard, then retry."}
      </span>
    </PageError>
  )
}
