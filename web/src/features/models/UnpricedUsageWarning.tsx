import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { TextButton } from "@/design-system/actions/TextButton"
import { InfoBanner } from "@/design-system/feedback/InfoBanner"
import { isDeploymentOperator } from "@/features/organization/roles"
import { useOrganizationContext } from "@/shared/api/organizations"
import { usePricing } from "@/shared/api/pricing"
import { useUnpricedUsage } from "@/shared/api/usage"
import { formatNumber } from "@/shared/helpers/format"
import { DAY_S } from "@/shared/helpers/timeRange"
import { useSelectedWorkspace } from "@/shared/hooks/SelectedWorkspace"

// How many model names the sentence spells out before folding the rest.
const NAMED_MODELS = 3

// Usage groups by the bare model name while a stored price is keyed
// `provider:model`, so either spelling counts. A name two providers share is
// treated as priced once either is, which errs toward a quieter banner.
function isPriced(model: string, pricedKeys: Set<string>): boolean {
  if (pricedKeys.has(model)) return true
  for (const key of pricedKeys) {
    if (key.endsWith(`:${model}`)) return true
  }
  return false
}

// A notice beside `PricingWarning` in the shell: successful requests in the last
// day whose model usage had no price, so the response carried no inline cost and
// anything billing from it charged nothing for the model (#1625). Scoped to the
// selected workspace, as the Activity rows it links to are; each one's details
// offer "Set model price". Deployment-operator-only, because a price is a
// deployment-wide write. Dismissible per tab. One line, because it sits above
// every page: the models it names are what to act on, and Activity has the rest.
export function UnpricedUsageWarning() {
  const organization = useOrganizationContext()
  const isOperator = isDeploymentOperator(organization.data)
  const { selected: workspace } = useSelectedWorkspace()
  const unpriced = useUnpricedUsage(
    DAY_S,
    workspace?.workspace_id ?? "",
    isOperator,
  )
  const [dismissed, setDismissed] = useState(false)

  // Read through `isOperator` for the reason `PricingWarning` does: a disabled
  // query still serves whatever sits under its key. Every field is read
  // optionally because a banner in the shell must not take the shell down over
  // a body it did not expect.
  const total = isOperator ? (unpriced.data?.totals?.request_count ?? 0) : 0
  // Pricing a model leaves its logged rows uncosted, so without this the banner
  // would keep asking for a price the operator has already set.
  const pricing = usePricing(total > 0)
  const pricedKeys = new Set((pricing.data ?? []).map((row) => row.model_key))
  const byModel = unpriced.data?.by_model ?? []
  const stillUnpriced = byModel.filter(
    (row) => row.is_other || !row.key || !isPriced(row.key, pricedKeys),
  )
  const requests =
    total -
    byModel
      .filter((row) => !stillUnpriced.includes(row))
      .reduce((sum, row) => sum + row.requests, 0)
  // Held back until the price list answers, so the banner does not flash up
  // for a model that turns out to be priced. A failed read shows it.
  if (requests <= 0 || dismissed || pricing.isPending) {
    return null
  }

  const models = stillUnpriced
    .filter((row) => !row.is_other && row.key)
    .sort((a, b) => b.requests - a.requests)
    .map((row) => row.key ?? "")
  const named = models.slice(0, NAMED_MODELS)
  const more = models.length - named.length

  return (
    <div
      data-slot="unpriced-usage"
      className="mx-auto w-full max-w-[112.5rem] shrink-0 px-4 md:px-6"
    >
      <InfoBanner tone="warning">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1">
            {formatNumber(requests)} {requests === 1 ? "request" : "requests"}{" "}
            in the last 24 hours had no model price
            {workspace ? ` in ${workspace.name}` : ""}
            {named.length > 0 ? (
              <>
                :{" "}
                <span className="text-mono-caption [overflow-wrap:anywhere]">
                  {named.join(", ")}
                </span>
                {more > 0 ? ` and ${formatNumber(more)} more` : ""}
              </>
            ) : null}
          </span>
          <Link
            to="/activity"
            search={{
              status: "success",
              priced: "false",
              range: "24h",
              source: "gateway",
            }}
            className="text-sm text-link underline-offset-2 hover:underline focus-visible:otari-focus-ring"
          >
            View them
          </Link>
          <span className="text-sm">
            <TextButton onPress={() => setDismissed(true)}>Dismiss</TextButton>
          </span>
        </span>
      </InfoBanner>
    </div>
  )
}
