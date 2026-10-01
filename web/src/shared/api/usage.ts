import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type {
  InFlightResponse,
  SummaryDimension,
  UsageActivityGroupBy,
  UsageActivityGroups,
  UsageBucket,
  UsageCount,
  UsageDeleteResult,
  UsageEntry,
  UsageFilters,
  UsageGroupBy,
  UsageGroupedSeries,
  UsageMutationSelection,
  UsageSetPriceRequest,
  UsageSetPriceResult,
  UsageSortKey,
  UsageSummary,
} from "@/client"
import { ApiError, apiFetch, longRequestSignal } from "@/shared/api/client"
import { useOrganizationContext } from "@/shared/api/organizations"
import { USAGE } from "@/shared/api/queryKeys"
import { isoAgo } from "@/shared/helpers/timeRange"

// ---------- activity / request log ----------

// Serialize the activity-log filters into query params, dropping empty values so
// the query key and the request URL stay stable across renders.
//
// Every field of UsageFilters has to appear here. The list, the row count, and the
// summary all go through this one function, so a field left out does not fail
// loudly: the page still shows its filter chip and the URL still carries the value,
// while the request goes out unfiltered and the table quietly shows everything.
function usageParams(filters: UsageFilters): URLSearchParams {
  const params = new URLSearchParams()
  // A multi-value filter goes on the wire as a repeated param (the analytics
  // endpoints match any of them); an empty array is no filter at all, not a
  // filter matching nothing.
  const appendAll = (key: string, value: string | string[] | undefined) => {
    const values = typeof value === "string" ? [value] : (value ?? [])
    values
      .filter((one) => one !== "")
      .forEach((one) => {
        params.append(key, one)
      })
  }
  if (filters.workspace_id) params.set("workspace_id", filters.workspace_id)
  if (filters.start_date) params.set("start_date", filters.start_date)
  if (filters.end_date) params.set("end_date", filters.end_date)
  if (filters.status) params.set("status", filters.status)
  appendAll("model", filters.model)
  if (filters.endpoint) params.set("endpoint", filters.endpoint)
  if (filters.provider) params.set("provider", filters.provider)
  appendAll("user_id", filters.user_id)
  appendAll("api_key_id", filters.api_key_id)
  if (filters.source) params.set("source", filters.source)
  if (filters.source_label) params.set("source_label", filters.source_label)
  if (filters.tool) params.set("tool", filters.tool)
  if (filters.priced !== undefined) params.set("priced", String(filters.priced))
  if (filters.counts_toward_budget !== undefined) {
    params.set("counts_toward_budget", String(filters.counts_toward_budget))
  }
  if (filters.include_absorbed !== undefined) {
    params.set("include_absorbed", String(filters.include_absorbed))
  }
  if (filters.q) params.set("q", filters.q)
  appendAll("requested_model", filters.requested_model)
  appendAll("exclude_model", filters.exclude_model)
  appendAll("exclude_user_id", filters.exclude_user_id)
  appendAll("exclude_api_key_id", filters.exclude_api_key_id)
  appendAll("exclude_source", filters.exclude_source)
  appendAll("exclude_status", filters.exclude_status)
  appendAll("policy_name", filters.policy_name)
  appendAll("exclude_policy_name", filters.exclude_policy_name)
  if (filters.routed !== undefined) params.set("routed", String(filters.routed))
  appendAll("is_null", filters.is_null)
  if (filters.tokens_gt !== undefined) {
    params.set("tokens_gt", String(filters.tokens_gt))
  }
  if (filters.cost_gt !== undefined) {
    params.set("cost_gt", String(filters.cost_gt))
  }
  if (filters.latency_ms_gt !== undefined) {
    params.set("latency_ms_gt", String(filters.latency_ms_gt))
  }
  return params
}

