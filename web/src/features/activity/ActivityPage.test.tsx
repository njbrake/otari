import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import { API_ROOT } from "@/shared/api/client"
import {
  CALLER_IDENTITY,
  entry,
  group,
  lastList,
  listCalls,
  listCarries,
  mockApi,
  renderPage,
  rowOf,
  WORKSPACE_ID,
} from "@/tests/activity"
import { organizationMember } from "@/tests/fixtures"

// The log itself: its rows, the totals over them, a request opened in full, grouping, and what each kind of reader is shown.

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ActivityPage", () => {
  describe("rows", () => {
    it("shows a request's time, model, tokens, cost, latency and outcome", async () => {
      mockApi({
        rows: [
          entry({
            total_tokens: 1500,
            latency_ms: 842,
            cost: 0.0123,
            status_code: 200,
          }),
        ],
      })
      renderPage(<ActivityPage />)

      const row = await rowOf("gpt-4o")
      expect(within(row).getByText("1.5k")).toBeInTheDocument()
      expect(within(row).getByText("$0.0123")).toBeInTheDocument()
      expect(within(row).getByText("842 ms")).toBeInTheDocument()
      expect(within(row).getByText("200")).toBeInTheDocument()
      expect(within(row).getByText("ci-runner")).toBeInTheDocument()
    })

    it("reads an imported row as subscription usage nothing billed", async () => {
      mockApi({
        rows: [
          entry({
            model: "claude-opus-5-5",
            source: "claude_code",
            counts_toward_budget: false,
            cost: 0.42,
          }),
        ],
      })
      renderPage(<ActivityPage />)

      const row = await rowOf("claude-opus-5-5")
      expect(within(row).getByText("Claude Code")).toBeInTheDocument()
      expect(within(row).getByText("Subscription")).toBeInTheDocument()
      expect(within(row).getByText("not billed")).toBeInTheDocument()
    })

    it("marks an unpriced request, and a failure by its code and reason", async () => {
      mockApi({
        rows: [
          entry({ id: "a", model: "unpriced-model", cost: null }),
          entry({
            id: "b",
            model: "failing-model",
            status: "error",
            status_code: 429,
            cost: null,
          }),
        ],
      })
      renderPage(<ActivityPage />)

      expect(
        within(await rowOf("unpriced-model")).getByText("unpriced"),
      ).toBeInTheDocument()
      const failed = await rowOf("failing-model")
      expect(within(failed).getByText("429")).toBeInTheDocument()
      expect(within(failed).getByText("Rate limited")).toBeInTheDocument()
    })

    it("says which alias the caller sent", async () => {
      mockApi({
        rows: [
          entry({
            model: "claude-haiku-4-5",
            provider: "anthropic",
            requested_model: "fast",
          }),
        ],
      })
      renderPage(<ActivityPage />)
      expect(
        within(await rowOf("claude-haiku-4-5")).getByText("requested as fast"),
      ).toBeInTheDocument()
    })

    it("filters to the tools a request ran from its badge", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [
          entry({
            billing_meters: {
              tools: { web_search: { billed: 2, errors: 0, unit_rate: 0.01 } },
            },
          }),
        ],
      })
      renderPage(<ActivityPage />)

      const row = await rowOf("gpt-4o")
      await user.click(
        within(row).getByRole("button", {
          name: "Filter to requests using web search",
        }),
      )
      await listCarries(calls, "tool", "web_search")
    })

    it("leaves Enter on a control inside a row to that control", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [
          entry({
            billing_meters: {
              tools: { web_search: { billed: 2, errors: 0, unit_rate: 0.01 } },
            },
          }),
        ],
      })
      renderPage(<ActivityPage />)

      const row = await rowOf("gpt-4o")
      within(row)
        .getByRole("button", { name: "Filter to requests using web search" })
        .focus()
      await user.keyboard("{Enter}")
      await listCarries(calls, "tool", "web_search")
      expect(
        screen.queryByRole("complementary", { name: "Request details" }),
      ).not.toBeInTheDocument()

      ;(await rowOf("gpt-4o")).focus()
      await user.keyboard("{Enter}")
      expect(
        await screen.findByRole("complementary", { name: "Request details" }),
      ).toBeInTheDocument()
    })

    it("lists each routed request once, and its earlier attempts under it on request", async () => {
      const user = userEvent.setup()
      const served = entry({
        id: "served",
        model: "claude-sonnet-5",
        request_group_id: "g1",
        policy_name: "opus-fallback",
        attempt_position: 2,
        attempt_count: 2,
        absorbed_attempts: 1,
      })
      const absorbed = entry({
        id: "absorbed",
        model: "claude-opus-5-5",
        request_group_id: "g1",
        policy_name: "opus-fallback",
        attempt_position: 1,
        attempt_count: 2,
        status: "absorbed",
        status_code: 529,
      })
      const { calls } = mockApi({ rows: [served, absorbed] })
      renderPage(<ActivityPage />)

      await rowOf("claude-sonnet-5")
      expect(lastList(calls).get("include_absorbed")).toBe("false")
      expect(
        within(await rowOf("claude-sonnet-5")).getByText("1 recovered"),
      ).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Filter Status" }))
      await user.click(
        screen.getByRole("menuitemcheckbox", {
          name: "Show recovered attempts as rows",
        }),
      )
      await listCarries(calls, "include_absorbed", "true")
      // Nested under the row that served, and marked as the attempt it was.
      const rows = screen.getAllByRole("row")
      const servedIndex = rows.findIndex((row) =>
        within(row).queryByText("claude-sonnet-5"),
      )
      expect(
        within(rows[servedIndex + 1]).getByText("attempt 1"),
      ).toBeInTheDocument()
    })
  })

  describe("totals", () => {
    it("adds up what the rows below billed, what subscriptions covered, and what went unpriced", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry()],
        totals: {
          request_count: 115,
          error_count: 3,
          absorbed_count: 6,
          cost: 26.98,
          imported_cost: 25.79,
          unpriced_requests: 11,
          p95_latency_ms: 1200,
        },
      })
      renderPage(<ActivityPage />)
      expect(await screen.findByText("115 requests")).toBeInTheDocument()
      expect(screen.getByText("3 failed")).toBeInTheDocument()
      expect(screen.getByText("6 recovered")).toBeInTheDocument()
      expect(screen.getByText("$1.19 billed")).toBeInTheDocument()
      expect(screen.getByText("$25.79 subscription")).toBeInTheDocument()
      expect(screen.getByText("P95 1.20 s")).toBeInTheDocument()
      expect(
        calls.some(
          (call) =>
            call.url.includes("/usage/summary") &&
            call.url.includes("include_p95=true"),
        ),
      ).toBe(true)

      await user.click(screen.getByRole("button", { name: "11 unpriced" }))
      await listCarries(calls, "priced", "false")
      expect(lastList(calls).get("status")).toBe("success")
    })
  })

  describe("the request panel", () => {
    it("opens a row beside the log, steps through the list, and closes on Escape", async () => {
      const user = userEvent.setup()
      mockApi({
        rows: [
          entry({ id: "a", model: "first-model" }),
          entry({ id: "b", model: "second-model" }),
        ],
      })
      renderPage(<ActivityPage />)

      await user.click(await rowOf("first-model"))
      const panel = await screen.findByRole("complementary", {
        name: "Request details",
      })
      expect(within(panel).getByText("1 / 2")).toBeInTheDocument()

      await user.keyboard("{ArrowDown}")
      await waitFor(() =>
        expect(
          within(
            screen.getByRole("complementary", { name: "Request details" }),
          ).getByRole("heading", { level: 2 }),
        ).toHaveTextContent("second-model"),
      )

      await user.keyboard("{Escape}")
      await waitFor(() =>
        expect(
          screen.queryByRole("complementary", { name: "Request details" }),
        ).not.toBeInTheDocument(),
      )
    })

    it("opens a linked request that is not on the page", async () => {
      const { calls } = mockApi({
        rows: [entry({ id: "a" })],
        otherRows: [entry({ id: "elsewhere", model: "linked-model" })],
      })
      renderPage(<ActivityPage />, "/activity?request=elsewhere")

      expect(
        await screen.findByRole("heading", { name: "linked-model" }),
      ).toBeInTheDocument()
      expect(listCalls(calls).some((url) => url.includes("id=elsewhere"))).toBe(
        true,
      )
    })

    it("says so when a linked request cannot be read, and lets it go", async () => {
      const user = userEvent.setup()
      mockApi({ rows: [entry({ id: "a" })] })
      renderPage(<ActivityPage />, "/activity?request=gone-request")

      const notice = await screen.findByText(/is not in the log/)
      await user.click(within(notice).getByRole("button", { name: "Close" }))
      expect(screen.queryByText(/is not in the log/)).not.toBeInTheDocument()
    })

    it("narrows the log to the open request's model and closes", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />)

      await user.click(await rowOf("gpt-4o"))
      const panel = await screen.findByRole("complementary", {
        name: "Request details",
      })
      await user.click(within(panel).getByRole("button", { name: "Model" }))
      await waitFor(() =>
        expect(lastList(calls).getAll("model")).toEqual(["gpt-4o"]),
      )
      expect(
        screen.queryByRole("complementary", { name: "Request details" }),
      ).not.toBeInTheDocument()
    })

    it("sets a model's price from a request that carried none", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry({ cost: null, provider: "fireworks", model: "deepseek" })],
      })
      renderPage(<ActivityPage />)

      await user.click(await rowOf("deepseek"))
      await user.click(
        await screen.findByRole("button", { name: "Set model price…" }),
      )
      const dialog = await screen.findByRole("dialog", {
        name: "Set model price",
      })
      expect(
        within(dialog).getByDisplayValue("fireworks:deepseek"),
      ).toBeInTheDocument()
      await user.type(within(dialog).getByLabelText(/Input/), "1")
      await user.type(within(dialog).getByLabelText(/Output/), "2")
      await user.click(
        within(dialog).getByRole("button", { name: "Set price" }),
      )

      await waitFor(() => {
        const write = calls.find(
          (call) =>
            call.url.includes(`${API_ROOT}/pricing`) && call.method !== "GET",
        )
        expect(JSON.parse(write?.body ?? "{}")).toMatchObject({
          model_key: "fireworks:deepseek",
          input_price_per_million: 1,
          output_price_per_million: 2,
        })
      })
    })
  })

  describe("grouping", () => {
    it("collapses the log into groups that open in place and become a list of their own", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry()],
        groups: [group({ key: "key-1", label: "ci-runner", requests: 12 })],
      })
      renderPage(<ActivityPage />, "/activity?group=source")

      const groupRow = await screen.findByRole("row", { name: /ci-runner/ })
      expect(within(groupRow).getByText("12 requests")).toBeInTheDocument()
      expect(
        calls.some(
          (call) =>
            call.url.includes("/usage/groups") &&
            call.url.includes("group_by=api_key"),
        ),
      ).toBe(true)

      await user.click(groupRow)
      await waitFor(() =>
        expect(
          listCalls(calls).some(
            (url) =>
              url.includes("api_key_id=key-1") && url.includes("limit=8"),
          ),
        ).toBe(true),
      )
      await user.click(
        await screen.findByRole("button", {
          name: "Show all 12 as a filtered list",
        }),
      )
      await waitFor(() =>
        expect(lastList(calls).getAll("api_key_id")).toEqual(["key-1"]),
      )
    })

    it("pauses grouping while sorted by anything but time", async () => {
      mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?group=model&sort=cost")
      expect(
        await screen.findByText(/Grouping pauses while sorted by cost/),
      ).toBeInTheDocument()
      await rowOf("gpt-4o")
    })
  })

  describe("who is reading", () => {
    it("reads a member's own requests from the organization route, with nothing of the operator's", async () => {
      const { calls } = mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      expect(listCalls(calls).at(-1)).toContain("/organizations/me/usage")
      expect(screen.getByText("Your requests")).toBeInTheDocument()
      expect(
        screen.queryByRole("columnheader", { name: /Member/ }),
      ).not.toBeInTheDocument()
      expect(calls.some((call) => call.url.includes("/in-flight"))).toBe(false)
      expect(
        screen.queryByRole("button", { name: /imported rows/ }),
      ).not.toBeInTheDocument()
    })

    it("lets a manager narrow the workspace to their own requests", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry()],
        viewer: "manager",
        members: [
          organizationMember({
            user_id: CALLER_IDENTITY,
            attribution_user_id: "me-attr",
          }),
        ],
      })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")
      expect(
        screen.getByRole("columnheader", { name: /Member/ }),
      ).toBeInTheDocument()

      await user.click(screen.getByRole("radio", { name: "You" }))
      await waitFor(() =>
        expect(lastList(calls).getAll("user_id")).toEqual(["me-attr"]),
      )
      expect(
        screen.queryByRole("columnheader", { name: /Member/ }),
      ).not.toBeInTheDocument()
    })

    it("reads a workspace admin who is an organization member as a member, as the server does", async () => {
      mockApi({ rows: [entry()], viewer: "workspaceAdmin" })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")
      expect(screen.getByText("Your requests")).toBeInTheDocument()
      expect(
        screen.queryByRole("radio", { name: "You" }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole("columnheader", { name: /Member/ }),
      ).not.toBeInTheDocument()
    })

    it("marks a budget that has run over", async () => {
      mockApi({
        rows: [entry()],
        viewer: "member",
        spend: {
          workspace_id: WORKSPACE_ID,
          name: "Everything",
          max_budget: 500,
          spent: 612,
          period_start: "2026-09-01T00:00:00Z",
          period_end: "2026-10-01T00:00:00Z",
        },
      })
      renderPage(<ActivityPage />)
      expect(await screen.findByText("$612.00 / $500")).toHaveClass(
        "text-danger",
      )
      expect(
        screen.getByRole("progressbar", { name: /Workspace budget used/ }),
      ).toHaveAttribute("aria-valuetext", expect.stringContaining("over"))
    })

    it("shows the workspace's budget to every member, and nothing when it has none", async () => {
      mockApi({
        rows: [entry()],
        viewer: "member",
        spend: {
          workspace_id: WORKSPACE_ID,
          max_budget: 500,
          spent: 21.4,
          period_start: "2026-09-01T00:00:00Z",
          period_end: "2026-10-01T00:00:00Z",
        },
      })
      renderPage(<ActivityPage />)
      expect(await screen.findByText("$21.40 / $500")).toBeInTheDocument()
      expect(screen.getByText("Workspace budget, Sep")).toBeInTheDocument()
    })

    it("leaves the budget out when the workspace has no ceiling", async () => {
      const { calls } = mockApi({ rows: [entry()], spend: null })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")
      // Asked and answered, so the absence below is the answer rather than a
      // read still on its way.
      await waitFor(() =>
        expect(calls.some((call) => call.url.includes("/budget"))).toBe(true),
      )
      expect(screen.queryByText(/Workspace budget/)).not.toBeInTheDocument()
    })
  })
})
