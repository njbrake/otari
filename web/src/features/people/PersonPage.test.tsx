import { Outlet } from "@tanstack/react-router"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UsageGroupRow, UsageSummary } from "@/client"
import { PersonPage } from "@/features/people/PersonPage"
import { API_ROOT } from "@/shared/api/client"
import { SelectedWorkspaceProvider } from "@/shared/hooks/SelectedWorkspace"
import { DeploymentProvider } from "@/shared/hooks/useDeployment"
import {
  apiKey,
  bootstrap,
  organizationContext,
  organizationMember,
  SURFACES,
  usageTotals,
} from "@/tests/fixtures"
import { AppProviders as Provider } from "@/tests/providers"
import { LocationProbe, renderWithRouter } from "@/tests/router"

const ADA = organizationMember({
  organization_member_id: "om-ada",
  user_id: "u-ada",
  attribution_user_id: "u-ada",
  full_name: "Ada Lovelace",
  email: "ada@example.com",
  role: "member",
  status: "active",
  workspaces: [
    {
      workspace_id: "ws-platform",
      workspace_name: "Platform",
      workspace_member_id: "wm-ada",
      role: "member",
    },
  ],
})

const KEYS = [
  apiKey({
    id: "k-ci",
    key_name: "ci-bot",
    user_id: "u-ada",
    workspace_id: "ws-platform",
  }),
  apiKey({
    id: "k-sub",
    key_name: "claude-subscription",
    user_id: "u-ada",
    workspace_id: "ws-platform",
    exclude_from_budget: true,
  }),
]

const row = (overrides: Partial<UsageGroupRow>): UsageGroupRow => ({
  key: null,
  cost: 0,
  tokens: 0,
  requests: 0,
  is_other: false,
  ...overrides,
})

/** One half of the person's spend, each breakdown keyed by its dimension. */
interface Half {
  cost: number
  requests: number
  by: Partial<Record<string, UsageGroupRow[]>>
}

const BUDGETED: Half = {
  cost: 12.5,
  requests: 30,
  by: {
    model: [
      row({
        key: "gpt-5",
        label: "GPT-5",
        cost: 12.5,
        tokens: 9000,
        requests: 30,
      }),
    ],
    api_key: [row({ key: "k-ci", cost: 12.5, tokens: 9000, requests: 30 })],
    provider: [row({ key: "openai", cost: 12.5, tokens: 9000, requests: 30 })],
    source: [row({ key: "gateway", cost: 12.5, tokens: 9000, requests: 30 })],
  },
}

const EXEMPT: Half = {
  cost: 40,
  requests: 8,
  by: {
    model: [
      row({
        key: "claude-opus-5",
        label: "Claude Opus 5",
        cost: 40,
        tokens: 50000,
        requests: 8,
      }),
    ],
    api_key: [row({ key: "k-sub", cost: 40, tokens: 50000, requests: 8 })],
    provider: [row({ key: "anthropic", cost: 40, tokens: 50000, requests: 8 })],
    source: [row({ key: "claude_code", cost: 40, tokens: 50000, requests: 8 })],
  },
}

const NOTHING: Half = { cost: 0, requests: 0, by: {} }

const FIELDS: Record<string, keyof UsageSummary> = {
  model: "by_model",
  user: "by_user",
  api_key: "by_api_key",
  provider: "by_provider",
  source: "by_source",
}

function summaryFor(half: Half, dimensions: string[]): UsageSummary {
  const breakdowns: Record<string, UsageGroupRow[]> = Object.fromEntries(
    Object.values(FIELDS).map((field) => [field, []]),
  )
  for (const dimension of dimensions) {
    const field = FIELDS[dimension]
    if (field) breakdowns[field] = half.by[dimension] ?? []
  }
  return {
    start_date: "",
    end_date: "",
    bucket: "day",
    totals: usageTotals({ cost: half.cost, request_count: half.requests }),
    by_model: [],
    by_user: [],
    by_api_key: [],
    by_source: [],
    by_source_label: [],
    by_endpoint: [],
    by_provider: [],
    by_tool: [],
    by_tag: [],
    errors_by_status_code: [],
    series: [],
    ...breakdowns,
  }
}