// One page of usage-log rows for the Activity viewer, newest first.
// Which of the two usage surfaces this caller may read.
//
// `/usage` is deployment-wide and refuses anyone who does not operate the
// deployment; `/organizations/me/usage` serves the same rows narrowed to the
// caller's own organization, to the workspaces they belong to within it
// (otari#837), and for a member or viewer to the requests billed to them. Both answer identical shapes, so every hook below differs only in
// the prefix it asks.
//
// Read off the organization context rather than `useDeploymentAdminAccess`,
// because the shell reads that context on every page anyway, so on all but the
// first paint the answer is already cached and no request goes to the wrong
// surface. `ready` covers the paint where it is not: an operator sent briefly to
// the scoped route would read their own organization's subset and quietly
// understate every total on screen, so the hooks wait rather than guess.
//
// **An errored context is ready, not still waiting.** It is the same question
// either way ("has the answer stopped being unknown"), and treating a failure as
// perpetual loading disables every usage hook for the session: the pages then
// issue no request at all and state that a gateway serving traffic has none,
// with nothing to report because nothing was asked. A suspended membership
// reaches this, since `_resolve_active_organization` 404s with no live
// membership to fall back to. So a failure falls through to the *narrower*
// surface, which is the safe direction (understating beats a cross-tenant read),
// and its own refusal is what the page reports. `AppShell` resolves the same
// error the same way, failing open rather than stranding the destinations behind
// it.
//
// The base is part of every query key it feeds, so two callers on one browser
// can never read each other's cached rows.
//
// `"organization"` pins the narrow surface regardless of who is asking. It
// exists for the organization-wide Usage page (otari-ai#1963), whose question is
// "this organization", so for an operator the caller-derived scope would answer
// a different one: `/usage` reads every tenant on the deployment, and a page
// titled with the organization would silently overstate it. A pinned base needs
// no context answer to be known, so it is ready on first paint.
export type UsageScope = "caller" | "organization"

export function useUsageScope(scope: UsageScope = "caller"): {
  base: string
  isReady: boolean
  isDeploymentWide: boolean
} {
  const context = useOrganizationContext()
  const isDeploymentWide =
    scope === "caller" && context.data?.deployment_operator === true
  return {
    base: isDeploymentWide ? "/usage" : "/organizations/me/usage",
    isReady: scope === "organization" || context.isSuccess || context.isError,
    isDeploymentWide,
  }
}

export interface UsageSort {
  key: UsageSortKey
  order: "asc" | "desc"
}

/** The server's own order, so a caller that does not sort sends nothing. */
export const NEWEST_FIRST: UsageSort = { key: "timestamp", order: "desc" }

export function isSameSort(a: UsageSort, b: UsageSort): boolean {
  return a.key === b.key && a.order === b.order
}

/**
 * The filters without `include_absorbed`, which only the list and its count
 * read: a summary, a grouping or a bulk selection counts earlier failed
 * attempts separately either way.
 */
export function withoutListOnly(
  filters: UsageFilters,
): Omit<UsageFilters, "include_absorbed"> {
  const { include_absorbed: _listOnly, ...rest } = filters
  return rest
}

// The log is a snapshot an operator reads, not a feed. On a busy gateway rows
// arrive faster than anyone can inspect them, so a page that refetched on its
// own reshuffled the table out from under whoever was reading it. It refetches
// only when asked: a mount, the refresh button, or a change of filters, window,
// or page (all of which are in the key). Nothing here opts back into the
// provider's refetch-on-focus default, which is already off (`provider.tsx`).
// `useLiveUsageCount` is how the page still says that newer rows exist.
const LOG_STALE_MS = 10_000

/** One read of log rows: `limit` of them after the first `skip`, in `sort` order. */
function fetchUsageRows(
  base: string,
  filters: UsageFilters,
  { skip, limit, sort }: { skip: number; limit: number; sort: UsageSort },
): Promise<UsageEntry[]> {
  const params = usageParams(filters)
  params.set("skip", String(skip))
  params.set("limit", String(limit))
  if (!isSameSort(sort, NEWEST_FIRST)) {
    params.set("sort", sort.key)
    params.set("order", sort.order)
  }
  return apiFetch<UsageEntry[]>(`${base}?${params.toString()}`)
}

// One page of the log. Every reader of a page goes through this, so a key
// has one fetcher: a grouped log's preview of a group and the same filter's
// first page share an entry and must agree on what it holds.
function usagePageQuery(
  base: string,
  filters: UsageFilters,
  page: number,
  pageSize: number,
  sort: UsageSort,
) {
  return queryOptions({
    queryKey: [USAGE, "list", base, filters, page, pageSize, sort],
    queryFn: () =>
      fetchUsageRows(base, filters, {
        skip: page * pageSize,
        limit: pageSize,
        sort,
      }),
    staleTime: LOG_STALE_MS,
  })
}

