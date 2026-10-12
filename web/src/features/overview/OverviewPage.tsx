import { Link } from "@tanstack/react-router"
import { type ReactNode, useEffect, useRef } from "react"
import type { UsageSeriesPoint } from "@/client"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { PageLoading } from "@/design-system/feedback/PageLoading"
import { PageIntro } from "@/design-system/layout/PageIntro"
import { scopeLabel } from "@/features/budgets/organizationBudget"
import { SetupGuide } from "@/features/onboarding/SetupGuide"
import { isDeploymentOperator } from "@/features/organization/roles"
import { tightestAllocation } from "@/features/overview/overview"
import { useModels } from "@/shared/api/models"
import { useOrganizationContext } from "@/shared/api/organizations"
import { useRefreshOverview } from "@/shared/api/overview"
import { useProviderHealth, useProviders } from "@/shared/api/providers"
import { useUsageLogs } from "@/shared/api/usage"
import { formatUtcMonthName } from "@/shared/helpers/format"
import { useUrlState } from "@/shared/helpers/urlState"
import { useSurfaces } from "@/shared/hooks/useDeployment"
import { BudgetChart } from "./BudgetChart"
import { GetStartedStrip } from "./GetStartedStrip"
import { LimitsPanel } from "./LimitsPanel"
import { OverviewAttention } from "./OverviewAttention"
import { OverviewScopeBar } from "./OverviewScopeBar"
import { OverviewTiles } from "./OverviewTiles"
import {
  billedByDay,
  budgetView,
  comparisonLabel,
  describeAttention,
  groupAttention,
  runningTotal,
} from "./overviewModel"
import { OVERVIEW_URL_DEFAULTS, offeredMonths } from "./overviewQuery"
import { ProvidersPanel } from "./ProvidersPanel"
import { RecentFailures } from "./RecentFailures"
import { useOverviewData } from "./useOverviewData"

/**
 * The landing route, which is the one page nobody navigates to on purpose.
 *
 * Provider health and the provider list answer 403 to anyone who does not
 * operate the deployment, so the operator's parts mount only for an operator:
 * a component that is not rendered runs none of its queries. Decided from the
 * organization context, where the usage hooks and the nav rail take the same
 * answer, and an errored context is an answer rather than a wait.
 */
export function OverviewIndex() {
  const context = useOrganizationContext()
  // `isFetched`, not `isPending`: an errored query goes back to pending on its
  // next fetch, which a second observer below would ask for, swinging the page
  // back to this spinner forever.
  if (!context.isFetched) {
    return <PageLoading />
  }
  if (!isDeploymentOperator(context.data)) {
    return <OrganizationOverview />
  }
  return <OperatorOverview />
}

/**
 * The operator's page: the provider list decides whether a fresh gateway gets
 * the getting-started strip, and provider health fills the rail.
 */
function OperatorOverview() {
  const providers = useProviders()
  const needsSetup =
    providers.isSuccess && providers.data.providers.length === 0
  // Imported usage lands without a provider, so "no providers" alone does not
  // mean nothing has happened: the strip waits on the log being empty too.
  const anyUsage = useUsageLogs({}, 0, 1, { enabled: needsSetup })
  if (providers.isLoading) {
    return <PageLoading />
  }
  return (
    <OverviewPage
      isOperator
      setup={
        <>
          {needsSetup && anyUsage.isSuccess && anyUsage.data.length === 0 ? (
            <GetStartedStrip />
          ) : null}
          <SetupGuide
            canServeRequests={
              providers.isSuccess && providers.data.providers.length > 0
            }
          />
        </>
      }
      setupError={providers.error}
      refreshSetup={() => void providers.refetch()}
      setupFetching={providers.isFetching}
    />
  )
}

/**
 * Everyone else's page. Whether a request could succeed is read off the model
 * catalog, which lists the selectors this caller may name, since `/providers`
 * refuses them.
 */
