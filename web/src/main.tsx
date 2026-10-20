import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { createBootLoader, firstSettled } from "@/app/boot"
import { DeploymentGate } from "@/app/DeploymentGate"
import { Provider } from "@/app/provider"
import { apiFetch } from "@/shared/api/client"
import { prepareRequests } from "@/shared/api/overlayRequestPolicy"
import type { WireBootstrap } from "@/shared/helpers/bootstrap"
import "@/styles/globals.css"

const container = document.getElementById("root")
if (!container) {
  throw new Error("Root element #root not found")
}

// Mounted once the first bootstrap attempt settles rather than at once. The
// answer decides whether this URL is a management dashboard, a sign-in screen,
// or a data-plane gateway's landing page, and painting one of those only to swap
// it for another is worse than waiting one same-origin round trip, which the
// boot markup in `index.html` covers. A failed first attempt mounts the failure
// screen, which keeps retrying and becomes the app when an attempt answers
// (`app/boot.ts`). The request policy is settled before the bootstrap is asked
// for, because the answer can change where that request goes.
const loader = createBootLoader({
  prepare: prepareRequests,
  load: (signal) => apiFetch<WireBootstrap>("/bootstrap", { signal }),
})

void firstSettled(loader).then(() => {
  createRoot(container).render(
    <StrictMode>
      <Provider>
        <DeploymentGate loader={loader} />
      </Provider>
    </StrictMode>,
  )
})
