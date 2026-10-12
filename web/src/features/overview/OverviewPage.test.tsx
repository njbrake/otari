import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useLocation } from "@tanstack/react-router"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AllocationHealth,
  DeploymentBootstrap,
  OverviewAttentionItem,
  OverviewLimitRow,
  OverviewSummary,
  UsageEntry,
  UsageSummary,
  WorkspaceSpend,
} from "@/client"
import { OverviewIndex } from "@/features/overview/OverviewPage"
import { API_ROOT } from "@/shared/api/client"
import { SelectedWorkspaceProvider } from "@/shared/hooks/SelectedWorkspace"
import { DeploymentProvider } from "@/shared/hooks/useDeployment"
import {
  bootstrap,
  HOSTED_SURFACES,
  organizationContext,
  seriesPoint,
  usageTotals,
  workspaceActivation,
} from "@/tests/fixtures"
import { withRouter } from "@/tests/router"

// Twelve days into October 2026, UTC, which is what every month on the page is
// measured in.
const NOW = new Date("2026-10-12T12:00:00Z")

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function summary(
  totals: Partial<UsageSummary["totals"]> = {},
  series: UsageSummary["series"] = [],
): UsageSummary {
  return {
    start_date: "2026-10-01T00:00:00Z",
    end_date: "2026-11-01T00:00:00Z",
    bucket: "day",
    totals: usageTotals(totals),
    by_model: [],
    by_user: [],
    by_api_key: [],
    by_source: [],
    by_source_label: [],
    by_endpoint: [],
    by_provider: [],
    by_tool: [],
    by_policy: [],
    by_workspace: [],
    by_channel: [],
    errors_by_status_code: [],
    series,
  }
}

