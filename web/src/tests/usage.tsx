import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useLocation } from "@tanstack/react-router"
import { render } from "@testing-library/react"
import type { ReactElement } from "react"
import { vi } from "vitest"
import type { SavedView, UsageSummary, UsageTotals, Workspace } from "@/client"
import { DIMENSIONS } from "@/features/usage/usageQuery"
import { API_ROOT } from "@/shared/api/client"
import type { UsageBreakdownRow } from "@/shared/api/usage"
import { SelectedWorkspaceProvider } from "@/shared/hooks/SelectedWorkspace"
import { DeploymentProvider } from "@/shared/hooks/useDeployment"
import {
  bootstrap,
  organizationContext,
  organizationMember,
  seriesPoint,
  usageTotals,
} from "@/tests/fixtures"
import { withRouter } from "@/tests/router"

export const WORKSPACE_ID = "ws-1"
export const CALLER_IDENTITY = "identity-1"
/** The id the caller's own requests carry, from the roster. */
export const OWN_USER_ID = "u-self"

/** Who is reading: a member, a workspace admin, an organization owner, or an operator. */
type UsageViewerKind = "member" | "workspaceAdmin" | "owner" | "operator"

export function breakdownRow(
  overrides: Partial<UsageBreakdownRow> & Pick<UsageBreakdownRow, "key">,
): UsageBreakdownRow {
  return {
    label: null,
    cost: 0,
    tokens: 0,
    requests: 0,
    is_other: false,
    imported_cost: 0,
    error_count: 0,
    cache_read_tokens: 0,
    p95_latency_ms: null,
    ...overrides,
  }
}

const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30"]

