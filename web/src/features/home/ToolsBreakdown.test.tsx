import { Outlet } from "@tanstack/react-router"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UsageToolRow } from "@/client"
import {
  billedPerCall,
  ToolsBreakdown,
  toolFailureRate,
} from "@/features/home/ToolsBreakdown"
import { windowOf } from "@/features/spend/period"
import { API_ROOT } from "@/shared/api/client"
import { DeploymentProvider } from "@/shared/hooks/useDeployment"
import { bootstrap, organizationContext, usageTotals } from "@/tests/fixtures"
import { AppProviders as Provider } from "@/tests/providers"
import { LocationProbe, renderWithRouter } from "@/tests/router"
import { findRowMenuItem } from "@/tests/rowMenu"

const TOOLS: UsageToolRow[] = [
  { tool: "web_search", calls: 40, errors: 10, requests: 30, cost: 0.4 },
  { tool: "code_execution", calls: 5, errors: 0, requests: 5, cost: 0 },
]

async function renderTools({ isOperator = true } = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).slice(API_ROOT.length).split("?")[0]
    if (path === "/organizations/me") {
      return Response.json(
        organizationContext({ deployment_operator: isOperator }),
      )
    }
    if (path === "/organizations/me/usage/summary") {
      return Response.json({
        totals: usageTotals(),
        series: [],
        by_tool: TOOLS,
      })
    }
    if (path.startsWith("/pricing/")) {
      return Response.json({ detail: "Not found" }, { status: 404 })
    }
    return Response.json([])
  })
  await renderWithRouter(
    <ToolsBreakdown
      window={windowOf("30d", Date.now())}
      canOpen
      emptyText="No gateway tool ran in this window."
    />,
    {
      routes: [{ path: "/requests", element: <LocationProbe /> }],
      shell: (
        <Provider>
          <DeploymentProvider value={bootstrap()}>
            <Outlet />
          </DeploymentProvider>
        </Provider>
      ),
    },
  )
  const table = await screen.findByRole("grid", { name: "Spend by tool" })
  await within(table).findByText("Web search")
  return table
}

describe("ToolsBreakdown", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reads what a call was billed and how often one failed", () => {
    expect(billedPerCall(TOOLS[0])).toBeCloseTo(0.01)
    expect(billedPerCall(TOOLS[1])).toBeUndefined()
    expect(toolFailureRate(TOOLS[0])).toBeCloseTo(0.2)
    expect(toolFailureRate(TOOLS[1])).toBe(0)
  })

  it("lists each tool's calls, failures, rate, billed per call and cost", async () => {
    const table = await renderTools()
    const search = within(table)
      .getByText("Web search")
      .closest("tr") as HTMLElement
    expect(within(search).getByText("40")).toBeVisible()
    expect(within(search).getByText("10")).toHaveClass("text-danger")
    expect(within(search).getByText("20.0%")).toBeVisible()
    expect(within(search).getByText("$0.01")).toBeVisible()
    expect(within(search).getByText("$0.40")).toBeVisible()
    const code = within(table)
      .getByText("Code execution")
      .closest("tr") as HTMLElement
    expect(within(code).getByText("Not billed")).toBeVisible()
  })

  it("opens the requests that ran a tool", async () => {
    const user = userEvent.setup()
    const table = await renderTools()
    await user.click(
      within(table).getByRole("link", { name: "Requests for Web search" }),
    )
    expect((await screen.findByTestId("location")).textContent).toMatch(
      /^\/requests\?.*tool=web_search/,
    )
  })

  it("lets an operator set code execution's price per call", async () => {
    const user = userEvent.setup()
    const table = await renderTools()
    const code = within(table)
      .getByText("Code execution")
      .closest("tr") as HTMLElement
    const item = await findRowMenuItem(user, /Set price per call/, code)
    expect(item).not.toBeNull()
    await user.click(item as HTMLElement)
    expect(
      await screen.findByRole("dialog", { name: "Edit tool price" }),
    ).toBeVisible()
  })

  it("offers no price to anyone who does not operate the deployment", async () => {
    const user = userEvent.setup()
    const table = await renderTools({ isOperator: false })
    expect(await findRowMenuItem(user, /price/i, table)).toBeNull()
  })
})
