import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { PageLoading } from "@/design-system/feedback/PageLoading"
import { PageIntro } from "@/design-system/layout/PageIntro"
import { SetupGuide } from "@/features/onboarding/SetupGuide"
import { canManage } from "@/features/organization/roles"
import { useModels } from "@/shared/api/models"
import {
  useDeploymentOperator,
  useOrganizationContext,
} from "@/shared/api/organizations"
import { useProviders } from "@/shared/api/providers"
import { useUsageLogs } from "@/shared/api/usage"
import { formatUtcMonthName } from "@/shared/helpers/format"
import { useUrlState } from "@/shared/helpers/urlState"
import { useSurfaces } from "@/shared/hooks/useDeployment"
import { BudgetChart } from "./BudgetChart"
import { GetStartedStrip } from "./GetStartedStrip"
import { LegendSwatch } from "./LegendSwatch"
import { LimitsPanel } from "./LimitsPanel"
import { OperatorProviders } from "./OperatorProviders"
import { OverviewAttention } from "./OverviewAttention"
import { OverviewScopeBar } from "./OverviewScopeBar"
import { OverviewTiles } from "./OverviewTiles"
import {
  attentionKey,
  billedByDay,
  canProjectMonth,
  comparisonLabel,
  costOnDay,
  describeAttention,
  groupAttention,
  readBudget,
  runningTotal,
} from "./overviewModel"
import { OVERVIEW_URL_DEFAULTS, offeredMonths } from "./overviewQuery"
import { RecentFailures } from "./RecentFailures"
import { useOverviewData } from "./useOverviewData"

/**
 * The landing route, which is the one page nobody navigates to on purpose.
 *
 * Provider health and the provider list answer 403 to anyone who does not
 * operate the deployment, so the operator's parts mount only for an operator:
 * a component that is not rendered runs none of its queries. Decided by
 * `useDeploymentOperator`, the answer the usage hooks and the nav rail take.
 *
 * So an errored context lands on the operator page, as it does for every other
 * operator gate: its panels report their own refusals, where the reverse would
 * hide the deployment's state from the one caller who owns it. An errored
 * context is an answer, not a wait: holding the page on a loading state that
 * no retry clears renders nothing at all.
 */
export function OverviewIndex() {
  const { answer, isSettled } = useDeploymentOperator()
  if (!isSettled) {
    return <PageLoading />
  }
  if (answer === "not-operator") {
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
 * refuses them. An empty catalog and no requests yet is a new account with
 * nothing to route to, which the setup guide holds back for, so the first-steps
 * strip says what comes first: an owner or admin adds a provider key, and a
 * member asks one to.
 */
function OrganizationOverview() {
  const models = useModels()
  const context = useOrganizationContext()
  const managesOrganization = canManage(context.data)
  const hasNoModels = models.isSuccess && models.data.data.length === 0
  // Waits for the catalog and the log, so it never flashes in on a set-up account.
  const anyUsage = useUsageLogs({}, 0, 1, { enabled: hasNoModels })
  const needsFirstSteps =
    hasNoModels && anyUsage.isSuccess && anyUsage.data.length === 0
  return (
    <OverviewPage
      isOperator={false}
      setup={
        <>
          <SetupGuide canServeRequests={(models.data?.data.length ?? 0) > 0} />
          {needsFirstSteps ? (
            <GetStartedStrip
              description={
                managesOrganization
                  ? "Add a provider key to start serving models, then create an API key and send your first request."
                  : "Ask an owner or admin of this organization to add a provider key. Once models are available, you can create an API key and send a request."
              }
              action={managesOrganization ? "organization-provider-key" : ""}
            />
          ) : null}
        </>
      }
      refreshSetup={() => void models.refetch()}
      setupFetching={models.isFetching}
    />
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
  const ownTotals = runningTotal(billedByDay(series, month))
  const workspaceTotals = data.workspace?.data
    ? runningTotal(billedByDay(data.workspace.data.series, month))
    : undefined

  const cap =
    scope === "organization"
      ? undefined
      : (data.spend.data?.max_budget ?? undefined)
  const limits = overview.data?.limits
  const organizationName =
    context.data?.organization.name ?? "This organization"
  const budget = readBudget({
    scope,
    month,
    now,
    isManager: viewer.isManager && !data.isFallback,
    canSetBudgets: viewer.canReadOrganization,
    workspaceId: viewer.workspaceId,
    organizationName,
    totals,
    workspaceTotals: data.workspace?.data?.totals,
    spend: data.spend.isError ? undefined : data.spend.data,
    overview: overview.data,
  })
  // A budget tile with nothing to show yet, as opposed to one whose reads
  // answered with nothing: its reads are still out and none has failed.
  const isBudgetLoading =
    !data.error &&
    (!totals ||
      data.spend.isPending ||
      overview.isPending ||
      data.workspace?.isPending === true) &&
    (budget.kind === "unknown"
      ? budget.line === undefined
      : budget.kind === "none" && budget.used === undefined)

  const attention = groupAttention(overview.data?.attention ?? []).map(
    (item) => ({
      key: attentionKey(item),
      ...describeAttention(item, {
        servesProviders: isOperator && servesProviders,
        canManageBudgets: viewer.canReadOrganization,
        workspaceId: viewer.workspaceId || undefined,
        failuresSearch: data.failuresSearch,
      }),
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
  // You (their share stacked under the rest). A member reads no workspace
  // spend by day, so theirs are their own with nothing measured against them.
  const ownOnly = scope === "you" && (!viewer.isManager || data.isFallback)
  const chartTotals = workspaceTotals ?? ownTotals
  const marksCrossing = scope === "workspace" || workspaceTotals !== undefined
  const chartCap = ownOnly ? undefined : cap
  const showsBudget = chartCap !== undefined
  const isProjected = canProjectMonth(month, now) && !ownOnly

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
          todayCost={month.isCurrent ? costOnDay(series, data.now) : undefined}
          budget={budget}
          failuresSearch={data.failuresSearch}
          isLoading={!totals && !data.error}
          isBudgetLoading={isBudgetLoading}
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
                {isProjected ? (
                  <LegendSwatch className="otari-hatch-swatch">
                    Projected
                  </LegendSwatch>
                ) : null}
              </span>
              <Link
                to="/usage"
                search={data.usageSearch}
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
                now={now}
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
                ? month.isCurrent
                  ? "Your spend alone, so there's no budget line: the Workspace budget tile measures the whole workspace against it. "
                  : "Your spend alone, so there's no budget line: workspace spend by month is for managers. "
                : showsBudget && !month.isCurrent
                  ? "Past budgets aren't stored, so the line is today's budget. "
                  : ""}
              Running total of billed spend. Subscription usage isn&rsquo;t
              included because it doesn&rsquo;t count toward{" "}
              {cap !== undefined ? "the budget" : "limits"}.
              {isProjected ? " Projection uses this month's pace so far." : ""}
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
