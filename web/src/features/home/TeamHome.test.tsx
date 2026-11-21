import { Outlet, useLocation, useRouterState } from "@tanstack/react-router"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TeamHome } from "@/features/home/TeamHome"
import { API_ROOT } from "@/shared/api/client"
import { SelectedWorkspaceProvider } from "@/shared/hooks/SelectedWorkspace"
import { DeploymentProvider } from "@/shared/hooks/useDeployment"
import {
  bootstrap,
  groupedSeries,
  organizationContext,
  organizationMember,
  SURFACES,
  usageTotals,
  workspace,
} from "@/tests/fixtures"
import { AppProviders as Provider } from "@/tests/providers"
import { LocationProbe, renderWithRouter } from "@/tests/router"
import { findRowMenuItem } from "@/tests/rowMenu"
import { selectTrigger } from "@/tests/select"

const ADA = organizationMember({
  organization_member_id: "m-ada",
  user_id: "u-ada",
  attribution_user_id: "u-ada",
  full_name: "Ada Lovelace",
})
const WEI = organizationMember({
  organization_member_id: "m-wei",
  user_id: "u-wei",
  attribution_user_id: "u-wei",
  full_name: "Wei Zhang",
})

describe("Home, Where it went", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it("shows no columns until the roster says which cut it opens on", async () => {
    let answerRoster: ((response: Response) => void) | undefined
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input).slice(API_ROOT.length).split("?")[0]
      if (path === "/organizations/me") {
        return Response.json(
          organizationContext({ role: "owner", deployment_operator: false }),
        )
      }
      if (path === "/organizations/me/members") {
        return new Promise<Response>((resolve) => {
          answerRoster = resolve
        })
      }
      // Every other read is still on its way.
      return new Promise<Response>(() => {})
    })
    await renderWithRouter(<TeamHome />, {
      shell: (
        <Provider>
          <DeploymentProvider value={bootstrap()}>
            <SelectedWorkspaceProvider>
              <Outlet />
            </SelectedWorkspaceProvider>
          </DeploymentProvider>
        </Provider>
      ),
    })

    const section = await screen.findByRole("region", {
      name: "Where it went",
    })
    await waitFor(() => expect(answerRoster).toBeDefined())
    expect(within(section).getByText("Loading…")).toBeVisible()
    expect(within(section).queryAllByRole("columnheader")).toHaveLength(0)

    answerRoster?.(Response.json({ data: [ADA, WEI], count: 2 }))
    const table = await within(section).findByRole("grid", {
      name: "Spend by people",
    })
    expect(
      within(table).getByRole("columnheader", { name: "Person" }),
    ).toBeVisible()
  })
})

describe("Home, Where it went by model", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  /** Two providers' ids for one model, as the gateway marks them. */
  const BY_MODEL = [
    {
      key: "accounts/fireworks/models/deepseek-v4p1-flash-1017",
      label: "DeepSeek V4.1 Flash 1017",
      model_group: "deepseekv41flash1017",
      cost: 149.33,
      tokens: 8_590_300_000,
      requests: 900,
      is_other: false,
    },
    {
      key: "moonshotai/Kimi-K3.1-Pro",
      label: "Kimi K3.1 Pro",
      model_group: "kimik31pro",
      cost: 70.28,
      tokens: 314_900_000,
      requests: 200,
      is_other: false,
    },
    {
      key: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      label: "DeepSeek V4.1 Flash 1017",
      model_group: "deepseekv41flash1017",
      cost: 50.47,
      tokens: 2_973_500_000,
      requests: 300,
      is_other: false,
    },
  ]

  function SessionsProbe() {
    const search = useRouterState({
      select: (state) => state.location.searchStr,
    })
    return <output aria-label="Sessions search">{search}</output>
  }

  it("lists one model once, by name, and opens the sessions of every id it ran as", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input).slice(API_ROOT.length).split("?")[0]
      if (path === "/organizations/me") {
        return Response.json(
          organizationContext({ role: "owner", deployment_operator: false }),
        )
      }
      if (path === "/organizations/me/members") {
        return Response.json({ data: [ADA, WEI], count: 2 })
      }
      if (path === "/organizations/me/usage/summary") {
        return Response.json({
          totals: usageTotals({ cost: 270.08, request_count: 1400 }),
          series: [],
          by_user: [],
          by_api_key: [],
          by_model: BY_MODEL,
          errors_by_status_code: [],
        })
      }
      if (path === "/organizations/me/spend-ceilings") {
        return Response.json({ data: [], count: 0 })
      }
      if (path.endsWith("/traces/count")) return Response.json({ count: 3 })
      if (path === "/workspaces") return Response.json({ data: [], count: 0 })
      if (path.endsWith("/usage/series")) {
        return Response.json(groupedSeries())
      }
      return Response.json([])
    })
    await renderWithRouter(<TeamHome />, {
      url: "/?by=models",
      routes: [{ path: "/sessions", element: <SessionsProbe /> }],
      shell: (
        <Provider>
          <DeploymentProvider
            value={bootstrap({ surfaces: [...SURFACES, "traces"] })}
          >
            <SelectedWorkspaceProvider>
              <Outlet />
            </SelectedWorkspaceProvider>
          </DeploymentProvider>
        </Provider>
      ),
    })

    const table = await screen.findByRole("grid", { name: "Spend by models" })
    await within(table).findByText("Kimi K3.1 Pro")
    const rows = within(table).getAllByRole("row").slice(1)
    expect(
      rows.map((row) => within(row).getByRole("rowheader").textContent),
      // Each name with the link to its sessions under it.
    ).toEqual(["DeepSeek V4.1 Flash 1017Sessions", "Kimi K3.1 ProSessions"])
    expect(within(rows[0]).getByText("$199.80")).toBeVisible()
    // A model's p95 is no one percentile, which the header says beside itself.
    expect(
      within(table).getByText(
        /A model's p95 is the slowest of its provider ids/,
      ),
    ).toBeInTheDocument()

    await userEvent.setup().click(
      within(rows[0]).getByRole("link", {
        name: "Sessions for DeepSeek V4.1 Flash 1017",
      }),
    )
    const search = new URLSearchParams(
      (await screen.findByRole("status", { name: "Sessions search" }))
        .textContent ?? "",
    )
    expect(search.getAll("model")).toEqual([
      "accounts/fireworks/models/deepseek-v4p1-flash-1017",
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    ])
  })
})