/** The month's days, each billing `perDay`. */
function daily(days: number, perDay: number, month = "2026-10") {
  return Array.from({ length: days }, (_, index) =>
    seriesPoint({
      bucket_start: `${month}-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      cost: perDay,
      requests: 10,
    }),
  )
}

function attention(
  kind: OverviewAttentionItem["kind"],
  over: Partial<OverviewAttentionItem> = {},
): OverviewAttentionItem {
  return {
    kind,
    severity: "warn",
    subject_id: null,
    subject_name: null,
    used: null,
    limit: null,
    fraction: null,
    at: null,
    count: null,
    ...over,
  }
}

function limitRow(over: Partial<OverviewLimitRow>): OverviewLimitRow {
  return {
    id: "key-1",
    name: "research-app",
    owner_name: null,
    is_mine: true,
    spent: 0,
    limit: null,
    limit_spent: null,
    period_end: null,
    last_used_at: null,
    expires_at: null,
    is_subscription: false,
    ...over,
  }
}

function strip(over: Partial<AllocationHealth> = {}): AllocationHealth {
  return {
    over_count: 0,
    near_count: 1,
    capped_count: 1,
    total_count: 1,
    worst: {
      budget_id: "11111111-2222-3333-4444-555555555555",
      name: null,
      spent: 455,
      allocated: 500,
      scope_type: "workspace",
      scope_id: WORKSPACE_B,
    },
    ...over,
  }
}

function failure(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: "req-1",
    user_id: null,
    api_key_id: null,
    api_key_name: "ci-runner",
    timestamp: "2026-10-12T08:41:12Z",
    model: "claude-opus-5-5",
    provider: "anthropic",
    endpoint: "/v1/messages",
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost: null,
    status: "error",
    status_code: 529,
    error_message: "Provider overloaded",
    latency_ms: 120,
    ...over,
  } as UsageEntry
}

interface Bodies {
  /** Held open for the Organization scope's overview, until it resolves. */
  holdOrganization?: Promise<void>
  /** Held open for the summaries whose window starts on this day. */
  holdSummaryFrom?: { day: string; until: Promise<void> }
  /** Held open for the workspace's own month, read beside a manager's at You. */
  holdWorkspace?: Promise<void>
  /** The overview summary per scope asked for, over `overview`. */
  overviewByScope?: Partial<Record<string, Partial<OverviewSummary>>>
  /** The first day of the month the page reads, if not October. */
  monthStart?: string
  /** The overview summary answers 500. */
  overviewFails?: boolean
  /** The month's totals and series in the scope asked for. */
  month?: Partial<UsageSummary["totals"]>
  series?: UsageSummary["series"]
  /** The comparison window's totals. */
  previous?: Partial<UsageSummary["totals"]>
  /** The workspace's own month, beside a manager's at You. */
  workspace?: Partial<UsageSummary["totals"]>
  workspaceSeries?: UsageSummary["series"]
  overview?: Partial<OverviewSummary>
  spend?: WorkspaceSpend | null
  failures?: UsageEntry[]
  health?: unknown
  providers?: unknown
  members?: unknown[]
  context?: Parameters<typeof organizationContext>[0]
  activation?: unknown
  models?: string[]
}

function overviewBody(over: Partial<OverviewSummary> = {}): OverviewSummary {
  return {
    active_keys: 0,
    active_members: 0,
    budgets: null,
    ceilings: null,
    month: {
      start: "2026-10-01T00:00:00Z",
      end: "2026-11-01T00:00:00Z",
      elapsed_days: 12,
      days: 31,
    },
    scope: "workspace",
    attention: [],
    limits: { kind: "keys", rows: [] },
    ...over,
  }
}

function modelCatalog(ids: string[]) {
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "openai",
    })),
  }
}

/**
 * The gateway, for an operator by default. Every request is recorded, so a test
 * can say what the page asked for. Summaries are told apart by their window
 * (this month, or the comparison before it) and by whether they name the
 * caller, which is how the page reads the workspace beside a manager's own.
 */
function mockApi(b: Bodies, { scoped = false } = {}): string[] {
  const requested: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input)
    requested.push(url)
    const params = new URL(url, "http://localhost").searchParams
    if (url.endsWith(`${API_ROOT}/organizations/me`)) {
      return jsonResponse(
        organizationContext({
          ...(scoped ? { deployment_operator: false } : {}),
          ...(b.context ?? TWO_WORKSPACES),
        }),
      )
    }
    if (url.includes(`${API_ROOT}/organizations/me/members`)) {
      return jsonResponse({ data: b.members ?? [] })
    }
    if (url.includes("/activation")) {
      // Ineligible unless a test is about the guide, which otherwise opens
      // over the page it is testing.
      return jsonResponse(
        b.activation ?? workspaceActivation({ experience_eligible: false }),
      )
    }
    if (url.includes(`${API_ROOT}/models`)) {
      return jsonResponse(modelCatalog(b.models ?? ["openai:gpt-4o-mini"]))
    }
    if (url.includes("/usage/summary")) {
      if (
        b.holdSummaryFrom &&
        params.get("start_date")?.startsWith(b.holdSummaryFrom.day)
      ) {
        await b.holdSummaryFrom.until
      }
      if (params.get("start_date")?.startsWith(b.monthStart ?? "2026-10-01")) {
        if (b.workspace && !params.get("user_id")) {
          if (b.holdWorkspace && !url.includes("/organizations/me/")) {
            await b.holdWorkspace
          }
          return jsonResponse(summary(b.workspace, b.workspaceSeries))
        }
        return jsonResponse(summary(b.month, b.series))
      }
      return jsonResponse(summary(b.previous))
    }
    if (url.includes(`${API_ROOT}/overview`)) {
      if (b.holdOrganization && params.get("scope") === "organization") {
        await b.holdOrganization
      }
      if (b.overviewFails) {
        return jsonResponse({ detail: "overview exploded" }, 500)
      }
      // The scope asked for, unless a test says the server read another.
      const scope = (params.get("scope") ??
        "workspace") as OverviewSummary["scope"]
      return jsonResponse(
        overviewBody({ scope, ...b.overview, ...b.overviewByScope?.[scope] }),
      )
    }
    if (url.match(/\/workspaces\/[^/]+\/budget/)) {
      return jsonResponse(b.spend ?? null)
    }
    if (url.includes(`${API_ROOT}/providers/health`)) {
      return jsonResponse(
        b.health ?? { providers: [], healthy: 0, degraded: 0, total: 0 },
      )
    }
    if (url.includes(`${API_ROOT}/providers`)) {
      return jsonResponse({
        providers: b.providers ?? [{ provider: "openai" }],
      })
    }
    if (url.includes("/usage")) return jsonResponse(b.failures ?? [])
    return scoped
      ? jsonResponse({ detail: "forbidden" }, 403)
      : jsonResponse([])
  })
  return requested
}

function LocationProbe() {
  const location = useLocation()
  return (
    <div data-testid="loc">
      {location.pathname}
      {location.searchStr}
    </div>
  )
}

const ROUTES = [
  { path: "/providers", element: <LocationProbe /> },
  { path: "/organization/provider-keys", element: <LocationProbe /> },
  { path: "/activity", element: <LocationProbe /> },
  { path: "/usage", element: <LocationProbe /> },
  { path: "/keys", element: <LocationProbe /> },
]

function renderPage(
  ui: ReactElement,
  {
    url = "/overview",
    deployment = bootstrap(),
    workspace,
  }: {
    url?: string
    deployment?: DeploymentBootstrap
    workspace?: string
  } = {},
) {
  if (workspace) {
    window.localStorage.setItem("otari.dashboard.selectedWorkspace", workspace)
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <DeploymentProvider value={deployment}>
        {workspace ? (
          <SelectedWorkspaceProvider>{ui}</SelectedWorkspaceProvider>
        ) : (
          ui
        )}
      </DeploymentProvider>
    </QueryClientProvider>,
    { wrapper: withRouter({ url, routes: ROUTES }) },
  )
}

const WORKSPACE_A = "44444444-4444-4444-4444-444444444444"
const WORKSPACE_B = "55555555-5555-5555-5555-555555555555"

const TWO_WORKSPACES = {
  workspace_memberships: [
    { workspace_id: WORKSPACE_A, name: "Research", role: "owner" },
    { workspace_id: WORKSPACE_B, name: "Staging", role: "member" },
  ],
}

/** A member of the workspace, who reads their own usage only. */
const MEMBER = {
  role: "member" as const,
  workspace_memberships: [
    { workspace_id: WORKSPACE_A, name: "Research", role: "member" },
  ],
}

const BUDGET: WorkspaceSpend = {
  workspace_id: WORKSPACE_A,
  max_budget: 1000,
  spent: 300,
  period_start: "2026-10-01T00:00:00Z",
  period_end: "2026-11-01T00:00:00Z",
}

function tile(label: string) {
  return screen.getByText(label).parentElement as HTMLElement
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.localStorage.clear()
})

describe("the Overview's numbers", () => {
  it("splits the month's total and sets it against the same days last month", async () => {
    mockApi({
      month: { cost: 683.65, imported_cost: 612.4, request_count: 5140 },
      series: [
        seriesPoint({ bucket_start: "2026-10-12T00:00:00Z", cost: 37.02 }),
      ],
      previous: { cost: 41.8 },
    })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const total = await screen.findByText("$683.65")
    const cell = total.parentElement as HTMLElement
    expect(within(cell).getByText("Sep 1 – 12 $41.80")).toBeInTheDocument()
    expect(within(cell).getByText("$37.02 today")).toBeInTheDocument()
    expect(within(cell).getByText("$71.25")).toBeInTheDocument()
    expect(
      within(cell).getByText("subscription · not billed"),
    ).toBeInTheDocument()
  })

  it("opens the month's failures in Activity from the request count", async () => {
    mockApi({ month: { request_count: 400, error_count: 6 } })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const link = await screen.findByRole("link", { name: "6 failed" })
    expect(link).toHaveAttribute(
      "title",
      "1.5% of requests. Opens Activity filtered to failures.",
    )
    const href = link.getAttribute("href") ?? ""
    expect(href).toContain("status=error")
    expect(href).toContain("start_date=2026-10-01")
    expect(within(tile("Requests")).getByText("HEALTHY")).toBeInTheDocument()
  })

  it("reads the workspace budget with its pace", async () => {
    // $300 settled eleven and a half days into a 31-day period is on pace
    // for $809. The month's billed spend is the period's settled spend, since
    // the budget's period is this calendar month.
    mockApi({ spend: BUDGET, month: { cost: 300 } })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const cell = (await screen.findByText("Workspace budget"))
      .parentElement as HTMLElement
    await waitFor(() =>
      expect(within(cell).getByText("30%")).toBeInTheDocument(),
    )
    expect(within(cell).getByText("ON TRACK")).toBeInTheDocument()
    expect(within(cell).getByText("$300.00 of $1,000")).toBeInTheDocument()
    expect(
      within(cell).getByText("On pace for $809 by Oct 31"),
    ).toBeInTheDocument()
  })

  it("warns when the server says the pace passes the budget", async () => {
    mockApi({
      spend: { ...BUDGET, spent: 638.2 },
      month: { cost: 638.2 },
      overview: {
        attention: [
          attention("budget_pace", {
            subject_id: WORKSPACE_A,
            subject_name: "Research",
            at: "2026-10-19T00:00:00Z",
          }),
        ],
      },
    })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(await screen.findByText("AT RISK")).toBeInTheDocument()
    expect(screen.getByText("On pace for $1,720 by Oct 31")).toHaveClass(
      "text-warning",
    )
  })

  it("leaves the verdict to the server, and paces settled spend only", async () => {
    // The budget counts $638.20 with holds, but only $200 has settled and the
    // server raises no pace item: on track, at the settled pace.
    mockApi({ spend: { ...BUDGET, spent: 638.2 }, month: { cost: 200 } })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const cell = (await screen.findByText("Workspace budget"))
      .parentElement as HTMLElement
    expect(await within(cell).findByText("ON TRACK")).toBeInTheDocument()
    expect(within(cell).getByText("On pace for $539 by Oct 31")).toHaveClass(
      "text-subtle",
    )
    expect(within(cell).queryByText("AT RISK")).toBeNull()
  })

  it("says there is no budget, and offers one to whoever may set it", async () => {
    mockApi({ spend: null, month: { cost: 120 } })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByText("Workspace billed this month"),
    ).toBeInTheDocument()
    expect(screen.getByText("No workspace budget set")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Set a budget" })).toHaveAttribute(
      "href",
      "/budgets",
    )
  })

  it("shows a dash, not a zero, for a summary that failed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith(`${API_ROOT}/organizations/me`)) {
        return jsonResponse(organizationContext(TWO_WORKSPACES))
      }
      if (url.includes("/usage/summary")) {
        return jsonResponse({ detail: "usage exploded" }, 500)
      }
      if (url.includes(`${API_ROOT}/providers`) && !url.includes("health")) {
        return jsonResponse({ providers: [{ provider: "openai" }] })
      }
      return jsonResponse(url.includes("/overview") ? overviewBody() : [])
    })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(await screen.findByText(/usage exploded/)).toBeInTheDocument()
    expect(
      within(tile("Total at API prices")).getByText("—"),
    ).toBeInTheDocument()
    expect(within(tile("Requests")).getByText("no data")).toBeInTheDocument()
  })
})

describe("the Overview's scope and month", () => {
  it("reads the month the URL names, against the whole month before", async () => {
    const requested = mockApi({
      month: { cost: 90 },
      previous: { cost: 80 },
    })
    renderPage(<OverviewIndex />, {
      url: "/overview?month=2026-09",
      workspace: WORKSPACE_A,
    })

    expect(
      await screen.findByRole("heading", { name: "Failures in September" }),
    ).toBeInTheDocument()
    expect(screen.getByText("Sep 1 – 30, 2026 UTC")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Month: September 2026" }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(tile("Total at API prices")).getByText("August $80.00"),
      ).toBeInTheDocument(),
    )
    expect(
      within(tile("Total at API prices")).getByText("month total"),
    ).toBeInTheDocument()
    expect(requested.some((url) => url.includes("month=2026-09"))).toBe(true)
  })

  it("picks a month from the menu, or leaves for Usage", async () => {
    mockApi({})
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByText("Oct 1 – 12, 2026 UTC · day 12 of 31"),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Month: This month" }))
    const menu = await screen.findByRole("menu")
    // This month and the eleven before it, then the way out, which is an
    // action rather than one more choice.
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(12)
    expect(
      within(menu).getByRole("menuitem", { name: "Other ranges in Usage" }),
    ).toBeInTheDocument()
    await user.click(within(menu).getByText("August 2026"))
    expect(
      await screen.findByRole("heading", { name: "Failures in August" }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Month: August 2026" }))
    await user.click(await screen.findByText("Other ranges in Usage"))
    expect(await screen.findByTestId("loc")).toHaveTextContent("/usage")
  })

  it("links Usage's daily spend for the scope and month on screen", async () => {
    mockApi({})
    renderPage(<OverviewIndex />, {
      url: "/overview?month=2026-09",
      workspace: WORKSPACE_A,
    })

    const link = await screen.findByRole("link", {
      name: "Daily spend in Usage →",
    })
    await waitFor(() =>
      expect(link).toHaveAttribute(
        "href",
        "/usage?scope=workspace&start_date=2026-09-01T00%3A00%3A00.000Z&end_date=2026-10-01T00%3A00%3A00.000Z",
      ),
    )
  })

  it("keeps the old month's labels until the comparison lands too", async () => {
    let release = () => {}
    const until = new Promise<void>((resolve) => {
      release = resolve
    })
    // August's comparison is July, held while every other read answers.
    const requested = mockApi({ holdSummaryFrom: { day: "2026-07-01", until } })
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    await screen.findByText("Oct 1 – 12, 2026 UTC · day 12 of 31")
    await user.click(screen.getByRole("button", { name: "Month: This month" }))
    await user.click(
      within(await screen.findByRole("menu")).getByText("August 2026"),
    )
    await waitFor(() =>
      expect(
        requested.some((url) => url.includes("start_date=2026-07-01")),
      ).toBe(true),
    )
    expect(
      screen.queryByRole("heading", { name: "Failures in August" }),
    ).toBeNull()

    release()
    expect(
      await screen.findByRole("heading", { name: "Failures in August" }),
    ).toBeInTheDocument()
  })

  it("tells a member it is their own usage and asks the server for it", async () => {
    const requested = mockApi(
      { context: MEMBER, spend: BUDGET },
      { scoped: true },
    )
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(await screen.findByText("Your usage")).toBeInTheDocument()
    expect(screen.queryByRole("radiogroup", { name: "Scope" })).toBeNull()
    expect(
      screen.getByText("Requests made with your keys and your subscription"),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(requested.some((url) => url.includes("scope=you"))).toBe(true),
    )
    // The member-readable workspace budget, with their share beside it.
    expect(await screen.findByText(/yours \$0/)).toBeInTheDocument()
    // Nothing outside what a member may read: their organization's surface,
    // the overview, the workspace budget, and the setup guide's two reads.
    const outside = requested.filter(
      (url) =>
        !url.endsWith(`${API_ROOT}/organizations/me`) &&
        !url.includes(`${API_ROOT}/organizations/me/`) &&
        !url.includes(`${API_ROOT}/overview`) &&
        !url.includes(`${API_ROOT}/models`) &&
        !/\/workspaces\/[^/]+\/(budget|activation)/.test(url),
    )
    expect(outside).toEqual([])
  })

  it("says so when the server read the caller's own usage instead", async () => {
    // The answer's `scope` is the one read: a scope the caller may not read
    // falls back to theirs, and the rail and the caption follow it.
    const requested = mockApi({
      month: { cost: 40, request_count: 100, error_count: 4 },
      spend: BUDGET,
      overview: {
        scope: "you",
        month: {
          start: "2026-10-01T00:00:00Z",
          end: "2026-11-01T00:00:00Z",
          elapsed_days: 12,
          days: 31,
        },
      },
    })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByRole("heading", { name: "Your keys" }),
    ).toBeInTheDocument()
    // The tiles follow: the budget names the caller's share, and the failures
    // open as the caller's own rather than the workspace's.
    expect(
      await screen.findByText("Resets Nov 1 · yours $40.00"),
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "4 failed" })).not.toHaveAttribute(
      "href",
      expect.stringContaining("scope=you"),
    )
    // And the chart does not split the caller's share out of a workspace it
    // was not given.
    expect(screen.queryByText("Rest of workspace")).toBeNull()
    expect(
      requested.filter((url) => url.includes("/usage/summary")).length,
    ).toBeGreaterThan(0)
    expect(
      screen.getByText(
        "Your usage: Requests made with your keys and your subscription",
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Oct 1 – 12, 2026 UTC · day 12 of 31"),
    ).toBeInTheDocument()
  })

  it("reads the tightest ceiling and the workspaces across the organization", async () => {
    mockApi({
      overview: {
        scope: "organization",
        ceilings: strip(),
        limits: {
          kind: "workspaces",
          rows: [
            limitRow({
              id: WORKSPACE_B,
              name: "Staging",
              is_mine: false,
              spent: 455,
              limit: 500,
              limit_spent: 455,
            }),
            limitRow({
              id: WORKSPACE_A,
              name: "Research",
              is_mine: false,
              spent: 410.9,
              last_used_at: "2026-10-12T09:00:00Z",
            }),
          ],
        },
      },
    })
    renderPage(<OverviewIndex />, {
      url: "/overview?scope=organization",
      workspace: WORKSPACE_A,
    })

    const cell = (await screen.findByText("Tightest budget"))
      .parentElement as HTMLElement
    await waitFor(() =>
      expect(within(cell).getByText("91%")).toBeInTheDocument(),
    )
    expect(within(cell).getByText("NEAR LIMIT")).toBeInTheDocument()
    expect(within(cell).getByText("Staging ceiling")).toBeInTheDocument()

    const rail = screen.getByRole("heading", { name: "Workspaces" })
      .parentElement as HTMLElement
    expect(within(rail).getByText("current")).toBeInTheDocument()
    // A workspace's last use is its last request in the month read.
    expect(within(rail).getByText("Last used 3h ago")).toBeInTheDocument()
    expect(within(rail).getByText("No requests this month")).toBeInTheDocument()
    expect(within(rail).queryByText("Never used")).toBeNull()
    expect(within(rail).getByText("No spend ceiling")).toBeInTheDocument()
    expect(
      within(rail).getByRole("link", { name: "Manage budgets" }),
    ).toBeInTheDocument()
    // Activity reads one workspace, so failures across them link nowhere.
    expect(screen.queryByRole("link", { name: /in Activity/ })).toBeNull()
  })
})

describe("switching scope", () => {
  it("keeps the rail describing its rows until the new answer lands", async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    mockApi({
      holdOrganization: held,
      overviewByScope: {
        workspace: {
          limits: { kind: "keys", rows: [limitRow({ name: "ci-runner" })] },
        },
        organization: {
          limits: {
            kind: "workspaces",
            rows: [
              limitRow({ id: WORKSPACE_B, name: "Staging", is_mine: false }),
            ],
          },
        },
      },
    })
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByRole("heading", { name: "Keys" }),
    ).toBeInTheDocument()
    await screen.findByText("ci-runner")
    await user.click(screen.getByRole("radio", { name: "Organization" }))

    // The switch shows the click at once; the rail still names the key rows
    // it shows, and the page says it is busy rather than relabeling them.
    expect(screen.getByRole("radio", { name: "Organization" })).toBeChecked()
    expect(screen.getByRole("heading", { name: "Keys" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Workspaces" })).toBeNull()
    expect(screen.getByText("ci-runner")).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "Keys" }).closest("[aria-busy]"),
    ).not.toBeNull()

    release()
    expect(
      await screen.findByRole("heading", { name: "Workspaces" }),
    ).toBeInTheDocument()
    expect(screen.getByText("Staging")).toBeInTheDocument()
    expect(document.querySelector("[aria-busy]")).toBeNull()
  })

  it("reads the organization's failures from the organization, not the deployment", async () => {
    const requested = mockApi({ overview: { scope: "organization" } })
    renderPage(<OverviewIndex />, {
      url: "/overview?scope=organization",
      workspace: WORKSPACE_A,
    })

    await screen.findByRole("heading", { name: "Workspaces" })
    await waitFor(() =>
      expect(
        requested.some(
          (url) =>
            url.includes(`${API_ROOT}/organizations/me/usage?`) &&
            url.includes("status=error"),
        ),
      ).toBe(true),
    )
    // An operator's own surface spans every tenant, so it is not asked.
    expect(
      requested.some(
        (url) =>
          url.includes(`${API_ROOT}/usage?`) &&
          !url.includes("/organizations/me/") &&
          url.includes("status=error"),
      ),
    ).toBe(false)
  })
})

describe("what needs attention", () => {
  it("words each item the server raised and links where it is fixed", async () => {
    mockApi({
      overview: {
        attention: [
          attention("provider_unreachable", {
            severity: "alert",
            subject_id: "fireworks",
            subject_name: "fireworks",
          }),
          attention("budget_pace", {
            subject_id: WORKSPACE_A,
            subject_name: "Research",
            at: "2026-10-19T00:00:00Z",
          }),
          attention("key_near_limit", {
            subject_name: "ci-runner",
            fraction: 0.92,
            limit: 25,
          }),
          attention("key_expiring", {
            subject_name: "eval-harness",
            at: "2026-10-15T00:00:00Z",
          }),
        ],
      },
    })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const strip = await screen.findByRole("region", { name: "Needs attention" })
    expect(
      within(strip).getByRole("link", {
        name: "1 provider unreachable: fireworks",
      }),
    ).toHaveAttribute("href", "/providers")
    expect(
      within(strip).getByRole("link", {
        name: "Workspace on pace to pass its budget ~Oct 19",
      }),
    ).toHaveAttribute("href", "/budgets")
    expect(
      within(strip).getByRole("link", {
        name: "ci-runner at 92% of its $25 limit",
      }),
    ).toHaveAttribute("href", "/keys")
    expect(
      within(strip).getByRole("link", { name: "eval-harness expires Oct 15" }),
    ).toBeInTheDocument()
  })

  it("names another workspace's ceiling across the organization", async () => {
    mockApi({
      overview: {
        scope: "organization",
        attention: [
          attention("budget_over", {
            severity: "alert",
            subject_id: WORKSPACE_B,
            subject_name: "Staging",
          }),
          attention("budget_near", {
            subject_id: WORKSPACE_A,
            subject_name: "Research",
            fraction: 0.85,
          }),
        ],
      },
    })
    renderPage(<OverviewIndex />, {
      url: "/overview?scope=organization",
      workspace: WORKSPACE_A,
    })

    const strip = await screen.findByRole("region", { name: "Needs attention" })
    expect(
      within(strip).getByRole("link", { name: "Staging over its ceiling" }),
    ).toHaveAttribute("href", "/budgets")
    expect(
      within(strip).getByRole("link", {
        name: "Workspace at 85% of its budget",
      }),
    ).toBeInTheDocument()
  })

  it("words a member's budget item without a link they cannot follow", async () => {
    mockApi(
      {
        context: MEMBER,
        overview: {
          attention: [
            attention("budget_near", {
              subject_id: WORKSPACE_A,
              subject_name: "Research",
              fraction: 0.85,
            }),
          ],
        },
      },
      { scoped: true },
    )
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const strip = await screen.findByRole("region", { name: "Needs attention" })
    expect(
      within(strip).getByText("Workspace at 85% of its budget"),
    ).toBeInTheDocument()
    expect(within(strip).queryByRole("link")).toBeNull()
    // Warnings only, so the dot is a warning's.
    expect(strip.querySelector(".bg-warning")).not.toBeNull()
    expect(strip.querySelector(".bg-danger")).toBeNull()
  })

  it("says the error rate across the organization without a link", async () => {
    mockApi({
      overview: {
        scope: "organization",
        attention: [
          attention("error_rate", { severity: "alert", fraction: 0.12 }),
        ],
      },
    })
    renderPage(<OverviewIndex />, {
      url: "/overview?scope=organization",
      workspace: WORKSPACE_A,
    })

    const strip = await screen.findByRole("region", {
      name: "Needs attention",
    })
    expect(within(strip).getByText("Error rate 12.0%")).toBeInTheDocument()
    expect(within(strip).queryByRole("link")).toBeNull()
    expect(strip.querySelector(".bg-danger")).not.toBeNull()
  })

  it("states a provider problem without a link where no page serves it", async () => {
    mockApi({
      overview: {
        attention: [attention("provider_unreachable", { count: 2 })],
      },
    })
    renderPage(<OverviewIndex />, {
      workspace: WORKSPACE_A,
      deployment: bootstrap({
        deployment_type: "hosted",
        surfaces: HOSTED_SURFACES,
      }),
    })

    const strip = await screen.findByRole("region", { name: "Needs attention" })
    expect(
      within(strip).getByText("2 providers unreachable"),
    ).toBeInTheDocument()
    expect(within(strip).queryByRole("link")).toBeNull()
  })

  it("draws nothing when nothing needs attention", async () => {
    mockApi({ month: { cost: 5 } })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })
    await screen.findAllByText("$5.00")
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull()
  })
})

describe("the budget chart", () => {
  it("reads out a day from the keyboard", async () => {
    mockApi({ spend: BUDGET, series: daily(12, 25) })
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const chart = await screen.findByRole("slider", {
      name: /Billed spend in October, running total, against a \$1,000 budget/,
    })
    expect(chart).toHaveAttribute(
      "aria-valuetext",
      "Oct 12: Billed so far $300.00",
    )
    chart.focus()
    await user.keyboard("{ArrowRight}")
    expect(chart).toHaveAttribute(
      "aria-valuetext",
      // $300 over the 11.5 days October has run, carried to the end of the 13th.
      "Oct 13, projected: Projected $339.13",
    )
  })

  it("marks the day the projection passes the budget", async () => {
    // $720 over 11.5 days passes $1,000 15.97 days in: Oct 16, as the
    // server dates it.
    mockApi({ spend: BUDGET, series: daily(12, 60) })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(await screen.findByText(/Over budget ~/)).toHaveTextContent(
      "Over budget ~Oct 16",
    )
    expect(
      screen.getByRole("heading", { name: "Billed spend vs budget, October" }),
    ).toBeInTheDocument()
  })

  it("stacks a manager's own share under the rest of the workspace at You", async () => {
    mockApi({
      context: TWO_WORKSPACES,
      members: [
        {
          user_id: "33333333-3333-3333-3333-333333333333",
          attribution_user_id: "gw-user-1",
        },
      ],
      spend: BUDGET,
      series: daily(12, 5),
      workspace: { cost: 300 },
      workspaceSeries: daily(12, 25),
    })
    renderPage(<OverviewIndex />, {
      url: "/overview?scope=you",
      workspace: WORKSPACE_A,
    })

    const chart = await screen.findByRole("slider", { name: /Billed spend/ })
    await waitFor(() =>
      expect(chart).toHaveAttribute(
        "aria-valuetext",
        "Oct 12: Yours $60.00, Rest of workspace $240.00",
      ),
    )
    expect(screen.getByText("Rest of workspace")).toBeInTheDocument()
  })
  it("holds the organization's chart until the workspace beside a manager's own lands", async () => {
    let release = () => {}
    const holdWorkspace = new Promise<void>((resolve) => {
      release = resolve
    })
    mockApi({
      context: TWO_WORKSPACES,
      members: [
        {
          user_id: "33333333-3333-3333-3333-333333333333",
          attribution_user_id: "gw-user-1",
        },
      ],
      spend: BUDGET,
      series: daily(12, 5),
      workspace: { cost: 300 },
      workspaceSeries: daily(12, 25),
      holdWorkspace,
    })
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, {
      url: "/overview?scope=organization",
      workspace: WORKSPACE_A,
    })

    await screen.findByRole("heading", { name: "Workspaces" })
    await user.click(screen.getByRole("radio", { name: "You" }))
    // Everything but the workspace's own month has answered by now.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      screen.getByRole("heading", { name: "Billed spend, October" }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("heading", {
        name: "Billed spend vs budget, October",
      }),
    ).toBeNull()

    release()
    expect(
      await screen.findByRole("heading", {
        name: "Billed spend vs budget, October",
      }),
    ).toBeInTheDocument()
  })
})

describe("a member's chart and a month that has ended", () => {
  it("draws a member's own total alone, with nothing measured against it", async () => {
    mockApi(
      { context: MEMBER, spend: BUDGET, series: daily(12, 5) },
      { scoped: true },
    )
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByRole("heading", {
        name: "Your billed spend, October",
      }),
    ).toBeInTheDocument()
    const chart = await screen.findByRole("slider", {
      name: "Your billed spend in October, running total. Use the arrow keys to read a day.",
    })
    expect(chart).toHaveAttribute("aria-valuetext", "Oct 12: Yours $60.00")
    // Nothing about the days to come.
    chart.focus()
    await user.keyboard("{ArrowRight}")
    expect(chart).toHaveAttribute("aria-valuetext", "Oct 12: Yours $60.00")
    expect(screen.queryByText(/Budget \$1,000/)).toBeNull()
    expect(screen.queryByText("Projected")).toBeNull()
    expect(screen.queryByText("Today")).toBeNull()
    expect(screen.queryByText(/Over budget ~/)).toBeNull()
    expect(
      screen.getByText(
        /Your spend alone, so there's no budget line: the Workspace budget tile measures the whole workspace against it\. Running total of billed spend\./,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Projection uses/)).toBeNull()
    // The budget tile keeps the figures a member can read.
    expect(screen.getByText("$300.00 of $1,000")).toBeInTheDocument()
  })

  it("tells a member with no workspace budget only that spend counts toward limits", async () => {
    mockApi(
      { context: MEMBER, spend: null, series: daily(12, 5) },
      { scoped: true },
    )
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByText(
        /^Running total of billed spend\. Subscription usage isn.t included because it doesn.t count toward limits\.$/,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/no budget line/)).toBeNull()
  })

  it("draws a past month against today's budget and judges nothing", async () => {
    mockApi({
      monthStart: "2026-09-01",
      month: { cost: 1200 },
      series: daily(30, 40, "2026-09"),
      spend: BUDGET,
      overview: {
        limits: {
          kind: "keys",
          rows: [
            limitRow({
              spent: 21.5,
              limit: 25,
              limit_spent: 23.04,
              period_end: "2026-11-01T00:00:00Z",
            }),
          ],
        },
      },
    })
    renderPage(<OverviewIndex />, {
      url: "/overview?month=2026-09",
      workspace: WORKSPACE_A,
    })

    expect(await screen.findByText("Today's budget $1,000")).toBeInTheDocument()
    // The running total passed $1,000 on Sep 26, but today's budget is no
    // verdict on September.
    expect(screen.queryByText(/Passed budget/)).toBeNull()
    expect(
      screen.getByText(
        /^Past budgets aren't stored, so the line is today's budget\./,
      ),
    ).toBeInTheDocument()

    const cell = screen.getByText("Workspace budget")
      .parentElement as HTMLElement
    await waitFor(() =>
      expect(
        within(cell).getByText("$1,200.00 of today's $1,000"),
      ).toBeInTheDocument(),
    )
    expect(
      within(cell).getByText("Measured against today's budget"),
    ).toBeInTheDocument()
    for (const word of [
      "OVER BUDGET",
      "STAYED IN BUDGET",
      "ENDED NEAR LIMIT",
    ]) {
      expect(within(cell).queryByText(word)).toBeNull()
    }

    const rail = screen.getByRole("heading", { name: "Keys" })
      .parentElement as HTMLElement
    expect(
      await within(rail).findByText("Limit today: $25"),
    ).toBeInTheDocument()
    expect(within(rail).queryByText(/% of limit/)).toBeNull()
    expect(within(rail).queryByText(/^Resets/)).toBeNull()
    expect(within(rail).queryByRole("progressbar")).toBeNull()
    expect(within(rail).queryByText(/\/ \$25/)).toBeNull()
  })
})

describe("recent failures and the rail", () => {
  it("lists the month's failures and opens one in Activity", async () => {
    mockApi({
      month: { request_count: 100, error_count: 3 },
      failures: [
        failure(),
        failure({
          id: "req-2",
          timestamp: "2026-10-11T22:40:00Z",
          status_code: 400,
          error_message: "Context length exceeded",
        }),
      ],
    })
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(await screen.findByText("Provider overloaded")).toBeInTheDocument()
    expect(screen.getByText("08:41:12")).toBeInTheDocument()
    expect(screen.getByText("Oct 11 22:40")).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "View all 3 in Activity →" }),
    ).toBeInTheDocument()
    await user.click(screen.getByText("Context length exceeded"))
    expect(await screen.findByTestId("loc")).toHaveTextContent("request=req-2")
  })

  it("reloads every read on Refresh", async () => {
    const bodies: Bodies = { month: { request_count: 100, error_count: 3 } }
    mockApi(bodies)
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByRole("link", { name: "3 failed" }),
    ).toBeInTheDocument()
    bodies.month = { request_count: 120, error_count: 7 }
    bodies.failures = [failure({ id: "req-new", error_message: "Fresh one" })]
    await user.click(screen.getByRole("button", { name: /refresh/i }))

    expect(
      await screen.findByRole("link", { name: "7 failed" }),
    ).toBeInTheDocument()
    expect(await screen.findByText("Fresh one")).toBeInTheDocument()
  })

  it("says the rail could not load, not that there are no keys", async () => {
    mockApi({ overviewFails: true })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByText("Keys could not be loaded."),
    ).toBeInTheDocument()
    expect(screen.queryByText("No keys yet.")).toBeNull()
  })

  it("says so when the month has no failures", async () => {
    mockApi({})
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })
    expect(
      await screen.findByText("No failed requests this month."),
    ).toBeInTheDocument()
  })

  it("meters each key against its limit, and a subscription key not at all", async () => {
    mockApi({
      overview: {
        limits: {
          kind: "keys",
          rows: [
            limitRow({
              spent: 21.5,
              limit: 25,
              limit_spent: 23.04,
              period_end: "2026-11-01T00:00:00Z",
              last_used_at: "2026-10-12T11:54:00Z",
            }),
            limitRow({
              id: "key-2",
              name: "eval-harness",
              spent: 0.11,
              expires_at: "2026-10-15T00:00:00Z",
            }),
            limitRow({
              id: "key-3",
              name: "Claude Code",
              is_subscription: true,
            }),
            limitRow({
              id: "key-4",
              name: "old-key",
              expires_at: "2026-10-01T00:00:00Z",
            }),
            limitRow({
              id: "key-5",
              name: "batch-jobs",
              spent: 12,
              limit: 10,
            }),
          ],
        },
      },
    })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const rail = (await screen.findByRole("heading", { name: "Keys" }))
      .parentElement as HTMLElement
    await waitFor(() =>
      expect(within(rail).getByText("$21.50")).toBeInTheDocument(),
    )
    // The meter and the share read the ceiling's own count, which is what
    // the gate enforces; the figure beside the name is the month's billing.
    // Near its limit from 80%, as the server judges it, and over from 100%.
    expect(within(rail).getByText("92% of limit")).toHaveClass("text-warning")
    expect(within(rail).getByText("120% of limit")).toHaveClass("text-danger")
    expect(within(rail).getByText("Resets Nov 1")).toBeInTheDocument()
    expect(
      within(rail).getByRole("progressbar", {
        name: "research-app limit used",
      }),
    ).toHaveAttribute("aria-valuenow", "92")
    expect(within(rail).getByText("Expires in 3 days")).toHaveClass(
      "text-warning",
    )
    expect(
      within(rail).getByText("Subscription · tracked, not limited"),
    ).toBeInTheDocument()
    // A key past its expiry says so, rather than "Expires today" forever.
    expect(within(rail).getByText("Expired")).toHaveClass("text-danger")
    expect(
      within(rail).getByRole("link", { name: "Create key" }),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole("link", { name: "All keys" }),
    ).toBeInTheDocument()
  })

  it("shows an operator their providers, and nobody else", async () => {
    mockApi({
      health: {
        providers: [
          {
            instance: "anthropic",
            ok: true,
            model_count: 3,
            discovery_unsupported: false,
          },
          {
            instance: "fireworks",
            ok: false,
            model_count: 0,
            discovery_unsupported: false,
          },
        ],
        healthy: 1,
        degraded: 0,
        total: 2,
      },
    })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const panel = (await screen.findByRole("heading", { name: "Providers" }))
      .parentElement as HTMLElement
    // In the Providers page's words.
    expect(await within(panel).findByText("Unreachable")).toBeInTheDocument()
    expect(within(panel).getByText("Reachable")).toBeInTheDocument()
  })

  it("asks for the overview again, once, when a fresh provider check disagrees with it", async () => {
    const requested = mockApi({
      health: {
        providers: [
          {
            instance: "fireworks",
            ok: false,
            model_count: 0,
            discovery_unsupported: false,
          },
        ],
        healthy: 0,
        degraded: 0,
        total: 1,
      },
    })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    const overviewReads = () =>
      requested.filter((url) => url.includes("/overview")).length
    await waitFor(() => expect(overviewReads()).toBe(2))
    // The answer still names no provider; it is not asked for a third time.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(overviewReads()).toBe(2)
  })

  it("reads no provider health for a caller who does not operate the deployment", async () => {
    const requested = mockApi({ context: MEMBER }, { scoped: true })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })
    await screen.findByText("Your usage")
    expect(screen.queryByRole("heading", { name: "Providers" })).toBeNull()
    expect(requested.some((url) => url.includes("/providers"))).toBe(false)
  })
})

describe("OverviewIndex routing", () => {
  it("shows a getting-started strip and links to providers on a fresh gateway", async () => {
    mockApi({ providers: [] })
    const user = userEvent.setup()
    renderPage(<OverviewIndex />)

    expect(
      await screen.findByText("Get started with Otari"),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("link", { name: "Add your first provider" }),
    )
    expect(await screen.findByTestId("loc")).toHaveTextContent("/providers")
  })

  it("sends a hosted deployment to the organization's provider keys", async () => {
    mockApi({ providers: [] })
    const user = userEvent.setup()
    renderPage(<OverviewIndex />, {
      deployment: bootstrap({
        deployment_type: "hosted",
        surfaces: HOSTED_SURFACES,
      }),
    })

    await screen.findByText("Get started with Otari")
    await user.click(
      screen.getByRole("link", { name: "Add your first provider" }),
    )
    expect(await screen.findByTestId("loc")).toHaveTextContent(
      "/organization/provider-keys",
    )
  })

  it("keeps the strip away from a gateway with usage but no providers", async () => {
    mockApi({ providers: [], failures: [failure()] })
    renderPage(<OverviewIndex />)
    await screen.findByRole("heading", { name: "Overview" })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled(),
    )
    expect(screen.queryByText("Get started with Otari")).toBeNull()
  })

  it("reports a failed provider query, and clears it on Refresh", async () => {
    let failProviders = true
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith(`${API_ROOT}/organizations/me`)) {
        return jsonResponse(organizationContext())
      }
      if (url.includes("/usage/summary")) return jsonResponse(summary())
      if (url.includes("/overview")) return jsonResponse(overviewBody())
      if (url.includes(`${API_ROOT}/providers/health`)) {
        return jsonResponse({
          providers: [],
          healthy: 0,
          degraded: 0,
          total: 0,
        })
      }
      if (url.includes(`${API_ROOT}/providers`)) {
        return failProviders
          ? jsonResponse({ detail: "providers exploded" }, 500)
          : jsonResponse({ providers: [{ provider: "openai" }] })
      }
      return jsonResponse([])
    })
    const user = userEvent.setup()
    renderPage(<OverviewIndex />)

    expect(await screen.findByText(/providers exploded/)).toBeInTheDocument()
    expect(screen.queryByText("Get started with Otari")).toBeNull()
    failProviders = false
    await user.click(screen.getByRole("button", { name: /refresh/i }))
    await waitFor(() =>
      expect(screen.queryByText(/providers exploded/)).toBeNull(),
    )
  })

  it("lands a failed context on the scoped page and settles there", async () => {
    const requested: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith(`${API_ROOT}/organizations/me`)) {
        return jsonResponse({ detail: "context exploded" }, 500)
      }
      if (url.includes(`${API_ROOT}/organizations/me/usage/summary`)) {
        return jsonResponse(summary({ cost: 200, request_count: 2000 }))
      }
      if (url.includes(`${API_ROOT}/organizations/me/usage`)) {
        return jsonResponse([])
      }
      if (url.includes(`${API_ROOT}/overview`))
        return jsonResponse(overviewBody())
      return jsonResponse({ detail: "forbidden" }, 403)
    })
    renderPage(<OverviewIndex />)

    expect((await screen.findAllByText("$200.00")).length).toBeGreaterThan(0)
    expect(screen.queryByRole("heading", { name: "Providers" })).toBeNull()
    expect(
      requested.filter((url) => url.endsWith(`${API_ROOT}/organizations/me`))
        .length,
    ).toBeLessThan(4)
    expect(
      requested.some((url) => url.endsWith(`${API_ROOT}/admin/access`)),
    ).toBe(false)
  })
})

describe("the setup guide on either Overview", () => {
  it("offers it to a caller who does not operate the deployment", async () => {
    const requested = mockApi(
      { context: TWO_WORKSPACES, activation: workspaceActivation() },
      { scoped: true },
    )
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByRole("heading", { name: "Send your first request" }),
    ).toBeInTheDocument()
    expect(requested.some((url) => url.includes(`${API_ROOT}/models`))).toBe(
      true,
    )
    expect(requested.some((url) => url.endsWith(`${API_ROOT}/providers`))).toBe(
      false,
    )
  })

  it("still offers it to an operator", async () => {
    mockApi({ context: TWO_WORKSPACES, activation: workspaceActivation() })
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    expect(
      await screen.findByRole("heading", { name: "Send your first request" }),
    ).toBeInTheDocument()
  })

  it("shows nothing to a caller the server reports ineligible", async () => {
    const requested = mockApi(
      {
        context: TWO_WORKSPACES,
        activation: workspaceActivation({ experience_eligible: false }),
      },
      { scoped: true },
    )
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    await waitFor(() => {
      expect(requested.some((url) => url.includes("/activation"))).toBe(true)
    })
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled()
    })
    expect(
      screen.queryByRole("heading", { name: "Send your first request" }),
    ).toBeNull()
  })

  it("holds back, without asking, while the caller can route nowhere", async () => {
    const requested = mockApi(
      {
        context: TWO_WORKSPACES,
        models: [],
        activation: workspaceActivation(),
      },
      { scoped: true },
    )
    renderPage(<OverviewIndex />, { workspace: WORKSPACE_A })

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled()
    })
    expect(requested.some((url) => url.includes(`${API_ROOT}/models`))).toBe(
      true,
    )
    expect(
      screen.queryByRole("heading", { name: "Send your first request" }),
    ).toBeNull()
    expect(requested.some((url) => url.includes("/activation"))).toBe(false)
  })
})