function OrganizationOverview() {
  const models = useModels()
  return (
    <OverviewPage
      isOperator={false}
      setup={
        <SetupGuide canServeRequests={(models.data?.data.length ?? 0) > 0} />
      }
      refreshSetup={() => void models.refetch()}
      setupFetching={models.isFetching}
    />
  )
}

/** The cost of the UTC day `now` falls on, from a daily series. */
function costOn(series: readonly UsageSeriesPoint[], now: Date) {
  const today = now.toISOString().slice(0, 10)
  return (
    series.find((point) => point.bucket_start.slice(0, 10) === today)?.cost ?? 0
  )
}

/**
 * Spend, limits and failures for one scope and one calendar month: what needs
 * attention, three numbers, the month's running total against its budget, the
 * latest failures, and the limits beside them.
 *
 * The scope and month live in the URL (`overviewQuery.ts`); `useOverviewData`
 * reads them, and this composes the page from what it returns.
 */
function OverviewPage({
  isOperator,
  setup,
  setupError,
  refreshSetup,
  setupFetching,
}: {
  isOperator: boolean
  setup: ReactNode
  setupError?: unknown
  refreshSetup: () => void
  setupFetching: boolean
}) {
  const url = useUrlState(OVERVIEW_URL_DEFAULTS)
  const data = useOverviewData(url)
  const context = useOrganizationContext()
  const servesProviders = useSurfaces()("providers")
  const { viewer, scope, month, summary, overview } = data
  const now = data.now.getTime()

  const series = summary.data?.series ?? []
  const totals = summary.data?.totals
  const billed = totals
    ? Math.max(0, totals.cost - (totals.imported_cost ?? 0))
    : undefined
  const ownTotals = runningTotal(billedByDay(series, month))
  const workspaceTotals = data.workspace?.data
    ? runningTotal(billedByDay(data.workspace.data.series, month))
    : undefined
  const workspaceBilledTotals = data.workspace?.data?.totals
  const workspaceBilled =
    scope === "workspace"
      ? billed
      : workspaceBilledTotals
        ? Math.max(
            0,
            workspaceBilledTotals.cost -
              (workspaceBilledTotals.imported_cost ?? 0),
          )
        : undefined

  const spend = scope === "organization" ? undefined : data.spend.data
  const cap = spend?.max_budget ?? undefined
  const limits = overview.data?.limits
  const organizationName =
    context.data?.organization.name ?? "This organization"
  const tightest = tightestAllocation(
    overview.data?.ceilings,
    (worst) =>
      limits?.rows.find((row) => row.id === worst.scope_id)?.name ??
      (worst.scope_type
        ? scopeLabel(
            { scope_type: worst.scope_type, scope_id: worst.scope_id ?? "" },
            { organizationName, workspaces: [] },
          )
        : worst.budget_id),
  )
  // The server's word on this workspace's budget pace, and the settled spend
  // to pace from where it is known: the month's billed spend, for a budget
  // whose period is this calendar month.
  const pace = overview.data?.attention.find(
    (item) =>
      item.kind === "budget_pace" && item.subject_id === viewer.workspaceId,
  )
  const periodIsMonth =
    spend?.period_start != null &&
    spend.period_end != null &&
    Date.parse(spend.period_start) === month.start.getTime() &&
    Date.parse(spend.period_end) === month.end.getTime()
  const budget = budgetView({
    scope,
    month,
    now,
    isManager: viewer.isManager && !data.isFallback,
    canSetBudgets: viewer.canReadOrganization,
    spend: data.spend.isError ? undefined : spend,
    ownBilled: scope === "you" ? billed : undefined,
    workspaceBilled,
    billed,
    tightest,
    ceilingCount: overview.data
      ? (overview.data.ceilings?.total_count ?? null)
      : null,
    serverPace: pace ? { at: pace.at ?? null } : undefined,
    settledSpent: periodIsMonth ? workspaceBilled : undefined,
  })

  const attention = groupAttention(overview.data?.attention ?? []).map((item) =>
    describeAttention(item, {
      servesProviders: isOperator && servesProviders,
      canManageBudgets: viewer.canReadOrganization,
      workspaceId: viewer.workspaceId || undefined,
      failuresSearch: data.failuresSearch,
    }),
  )

  const months = offeredMonths(data.now)
  // Another scope's or month's answers are still on screen: dimmed, and said
  // to be busy, until the new ones land.
  const busy = data.isStale ? "opacity-60" : ""
  const monthName = formatUtcMonthName(month.start.getTime())
  const inMonth = month.isCurrent ? "this month" : `in ${monthName}`
  // Where the server fell back to the caller's own usage, the switch keeps
  // the scope asked for and the description says what was read instead.
  const description =
    scope === "you"
      ? `${data.isFallback ? "Your usage: " : ""}Requests made with your keys and your subscription`
      : scope === "workspace"
        ? `Everything in ${viewer.workspaceName || "this workspace"}, all members`
        : `All workspaces in ${organizationName}`
  // The chart's bars are the workspace's at Workspace and, for a manager, at
  // You (their share stacked under the rest). A member sees no workspace
  // totals, so theirs are their own with nothing measured against them.
  const ownOnly = scope === "you" && (!viewer.isManager || data.isFallback)
  const chartTotals = workspaceTotals ?? ownTotals
  const marksCrossing = scope === "workspace" || workspaceTotals !== undefined
  const chartCap = ownOnly ? undefined : cap
  const showsBudget = chartCap !== undefined

  const refresh = () => {
    refreshSetup()
    data.refresh()
  }

  return (
    <div className="flex flex-col">
      <PageIntro title="Overview">
        Spend, limits and failures at a glance. Subscription usage is tracked
        but doesn&rsquo;t count toward limits.
      </PageIntro>

      {setup}

      <ErrorBanner error={setupError ?? data.error} />

      <OverviewAttention
        items={attention}
        isAlert={(overview.data?.attention ?? []).some(
          (item) => item.severity === "alert",
        )}
        isBusy={data.isStale}
      />

      <OverviewScopeBar
        scopes={data.scopes}
        scope={data.requested}
        onScope={(next) =>
          url.patch({ scope: next === data.scopes[0] ? "" : next })
        }
        months={months}
        month={data.requestedMonth}
        shownMonth={month}
        days={
          overview.data
            ? {
                elapsed: overview.data.month.elapsed_days,
                length: overview.data.month.days,
              }
            : { elapsed: month.elapsed, length: month.length }
        }
        onMonth={(key) =>
          url.patch({ month: key === months[0].key ? "" : key })
        }
        description={description}
        onRefresh={refresh}
        isFetching={data.isFetching || setupFetching}
        updatedAt={data.updatedAt}
      />

      <div
        aria-busy={data.isStale || undefined}
        className={`-mx-4 transition-opacity md:-mx-6 ${busy}`}
      >
        <OverviewTiles
          totals={totals}
          series={series}
          previousCost={data.previous.data?.totals.cost}
          comparison={comparisonLabel(data.before)}
          todayCost={month.isCurrent ? costOn(series, data.now) : undefined}
          budget={budget}
          failuresSearch={data.failuresSearch}
        />
      </div>

      <div
        aria-busy={data.isStale || undefined}
        className={`-mx-4 grid transition-opacity md:-mx-6 lg:grid-cols-[minmax(0,1fr)_23.75rem] ${busy}`}
      >
        <div className="min-w-0 border-border lg:border-r">
          <section
            aria-label={`Billed spend, ${monthName}`}
            className="border-b border-border px-4 py-5 md:px-6"
          >
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <h2 className="text-title">
                {ownOnly
                  ? `Your billed spend, ${monthName}`
                  : showsBudget
                    ? `Billed spend vs budget, ${monthName}`
                    : `Billed spend, ${monthName}`}
              </h2>
              <span className="flex items-center gap-3 text-caption">
                {workspaceTotals ? (
                  <>
                    <LegendSwatch className="bg-accent">Yours</LegendSwatch>
                    <LegendSwatch className="bg-chart-cat-other">
                      Rest of workspace
                    </LegendSwatch>
                  </>
                ) : (
                  <LegendSwatch className="bg-accent">
                    {ownOnly ? "Yours" : "So far"}
                  </LegendSwatch>
                )}
                {month.isCurrent && !ownOnly ? (
                  <LegendSwatch className="otari-hatch-swatch">
                    Projected
                  </LegendSwatch>
                ) : null}
              </span>
              <Link
                to="/usage"
                className="ml-auto text-sm whitespace-nowrap text-link underline-offset-2 hover:underline focus-visible:otari-focus-ring"
              >
                Daily spend in Usage →
              </Link>
            </div>
            {summary.isSuccess &&
            (!data.workspace || data.workspace.isSuccess) ? (
              <BudgetChart
                key={`${month.key}-${scope}`}
                month={month}
                totals={chartTotals}
                mine={workspaceTotals ? ownTotals : undefined}
                cap={chartCap}
                marksCrossing={marksCrossing}
                ownOnly={ownOnly}
              />
            ) : (
              <div className="h-51" aria-hidden />
            )}
            <p className="mt-2.5 text-caption">
              {ownOnly && cap !== undefined
                ? "Members don't see workspace totals, so there's no budget line: your spend alone can't show how close the workspace is. "
                : showsBudget && !month.isCurrent
                  ? "Past budgets aren't stored, so the line is today's budget. "
                  : ""}
              Running total of billed spend. Subscription usage isn&rsquo;t
              included because it doesn&rsquo;t count toward{" "}
              {cap !== undefined ? "the budget" : "limits"}.
              {month.isCurrent && !ownOnly
                ? " Projection uses this month's daily average."
                : ""}
            </p>
          </section>
          <RecentFailures
            month={month}
            now={data.now}
            entries={data.failures.data ?? []}
            count={totals?.error_count}
            isLoading={
              !data.isReady || (data.failures.isPending && !data.failures.data)
            }
            error={data.failures.error}
            failuresSearch={data.failuresSearch}
          />
        </div>
        <aside className="flex min-w-0 flex-col border-t border-border px-4 py-5 md:px-6 lg:border-t-0">
          {isOperator ? (
            <OperatorProviders
              reportedDown={
                overview.isPlaceholderData
                  ? undefined
                  : overview.data?.attention
                      .filter((item) => item.kind === "provider_unreachable")
                      .map((item) => item.subject_id ?? "")
              }
            />
          ) : null}
          <LimitsPanel
            scope={scope}
            limits={limits}
            isLoading={overview.isPending && !overview.data}
            isError={overview.isError && !overview.data}
            inMonth={inMonth}
            isPast={!month.isCurrent}
            now={now}
            workspaceId={viewer.workspaceId || undefined}
          />
        </aside>
      </div>
    </div>
  )
}

/**
 * Provider health, read only where the reader operates the deployment. The
 * attention list reads the same check from the gateway's cache, which a fresh
 * gateway fills only once this read runs, so a disagreement asks for the
 * overview again.
 */
function OperatorProviders({
  reportedDown,
}: {
  /** The providers the overview's attention list names as unreachable. */
  reportedDown: string[] | undefined
}) {
  const health = useProviderHealth()
  const refreshOverview = useRefreshOverview()
  const down = health.data?.providers
    .filter((provider) => !provider.ok && !provider.discovery_unsupported)
    .map((provider) => provider.instance)
    .sort()
    .join()
  const reported = reportedDown?.toSorted().join()
  // Once per check result, so a lasting disagreement cannot loop.
  const askedFor = useRef<string>(undefined)
  useEffect(() => {
    if (down === undefined || reported === undefined || down === reported)
      return
    if (askedFor.current === down) return
    askedFor.current = down
    void refreshOverview()
  }, [down, reported, refreshOverview])
  return (
    <ProvidersPanel
      providers={health.data?.providers}
      isError={health.isError}
    />
  )
}

function LegendSwatch({
  className,
  children,
}: {
  className: string
  children: string
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={`size-2 ${className}`} />
      {children}
    </span>
  )
}