describe("Home, People active", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  const placed = (id: string, workspaceId: string, name: string) =>
    organizationMember({
      organization_member_id: `m-${id}`,
      user_id: `u-${id}`,
      attribution_user_id: `u-${id}`,
      full_name: name,
      workspaces: [
        {
          workspace_id: workspaceId,
          workspace_member_id: `wm-${id}`,
          workspace_name: workspaceId,
          role: "member",
        },
      ],
    })

  /** Every read answered; returns the trace count requests it saw. */
  function mockApi() {
    const counts: URL[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://test")
      const path = url.pathname.replace(
        new URL(API_ROOT, "http://test").pathname,
        "",
      )
      if (path === "/organizations/me") {
        return Response.json(
          organizationContext({
            role: "owner",
            deployment_operator: false,
            // The sidebar has a workspace selected, which the page's own
            // "All workspaces" must not narrow to.
            workspace_memberships: [
              { workspace_id: "ws-a", name: "Platform", role: "owner" },
            ],
          }),
        )
      }
      if (path === "/organizations/me/members") {
        return Response.json({
          data: [
            placed("ada", "ws-a", "Ada Lovelace"),
            placed("lin", "ws-a", "Lin Chen"),
            placed("wei", "ws-b", "Wei Zhang"),
          ],
          count: 3,
        })
      }
      if (path === "/organizations/me/usage/summary") {
        return Response.json({
          totals: usageTotals({ cost: 0, request_count: 0 }),
          series: [],
          by_user: [],
          by_api_key: [],
          by_model: [],
          errors_by_status_code: [],
        })
      }
      if (path.endsWith("/traces/count")) {
        counts.push(url)
        return Response.json({ count: 3 })
      }
      if (path === "/organizations/me/spend-ceilings") {
        return Response.json({ data: [], count: 0 })
      }
      if (path === "/workspaces") return Response.json({ data: [], count: 0 })
      if (path.endsWith("/usage/series")) {
        return Response.json(groupedSeries())
      }
      return Response.json([])
    })
    return counts
  }

  async function renderHome(url: string, { hasTraces = true } = {}) {
    await renderWithRouter(<TeamHome />, {
      url,
      shell: (
        <Provider>
          <DeploymentProvider
            value={bootstrap(
              hasTraces ? { surfaces: [...SURFACES, "traces"] } : {},
            )}
          >
            <SelectedWorkspaceProvider>
              <Outlet />
            </SelectedWorkspaceProvider>
          </DeploymentProvider>
        </Provider>
      ),
    })
  }

  it("links each person's name to their page and their sessions beside it", async () => {
    mockApi()
    await renderHome("/?period=7d&workspace=ws-a&by=people")
    const table = await screen.findByRole("grid", { name: "Spend by people" })
    const name = await within(table).findByRole("link", {
      name: "Ada Lovelace",
    })
    // Their page opens on the window Home was reading.
    expect(name).toHaveAttribute("href", "/people/m-ada?period=7d")
    const row = name.closest("tr") as HTMLElement
    const sessions = within(row).getByRole("link", {
      name: "Sessions for Ada Lovelace",
    })
    expect(sessions.getAttribute("href")).toMatch(/^\/sessions\?/)
    expect(sessions.getAttribute("href")).toContain("user_id=u-ada")
    // The row itself is not a press target: the two links are.
    expect(screen.queryByText(/A row opens/)).toBeNull()
  })

  it("points an empty window at a longer one, but not from the longest", async () => {
    mockApi()
    await renderHome("/?period=7d&by=models")
    expect(
      await screen.findByText(
        "Nothing was spent in this window. Pick a longer one above.",
      ),
    ).toBeVisible()
  })

  it("offers no longer window from 6M", async () => {
    mockApi()
    await renderHome("/?period=6m&by=models")
    expect(
      await screen.findByText("Nothing was spent in this window."),
    ).toBeVisible()
    expect(screen.queryByText(/Pick a longer one/)).toBeNull()
  })

  it("counts the people of the workspace the page shows, not the organization", async () => {
    mockApi()
    await renderHome("/?workspace=ws-a")
    // Two of the three members are in ws-a, and nobody spent anything.
    expect(await screen.findByText("0 of 2")).toBeVisible()
  })

  it("links the sessions where the deployment records them", async () => {
    mockApi()
    await renderHome("/?workspace=ws-a")
    expect(await screen.findByText("0 of 2")).toBeVisible()
    expect(
      await screen.findByRole("link", { name: "See the sessions" }),
    ).toBeVisible()
  })

  it("offers no sessions where the deployment records none", async () => {
    const counts = mockApi()
    await renderHome("/?workspace=ws-a", { hasTraces: false })
    expect(await screen.findByText("0 of 2")).toBeVisible()
    expect(screen.getByText("in this workspace")).toBeVisible()
    expect(screen.queryByRole("link", { name: "See the sessions" })).toBeNull()
    expect(screen.queryByRole("link", { name: /^Sessions for / })).toBeNull()
    expect(counts).toHaveLength(0)
  })

  it("counts every workspace's sessions when the page shows them all", async () => {
    const counts = mockApi()
    await renderHome("/")
    await waitFor(() => expect(counts.length).toBeGreaterThan(0))
    for (const url of counts) {
      expect(url.searchParams.get("workspace_id")).toBeNull()
    }
  })
})