/** A month's usage: a billed model, a subscription one, and an unpriced call. */
export function breakdownSummary(
  overrides: Partial<UsageSummary> = {},
  totals: Partial<UsageTotals> = {},
): UsageSummary {
  const models = [
    breakdownRow({
      key: "claude-opus-5-5",
      cost: 1123.75,
      imported_cost: 1101.35,
      tokens: 1_783_900_000,
      cache_read_tokens: 1_748_200_000,
      requests: 4861,
      error_count: 5,
      p95_latency_ms: 9_400,
    }),
    breakdownRow({
      key: "fireworks:accounts/fireworks/models/deepseek-v4-flash",
      cost: 28.61,
      tokens: 7_700_000,
      cache_read_tokens: 600_000,
      requests: 3031,
      error_count: 2,
      p95_latency_ms: 1_850,
    }),
    breakdownRow({
      key: "claude-haiku-4-5",
      cost: 13.42,
      tokens: 845_800,
      requests: 271,
      p95_latency_ms: 640,
    }),
  ]
  return {
    start_date: "2026-08-31T00:00:00Z",
    end_date: "2026-09-30T12:00:00Z",
    bucket: "day",
    totals: usageTotals({
      cost: 1215.07,
      imported_cost: 1108.4,
      request_count: 8452,
      error_count: 8,
      unpriced_requests: 3,
      billed_input_tokens: 1_800_000_000,
      billed_output_tokens: 56_400_000,
      ...totals,
    }),
    by_model: models,
    by_user: [
      breakdownRow({
        key: OWN_USER_ID,
        cost: 1215.07,
        imported_cost: 1108.4,
        tokens: 1_856_400_000,
        requests: 8452,
      }),
      breakdownRow({
        key: "u-jordan",
        label: "Jordan M.",
        cost: 342.1,
        tokens: 61_200_000,
        requests: 2410,
        error_count: 9,
      }),
    ],
    by_api_key: [
      breakdownRow({
        key: "key-research",
        label: "research-app",
        cost: 64.26,
        tokens: 36_300_000,
        requests: 317,
      }),
      breakdownRow({
        key: null,
        cost: 1108.4,
        imported_cost: 1108.4,
        tokens: 1_811_300_000,
        requests: 4801,
      }),
    ],
    by_source: [],
    by_source_label: [
      breakdownRow({
        key: null,
        cost: 7.64,
        tokens: 12_300_000,
        requests: 3369,
        first_at: "2026-09-01T08:00:00Z",
        last_at: "2026-09-30T11:00:00Z",
      }),
      breakdownRow({
        key: "4e498676-f14e-4080-bbdb-a872e7114efb",
        cost: 536.97,
        imported_cost: 536.97,
        tokens: 854_800_000,
        requests: 2359,
        first_at: "2026-09-29T09:14:00Z",
        last_at: "2026-09-29T15:54:00Z",
        source: "claude_code",
      }),
    ],
    by_endpoint: [],
    by_provider: [],
    by_policy: [
      breakdownRow({ key: null, cost: 1186.08, requests: 5389 }),
      breakdownRow({ key: "thymeline-prod", cost: 28.99, requests: 3063 }),
    ],
    by_channel: [
      breakdownRow({
        key: "imported",
        cost: 1108.4,
        imported_cost: 1108.4,
        requests: 4801,
      }),
      breakdownRow({ key: "api", cost: 106.01, requests: 3649 }),
    ],
    by_workspace: [
      breakdownRow({
        key: WORKSPACE_ID,
        label: "Production",
        cost: 1215.07,
        requests: 8452,
      }),
      breakdownRow({
        key: "ws-2",
        label: "Research",
        cost: 823.8,
        requests: 3920,
      }),
    ],
    by_tool: [
      { tool: "web_search", calls: 51, errors: 0, requests: 13, cost: 0 },
    ],
    by_tag: [],
    errors_by_status_code: [],
    series: DAYS.map((day, index) => ({
      ...seriesPoint({
        bucket_start: `${day}T00:00:00Z`,
        cost: [10, 20, 1185.07][index],
        requests: [100, 200, 8152][index],
        input_tokens: [1_000, 2_000, 1_799_997_000][index],
        cache_read_tokens: [0, 0, 1_748_800_000][index],
      }),
      imported_cost: [0, 0, 1108.4][index],
    })),
    ...overrides,
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

interface FetchCall {
  url: string
  method: string
  body: string | undefined
}

export function mockUsageApi(
  opts: {
    viewer?: UsageViewerKind
    summary?: UsageSummary
    /** The window before's summary, which the tiles' growth reads. */
    previous?: UsageSummary
    views?: SavedView[]
    /** False for a manager whose own requests the roster names no id for. */
    hasOwnUserId?: boolean
    /** Workspaces a read of one by id answers with. */
    workspaces?: Workspace[]
    /**
     * Whether the workspace shares its totals with members. Kept from them
     * unless a test shares them, which keeps a member to their own usage.
     */
    membersSeeWorkspaceTotals?: boolean
    /** Held open for the visibility read, until it resolves. */
    holdVisibility?: Promise<void>
    /** Held open for every visibility read after the first, until it resolves. */
    holdReread?: Promise<void>
    /** The visibility read fails. */
    visibilityFails?: boolean
    /**
     * The managers turn the totals off before the page next asks for them:
     * that ask is refused, and the setting reads as hidden from then on.
     */
    revokesTotals?: boolean
    /** A promise a read waits on before it answers, to hold one back. */
    hold?: (
      kind: "summary" | "series" | "latency" | "tools",
      params: URLSearchParams,
    ) => Promise<void> | undefined
  } = {},
) {
  const viewer = opts.viewer ?? "owner"
  const summary = opts.summary ?? breakdownSummary()
  const calls: FetchCall[] = []
  let isShared = opts.membersSeeWorkspaceTotals ?? false
  let visibilityReads = 0
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      })
      const params = new URL(url, "http://localhost").searchParams
      if (url.includes("/saved-views")) {
        return jsonResponse({ data: opts.views ?? [], count: 0 })
      }
      if (url.includes("/pricing") && method === "POST") {
        return jsonResponse({})
      }
      if (url.includes(`/workspaces/${WORKSPACE_ID}/visibility`)) {
        await opts.holdVisibility
        if (opts.visibilityFails) {
          return jsonResponse({ detail: "visibility exploded" }, 500)
        }
        visibilityReads += 1
        if (visibilityReads > 1) await opts.holdReread
        return jsonResponse({ members_see_workspace_totals: isShared })
      }
      if (params.get("workspace_totals") === "true" && opts.revokesTotals) {
        isShared = false
      }
      if (params.get("workspace_totals") === "true" && !isShared) {
        return jsonResponse(
          { detail: "Workspace totals are not shared with members" },
          403,
        )
      }
      if (url.includes(`/workspaces/${WORKSPACE_ID}/budget`)) {
        // As the server answers: a member of a workspace that keeps its totals
        // from members is given the share used, not the dollars.
        const hidesSpend = viewer === "member" && !isShared
        return jsonResponse({
          workspace_id: WORKSPACE_ID,
          max_budget: 500,
          spent: hidesSpend ? null : 412,
          // Rounded to a whole percent where the dollars are withheld.
          used_fraction: hidesSpend ? 0.82 : 0.824,
          period_start: "2026-09-01T00:00:00Z",
          period_end: "2026-10-01T00:00:00Z",
        })
      }
      const known = opts.workspaces?.find((one) =>
        url.endsWith(`/workspaces/${one.id}`),
      )
      if (known) return jsonResponse(known)
      if (url.includes("/usage/summary")) {
        await opts.hold?.("summary", params)
        if (params.getAll("dimensions").includes("none")) {
          return jsonResponse(opts.previous ?? breakdownSummary())
        }
        // As the server does: only the breakdowns asked for are filled, and
        // `rank_order=asc` lists them from the other end, the rows with no key
        // and the fold still last. The fixture's rows are in descending order.
        // A row carries its p95 only where `p95_by` named its breakdown or the
        // ranking is by p95, as on the server.
        const asked = new Set(params.getAll("dimensions"))
        const isAscending = params.get("rank_order") === "asc"
        const withP95 = (dimension: string, rows: UsageBreakdownRow[]) =>
          params.get("p95_by") === dimension || params.get("rank_by") === "p95"
            ? rows
            : rows.map((row) => ({ ...row, p95_latency_ms: null }))
        return jsonResponse(
          Object.fromEntries(
            Object.entries(summary).map(([field, value]) => {
              if (!field.startsWith("by_")) return [field, value]
              if (!asked.has(field.slice(3))) return [field, []]
              if (field === "by_tool") return [field, value]
              const ranked = withP95(
                field.slice(3),
                value as UsageBreakdownRow[],
              )
              if (!isAscending) return [field, ranked]
              const rows = ranked
              const isRanked = (row: UsageBreakdownRow) =>
                !row.is_other && row.key !== null
              return [
                field,
                [
                  ...rows.filter(isRanked).reverse(),
                  ...rows.filter((row) => !isRanked(row)),
                ],
              ]
            }),
          ),
        )
      }
      // The latency and the tools are read apart from the summary, so they
      // answer from the same fixture: each group's p95 off its breakdown row.
      if (url.includes("/usage/latency")) {
        await opts.hold?.("latency", params)
        const groupBy = params.get("group_by")
        const rows = groupBy
          ? ((summary as unknown as Record<string, UsageBreakdownRow[]>)[
              `by_${groupBy}`
            ] ?? [])
          : []
        return jsonResponse({
          start_date: summary.start_date,
          end_date: summary.end_date,
          p95_latency_ms: groupBy ? null : summary.totals.p95_latency_ms,
          group_by: groupBy,
          groups: rows
            .filter((row) => !row.is_other)
            .map((row) => ({
              key: row.key,
              p95_latency_ms: row.p95_latency_ms ?? null,
            })),
        })
      }
      if (url.includes("/usage/tools")) {
        await opts.hold?.("tools", params)
        return jsonResponse({
          start_date: summary.start_date,
          end_date: summary.end_date,
          tools: summary.by_tool,
        })
      }
      if (url.includes("/usage/series")) {
        await opts.hold?.("series", params)
        const groupBy = params.get("group_by") ?? "model"
        const def = Object.values(DIMENSIONS).find(
          (one) => one.series === groupBy,
        )
        const rows = def?.rows(summary) ?? []
        return jsonResponse({
          start_date: summary.start_date,
          end_date: summary.end_date,
          bucket: "day",
          group_by: groupBy,
          groups: rows,
          points: rows.map((row) => ({
            bucket_start: "2026-09-30T00:00:00Z",
            key: row.key,
            is_other: false,
            cost: row.cost,
            imported_cost: row.imported_cost,
            tokens: row.tokens,
            requests: row.requests,
          })),
        })
      }
      if (url.includes(`${API_ROOT}/organizations/me/members`)) {
        const members = [
          organizationMember({
            user_id: CALLER_IDENTITY,
            attribution_user_id:
              opts.hasOwnUserId === false ? null : OWN_USER_ID,
          }),
        ]
        return jsonResponse({ data: members, total: members.length })
      }
      if (url.endsWith(`${API_ROOT}/organizations/me`)) {
        return jsonResponse(
          organizationContext({
            role:
              viewer === "owner" || viewer === "operator" ? "owner" : "member",
            caller: {
              user_id: CALLER_IDENTITY,
              email: "me@example.com",
              full_name: null,
              has_password: true,
              claims_deployment: viewer === "operator",
            },
            deployment_operator: viewer === "operator",
            workspace_memberships: [
              {
                workspace_id: WORKSPACE_ID,
                name: "Production",
                role:
                  viewer === "member"
                    ? "member"
                    : viewer === "workspaceAdmin"
                      ? "admin"
                      : "owner",
              },
            ],
          }),
        )
      }
      return jsonResponse([])
    })
  return { mock, calls }
}