// `placeholderData: keepPreviousData` keeps the current page on screen while the
// next loads, so paging does not flash empty.
export function useUsageLogs(
  filters: UsageFilters,
  page: number,
  pageSize: number,
  {
    sort = NEWEST_FIRST,
    enabled = true,
  }: { sort?: UsageSort; enabled?: boolean } = {},
) {
  const scope = useUsageScope()
  return useQuery({
    ...usagePageQuery(scope.base, filters, page, pageSize, sort),
    enabled: enabled && scope.isReady,
    placeholderData: keepPreviousData,
  })
}

// The log read a batch at a time and kept, for a list that grows as it is
// scrolled rather than paging: each batch asks only for the rows after the last,
// and the next is offered while a batch came back full and the rows stay under
// `maxRows`.
export function useUsageBatches(
  filters: UsageFilters,
  batch: number,
  maxRows: number,
  {
    sort = NEWEST_FIRST,
    enabled = true,
  }: { sort?: UsageSort; enabled?: boolean } = {},
) {
  const scope = useUsageScope()
  return useInfiniteQuery({
    queryKey: [USAGE, "batches", scope.base, filters, batch, sort],
    queryFn: ({ pageParam }) =>
      fetchUsageRows(scope.base, filters, {
        skip: pageParam,
        limit: batch,
        sort,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, skip) =>
      last.length === batch && skip + batch < maxRows
        ? skip + batch
        : undefined,
    enabled: enabled && scope.isReady,
    // A snapshot, as the paged log is.
    staleTime: LOG_STALE_MS,
  })
}

// One row by its own id, for a link that opens a request: the row it names is
// usually not on the page the link lands on. Read only while `id` is set.
export function useUsageRow(id: string | undefined) {
  const scope = useUsageScope()
  return useQuery({
    queryKey: [USAGE, "row", scope.base, id],
    queryFn: async () => {
      const params = new URLSearchParams({ id: id as string })
      const [row] = await apiFetch<UsageEntry[]>(
        `${scope.base}?${params.toString()}`,
      )
      return row ?? null
    },
    enabled: id !== undefined && scope.isReady,
    staleTime: 30_000,
  })
}

// The count's query for the list it sits beside. Only the sort's column
// matters: any but time bounds the window as the list's does, whichever way.
function countParams(filters: UsageFilters, sortKey: UsageSortKey) {
  const params = usageParams(filters)
  if (sortKey !== NEWEST_FIRST.key) params.set("sort", sortKey)
  return params.toString()
}

// Total rows matching the same filters, for the paginator's "N of M". A separate
// request so /v1/usage stays a bare array; run alongside the list, in its order.
//
// Deliberately as frozen as the log it counts (see `useUsageLogs`): the total
// describes the page on screen, so a total that moved on its own would disagree
// with the rows the operator can actually page through.
export function useUsageCount(
  filters: UsageFilters,
  enabled = true,
  sort: UsageSort = NEWEST_FIRST,
) {
  const scope = useUsageScope()
  return useQuery({
    queryKey: [USAGE, "count", scope.base, filters, sort.key],
    queryFn: () =>
      apiFetch<UsageCount>(
        `${scope.base}/count?${countParams(filters, sort.key)}`,
      ),
    enabled: enabled && scope.isReady,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  })
}

// How often the live row count re-reads. Slow, because nothing on screen moves
// when it changes: it only sizes the "N new" badge, which an operator glances at
// rather than watches. TanStack does not poll a backgrounded tab, so an idle
// dashboard costs nothing.
const NEW_ROW_POLL_MS = 15_000

// The same count as `useUsageCount`, polled, so a frozen page can say how far
// behind it has fallen without moving a single row.
//
// A separate cache entry rather than a `refetchInterval` on `useUsageCount`: the
// two readings serve opposite purposes (one is pinned to the rendered page, the
// other is deliberately ahead of it), and two observers of one query key cannot
// disagree about how fresh their data is. The duplicate `COUNT(*)` at mount is
// one indexed count, which is what makes polling it affordable in the first place.
export function useLiveUsageCount(
  filters: UsageFilters,
  enabled = true,
  sort: UsageSort = NEWEST_FIRST,
) {
  const scope = useUsageScope()
  return useQuery({
    queryKey: [USAGE, "count", "live", scope.base, filters, sort.key],
    queryFn: () =>
      apiFetch<UsageCount>(
        `${scope.base}/count?${countParams(filters, sort.key)}`,
      ),
    enabled: enabled && scope.isReady,
    refetchInterval: NEW_ROW_POLL_MS,
    staleTime: 0,
    // A failed count is not worth surfacing: it sits beside a refresh button that
    // fetches the real thing, and the next poll retries anyway.
    retry: false,
  })
}

// How often the in-flight list re-reads. Tight, because it is the only view of a
// request that has not settled yet and the reason to watch it is that something is
// taking a while. TanStack does not poll a backgrounded tab
// (`refetchIntervalInBackground` defaults to false), so an idle dashboard left open
// costs nothing.
const IN_FLIGHT_POLL_MS = 2_000

// Requests the gateway is serving right now, rendered as a live count beside the
// activity log's refresh control rather than as rows in it: the log is a frozen
// snapshot, and rows that reordered themselves every two seconds were the reason
// a busy gateway's activity page could not be read at all. The read takes no
// filters: a request in progress has no outcome, cost, or token count for the
// log's filters to match on, so it is reported gateway-wide.
//
// Never cached across mounts (`staleTime: 0`) and never kept as placeholder data:
// a stale in-flight list is worse than none, since it claims work is running that
// finished a minute ago.
// `enabled` is how the Activity page keeps a non-operator from polling a route
// that would refuse them every few seconds: this one endpoint stays
// deployment-wide, because its registry entries carry no workspace to scope by
// (see `usage.list_in_flight`).
export function useInFlightRequests(enabled = true) {
  return useQuery({
    queryKey: [USAGE, "in-flight"],
    queryFn: () => apiFetch<InFlightResponse>("/usage/in-flight"),
    enabled,
    refetchInterval: IN_FLIGHT_POLL_MS,
    staleTime: 0,
    // Retrying a 404 cannot help: a gateway that does not serve this endpoint
    // never will. Fail fast on it and add no rows rather than re-asking.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 3,
  })
}

// How often the rolling failure count re-reads. A dropped-traffic signal is only
// useful if it moves while the operator watches it.
const FAILURE_COUNT_POLL_MS = 60_000

// Requests that failed within the last `windowSeconds`, as a live count. The
// window is resolved inside the query function, not in the key, for two reasons:
// the key stays stable (a "now"-derived key would mint a new cache entry on every
// render), and every refetch re-anchors, so a tab left open keeps reporting the
// last hour rather than quietly widening to the last hour and a half.
//
// Scoped to `source: "gateway"`: imported usage can carry status=error too (the
// external-events API accepts it), and an imported session's failures are not this
// gateway dropping traffic. Counting them would make the signal cry wolf.
export function useFailureCount(windowSeconds: number, enabled = true) {
  const scope = useUsageScope()
  return useQuery({
    queryKey: [USAGE, "count", "failures", scope.base, windowSeconds],
    queryFn: () => {
      const filters: UsageFilters = {
        status: "error",
        source: "gateway",
        start_date: isoAgo(windowSeconds),
      }
      return apiFetch<UsageCount>(
        `${scope.base}/count?${usageParams(filters).toString()}`,
      )
    },
    enabled: enabled && scope.isReady,
    refetchInterval: FAILURE_COUNT_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    // A failed count is not worth surfacing: it sits beside its own alarm, and
    // the next poll retries anyway.
    retry: false,
  })
}

// Unpriced usage moves at the pace of traffic to a model nobody priced, so a slow
// poll is enough for a banner that reports it.
const UNPRICED_USAGE_POLL_MS = 5 * 60_000

// Successful gateway requests within the last `windowSeconds` whose model usage
// had no price (the Activity page's "Unpriced" filter), with the models that
// served them. One bounded summary read: the totals, and the `model` breakdown
// only. `workspaceId` narrows it the way Activity narrows to the shell's
// selected workspace, so a count and the Activity rows it links to agree; ""
// is no workspace, which Activity reads as deployment-wide too. The window is
// resolved in the query function for the reasons `useFailureCount` gives.
export function useUnpricedUsage(
  windowSeconds: number,
  workspaceId: string,
  enabled = true,
) {
  const scope = useUsageScope()
  return useQuery({
    queryKey: [
      USAGE,
      "summary",
      "unpriced",
      scope.base,
      workspaceId,
      windowSeconds,
    ],
    queryFn: () => {
      const params = usageParams({
        workspace_id: workspaceId || undefined,
        status: "success",
        source: "gateway",
        priced: false,
        start_date: isoAgo(windowSeconds),
      })
      params.set("bucket", "hour")
      params.append("dimensions", "model")
      return apiFetch<UsageSummary>(
        `${scope.base}/summary?${params.toString()}`,
      )
    },
    enabled: enabled && scope.isReady,
    refetchInterval: UNPRICED_USAGE_POLL_MS,
    retry: false,
  })
}

// The rows of one or more request groups: every attempt a routed request made,
// which is what turns "attempt 1 of 2, failed" into "and here is what served it".
// A plan is capped at a handful of candidates and the activity table pages at a
// hundred rows, so this leaves an order of magnitude of headroom over the largest
// batch either caller can ask for. It is deliberately not a tight bound: nothing
// downstream detects truncation, so the limit has to be one no real page reaches.
const REQUEST_GROUP_PAGE_LIMIT = 1000

// Fetched as a batch (the endpoint takes a repeatable `request_group_id`) so a
// page of the activity log costs one lookup rather than one per row. The key
// sorts its ids so two callers asking for the same set share a cache entry.
export function useRequestGroups(groupIds: readonly string[]) {
  const ids = [...new Set(groupIds)].sort()
  const scope = useUsageScope()
  return useQuery({
    queryKey: [USAGE, "groups", scope.base, ids],
    queryFn: () => {
      const params = new URLSearchParams()
      ids.forEach((id) => {
        params.append("request_group_id", id)
      })
      params.set("limit", String(REQUEST_GROUP_PAGE_LIMIT))
      return apiFetch<UsageEntry[]>(`${scope.base}?${params.toString()}`)
    },
    enabled: ids.length > 0 && scope.isReady,
    placeholderData: keepPreviousData,
    // A group is immutable once its request finished, so the only reason to
    // refetch is a group that was still in flight when it was first read.
    staleTime: 30_000,
  })
}

// Delete imported usage rows by selection (ids or by_filter). Only rows the server
// treats as imported are removed, which is provenance as well as budget participation
// (see `UsageEntry.bulk_editable`); every usage view is invalidated so the list, count,
// and analytics refresh.
//
// Given the long deadline, not apiFetch's default: a by_filter delete is one
// unbounded DELETE server-side, so its duration tracks the number of matched
// rows. Timing out here would report failure for a delete that committed anyway.
export function useDeleteUsage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UsageMutationSelection) =>
      apiFetch<UsageDeleteResult>("/usage", {
        method: "DELETE",
        body: JSON.stringify(body),
        signal: longRequestSignal(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [USAGE] })
    },
  })
}