describe("Home, by provider", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  const PROVIDERS = [
    { key: "openai", label: null, cost: 6, tokens: 600, requests: 4 },
    { key: "anthropic", label: null, cost: 3, tokens: 300, requests: 2 },
    // Requests that recorded no provider.
    { key: null, label: null, cost: 1, tokens: 100, requests: 3 },
  ]

  /** An owner's view, with one or two workspaces. */
  function mockApi({ workspaces = 1 }: { workspaces?: number } = {}) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://test")
      const path = url.pathname.replace(
        new URL(API_ROOT, "http://test").pathname,
        "",
      )
      if (path === "/organizations/me") {
        return Response.json(
          organizationContext({ role: "owner", deployment_operator: false }),
        )
      }
      if (path === "/organizations/me/members") {
        return Response.json({ data: [ADA, WEI], count: 2 })
      }
      if (path === "/organizations/me/usage/summary") {
        const provider = url.searchParams.get("provider")
        if (provider && url.searchParams.get("dimensions") === "none") {
          // Which workspace a provider row opens in: Data spent the most.
          const workspace = url.searchParams.get("workspace_id")
          return Response.json({
            totals: usageTotals({ cost: workspace === "ws-b" ? 5 : 1 }),
            series: [],
          })
        }
        if (provider) {
          // A provider row's top model.
          return Response.json({
            totals: usageTotals({ cost: 6, request_count: 4 }),
            series: [],
            by_model: [
              {
                key: `${provider}-flagship`,
                label: null,
                cost: 5,
                tokens: 500,
                requests: 3,
                is_other: false,
              },
            ],
          })
        }
        return Response.json({
          totals: usageTotals({ cost: 10, request_count: 9 }),
          series: [],
          by_user: [],
          by_api_key: [],
          by_model: [],
          by_provider: PROVIDERS.map((row) => ({ ...row, is_other: false })),
          errors_by_status_code: [],
        })
      }
      if (path === "/organizations/me/spend-ceilings") {
        return Response.json({ data: [], count: 0 })
      }
      if (path === "/workspaces") {
        const all = [
          { id: "ws-a", name: "Platform" },
          { id: "ws-b", name: "Data" },
        ].slice(0, workspaces)
        return Response.json({ data: all, count: all.length })
      }
      if (path.endsWith("/usage/series")) {
        return Response.json(groupedSeries())
      }
      return Response.json([])
    })
  }

  async function renderHome(url = "/?by=providers") {
    await renderWithRouter(<TeamHome />, {
      url,
      routes: [{ path: "/requests", element: <LocationProbe /> }],
      shell: (
        <Provider>
          <DeploymentProvider value={bootstrap()}>
            <SelectedWorkspaceProvider>
              <Outlet />
            </SelectedWorkspaceProvider>
          </DeploymentProvider>
        </Provider>
      ),
    })
  }

  async function providerTable() {
    const table = await screen.findByRole("grid", {
      name: "Spend by providers",
    })
    await within(table).findByText("OpenAI")
    return table
  }

  it("offers Providers beside the other cuts", async () => {
    const user = userEvent.setup()
    mockApi()
    await renderHome("/")
    await waitFor(() =>
      expect(selectTrigger("Break down by")).toBeInTheDocument(),
    )
    await user.click(selectTrigger("Break down by"))
    const options = await screen.findAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual([
      "People",
      "API keys",
      "Models",
      "Providers",
      "Channels",
      "Routing policies",
      "Tools",
    ])
  })

  it("lists each provider's spend and share, the unrecorded ones as one row", async () => {
    mockApi()
    await renderHome()
    const table = await providerTable()
    const names = within(table)
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent)
    // A provider's requests are linked under its name; the unrecorded row has none.
    expect(names).toEqual([
      "OpenAIRequests",
      "AnthropicRequests",
      "Unknown providerNot recorded",
    ])
    const openai = within(table).getByRole("row", { name: /OpenAI/ })
    expect(within(openai).getByText("$6.00")).toBeVisible()
    expect(within(openai).getByText("60%")).toBeVisible()
    expect(
      await within(openai).findByText("openai-flagship"),
    ).toBeInTheDocument()
    const unknown = within(table).getByRole("row", {
      name: /Unknown provider/,
    })
    expect(within(unknown).getByText("10%")).toBeVisible()
    // A provider's limit lives on a stored key, so the cut shows none.
    expect(
      within(table).queryByRole("columnheader", { name: "Limit" }),
    ).toBeNull()
    // Each provider that recorded one links to its requests, and the row that
    // did not has nothing to open.
    expect(
      within(openai).getByRole("link", { name: "Requests for OpenAI" }),
    ).toBeVisible()
    expect(within(unknown).queryByRole("link")).toBeNull()
  })

  it("opens a provider's requests over the window", async () => {
    mockApi()
    const user = userEvent.setup()
    await renderHome()
    const table = await providerTable()
    await user.click(
      within(table).getByRole("link", { name: "Requests for OpenAI" }),
    )
    const landed = await screen.findByTestId("location")
    const [path, query] = (landed.textContent ?? "").split("?")
    expect(path).toBe("/requests")
    const search = new URLSearchParams(query)
    expect(search.get("provider")).toBe("openai")
    expect(search.get("start_date")).toBeTruthy()
  })

  it("opens a provider's requests in the workspace that spent the most on it", async () => {
    mockApi({ workspaces: 2 })
    const user = userEvent.setup()
    await renderHome("/?by=providers")
    const table = await providerTable()
    await user.click(
      within(table).getByRole("link", { name: "Requests for OpenAI" }),
    )
    const landed = await screen.findByTestId("location")
    expect(landed.textContent).toContain("provider=openai")
    // Each workspace's spend on the provider was weighed, not just the one
    // the sidebar had selected.
    const weighed = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => new URL(String(input), "http://test"))
      .filter(
        (url) =>
          url.searchParams.get("provider") === "openai" &&
          url.searchParams.get("dimensions") === "none",
      )
      .map((url) => url.searchParams.get("workspace_id"))
    expect(weighed.sort()).toEqual(["ws-a", "ws-b"])
  })

  it("offers nothing to open on the row that recorded no provider", async () => {
    mockApi()
    const user = userEvent.setup()
    await renderHome()
    const table = await providerTable()
    const unknown = within(table).getByRole("row", {
      name: /Unknown provider/,
    })
    expect(await findRowMenuItem(user, /See its requests/, unknown)).toBeNull()
    const openai = within(table).getByRole("row", { name: /OpenAI/ })
    expect(
      await findRowMenuItem(user, /See its requests/, openai),
    ).not.toBeNull()
  })

  it("picks the cut from a list on a phone once there are more than three", async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
    try {
      mockApi()
      await renderHome()
      await waitFor(() =>
        expect(selectTrigger("Break down by")).toBeInTheDocument(),
      )
      expect(
        screen.queryByRole("radiogroup", { name: "Break down by" }),
      ).toBeNull()
    } finally {
      window.matchMedia = original
    }
  })

  it("picks the cut from a list once there are more than four", async () => {
    mockApi({ workspaces: 2 })
    await renderHome()
    await providerTable()
    await waitFor(() =>
      expect(
        screen.queryByRole("radiogroup", { name: "Break down by" }),
      ).toBeNull(),
    )
    expect(selectTrigger("Break down by")).toHaveTextContent("Providers")
  })
})