/** Every usage read of one kind, as parameters, oldest first. */
export function usageReads(
  calls: readonly FetchCall[],
  kind: "summary" | "series" | "latency" | "tools",
): URLSearchParams[] {
  return calls
    .filter((call) => call.url.includes(`/usage/${kind}`))
    .map((call) => new URL(call.url, "http://localhost").searchParams)
}

/** The page's own summary (not the window before's), latest first. */
export function lastBreakdown(calls: readonly FetchCall[]): URLSearchParams {
  const reads = usageReads(calls, "summary").filter(
    (params) => !params.getAll("dimensions").includes("none"),
  )
  return reads.at(-1) ?? new URLSearchParams()
}

/** Surfaces where a navigation landed, by role, for a drill into Activity. */
function LocationProbe() {
  const location = useLocation()
  return (
    <div
      role="status"
      aria-label="Current location"
    >{`${location.pathname}${location.searchStr}`}</div>
  )
}

/** Shows the page's own URL, so a test can read what it wrote. */
export function UrlProbe() {
  const location = useLocation()
  return <output aria-label="Page URL">{location.searchStr}</output>
}

export function renderUsage(ui: ReactElement, route = "/usage") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <DeploymentProvider value={bootstrap()}>
      <QueryClientProvider client={client}>
        <SelectedWorkspaceProvider>{ui}</SelectedWorkspaceProvider>
      </QueryClientProvider>
    </DeploymentProvider>,
    {
      wrapper: withRouter({
        url: route,
        routes: [{ path: "/activity", element: <LocationProbe /> }],
      }),
    },
  )
}
