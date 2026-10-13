import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { FiMove, FiShare } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { TextButton } from "@/design-system/actions/TextButton"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { Checkbox } from "@/design-system/forms/Checkbox"
import { PageIntro } from "@/design-system/layout/PageIntro"
import { ChartLegend } from "@/design-system/metrics/charts"
import { Segmented } from "@/design-system/navigation/Segmented"
import { describeSpan, type Span } from "@/features/activity/chartBars"
import { SavedViewsMenu } from "@/features/savedViews/SavedViewsMenu"
import { usePageViews } from "@/features/savedViews/usePageViews"
import { useUsageSummary } from "@/shared/api/usage"
import { formatNumber } from "@/shared/helpers/format"
import type { DashboardSearch } from "@/shared/helpers/search"
import {
  bucketDurationMs,
  formatWindowLabel,
  USAGE_PRESETS,
} from "@/shared/helpers/timeRange"
import { useUrlState } from "@/shared/helpers/urlState"
import { BreakdownTable } from "./BreakdownTable"
import { BreakdownTabs } from "./BreakdownTabs"
import { ShareDialog } from "./ShareDialog"
import { ToolPriceDialog } from "./ToolPriceDialog"
import { ToolsTable } from "./ToolsTable"
import { UsageChart } from "./UsageChart"
import { UsageFilterChips } from "./UsageFilterChips"
import { UsageScopeBar } from "./UsageScopeBar"
import { UsageTiles } from "./UsageTiles"
import {
  axisScale,
  foldSeries,
  METRICS,
  nextSort,
  placeUnranked,
  shareFigures,
  totalSeries,
  valueFormatter,
} from "./usageModel"
import {
  activitySearch,
  CLEAR_FILTERS,
  clearPatch,
  DIMENSIONS,
  filterPatch,
  sortPatch,
  USAGE_URL_DEFAULTS,
  USAGE_VIEWS,
  viewPatch,
  viewQuery,
} from "./usageQuery"
import { useUsageData, useUsageViewer } from "./useUsageData"
import { useUsageNames } from "./useUsageNames"

/**
 * Where usage is going over time: the scope and window, the three numbers that
 * answer it, then the chart and the table that explain them, driven by one
 * choice of breakdown. Activity answers which requests; a row here opens
 * exactly those requests there.
 *
 * Everything that decides what is shown lives in the URL (`usageQuery.ts`), so
 * a view is a link and a saved view a query string. `useUsageData` reads it;
 * this composes the page from what it returns.
 */