// Set the cost of imported usage rows from manual per-1M rates. Long deadline
// for the same reason as the delete: the server reprices every matched row.
export function useSetUsagePrice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UsageSetPriceRequest) =>
      apiFetch<UsageSetPriceResult>("/usage/set-price", {
        method: "POST",
        body: JSON.stringify(body),
        signal: longRequestSignal(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [USAGE] })
    },
  })
}

// ---------- usage analytics summary ----------

// Pass this as `dimensions` to read only `totals` / `series`. Named rather than a
// bare `[]` at each call site so it is clear the omission is deliberate.
export const NO_BREAKDOWNS: SummaryDimension[] = []

// Aggregated spend/tokens/requests for the Usage page. Shares the activity
// filter serialization and adds the time-series bucket. `enabled` lets a caller
// skip the request (e.g. the previous-period query when the range is unbounded,
// so there is nothing to compare against). staleTime is longer than the live
// Activity log's: an aggregate over days moves slowly and need not refetch on
// every focus.
//
// `dimensions` names the breakdowns to compute. Each one costs the server a
// separate GROUP BY over the window, and several callers here read only `totals`
// or `series` (tiles, timeline context, the previous-period comparison), so they
// pass `[]` and skip all of them. Omitting the argument keeps the server default
// (every breakdown).
export function useUsageSummary(
  filters: UsageFilters,
  bucket: UsageBucket,
  dimensions?: SummaryDimension[],
  enabled = true,
  usageScope: UsageScope = "caller",
) {
  const scope = useUsageScope(usageScope)
  return useQuery({
    queryKey: [
      USAGE,
      "summary",
      scope.base,
      filters,
      bucket,
      dimensions ?? "all",
    ],
    queryFn: () => {
      const params = usageParams(filters)
      params.set("bucket", bucket)
      // A repeated query param has no empty-list form, so an empty selection goes
      // on the wire as the server's `none` sentinel.
      if (dimensions) {
        const requested = dimensions.length > 0 ? dimensions : ["none"]
        requested.forEach((dimension) => {
          params.append("dimensions", dimension)
        })
      }
      return apiFetch<UsageSummary>(
        `${scope.base}/summary?${params.toString()}`,
      )
    },
    enabled: enabled && scope.isReady,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

// The Activity page's totals line and chart: the series and the totals, and
// no breakdowns. The 95th-percentile latency sorts the window's latencies, so
// the server computes it only when asked: the totals line asks, the chart does
// not. `include_absorbed` is the list's and count's alone, so it is not sent:
// the totals count earlier failed attempts separately either way.
export function useActivityTotals(
  filters: UsageFilters,
  bucket: UsageBucket,
  {
    enabled = true,
    withP95 = false,
  }: { enabled?: boolean; withP95?: boolean } = {},
) {
  const scope = useUsageScope()
  const summaryFilters = withoutListOnly(filters)
  return useQuery({
    queryKey: [
      USAGE,
      "summary",
      "activity",
      scope.base,
      summaryFilters,
      bucket,
      withP95,
    ],
    queryFn: () => {
      const params = usageParams(summaryFilters)
      params.set("bucket", bucket)
      params.append("dimensions", "none")
      if (withP95) params.set("include_p95", "true")
      return apiFetch<UsageSummary>(
        `${scope.base}/summary?${params.toString()}`,
      )
    },
    enabled: enabled && scope.isReady,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  })
}

// The first rows of each of several filtered sets, for the groups a grouped
// log has open: each the first page of that filter's list, newest first.
export function useUsagePreviews(
  filterSets: readonly UsageFilters[],
  limit: number,
) {
  const scope = useUsageScope()
  return useQueries({
    queries: filterSets.map((filters) => ({
      ...usagePageQuery(scope.base, filters, 0, limit, NEWEST_FIRST),
      enabled: scope.isReady,
    })),
  })
}

// The endpoint's own ceiling. A grouping past it says how many groups there
// were, and the page offers to narrow rather than paging groups.
export const ACTIVITY_GROUP_LIMIT = 200

// How a column menu asks for its values: busiest first, narrowed by what the
// menu's search box holds. The grouped log leaves both off, most recent first.
export type GroupsQuery = { search?: string; order?: "recent" | "requests" }

// The log collapsed to one row per key, session, model, member, policy or alias,
// with each group's totals: the grouped log, and the values a column menu lists.
// The previous result stands in only for the same grouping, since another
// grouping's keys would be read as this one's: model names listed as members.
export function useActivityGroups(
  filters: UsageFilters,
  groupBy: UsageActivityGroupBy,
  {
    enabled = true,
    search = "",
    order = "recent",
  }: GroupsQuery & { enabled?: boolean } = {},
) {
  const scope = useUsageScope()
  const groupFilters = withoutListOnly(filters)
  return useQuery({
    // The grouping ends the key, which is what the placeholder below compares.
    queryKey: [
      USAGE,
      "activity-groups",
      scope.base,
      groupFilters,
      search,
      order,
      groupBy,
    ],
    queryFn: () => {
      const params = usageParams(groupFilters)
      params.set("group_by", groupBy)
      params.set("limit", String(ACTIVITY_GROUP_LIMIT))
      if (search) params.set("search", search)
      if (order !== "recent") params.set("order", order)
      return apiFetch<UsageActivityGroups>(
        `${scope.base}/groups?${params.toString()}`,
      )
    },
    enabled: enabled && scope.isReady,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey.at(-1) === groupBy ? previous : undefined,
    staleTime: 10_000,
  })
}

// A per-group time series for the stacked analytics chart (top groups by spend
// plus an "other" fold). Only fetched while a group-by dimension is active, so
// the ungrouped view costs nothing extra. Caching mirrors useUsageSummary.
export function useUsageGroupedSeries(
  filters: UsageFilters,
  bucket: UsageBucket,
  groupBy: UsageGroupBy | null,
  enabled = true,
  usageScope: UsageScope = "caller",
) {
  const scope = useUsageScope(usageScope)
  return useQuery({
    queryKey: [USAGE, "series", scope.base, filters, bucket, groupBy],
    queryFn: () => {
      const params = usageParams(filters)
      params.set("bucket", bucket)
      params.set("group_by", groupBy as string)
      return apiFetch<UsageGroupedSeries>(
        `${scope.base}/series?${params.toString()}`,
      )
    },
    enabled: enabled && groupBy !== null && scope.isReady,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // A 404 is version skew (a gateway older than this dashboard, e.g. not yet
    // restarted onto the build that ships it); retrying cannot fix that, and
    // the page falls back to the ungrouped view with a notice instead.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 3,
  })
}