describe("Home, the window", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  function LocationProbe() {
    const { searchStr } = useLocation()
    return <output aria-label="Search">{searchStr}</output>
  }

  const spent = (key: string, label: string) => ({
    key,
    label,
    cost: 2,
    requests: 3,
    tokens: 900,
    is_other: false,
  })

  /** Every read answered with some spend; returns every URL the page asked. */
  function mockApi({ errors = 0 }: { errors?: number } = {}) {
    const asked: URL[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://test")
      asked.push(url)
      const path = url.pathname.replace(
        new URL(API_ROOT, "http://test").pathname,
        "",
      )
      if (path === "/organizations/me") {
        return Response.json(
          organizationContext({ role: "owner", deployment_operator: false }),
        )
      }
      if (path === "/organizations/me/members") {
        return Response.json({ data: [ADA, WEI], count: 2 })
      }
      if (path === "/organizations/me/usage/summary") {
        // Nothing was refused.
        if (url.searchParams.get("status_code") === "403") {
          return Response.json({
            totals: usageTotals({ request_count: 0 }),
            series: [],
            by_user: [],
          })
        }
        return Response.json({
          totals: usageTotals({
            cost: 4,
            request_count: 6,
            error_count: errors,
          }),
          series: [],
          by_user: [spent("u-ada", "Ada"), spent("u-wei", "Wei")],
          by_api_key: [spent("k-1", "laptop")],
          by_model: [spent("gpt-5", "gpt-5")],
          errors_by_status_code: [],
        })
      }
      if (path.endsWith("/traces/count")) return Response.json({ count: 3 })
      if (path === "/organizations/me/spend-ceilings") {
        return Response.json({ data: [], count: 0 })
      }
      if (path === "/workspaces") {
        return Response.json({
          data: [
            workspace({ id: "ws-a", name: "Platform" }),
            workspace({ id: "ws-b", name: "Research" }),
          ],
          count: 2,
        })
      }
      if (path.endsWith("/usage/series")) {
        return Response.json(groupedSeries())
      }
      return Response.json([])
    })
    return asked
  }

  async function renderHome(url: string) {
    await renderWithRouter(<TeamHome />, {
      url,
      shell: (
        <Provider>
          <DeploymentProvider
            value={bootstrap({ surfaces: [...SURFACES, "traces"] })}
          >
            <SelectedWorkspaceProvider>
              <Outlet />
              <LocationProbe />
            </SelectedWorkspaceProvider>
          </DeploymentProvider>
        </Provider>
      ),
    })
  }

  /**
   * Needs attention's reads, which cover the last 24 hours whatever the window:
   * failures by status code, and the refusals by person.
   */
  const isBandRead = (url: URL) =>
    url.searchParams.getAll("dimensions").includes("status_code") ||
    (url.searchParams.get("status_code") === "403" &&
      url.searchParams.getAll("dimensions").includes("user"))

  /** The reads over a window: usage's `start_date`, sessions' `start`. */
  const windowed = (asked: URL[]) =>
    asked.filter(
      (url) =>
        (url.searchParams.has("start_date") || url.searchParams.has("start")) &&
        !isBandRead(url),
    )

  it("counts one failed request in the singular", async () => {
    mockApi({ errors: 1 })
    await renderHome("/?period=today&workspace=ws-a")
    expect(await screen.findByRole("link", { name: "1 failed" })).toBeVisible()
  })
  it("links no count across every workspace, since Requests lists one", async () => {
    mockApi({ errors: 1 })
    await renderHome("/?period=today")
    expect(await screen.findByText("1 failed")).toBeVisible()
    expect(screen.queryByRole("link", { name: "1 failed" })).toBeNull()
  })
  it("ends every read of yesterday at midnight, so none counts today", async () => {
    const asked = mockApi()
    await renderHome("/?period=yesterday")
    expect(await screen.findByText("Spent yesterday")).toBeVisible()
    // The top model of each person on screen is read over the window too.
    await waitFor(() =>
      expect(
        asked.some(
          (url) =>
            url.searchParams.get("user_id") === "u-ada" &&
            url.searchParams.get("dimensions") === "model",
        ),
      ).toBe(true),
    )
    await waitFor(() =>
      expect(asked.some((url) => url.pathname.endsWith("/traces/count"))).toBe(
        true,
      ),
    )
    const reads = windowed(asked)
    expect(reads.length).toBeGreaterThan(3)
    for (const url of reads) {
      expect(
        url.searchParams.get("end_date") ?? url.searchParams.get("end"),
        String(url),
      ).toBeTruthy()
    }
    // One day reads by the hour.
    const main = reads.find((url) =>
      url.searchParams.getAll("dimensions").includes("user"),
    )
    expect(main?.searchParams.get("bucket")).toBe("hour")
    const sessions = screen.getByRole("link", { name: "See the sessions" })
    expect(sessions.getAttribute("href")).toContain("end_date=")
  })

  it("ends each workspace's read of yesterday too", async () => {
    const asked = mockApi()
    await renderHome("/?period=yesterday&by=workspaces")
    await screen.findByRole("grid", { name: "Spend by workspaces" })
    await waitFor(() =>
      expect(
        asked.filter(
          (url) => url.searchParams.get("workspace_id") && !isBandRead(url),
        ),
      ).toHaveLength(2),
    )
    for (const url of windowed(asked)) {
      expect(
        url.searchParams.get("end_date") ?? url.searchParams.get("end"),
        String(url),
      ).toBeTruthy()
    }
  })

  it("reads the last day once for the organization while nothing failed", async () => {
    // Two workspaces, no failures and no refusals: the band's two reads are
    // the organization's, and none is repeated workspace by workspace.
    const asked = mockApi()
    await renderHome("/?period=7d")
    await screen.findByText("Nothing needs you right now.")
    const band = asked.filter(isBandRead)
    expect(band.length).toBeGreaterThanOrEqual(2)
    expect(band.filter((url) => url.searchParams.get("workspace_id"))).toEqual(
      [],
    )
  })

  it("opens on 30 days, and moves to today by the hour in the URL", async () => {
    const user = userEvent.setup()
    const asked = mockApi()
    await renderHome("/")
    const picker = await screen.findByRole("radiogroup", { name: "Window" })
    expect(
      within(picker)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.textContent),
    ).toEqual(["Today", "Yesterday", "7D", "30D", "3M", "6M"])
    expect(within(picker).getByRole("radio", { name: "30D" })).toBeChecked()
    expect(await screen.findByText("Spent, 30 days")).toBeVisible()
    // An open window names no end; only the window before it has one.
    await waitFor(() =>
      expect(
        asked.some((url) =>
          url.searchParams.getAll("dimensions").includes("user"),
        ),
      ).toBe(true),
    )
    for (const url of windowed(asked)) {
      const isMain = url.searchParams.getAll("dimensions").includes("user")
      if (isMain)
        expect(url.searchParams.has("end_date"), String(url)).toBe(false)
      // Only the window before it ends, which reads totals alone.
      if (url.searchParams.has("end_date")) {
        expect(url.searchParams.getAll("dimensions"), String(url)).toEqual([
          "none",
        ])
      }
    }

    await user.click(within(picker).getByRole("radio", { name: "Today" }))
    expect(screen.getByRole("status", { name: "Search" })).toHaveTextContent(
      "period=today",
    )
    expect(await screen.findByText("Spent today")).toBeVisible()
    await waitFor(() =>
      expect(
        asked.some(
          (url) =>
            url.searchParams.get("bucket") === "hour" &&
            url.searchParams.getAll("dimensions").includes("user"),
        ),
      ).toBe(true),
    )
  })

  it("reads an old 90-day link as 3M, and a retired or unknown one as 30D", async () => {
    mockApi()
    await renderHome("/?period=90d")
    const picker = await screen.findByRole("radiogroup", { name: "Window" })
    expect(within(picker).getByRole("radio", { name: "3M" })).toBeChecked()
    expect(await screen.findByText("Spent, 3 months")).toBeVisible()
  })

  it.each(["month", "custom", "bogus"])(
    "falls back to 30D for period=%s",
    async (period) => {
      mockApi()
      await renderHome(`/?period=${period}`)
      const picker = await screen.findByRole("radiogroup", { name: "Window" })
      expect(within(picker).getByRole("radio", { name: "30D" })).toBeChecked()
    },
  )
})