/** Every summary the page asked a person's half for, as its query string. */
async function renderPerson({
  budgeted = BUDGETED,
  exempt = EXEMPT,
  url = "/people/om-ada",
} = {}) {
  window.localStorage.setItem(
    "otari.dashboard.selectedWorkspace",
    "ws-platform",
  )
  const halves: URLSearchParams[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const [path, query = ""] = String(input).slice(API_ROOT.length).split("?")
    const params = new URLSearchParams(query)
    switch (path) {
      case "/organizations/me":
        return Response.json(
          organizationContext({
            role: "owner",
            deployment_operator: false,
            workspace_memberships: [
              { workspace_id: "ws-platform", name: "Platform", role: "owner" },
            ],
          }),
        )
      case "/organizations/me/members":
        return Response.json({ data: [ADA], count: 1 })
      case "/organizations/me/keys":
        return Response.json(KEYS)
      case "/organizations/me/traces":
        return Response.json({ items: [], total: 0 })
      case "/organizations/me/traces/count":
        return Response.json({ count: 0 })
      case "/organizations/me/usage/summary": {
        const side = params.get("counts_toward_budget")
        const dimensions = params.getAll("dimensions")
        if (side === null) {
          return Response.json(
            summaryFor({ cost: 52.5, requests: 38, by: {} }, dimensions),
          )
        }
        halves.push(params)
        return Response.json(
          summaryFor(side === "true" ? budgeted : exempt, dimensions),
        )
      }
      default:
        return Response.json({ data: [], count: 0 })
    }
  })
  await renderWithRouter(<PersonPage personId="om-ada" />, {
    url,
    routes: [
      { path: "/sessions", element: <LocationProbe /> },
      { path: "/requests", element: <LocationProbe /> },
    ],
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
  return { halves }
}

const breakdown = () =>
  screen.findByRole("grid", { name: /Ada Lovelace's spend by/ })

describe("A person's page", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it("leads with budgeted spend and names the exempt spend as not charged", async () => {
    await renderPerson()
    const label = await screen.findByText("Spent this month")
    const cell = label.closest("div")?.parentElement as HTMLElement
    expect(await within(cell).findByText("$12.50")).toBeVisible()
    expect(within(cell).getByText("+$40.00 not charged")).toBeVisible()
  })

  it("asks each half for the model breakdown, and the key one on API keys", async () => {
    const user = userEvent.setup()
    const { halves } = await renderPerson()
    const table = await breakdown()
    expect(await within(table).findByText("Claude Opus 5")).toBeVisible()
    expect(halves.map((one) => one.getAll("dimensions"))).toContainEqual([
      "model",
    ])
    expect(
      new Set(halves.map((one) => one.get("counts_toward_budget"))),
    ).toEqual(new Set(["true", "false"]))
    expect(halves.every((one) => one.get("user_id") === "u-ada")).toBe(true)

    halves.length = 0
    await user.click(screen.getByRole("radio", { name: "API keys" }))
    const keys = await screen.findByRole("grid", {
      name: "Ada Lovelace's spend by api keys",
    })
    const exemptRow = (
      await within(keys).findByText("claude-subscription")
    ).closest("tr") as HTMLElement
    expect(within(exemptRow).getByText("Exempt from budget")).toBeVisible()
    expect(within(exemptRow).getByText("$40.00")).toBeVisible()
    const ciRow = within(keys).getByText("ci-bot").closest("tr") as HTMLElement
    expect(within(ciRow).queryByText("Exempt from budget")).toBeNull()
    expect(
      halves.every((one) => one.getAll("dimensions").join() === "api_key"),
    ).toBe(true)
    expect(halves).toHaveLength(2)
  })

  it("reads the window the picker chooses", async () => {
    const user = userEvent.setup()
    const { halves } = await renderPerson()
    await breakdown()
    const monthStart = halves[0]?.get("start_date")
    const today = new Date()
    expect(monthStart).toBe(
      new Date(today.getFullYear(), today.getMonth(), 1).toISOString(),
    )

    await user.click(screen.getByRole("radio", { name: "7D" }))
    expect(await screen.findByText("Spent, 7 days")).toBeVisible()
    const weekStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - 6,
    ).toISOString()
    await waitFor(() =>
      expect(halves.map((one) => one.get("start_date"))).toContain(weekStart),
    )
  })

  it("opens a model's sessions filtered to this person and that model", async () => {
    const user = userEvent.setup()
    await renderPerson()
    const table = await breakdown()
    await user.click(
      await within(table).findByRole("link", { name: "Sessions for GPT-5" }),
    )
    const location = await screen.findByTestId("location")
    expect(location.textContent).toMatch(/^\/sessions\?/)
    const search = new URLSearchParams(
      location.textContent?.split("?")[1] ?? "",
    )
    expect(search.get("user_id")).toBe("u-ada")
    expect(search.getAll("model")).toEqual(["gpt-5"])
    expect(search.get("start_date")).toBeTruthy()
  })

  it("opens a provider's requests filtered to this person and that provider", async () => {
    const user = userEvent.setup()
    await renderPerson({ url: "/people/om-ada?by=providers" })
    const table = await screen.findByRole("grid", {
      name: "Ada Lovelace's spend by providers",
    })
    await user.click(
      await within(table).findByRole("link", {
        name: "Requests for Anthropic",
      }),
    )
    const location = await screen.findByTestId("location")
    expect(location.textContent).toMatch(/^\/requests\?/)
    const search = new URLSearchParams(
      location.textContent?.split("?")[1] ?? "",
    )
    expect(search.get("user_id")).toBe("u-ada")
    expect(search.get("provider")).toBe("anthropic")
  })

  it("says nothing was spent, and drops the exempt column, when nothing was", async () => {
    await renderPerson({ budgeted: NOTHING, exempt: NOTHING })
    const table = await breakdown()
    expect(
      await within(table).findByText(
        "Nothing was spent this month. Pick a longer window above.",
      ),
    ).toBeVisible()
    expect(
      within(table).getByRole("columnheader", { name: "Spent" }),
    ).toBeVisible()
    expect(
      within(table).queryByRole("columnheader", { name: "Exempt" }),
    ).toBeNull()
  })
})
