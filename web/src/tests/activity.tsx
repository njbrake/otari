import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render } from "@testing-library/react"
import type { ReactElement } from "react"
import { vi } from "vitest"

import type {
  InFlightResponse,
  OrganizationMember,
  SavedView,
  UsageActivityGroup,
  UsageEntry,
  UsageSeriesPoint,
  UsageTotals,
  WorkspaceSpend,
} from "@/client"
import { API_ROOT } from "@/shared/api/client"
import { SelectedWorkspaceProvider } from "@/shared/hooks/SelectedWorkspace"
import { DeploymentProvider } from "@/shared/hooks/useDeployment"
import { bootstrap } from "@/tests/fixtures"
import { withRouter } from "@/tests/router"

export function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  const row = {
    id: "req-1",
    user_id: "alice",
    api_key_id: "key-1",
    api_key_name: "ci-runner",
    timestamp: new Date().toISOString(),
    model: "gpt-4o",
    provider: "openai",
    endpoint: "/v1/chat/completions",
    prompt_tokens: 1200,
    completion_tokens: 300,
    total_tokens: 1500,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cache_write_1h_tokens: null,
    billing_meters: null,
    pricing_breakdown: null,
    cost: 0.0123,
    status: "success",
    error_message: null,
    status_code: null,
    latency_ms: 842,
    ttft_ms: null,
    source: "gateway",
    source_label: null,
    counts_toward_budget: true,
    absorbed_attempts: 0,
    requested_model: null,
    request_id: null,
    policy_name: null,
    attempt_position: null,
    attempt_count: null,
    selection_reason: null,
    request_group_id: null,
    ...overrides,
  }
  return {
    ...row,
    // Mirror the server's derivation unless a test explicitly overrides it.
    bulk_editable:
      overrides.bulk_editable ??
      (!row.counts_toward_budget && row.source !== "gateway"),
  }
}

export function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    cost: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_write_1h_tokens: 0,
    request_count: 0,
    error_count: 0,
    avg_latency_ms: null,
    p95_latency_ms: null,
    unpriced_requests: 0,
    billed_input_tokens: 0,
    billed_output_tokens: 0,
    absorbed_count: 0,
    imported_cost: 0,
    reasoning_tokens: 0,
    ...overrides,
  }
}

export function group(
  overrides: Partial<UsageActivityGroup> = {},
): UsageActivityGroup {
  return {
    key: "key-1",
    label: "ci-runner",
    requests: 1,
    errors: 0,
    absorbed: 0,
    cost: 0.01,
    imported_cost: 0,
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_tokens: 0,
    latency_ms: 842,
    first_at: new Date().toISOString(),
    last_at: new Date().toISOString(),
    models: ["gpt-4o"],
    model_count: 1,
    ...overrides,
  }
}