describe("Home, the figures and what needs attention", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  /**
   * One workspace whose last day failed often, with part of the window's
   * spend on a budget-exempt key.
   */
  function mockApi() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://test")
      const path = url.pathname.replace(
        new URL(API_ROOT, "http://test").pathname,
        "",
      )
      if (path === "/organizations/me") {
        return Response.json(
          organizationContext({ role: "owner", deployment_operator: false }),
        )
      }
      if (path === "/organizations/me/members") {
        return Response.json({ data: [ADA, WEI], count: 2 })
      }
      if (path === "/organizations/me/usage/summary") {
        const isCharged =
          url.searchParams.get("counts_toward_budget") === "true"
        const isUnpriced = url.searchParams.get("priced") === "false"
        const isDay = url.searchParams
          .getAll("dimensions")
          .includes("status_code")
        return Response.json({
          totals: usageTotals({
            cost: isCharged ? 30 : 50,
            request_count: isUnpriced ? 4 : 100,
            error_count: isUnpriced ? 0 : 12,
          }),
          series: [],
          by_user: [],
          by_api_key: [],
          by_model: [],
          errors_by_status_code: isDay
            ? [
                {
                  status_code: 502,
                  error_class: "provider_error",
                  requests: 12,
                },
              ]
            : [],
        })
      }
      if (path === "/organizations/me/usage") return Response.json([])
      if (path.endsWith("/traces/count")) return Response.json({ count: 3 })
      if (path === "/organizations/me/spend-ceilings") {
        return Response.json({ data: [], count: 0 })
      }
      if (path === "/workspaces") {
        return Response.json({
          data: [workspace({ id: "ws-a", name: "Platform" })],
          count: 1,
        })
      }
      if (path.endsWith("/usage/series")) {
        return Response.json(groupedSeries())
      }
      return Response.json([])
    })
  }

  async function renderHome() {
    await renderWithRouter(<TeamHome />, {
      url: "/?period=7d",
      shell: (
        <Provider>
          <DeploymentProvider value={bootstrap({ surfaces: SURFACES })}>
            <SelectedWorkspaceProvider>
              <Outlet />
            </SelectedWorkspaceProvider>
          </DeploymentProvider>
        </Provider>
      ),
    })
  }

  it("splits Spent into what was charged and what was not", async () => {
    mockApi()
    await renderHome()
    expect(await screen.findByText("$30.00 charged")).toBeVisible()
    expect(screen.getByText("+$20.00 not charged")).toBeVisible()
  })

  it("judges the failure rate and links the counts to Requests", async () => {
    mockApi()
    await renderHome()
    const failed = await screen.findByRole("link", { name: "12 failed" })
    const cell = failed.closest("[class*='row-span-4']") as HTMLElement
    expect(within(cell).getByText("HIGH")).toBeVisible()
    expect(failed.getAttribute("href")).toContain("status=error")
    const unpriced = within(cell).getByRole("link", { name: "4 unpriced" })
    expect(unpriced.getAttribute("href")).toContain("priced=false")
  })

  it("mounts Needs attention, with the last day's failures linked", async () => {
    mockApi()
    await renderHome()
    const band = await screen.findByRole("region", { name: "Needs attention" })
    expect(
      await within(band).findByText(
        "12 of 100 requests failed in the last 24 hours (12.0%).",
      ),
    ).toBeVisible()
    expect(
      within(band).getByRole("link", { name: "See the failures" }),
    ).toHaveAttribute("href", expect.stringContaining("status=error"))
  })

  it("lists the window's recent failures and offers a refresh", async () => {
    mockApi()
    await renderHome()
    expect(
      await screen.findByText("No request failed in the last 7 days."),
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible()
    expect(screen.getByText(/^Updated /)).toBeVisible()
  })
})

