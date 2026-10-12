import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { UsagePage } from "@/features/usage/UsagePage"
import { API_ROOT } from "@/shared/api/client"
import { workspace } from "@/tests/fixtures"
import {
  breakdownRow,
  breakdownSummary,
  lastBreakdown,
  mockUsageApi,
  OWN_USER_ID,
  renderUsage,
  UrlProbe,
  usageReads,
  WORKSPACE_ID,
} from "@/tests/usage"

afterEach(() => {
  vi.restoreAllMocks()
})

function page(route?: string) {
  return renderUsage(
    <>
      <UsagePage />
      <UrlProbe />
    </>,
    route,
  )
}

/** The chart's readout of the bar under the pointer or the keyboard's cursor. */
async function readout() {
  const total = await screen.findByText("Total")
  const box = total.closest("div")
  if (!box) throw new Error("no chart readout")
  return box
}
const pageUrl = () => screen.getByRole("status", { name: "Page URL" })
const table = () => screen.findByRole("grid", { name: /^Usage by/ })
// Found on the screen rather than inside a grid held from earlier: a new
// breakdown, or the scope the roster settles on, puts a new grid in its place.
async function rowNamed(name: string | RegExp) {
  const cell = await screen.findByRole("rowheader", { name })
  const row = cell.closest('[role="row"]')
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`)
  return row
}

describe("UsagePage", () => {
  describe("the three numbers", () => {
    it("splits the total at API prices into billed and subscription", async () => {
      mockUsageApi({ viewer: "member" })
      page()
      expect(await screen.findByText("$1,215.07")).toBeInTheDocument()
      expect(screen.getByText("$106.67")).toBeInTheDocument()
      expect(
        screen.getByText("billed · counts toward limits"),
      ).toBeInTheDocument()
      expect(screen.getByText("$1,108.40")).toBeInTheDocument()
      expect(screen.getByText("8 failed (0.1%)")).toBeInTheDocument()
      expect(screen.getByText("94% from cache")).toBeInTheDocument()
    })

    it("links the unpriced requests to Activity", async () => {
      const user = userEvent.setup()
      mockUsageApi()
      page()
      await user.click(await screen.findByRole("link", { name: "3 unpriced" }))
      const location = await screen.findByRole("status", {
        name: "Current location",
      })
      expect(location.textContent).toContain("priced=false")
      expect(location.textContent).toContain("status=success")
    })

    it("says growth as a multiple, a percentage, or the previous figure, never a red percentage off nothing", async () => {
      mockUsageApi({
        previous: breakdownSummary(
          {},
          { cost: 100, request_count: 8000, billed_input_tokens: 400_000_000 },
        ),
      })
      page()
      // $1,215 against $100 is past ten times: the previous figure itself.
      expect(await screen.findByText("prev 30d $100.00")).toBeInTheDocument()
      expect(screen.getByText("↑ 6% vs prev 30d")).toBeInTheDocument()
      expect(screen.getByText("4.1× prev 30d")).toBeInTheDocument()
    })
  })

  describe("scope", () => {
    it("tells a member they read their own usage, with no scope to pick", async () => {
      const { calls } = mockUsageApi({ viewer: "member" })
      page()
      expect(await screen.findByText("Your usage")).toBeInTheDocument()
      expect(screen.queryByRole("radiogroup", { name: "Scope" })).toBeNull()
      await table()
      // The server narrows a member's rows; the page asks for the workspace.
      expect(lastBreakdown(calls).get("workspace_id")).toBe(WORKSPACE_ID)
      expect(lastBreakdown(calls).getAll("user_id")).toEqual([])
    })

    it("lets a manager narrow the workspace to their own usage", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "workspaceAdmin" })
      page()
      const scope = await screen.findByRole("radiogroup", { name: "Scope" })
      expect(
        within(scope).queryByRole("radio", { name: "Organization" }),
      ).toBeNull()
      await user.click(within(scope).getByRole("radio", { name: "You" }))
      await waitFor(() =>
        expect(lastBreakdown(calls).getAll("user_id")).toEqual([OWN_USER_ID]),
      )
      expect(pageUrl().textContent).toContain("scope=you")
    })

    it("reads the organization across its workspaces, broken down by workspace", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "owner" })
      page()
      await user.click(
        await screen.findByRole("radio", { name: "Organization" }),
      )
      await waitFor(() =>
        expect(lastBreakdown(calls).getAll("dimensions")).toContain(
          "workspace",
        ),
      )
      const summaries = calls.filter((call) =>
        call.url.includes("/organizations/me/usage/summary"),
      )
      expect(summaries.length).toBeGreaterThan(0)
      expect(lastBreakdown(calls).get("workspace_id")).toBeNull()
      expect(await rowNamed(/Research/)).toBeInTheDocument()
    })

    it("opens a workspace's requests in Activity with that workspace named", async () => {
      const user = userEvent.setup()
      mockUsageApi({ viewer: "owner" })
      page("/usage?scope=organization")
      await user.click(await rowNamed(/Research/))
      const location = await screen.findByRole("status", {
        name: "Current location",
      })
      expect(location.textContent).toContain("workspace=ws-2")
    })

    it("names a workspace filter by its workspace under another breakdown", async () => {
      const { calls } = mockUsageApi({
        viewer: "owner",
        workspaces: [workspace({ id: "ws-3", name: "Staging" })],
      })
      page("/usage?scope=organization&by=model&workspace_id=ws-3")
      expect(
        await screen.findByRole("button", { name: "Remove Workspace Staging" }),
      ).toBeInTheDocument()
      // A read of the workspace the chip names, not of the whole list.
      const paths = calls.map(
        (call) => new URL(call.url, "http://localhost").pathname,
      )
      expect(paths).toContain(`${API_ROOT}/workspaces/ws-3`)
      expect(paths).not.toContain(`${API_ROOT}/workspaces`)
    })

    it("keeps a filter the scope cannot use in the URL, greyed, and does not send it", async () => {
      const { calls } = mockUsageApi({ viewer: "workspaceAdmin" })
      page("/usage?scope=you&user_id=u-jordan")
      expect(await screen.findByText("not in this scope")).toBeInTheDocument()
      await table()
      expect(lastBreakdown(calls).getAll("user_id")).toEqual([OWN_USER_ID])
      expect(pageUrl().textContent).toContain("user_id=u-jordan")
    })

    it("names a single workspace scope as the workspace's usage", async () => {
      mockUsageApi({ viewer: "workspaceAdmin", hasOwnUserId: false })
      page()
      expect(await screen.findByText("Workspace usage")).toBeInTheDocument()
      expect(screen.queryByText("Your usage")).toBeNull()
      expect(screen.queryByRole("radiogroup", { name: "Scope" })).toBeNull()
    })
  })

  describe("the breakdown", () => {
    it("drives the summary, its p95 and the chart's series from one choice", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "workspaceAdmin" })
      page()
      // A manager's workspace view leads with Member.
      await waitFor(() =>
        expect(lastBreakdown(calls).get("p95_by")).toBe("user"),
      )
      await user.click(screen.getByRole("button", { name: "Model" }))
      await waitFor(() =>
        expect(lastBreakdown(calls).get("p95_by")).toBe("model"),
      )
      // Only the breakdown on screen and the tools under it: each dimension is
      // a GROUP BY over the window.
      expect(lastBreakdown(calls).getAll("dimensions")).toEqual([
        "model",
        "tool",
      ])
      expect(lastBreakdown(calls).get("session_details")).toBeNull()
      expect(usageReads(calls, "series").at(-1)?.get("group_by")).toBe("model")
      expect(pageUrl().textContent).toContain("by=model")
    })

    it("offers the rest of the breakdowns under More", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "member" })
      page()
      await table()
      await user.click(screen.getByRole("button", { name: "More breakdowns" }))
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Policy" }),
      )
      await waitFor(() =>
        expect(lastBreakdown(calls).get("p95_by")).toBe("policy"),
      )
      // A menu trigger, not a toggle: its name says what it holds.
      expect(
        screen.getByRole("button", { name: "More breakdowns, Policy" }),
      ).not.toHaveAttribute("aria-pressed")
    })

    it("shows every column, a cut-down provider path and the p95", async () => {
      mockUsageApi({ viewer: "member" })
      page()
      const row = await rowNamed(/deepseek-v4-flash/)
      expect(within(row).getByText("fireworks/")).toBeInTheDocument()
      expect(within(row).getByText("1.85 s")).toBeInTheDocument()
      expect(within(row).getByText("$28.61")).toBeInTheDocument()
      const opus = await rowNamed("claude-opus-5-5")
      expect(within(opus).getByText("$22.40")).toBeInTheDocument()
      expect(within(opus).getByText("$1,101.35")).toBeInTheDocument()
      expect(within(opus).getByText("98% cached")).toBeInTheDocument()
    })

    it("pins the rows with no value last, explained", async () => {
      const { calls } = mockUsageApi({ viewer: "member" })
      page("/usage?by=session")
      await rowNamed(/No session/)
      // A session's origin is asked for only where sessions are on screen.
      expect(lastBreakdown(calls).get("session_details")).toBe("true")
      const names = within(await table())
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent)
      expect(names.at(-1)).toContain("No session")
      expect(names.at(-1)).toContain("Requests sent without a session ID")
      expect(names[0]).toContain("4e498676")
      expect(names[0]).toContain("Claude Code")
    })

    it("sorts by a header, reverses it, then returns to the share", async () => {
      const user = userEvent.setup()
      mockUsageApi({ viewer: "member" })
      page()
      const grid = await table()
      const header = within(grid).getByRole("columnheader", {
        name: /Requests/,
      })
      await user.click(header)
      expect(pageUrl().textContent).toContain("sort=requests")
      const first = () =>
        within(grid).getAllByRole("rowheader")[0].textContent ?? ""
      expect(first()).toContain("claude-opus-5-5")
      await user.click(header)
      expect(pageUrl().textContent).toContain("order=asc")
      expect(first()).toContain("claude-haiku-4-5")
      await user.click(header)
      expect(pageUrl().textContent).not.toContain("sort=")
    })

    it("defines the money columns and the p95 under the table, and a subscription figure on its cell", async () => {
      const user = userEvent.setup()
      mockUsageApi({ viewer: "member" })
      page()
      const opus = await rowNamed("claude-opus-5-5")
      expect(
        screen.getByText(
          "Billed counts toward limits · Subscription is priced at API rates, not billed · p95 latency: 95% of requests were faster",
        ),
      ).toBeVisible()
      expect(
        screen.getByRole("columnheader", { name: /^p95 Latency/ }),
      ).toBeInTheDocument()
      // A tooltip opens on hover once the pointer is known to be in use, which
      // a first press is what tells react-aria.
      await user.click(screen.getByRole("heading", { name: "Usage", level: 1 }))
      await user.hover(within(opus).getByText("$1,101.35"))
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "$1,101.35 at API prices, covered by subscription",
      )
      // A header is one control: it sorts, and nothing inside it is a button.
      const billed = within(await table()).getByRole("columnheader", {
        name: /Billed/,
      })
      expect(within(billed).queryByRole("button")).toBeNull()
      await user.click(billed)
      expect(pageUrl().textContent).toContain("sort=billed")
    })

    it("never shows the last breakdown's rows or series while the next one loads", async () => {
      const user = userEvent.setup()
      let releaseSummary = () => {}
      let releaseSeries = () => {}
      const summaryHeld = new Promise<void>((resolve) => {
        releaseSummary = resolve
      })
      const seriesHeld = new Promise<void>((resolve) => {
        releaseSeries = resolve
      })
      mockUsageApi({
        viewer: "workspaceAdmin",
        hold: (kind, params) => {
          if (kind === "summary" && params.get("p95_by") === "model") {
            return summaryHeld
          }
          if (kind === "series" && params.get("group_by") === "model") {
            return seriesHeld
          }
          return undefined
        },
      })
      page()
      await rowNamed(/Jordan M\./)
      const chart = await screen.findByRole("slider", {
        name: /Filter by date/,
      })
      chart.focus()
      await user.keyboard("{ArrowRight}")
      // The keyboard's cursor reads its bar out as a pointer would.
      expect(within(await readout()).getByText("Jordan M.")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Model" }))
      expect(screen.queryAllByText("Jordan M.")).toHaveLength(0)
      // Nor the last answer's model rows, which it never asked for, read as
      // none; its totals are the window's, and hold.
      expect(screen.queryByText(/No usage in this window/)).toBeNull()
      expect(screen.getByText("$1,215.07")).toBeInTheDocument()

      releaseSummary()
      await rowNamed("claude-opus-5-5")
      screen.getByRole("slider", { name: /Filter by date/ }).focus()
      await user.keyboard("{ArrowRight}")
      // The members' series are not drawn under Model while its own load.
      const swatches = (await readout()).querySelectorAll("[aria-hidden]")
      expect(swatches).toHaveLength(0)

      releaseSeries()
      await waitFor(async () =>
        expect(
          within(await readout()).getByText("claude-opus-5-5"),
        ).toBeInTheDocument(),
      )
    })

    it("asks the server to rank by the metric on screen", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "member" })
      page()
      await table()
      const ranks = () => [
        lastBreakdown(calls).get("rank_by"),
        usageReads(calls, "series").at(-1)?.get("rank_by"),
      ]
      expect(ranks()).toEqual(["cost", "cost"])
      await user.click(
        screen.getByRole("checkbox", { name: "Include subscription" }),
      )
      await waitFor(() => expect(ranks()).toEqual(["billed", "billed"]))
      await user.click(screen.getByRole("radio", { name: "Tokens" }))
      await waitFor(() => expect(ranks()).toEqual(["tokens", "tokens"]))
      // Subscription is a cost setting: it changes nothing off cost.
      expect(
        screen.queryByRole("checkbox", { name: "Include subscription" }),
      ).toBeNull()
      await user.click(screen.getByRole("radio", { name: "Requests" }))
      await waitFor(() => expect(ranks()).toEqual(["requests", "requests"]))
    })

    it("cannot open a row with no value in Activity, which has no filter for it", async () => {
      const user = userEvent.setup()
      mockUsageApi({ viewer: "member" })
      page("/usage?by=key")
      const none = await rowNamed(/^No API key/)
      const named = await rowNamed("research-app")
      expect(none.querySelector("svg[aria-hidden]")).toBeNull()
      expect(named.querySelector("svg[aria-hidden]")).not.toBeNull()
      await user.click(none)
      expect(
        screen.queryByRole("status", { name: "Current location" }),
      ).toBeNull()
    })

    it("leaves a channel out by its name", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "member" })
      page("/usage?by=channel")
      const row = await rowNamed(/^API/)
      await user.click(
        within(row).getByRole("button", { name: "Filter by API" }),
      )
      await user.click(
        await screen.findByRole("menuitem", { name: "Exclude API" }),
      )
      await waitFor(() =>
        expect(lastBreakdown(calls).getAll("exclude_channel")).toEqual(["api"]),
      )
      expect(pageUrl().textContent).toContain("exclude_channel=api")
      expect(screen.getByText("Channel is not:")).toBeInTheDocument()
    })

    it("leaves a value out from its own cell", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "member" })
      page()
      const row = await rowNamed("claude-haiku-4-5")
      await user.click(
        within(row).getByRole("button", { name: "Filter by claude-haiku-4-5" }),
      )
      await user.click(
        await screen.findByRole("menuitem", {
          name: "Exclude claude-haiku-4-5",
        }),
      )
      await waitFor(() =>
        expect(lastBreakdown(calls).getAll("exclude_model")).toEqual([
          "claude-haiku-4-5",
        ]),
      )
      expect(screen.getByText("Model is not:")).toBeInTheDocument()
      expect(screen.getByText("Also applied in Activity")).toBeInTheDocument()
    })

    it("opens a row's requests in Activity, with the window", async () => {
      const user = userEvent.setup()
      mockUsageApi({ viewer: "member" })
      page()
      await user.click(await rowNamed("claude-haiku-4-5"))
      const location = await screen.findByRole("status", {
        name: "Current location",
      })
      expect(location.textContent).toContain("model=claude-haiku-4-5")
      expect(location.textContent).toContain("start_date=")
    })

    it("asks the server for a channel by its name, and carries it into Activity", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "member" })
      page("/usage?channel=api")
      await waitFor(() =>
        expect(lastBreakdown(calls).getAll("channel")).toEqual(["api"]),
      )
      expect(lastBreakdown(calls).get("source")).toBeNull()
      expect(screen.getByText("Channel:")).toBeInTheDocument()

      await user.click(await rowNamed("claude-haiku-4-5"))
      const location = await screen.findByRole("status", {
        name: "Current location",
      })
      expect(location.textContent).toContain("channel=api")
    })

    it("leaves subscription usage out of the cost when asked", async () => {
      const user = userEvent.setup()
      mockUsageApi({ viewer: "member" })
      page()
      const share = async () =>
        within(await rowNamed("claude-opus-5-5")).getByText(/^\d+%$/)
          .textContent
      // $1,123.75 of $1,165.78 with subscription; $22.40 of $64.43 billed.
      expect(await share()).toBe("96%")
      await user.click(
        screen.getByRole("checkbox", { name: "Include subscription" }),
      )
      expect(pageUrl().textContent).toContain("subscription=exclude")
      await waitFor(async () => expect(await share()).toBe("35%"))
    })
  })

  describe("the chart", () => {
    it("narrows the page to a stretch of the window from the keyboard", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "member" })
      page()
      const chart = await screen.findByRole("slider", {
        name: /Filter by date/,
      })
      chart.focus()
      await user.keyboard("{ArrowLeft}{Enter}")
      await waitFor(() => expect(pageUrl().textContent).toContain("end_date="))
      expect(screen.getByText("Date:")).toBeInTheDocument()
      await waitFor(() =>
        expect(lastBreakdown(calls).get("end_date")).not.toBeNull(),
      )
    })
  })

  describe("gateway-run tools", () => {
    it("says a tool with no price has none, and lets an operator set one", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "operator" })
      page()
      expect(
        await screen.findByText(/no per-call price set/),
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Set" }))
      await user.type(await screen.findByLabelText("USD per call"), "0.01")
      await user.click(screen.getByRole("button", { name: "Set price" }))
      await waitFor(() =>
        expect(
          calls.find(
            (call) => call.method === "POST" && call.url.includes("/pricing"),
          )?.body,
        ).toBeDefined(),
      )
      const body = JSON.parse(
        calls.find(
          (call) => call.method === "POST" && call.url.includes("/pricing"),
        )?.body ?? "{}",
      )
      expect(body).toEqual({
        model_key: "otari:web_search",
        input_price_per_million: 10_000,
        output_price_per_million: 0,
        unit: "requests",
      })
    })

    it("offers no price to set to anyone but an operator", async () => {
      mockUsageApi({ viewer: "member" })
      page()
      expect(
        await screen.findByText(/no per-call price set/),
      ).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Set" })).toBeNull()
    })
  })

  describe("saved views", () => {
    it("applies a built-in view", async () => {
      const user = userEvent.setup()
      mockUsageApi({ viewer: "member" })
      page()
      await table()
      await user.click(
        screen.getByRole("button", { name: /Saved views|Views/ }),
      )
      expect(
        await screen.findByText("Imported usage, such as Claude Code"),
      ).toBeInTheDocument()
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Spend by API key" }),
      )
      await waitFor(() => expect(pageUrl().textContent).toContain("by=key"))
      expect(await rowNamed("research-app")).toBeInTheDocument()
      expect(await rowNamed(/^No API key/)).toBeInTheDocument()
    })

    it("saves the current view as a Usage view", async () => {
      const user = userEvent.setup()
      const { calls } = mockUsageApi({ viewer: "member" })
      page("/usage?by=key&metric=tokens")
      await table()
      await user.click(screen.getByRole("button", { name: /Saved views/ }))
      await user.click(
        await screen.findByRole("menuitem", { name: "Save current view…" }),
      )
      await user.type(screen.getByLabelText("View name"), "Key tokens")
      await user.click(screen.getByRole("button", { name: "Save" }))
      await waitFor(() => {
        const write = calls.find(
          (call) => call.url.includes("/saved-views") && call.method === "POST",
        )
        expect(JSON.parse(write?.body ?? "{}")).toMatchObject({
          page: "usage",
          name: "Key tokens",
        })
      })
    })
  })

  it("says the window is empty, not that the gateway has never had usage", async () => {
    mockUsageApi({
      viewer: "member",
      summary: breakdownSummary(
        { by_model: [], series: [], by_tool: [] },
        { cost: 0, imported_cost: 0, request_count: 0, error_count: 0 },
      ),
    })
    page()
    expect(
      await screen.findByText(/No usage in the last 30d\./),
    ).toBeInTheDocument()
    expect(screen.queryByText(/recorded yet/)).toBeNull()
  })

  it("explains an empty filtered table and clears back", async () => {
    const user = userEvent.setup()
    mockUsageApi({
      viewer: "member",
      summary: breakdownSummary({ by_model: [] }),
    })
    page("/usage?exclude_model=claude-opus-5-5")
    expect(
      await screen.findByText(/Nothing matches these filters/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(pageUrl().textContent).not.toContain("exclude_model")
  })

  it("marks a row whose every dollar is subscription usage", async () => {
    mockUsageApi({
      viewer: "member",
      summary: breakdownSummary({
        by_model: [
          breakdownRow({
            key: "claude-opus-5-5",
            cost: 10,
            imported_cost: 10,
            requests: 1,
          }),
        ],
      }),
    })
    page()
    const row = await rowNamed(/claude-opus-5-5/)
    expect(within(row).getByText("Subscription")).toBeInTheDocument()
  })
})