export function savedView(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: "view-1",
    user_id: "identity-1",
    page: "activity",
    name: "Slow calls",
    query: "latency_ms_gt=5000",
    shared: false,
    is_mine: true,
    owner_name: "You",
    created_at: new Date().toISOString(),
    updated_at: null,
    ...overrides,
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export const WORKSPACE_ID = "ws-1"
export const CALLER_IDENTITY = "identity-1"

interface FetchCall {
  url: string
  method: string
  body: string | undefined
}

/** Who is reading: a member, a manager of the workspace, or a deployment operator. */
export type Viewer = "member" | "manager" | "operator"

export function mockApi(
  opts: {
    rows?: UsageEntry[]
    /** Rows served to a group or id lookup that are not on the page. */
    otherRows?: UsageEntry[]
    // Thunks let polling tests change the response after rendering.
    total?: number | (() => number)
    totals?: Partial<UsageTotals>
    series?: UsageSeriesPoint[]
    /** The groups every grouping returns, or each grouping's own, whenever it answers. */
    groups?:
      | UsageActivityGroup[]
      | ((
          groupBy: string,
        ) => UsageActivityGroup[] | Promise<UsageActivityGroup[]>)
    /** How many groups the window holds, when more than the page returned. */
    groupsTotal?: number
    inFlight?: InFlightResponse | (() => InFlightResponse)
    viewer?: Viewer
    members?: OrganizationMember[]
    views?: SavedView[]
    spend?: WorkspaceSpend | null
    /** Fail these reads, by a substring of their path. */
    failing?: string[]
  } = {},
) {
  const rows = opts.rows ?? []
  const pool = [...rows, ...(opts.otherRows ?? [])]
  const viewer = opts.viewer ?? "operator"
  const total = () => {
    const value = opts.total ?? rows.length
    return typeof value === "function" ? value() : value
  }
  const inFlight = () => {
    const value = opts.inFlight ?? { requests: [], total: 0 }
    return typeof value === "function" ? value() : value
  }
  const calls: FetchCall[] = []

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
      if (opts.failing?.some((path) => url.includes(path))) {
        return jsonResponse({ detail: "Not available" }, 500)
      }
      const params = new URL(url, "http://localhost").searchParams

      if (url.endsWith(`${API_ROOT}/usage`) && method === "DELETE") {
        return jsonResponse({ deleted: 1 })
      }
      if (url.includes(`${API_ROOT}/usage/set-price`)) {
        return jsonResponse({ matched: 1, updated: 1, unchanged: 0 })
      }
      if (url.includes(`${API_ROOT}/pricing`) && method !== "GET") {
        return jsonResponse({})
      }
      if (url.includes("/saved-views")) {
        if (method === "POST") {
          return jsonResponse(savedView(JSON.parse(String(init?.body))), 201)
        }
        if (method === "DELETE") return jsonResponse({ message: "Deleted" })
        return jsonResponse({ data: opts.views ?? [] })
      }
      if (url.includes(`/workspaces/${WORKSPACE_ID}/budget`)) {
        return jsonResponse(opts.spend ?? null)
      }
      // Reads serve both deployment and organization scopes; writes stay global.
      if (url.includes("/usage/count")) {
        return jsonResponse({ total: total() })
      }
      if (url.includes("/usage/in-flight")) {
        return jsonResponse(inFlight())
      }
      if (url.includes("/usage/groups")) {
        const all =
          typeof opts.groups === "function"
            ? await opts.groups(params.get("group_by") ?? "")
            : (opts.groups ?? [])
        // Searched as the server does: the key or its label, ignoring case.
        const term = (params.get("search") ?? "").toLowerCase()
        const groups = term
          ? all.filter((group) =>
              [group.key, group.label].some((text) =>
                text?.toLowerCase().includes(term),
              ),
            )
          : all
        return jsonResponse({
          group_by: params.get("group_by"),
          start_date: "",
          end_date: "",
          groups,
          total: term ? groups.length : (opts.groupsTotal ?? groups.length),
        })
      }
      if (url.includes("/usage/summary")) {
        return jsonResponse({
          start_date: "",
          end_date: "",
          bucket: params.get("bucket") ?? "hour",
          totals: totals({ request_count: rows.length, ...opts.totals }),
          by_model: [],
          by_user: [],
          by_api_key: [],
          by_source: [],
          series: opts.series ?? [],
        })
      }
      if (url.includes("/usage")) {
        // Group and id lookups can return rows absent from the page.
        const groupIds = params.getAll("request_group_id")
        if (groupIds.length) {
          return jsonResponse(
            pool.filter(
              (row) =>
                row.request_group_id && groupIds.includes(row.request_group_id),
            ),
          )
        }
        const ids = params.getAll("id")
        if (ids.length) {
          return jsonResponse(pool.filter((row) => ids.includes(row.id)))
        }
        return jsonResponse(rows)
      }
      if (url.includes(`${API_ROOT}/organizations/me/members`)) {
        const members = opts.members ?? []
        return jsonResponse({ data: members, total: members.length })
      }
      if (url.endsWith(`${API_ROOT}/organizations/me`)) {
        return jsonResponse({
          organization_member_id: "om-1",
          role: viewer === "member" ? "member" : "owner",
          status: "active",
          caller: {
            user_id: CALLER_IDENTITY,
            email: "me@example.com",
            full_name: null,
            has_password: true,
            claims_deployment: viewer === "operator",
          },
          organization: {
            id: "org-1",
            name: "Acme",
            slug: "acme",
            created_by_user_id: null,
            created_at: new Date().toISOString(),
            updated_at: null,
          },
          byo_provider_keys_allowed: true,
          deployment_operator: viewer === "operator",
          provider_key_encryption_available: true,
          workspace_memberships: [
            {
              workspace_id: WORKSPACE_ID,
              name: "Production",
              role: viewer === "member" ? "member" : "owner",
            },
          ],
        })
      }
      return jsonResponse([])
    })

  return { mock, calls }
}

export function renderPage(ui: ReactElement, route = "/activity") {
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
      wrapper: withRouter({ url: route }),
    },
  )
}

/** The log's own reads (the list, and lookups by group or id), newest last. */
export function listCalls(calls: FetchCall[]): string[] {
  return calls
    .filter(
      (c) =>
        c.method === "GET" &&
        /\/usage\?|\/usage$/.test(c.url) &&
        c.url.includes(API_ROOT),
    )
    .map((c) => c.url)
}

/** The query of the latest list read, as parameters. */
export function lastList(calls: FetchCall[]): URLSearchParams {
  const url = listCalls(calls).at(-1) ?? ""
  return new URL(url, "http://localhost").searchParams
}