export function UsagePage() {
  const url = useUrlState(USAGE_URL_DEFAULTS)
  const viewer = useUsageViewer()
  const data = useUsageData(url, viewer)
  const navigate = useNavigate()
  const [isSharing, setIsSharing] = useState(false)
  const [pricingTool, setPricingTool] = useState<string>()
  const views = usePageViews({
    page: "usage",
    workspaceId: viewer.workspaceId,
    builtIns: USAGE_VIEWS,
    query: viewQuery(url),
    hasSpan: data.hasSpan,
    onApply: (query) => url.patch(viewPatch(query)),
  })

  const { dimension, metric, withSubscription, summary } = data
  // The share card names the top models by spend, read when the card opens:
  // the table's own model rows are ranked by whichever column it sorts.
  const shareModels = useUsageSummary(
    data.usageFilters,
    data.bucket,
    ["model"],
    isSharing,
    data.usageScope,
  )
  const def = DIMENSIONS[dimension]
  const names = useUsageNames({
    dimension,
    rows: data.rows,
    filters: [...data.filters, ...data.idleFilters],
    viewer,
  })
  // Until this breakdown's series arrives (a switch, a first load, a failed
  // read), the summary's totals hold the bars.
  const folded =
    !data.grouped && summary
      ? totalSeries(summary.series, metric, withSubscription)
      : foldSeries(data.grouped, metric, withSubscription, names.labelOf)

  // ---------- into Activity ----------
  const open = (search: DashboardSearch | undefined) => {
    if (search) void navigate({ to: "/activity", search })
  }
  const base = { window: data.window, context: data.context }
  // A row's requests, or none where Activity cannot show them: the fold, and
  // a group with no value that no Activity filter names.
  const rowSearch = (row: { key: string | null; is_other: boolean }) =>
    row.is_other
      ? undefined
      : activitySearch({
          ...base,
          filters: data.filters,
          row: { dimension, key: row.key },
        })
  const pageSearch = activitySearch({ ...base, filters: data.filters })
  const unpricedSearch = pageSearch
    ? { ...pageSearch, priced: "false", status: "success" }
    : undefined

  // ---------- the window ----------
  const barMs = bucketDurationMs(data.bucket)
  const span: Span | undefined = data.hasSpan
    ? {
        from: Date.parse(url.get("start_date")),
        to: Date.parse(url.get("end_date")),
      }
    : undefined
  // Day bars name their days, the last one inclusive, as the window caption
  // does; shorter bars name the span by the clock.
  const spanLabel = span
    ? data.bucket === "day"
      ? formatWindowLabel(url.get("start_date"), url.get("end_date"))
      : describeSpan(span.from, span.to, barMs)
    : undefined
  const setSpan = (next: Span | undefined) =>
    url.patch({
      start_date: next ? new Date(next.from).toISOString() : "",
      end_date: next ? new Date(next.to).toISOString() : "",
    })
  const bounds = {
    start: summary?.start_date ?? data.window.start,
    end: summary?.end_date ?? data.window.end,
  }

  // ---------- the share card ----------
  const shareScope = [
    data.scope === "you"
      ? "your usage"
      : data.scope === "workspace"
        ? "workspace-wide"
        : "organization-wide",
    ...data.filters.map(names.describeFilter),
  ].join(" · ")
  const share =
    isSharing && summary
      ? shareFigures(
          summary,
          shareModels.data?.by_model ?? [],
          withSubscription,
        )
      : undefined

  const isFiltered = data.filters.length > 0 || data.hasSpan
  // Empty in this window only: an older one may still hold usage, and nothing
  // read here says whether it does.
  const isWindowEmpty =
    summary !== undefined && summary.totals.request_count === 0 && !isFiltered
  const toolRows = data.tools
  const clearAll = () => url.patch(CLEAR_FILTERS)

  return (
    <div className="flex flex-col">
      <PageIntro
        title="Usage"
        beside={
          <SavedViewsMenu
            builtIns={USAGE_VIEWS}
            views={views.views}
            current={views.current}
            matching={views.matching}
            isDirty={views.isDirty}
            canShare={viewer.canShareViews}
            canSave={viewer.workspaceId !== ""}
            onApply={views.apply}
            onSave={views.save}
            onDelete={(view) => views.remove(view.id)}
            isSaving={views.isSaving}
            error={views.error}
            onClose={views.clearError}
          />
        }
        action={
          <Button
            size="sm"
            aria-label="Share usage as an image"
            onPress={() => setIsSharing(true)}
            isDisabled={!summary}
          >
            <FiShare aria-hidden className="size-3.5" />
            Share
          </Button>
        }
      >
        Spend, requests and token usage over time. Subscription usage is tracked
        but doesn't count toward limits.
      </PageIntro>

      <ErrorBanner error={data.error} />

      <UsageScopeBar
        scopes={data.scopes}
        scope={data.scope}
        onScope={(next) =>
          url.patch({
            scope: next === data.scopes[0] ? "" : next,
            start_date: "",
            end_date: "",
          })
        }
        range={data.preset.key}
        onRange={(range) => url.patch({ range, start_date: "", end_date: "" })}
        bounds={bounds}
        isAwaitingScope={data.isAwaitingScope}
        spend={data.scope === "organization" ? undefined : data.spend}
        onRefresh={data.refresh}
        isFetching={data.isFetching}
        updatedAt={data.updatedAt}
      />

      <UsageFilterChips
        filters={data.filters}
        idleFilters={data.idleFilters}
        span={spanLabel}
        valueName={names.valueName}
        onClear={(filter) => url.patch(clearPatch(filter))}
        onClearSpan={() => setSpan(undefined)}
        onClearAll={clearAll}
      />

      {isWindowEmpty ? (
        <EmptyMessage minHeightClass="min-h-[16rem]">
          No usage in the last {data.preset.label}. Requests through the gateway
          show up here
          {data.preset.key === USAGE_PRESETS.at(-1)?.key
            ? "."
            : ", and a longer window reaches further back."}
        </EmptyMessage>
      ) : (
        <>
          <div className="-mx-4 md:-mx-6">
            <UsageTiles
              summary={summary}
              previous={data.previous}
              windowLabel={data.preset.label}
              unpricedSearch={unpricedSearch}
              isLoading={data.isLoadingSummary}
            />
          </div>

          <section
            aria-label="Usage over time"
            className="flex flex-col gap-4 border-b border-border pt-4 pb-5"
          >
            <div className="flex flex-wrap items-center gap-4">
              <BreakdownTabs
                dimensions={data.offered}
                value={dimension}
                onChange={(by) =>
                  url.patch({
                    by: by === data.offered[0] ? "" : by,
                    sort: "",
                    order: "",
                  })
                }
              />
              <span className="ml-auto flex flex-wrap items-center gap-3">
                <Segmented
                  label="Metric"
                  value={metric}
                  onChange={(next) =>
                    url.patch({ metric: next === "cost" ? "" : next })
                  }
                  options={METRICS}
                />
                {metric === "cost" ? (
                  <Checkbox
                    isSelected={withSubscription}
                    onChange={(isSelected) =>
                      url.patch({ subscription: isSelected ? "" : "exclude" })
                    }
                  >
                    Include subscription
                  </Checkbox>
                ) : null}
              </span>
            </div>
            <UsageChart
              starts={(summary?.series ?? []).map((point) =>
                Date.parse(point.bucket_start),
              )}
              barMs={barMs}
              folded={folded}
              formatValue={valueFormatter(metric)}
              axisFor={(max) => axisScale(max, metric)}
              span={span}
              onSpan={setSpan}
            />
            <div className="flex flex-wrap items-center gap-4 pl-16">
              <ChartLegend series={folded.series} />
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-caption text-subtle">
                {spanLabel ? (
                  <>
                    Showing {spanLabel} ·{" "}
                    <TextButton onPress={() => setSpan(undefined)}>
                      Reset
                    </TextButton>
                  </>
                ) : (
                  <>
                    <FiMove aria-hidden className="size-3" />
                    Drag to filter by date
                  </>
                )}
              </span>
            </div>
          </section>

          <section
            aria-labelledby="usage-breakdown-title"
            className="flex flex-col"
          >
            <div className="flex flex-wrap items-baseline gap-2.5 pt-5 pb-2">
              <h2 id="usage-breakdown-title" className="text-title">
                By {def.noun}
              </h2>
              <span className="text-caption text-subtle">
                {formatNumber(data.rows.length)}{" "}
                {data.rows.length === 1 ? "row" : "rows"} · hover or tap a row
                to filter
                {data.canOpenActivity ? ", click to open in Activity" : ""}
              </span>
            </div>
            <BreakdownTable
              key={dimension}
              dimension={dimension}
              rows={placeUnranked(data.rows)}
              sort={data.sort}
              onSort={(key) => url.patch(sortPatch(nextSort(data.sort, key)))}
              metric={metric}
              withSubscription={withSubscription}
              nameOf={names.nameOf}
              colorOf={folded.colorOf}
              onFilter={(value, mode) =>
                url.patch(filterPatch(url, dimension, value, mode))
              }
              onOpen={(row) => open(rowSearch(row))}
              canOpen={(row) => rowSearch(row) !== undefined}
              isLoading={data.isLoading}
              isLoadingP95={data.isLoadingP95}
              emptyContent={
                isFiltered ? (
                  <>
                    Nothing matches these filters.{" "}
                    <TextButton onPress={clearAll}>Clear filters</TextButton>
                  </>
                ) : (
                  "No usage in this window."
                )
              }
            />
          </section>

          {toolRows.length ? (
            <section
              aria-labelledby="usage-tools-title"
              className="flex flex-col gap-2.5 pt-8"
            >
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <h2 id="usage-tools-title" className="text-title">
                    Gateway-run tools
                  </h2>
                  <span className="text-caption text-subtle">
                    billed per call, not per token
                  </span>
                </div>
                <p className="max-w-prose text-caption">
                  Tools Otari ran itself. MCP tools run on your own server, so
                  they show on each request in Activity instead.
                </p>
              </div>
              <ToolsTable
                rows={toolRows}
                onSetPrice={viewer.isOperator ? setPricingTool : undefined}
                onOpen={
                  pageSearch
                    ? (tool) => open({ ...pageSearch, tool })
                    : undefined
                }
                isLoading={data.isFetchingTools}
              />
            </section>
          ) : null}
        </>
      )}

      {share && summary ? (
        <ShareDialog
          totals={share.totals}
          series={share.series}
          modelRows={share.modelRows}
          windowLabel={formatWindowLabel(bounds.start, bounds.end)}
          scopeSuffix={` · ${shareScope}`}
          startIso={bounds.start ?? ""}
          endIso={bounds.end ?? ""}
          isStale={data.isFetching}
          onClose={() => setIsSharing(false)}
        />
      ) : null}
      {pricingTool ? (
        <ToolPriceDialog
          tool={pricingTool}
          onClose={() => setPricingTool(undefined)}
        />
      ) : null}
    </div>
  )
}