describe("Home, Where it went by any figure", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  const POLICIES = [
    {
      key: "fast",
      label: null,
      cost: 3,
      charged_cost: 3,
      tokens: 300,
      requests: 10,
      error_count: 4,
      p95_latency_ms: 2400,
      is_other: false,
    },
    {
      key: null,
      label: null,
      cost: 5,
      charged_cost: 2,
      tokens: 500,
      requests: 20,
      error_count: 0,
      p95_latency_ms: 300,
      is_other: false,
    },
  ]

  function RequestsProbe() {
    const search = useRouterState({
      select: (state) => state.location.searchStr,
    })
    return <output aria-label="Requests search">{search}</output>
  }

  /** Every summary read, and the breakdown read answering with `POLICIES`. */
  function mockPolicies() {
    const reads: URLSearchParams[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const [path, query = ""] = String(input).slice(API_ROOT.length).split("?")
      const params = new URLSearchParams(query)
      if (path === "/organizations/me") {
        return Response.json(
          organizationContext({ role: "owner", deployment_operator: false }),
        )
      }
      if (path === "/organizations/me/members") {
        return Response.json({ data: [ADA, WEI], count: 2 })
      }
      if (path === "/organizations/me/usage/summary") {
        reads.push(params)
        const isPolicies = params.getAll("dimensions").includes("policy")
        return Response.json({
          // What counted toward a budget is read as its own total.
          totals:
            params.get("counts_toward_budget") === "true"
              ? usageTotals({ cost: 5, charged_cost: 5, request_count: 30 })
              : usageTotals({ cost: 8, charged_cost: 5, request_count: 30 }),
          series: [],
          by_user: [],
          by_api_key: [],
          by_model: [],
          by_provider: [],
          by_policy: isPolicies ? POLICIES : [],
          errors_by_status_code: [],
        })
      }
      if (path === "/organizations/me/spend-ceilings") {
        return Response.json({ data: [], count: 0 })
      }
      if (path.endsWith("/traces/count")) return Response.json({ count: 3 })
      if (path === "/workspaces") return Response.json({ data: [], count: 0 })
      if (path.endsWith("/usage/series")) return Response.json(groupedSeries())
      return Response.json([])
    })
    return reads
  }

  async function renderPolicies(url: string) {
    await renderWithRouter(<TeamHome />, {
      url,
      routes: [{ path: "/requests", element: <RequestsProbe /> }],
      shell: (
        <Provider>
          <DeploymentProvider value={bootstrap()}>
            <SelectedWorkspaceProvider>
              <Outlet />
            </SelectedWorkspaceProvider>
          </DeploymentProvider>
        </Provider>
      ),
    })
    const table = await screen.findByRole("grid", {
      name: "Spend by routing policies",
    })
    await within(table).findByText("fast")
    return table
  }

  it("shows each policy's charged and not charged spend, failures and p95, Direct included", async () => {
    const reads = mockPolicies()
    const table = await renderPolicies("/?by=policies")
    const direct = within(table)
      .getByText("Direct")
      .closest("tr") as HTMLElement
    expect(within(direct).getByText("$5.00")).toBeVisible()
    // $2.00 charged, $3.00 not.
    expect(within(direct).getByText("$2.00")).toBeVisible()
    expect(within(direct).getByText("$3.00")).toBeVisible()
    const fast = within(table).getByText("fast").closest("tr") as HTMLElement
    expect(within(fast).getByText("2.40 s")).toBeVisible()
    expect(within(fast).getByText("4")).toHaveClass("text-danger")
    // The breakdown is read with each policy's p95.
    expect(
      reads.some(
        (one) =>
          one.get("p95_by") === "policy" &&
          one.getAll("dimensions").join() === "policy",
      ),
    ).toBe(true)
  })

  it("sorts by a pressed column on the server, and lists the rows in that order", async () => {
    const user = userEvent.setup()
    const reads = mockPolicies()
    const table = await renderPolicies("/?by=policies")
    const names = () =>
      within(table)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent)
    expect(names()[0]).toMatch(/^Direct/)
    await user.click(
      within(table).getByRole("columnheader", { name: /Failed/ }),
    )
    await waitFor(() => expect(names()[0]).toMatch(/^fast/))
    expect(
      reads.some(
        (one) =>
          one.get("rank_by") === "failed" && one.get("rank_order") === "desc",
      ),
    ).toBe(true)
    // Ranked by p95, the read names its one breakdown, as the server requires.
    await user.click(
      within(table).getByRole("columnheader", { name: /p95 latency/ }),
    )
    await waitFor(() =>
      expect(reads.some((one) => one.get("rank_by") === "p95")).toBe(true),
    )
    expect(
      reads
        .filter((one) => one.has("rank_by"))
        .every((one) => one.getAll("dimensions").join() === "policy"),
    ).toBe(true)
  })

  it("opens the requests that named a model directly from the Direct row", async () => {
    const user = userEvent.setup()
    mockPolicies()
    const table = await renderPolicies("/?by=policies")
    await user.click(
      within(table).getByRole("link", { name: "Requests for Direct" }),
    )
    const search = new URLSearchParams(
      (await screen.findByRole("status", { name: "Requests search" }))
        .textContent ?? "",
    )
    expect(search.get("routed")).toBe("false")
  })
})
