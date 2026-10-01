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
  mockApi,
  renderPage,
  savedView,
  WORKSPACE_ID,
} from "@/tests/activity"
import { organizationMember } from "@/tests/fixtures"

afterEach(() => {
  vi.restoreAllMocks()
})

/** The log's row naming `model`, found in the table rather than in a chip. */
async function rowOf(model: string) {
  const table = await screen.findByRole("table", { name: "Activity log" })
  const [cell] = await within(table).findAllByText(model)
  const row = cell.closest("tr")
  if (!row) throw new Error(`no row for ${model}`)
  return row
}

/** Waits for the latest list read to carry `key=value`. */
async function listCarries(
  calls: Parameters<typeof lastList>[0],
  key: string,
  value: string | null,
) {
  await waitFor(() => expect(lastList(calls).get(key)).toBe(value))
}

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
        screen.getByRole("button", { name: "Show recovered attempts as rows" }),
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

  describe("filters", () => {
    it("honors a drill-down's filters and shows each as a chip that clears only itself", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(
        <ActivityPage />,
        "/activity?source=gateway&source_label=sess-1&model=a&model=b&endpoint=%2Fv1%2Fmessages",
      )

      await rowOf("gpt-4o")
      const params = lastList(calls)
      expect(params.get("source")).toBe("gateway")
      expect(params.get("source_label")).toBe("sess-1")
      expect(params.getAll("model")).toEqual(["a", "b"])
      expect(params.get("endpoint")).toBe("/v1/messages")

      await user.click(
        screen.getByRole("button", { name: "Remove Session sess-1" }),
      )
      await listCarries(calls, "source_label", null)
      expect(lastList(calls).get("source")).toBe("gateway")
    })

    it("sends two picked statuses as the one left out", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?status=error&status=absorbed")
      await rowOf("gpt-4o")
      expect(lastList(calls).getAll("exclude_status")).toEqual(["success"])
      expect(lastList(calls).get("status")).toBeNull()
    })

    it("searches once typing settles", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.type(screen.getByLabelText("Search requests"), "haiku")
      await listCarries(calls, "q", "haiku")
    })

    it("lists a column's values in the window, leaving that column's own filter off", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry()],
        groups: (groupBy) =>
          groupBy === "alias"
            ? []
            : [
                group({ key: "gpt-4o", label: null, requests: 12 }),
                group({ key: "claude-haiku-4-5", label: null, requests: 30 }),
              ],
      })
      renderPage(<ActivityPage />, "/activity?model=gpt-4o")
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Model" }))
      const options = await screen.findByRole("checkbox", {
        name: "claude-haiku-4-5",
      })
      const modelsCall = calls
        .map((call) => call.url)
        .filter((url) => url.includes("/usage/groups?"))
        .findLast((url) => url.includes("group_by=model"))
      expect(modelsCall).toBeDefined()
      expect(modelsCall).not.toContain("model=gpt-4o")

      await user.click(options)
      await waitFor(() =>
        expect(lastList(calls).getAll("model")).toEqual([
          "gpt-4o",
          "claude-haiku-4-5",
        ]),
      )
    })

    it("searches a column's values on the server, busiest first", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry()],
        groups: (groupBy) =>
          groupBy === "model"
            ? ["a", "b", "c", "d", "e", "gpt-4o-mini"].map((key) =>
                group({ key, label: null }),
              )
            : [],
      })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Model" }))
      await screen.findByRole("checkbox", { name: "gpt-4o-mini" })
      await user.type(
        screen.getByRole("searchbox", { name: "Search model values" }),
        "mini",
      )
      await waitFor(() =>
        expect(
          calls.some(
            (call) =>
              call.url.includes("group_by=model") &&
              call.url.includes("search=mini") &&
              call.url.includes("order=requests"),
          ),
        ).toBe(true),
      )
      await waitFor(() =>
        expect(
          screen.queryByRole("checkbox", { name: "a" }),
        ).not.toBeInTheDocument(),
      )
      expect(
        screen.getByRole("checkbox", { name: "gpt-4o-mini" }),
      ).toBeInTheDocument()
    })

    it("says how many values are past those listed", async () => {
      const user = userEvent.setup()
      mockApi({
        rows: [entry()],
        groups: [group({ key: "gpt-4o", label: null })],
        groupsTotal: 250,
      })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Model" }))
      expect(
        await screen.findByText("249 more, search to narrow"),
      ).toBeInTheDocument()
    })

    it("says a column's values could not be loaded rather than that there are none", async () => {
      const user = userEvent.setup()
      mockApi({ rows: [entry()], failing: ["group_by=model"] })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Model" }))
      expect(
        await screen.findByText("These values could not be loaded."),
      ).toBeInTheDocument()
      expect(
        screen.queryByText("Nothing in this window."),
      ).not.toBeInTheDocument()
    })

    it("keeps the Policy column when the policies cannot be read", async () => {
      mockApi({ rows: [entry()], failing: ["group_by=policy"] })
      renderPage(<ActivityPage />)
      expect(
        await screen.findByRole("button", { name: "Filter Policy" }),
      ).toBeInTheDocument()
    })

    it("never lists one column's values in another column's menu", async () => {
      const user = userEvent.setup()
      // Members answer only once the menu has been looked at.
      let answerMembers: () => void = () => {}
      const members = new Promise<void>((resolve) => {
        answerMembers = resolve
      })
      mockApi({
        rows: [entry()],
        groups: async (groupBy) => {
          if (groupBy === "model") {
            return [group({ key: "claude-haiku-4-5", label: null })]
          }
          if (groupBy !== "user") return []
          await members
          return [group({ key: "user-2", label: null })]
        },
      })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Model" }))
      await screen.findByRole("checkbox", { name: "claude-haiku-4-5" })
      await user.keyboard("{Escape}")
      await user.click(screen.getByRole("button", { name: "Filter Member" }))
      expect(
        screen.queryByRole("checkbox", { name: "claude-haiku-4-5" }),
      ).not.toBeInTheDocument()
      answerMembers()
      expect(
        await screen.findByRole("checkbox", { name: /user-2/ }),
      ).toBeInTheDocument()
    })

    it("keeps the Policy column while it filters to direct requests", async () => {
      const { calls } = mockApi({
        rows: [entry()],
        groups: (groupBy) =>
          groupBy === "policy"
            ? [group({ key: "fast-first" }), group({ key: null })]
            : [],
      })
      renderPage(<ActivityPage />, "/activity?routed=false")

      expect(
        await screen.findByRole("button", { name: "Filter Policy" }),
      ).toBeInTheDocument()
      const policyReads = calls
        .map((call) => call.url)
        .filter((url) => url.includes("group_by=policy"))
      expect(policyReads.length).toBeGreaterThan(0)
      for (const url of policyReads) expect(url).not.toContain("routed=")
    })

    it("lists the aliases callers sent under Model, and filters to one", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry()],
        groups: (groupBy) =>
          groupBy === "alias"
            ? [group({ key: "fast", label: null, requests: 4 })]
            : [],
      })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Model" }))
      expect(await screen.findByText("Requested as alias")).toBeInTheDocument()
      await user.click(await screen.findByRole("checkbox", { name: "fast" }))
      await listCarries(calls, "requested_model", "fast")
    })

    it("excludes a value from its own cell", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />)
      const row = await rowOf("gpt-4o")

      await user.click(
        within(row).getByRole("button", { name: "Filter by gpt-4o" }),
      )
      await user.click(screen.getByRole("button", { name: "Exclude gpt-4o" }))
      await waitFor(() =>
        expect(lastList(calls).getAll("exclude_model")).toEqual(["gpt-4o"]),
      )
      expect(
        screen.getByRole("button", { name: "Remove Model is not gpt-4o" }),
      ).toBeInTheDocument()
    })

    it("shows only rows above a threshold picked from a numeric column", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Cost" }))
      await user.click(screen.getByRole("button", { name: "> $0.40" }))
      await listCarries(calls, "cost_gt", "0.4")
    })

    it("tells a filtered-empty log from one that has never been used, and clears back", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [] })
      renderPage(<ActivityPage />, "/activity?model=nothing")

      expect(
        await screen.findByText(/No requests match these filters/),
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Clear filters" }))
      await listCarries(calls, "model", null)
      expect(
        await screen.findByText("No requests recorded yet."),
      ).toBeInTheDocument()
    })
  })

  describe("sort, window and pages", () => {
    it("sorts by a column, reverses it, then returns to newest first", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")
      expect(lastList(calls).get("sort")).toBeNull()

      const cost = () => screen.getByRole("button", { name: /^Cost/ })
      const header = (name: RegExp) =>
        screen.getByRole("columnheader", { name })
      await user.click(cost())
      await listCarries(calls, "sort", "cost")
      expect(lastList(calls).get("order")).toBe("desc")
      await user.click(cost())
      await listCarries(calls, "order", "asc")
      expect(header(/Cost/)).toHaveAttribute("aria-sort", "ascending")
      // Back to the first read, which is cached, so the headers say it.
      await user.click(cost())
      await waitFor(() =>
        expect(header(/Time/)).toHaveAttribute("aria-sort", "descending"),
      )
      expect(header(/Cost/)).not.toHaveAttribute("aria-sort")
    })

    it("gives a list sorted by anything but time a start under All", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?range=all&sort=cost")
      await rowOf("gpt-4o")
      expect(lastList(calls).get("start_date")).not.toBeNull()
    })

    it("asks only the totals for a 95th percentile, not the chart", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?start_date=2026-09-01T00:00:00Z")
      await rowOf("gpt-4o")
      const summaries = calls
        .map((call) => call.url)
        .filter((url) => url.includes("/usage/summary"))
      expect(summaries.some((url) => url.includes("include_p95=true"))).toBe(
        true,
      )
      expect(summaries.some((url) => !url.includes("include_p95"))).toBe(true)
    })

    it("ignores a grouping the page does not offer", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?group=toString")
      await rowOf("gpt-4o")
      expect(
        calls.some((call) => call.url.includes("group_by=undefined")),
      ).toBe(false)
    })

    it("queries an unbounded window for All", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?range=all")
      await rowOf("gpt-4o")
      expect(lastList(calls).get("start_date")).toBeNull()
    })

    it("rewrites a range this page does not offer to the one it applied", async () => {
      mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?range=90d")
      await rowOf("gpt-4o")
      await waitFor(() =>
        expect(screen.getByRole("radio", { name: "24h" })).toBeChecked(),
      )
    })

    it("opens a bookmarked page on that page", async () => {
      const { calls } = mockApi({ rows: [entry()], total: 200 })
      renderPage(<ActivityPage />, "/activity?page=3")
      await rowOf("gpt-4o")
      expect(lastList(calls).get("skip")).toBe("150")
    })

    it("snaps a hand-edited page size to the nearest one offered", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?size=500")
      await rowOf("gpt-4o")
      expect(lastList(calls).get("limit")).toBe("100")
    })

    it("keeps Next reachable when the count fails", async () => {
      mockApi({
        rows: Array.from({ length: 50 }, (_, index) =>
          entry({ id: `r${index}`, model: `m${index}` }),
        ),
        failing: ["/usage/count"],
      })
      renderPage(<ActivityPage />)
      await rowOf("m0")
      expect(screen.getByRole("button", { name: /next/i })).toBeEnabled()
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

  describe("the operator's bulk actions", () => {
    it("recosts exactly the rows the operator was shown", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry({ source: "claude_code", counts_toward_budget: false })],
        total: 7,
        members: [
          organizationMember({
            user_id: CALLER_IDENTITY,
            attribution_user_id: "me-attr",
          }),
        ],
      })
      renderPage(<ActivityPage />, "/activity?scope=you&q=opus&cost_gt=0.1")

      await user.click(
        await screen.findByRole("button", { name: /Manage 7 imported rows/ }),
      )
      await user.click(
        screen.getByRole("button", { name: "Recost imported rows…" }),
      )
      const dialog = await screen.findByRole("dialog", {
        name: "Recost imported rows",
      })
      await user.type(within(dialog).getByLabelText(/Input/), "1")
      await user.type(within(dialog).getByLabelText(/Output/), "2")
      await user.click(
        within(dialog).getByRole("button", { name: "Recost 7 imported rows" }),
      )

      await waitFor(() => {
        const write = calls.find((call) =>
          call.url.includes("/usage/set-price"),
        )
        expect(JSON.parse(write?.body ?? "{}")).toEqual({
          by_filter: true,
          workspace_id: WORKSPACE_ID,
          start_date: expect.any(String),
          user_id: ["me-attr"],
          q: "opus",
          cost_gt: 0.1,
          input_price_per_million: 1,
          output_price_per_million: 2,
        })
      })
    })

    it("deletes every imported row matching the filters, not just the page", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry({ source: "claude_code", counts_toward_budget: false })],
        total: 58,
      })
      renderPage(
        <ActivityPage />,
        "/activity?exclude_model=gpt-4o&source_label=sess-1",
      )

      await user.click(
        await screen.findByRole("button", { name: /Manage 58 imported rows/ }),
      )
      await user.click(
        screen.getByRole("button", { name: "Delete imported rows…" }),
      )
      const dialog = await screen.findByRole("alertdialog")
      await user.click(
        within(dialog).getByRole("button", { name: "Delete rows" }),
      )

      await waitFor(() => {
        const write = calls.find(
          (call) =>
            call.method === "DELETE" && call.url.endsWith(`${API_ROOT}/usage`),
        )
        expect(JSON.parse(write?.body ?? "{}")).toMatchObject({
          by_filter: true,
          workspace_id: WORKSPACE_ID,
          exclude_model: ["gpt-4o"],
          source_label: "sess-1",
        })
      })
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

    it("shows the workspace's budget to every member, and nothing when it has none", async () => {
      mockApi({
        rows: [entry()],
        viewer: "member",
        spend: {
          workspace_id: WORKSPACE_ID,
          name: "Everything",
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

  describe("live updates", () => {
    it("offers newer rows once paused, and loads them only when asked", async () => {
      const user = userEvent.setup()
      let total = 3
      mockApi({ rows: [entry()], total: () => total, viewer: "member" })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      total = 5
      await user.click(screen.getByRole("button", { name: "Live updates" }))
      expect(
        await screen.findByRole("button", { name: "2 new · load" }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: /Refresh/ }),
      ).toBeInTheDocument()
    })

    it("brings a live window up to now on each tick, rather than re-reading a stale one", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const { calls } = mockApi({ rows: [entry()], viewer: "member" })
        renderPage(<ActivityPage />)
        await rowOf("gpt-4o")
        const first = lastList(calls).get("start_date")

        await vi.advanceTimersByTimeAsync(10_500)
        await waitFor(() =>
          expect(lastList(calls).get("start_date")).not.toBe(first),
        )
        expect(
          Date.parse(lastList(calls).get("start_date") ?? ""),
        ).toBeGreaterThan(Date.parse(first ?? ""))
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([
      ["on a later page", "/activity?page=1"],
      ["with a request open", "/activity?request=req-1"],
      [
        "in a window that has ended",
        "/activity?start_date=2026-01-01T00:00:00Z&end_date=2026-01-02T00:00:00Z",
      ],
    ])("holds still %s", async (_, route) => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const { calls } = mockApi({
          rows: [entry()],
          total: 200,
          viewer: "member",
        })
        renderPage(<ActivityPage />, route)
        await rowOf("gpt-4o")
        const reads = listCalls(calls).length

        await vi.advanceTimersByTimeAsync(21_000)
        expect(listCalls(calls)).toHaveLength(reads)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("reading what it asks for", () => {
    it("says a grouped log with nothing in it is empty, not loading", async () => {
      mockApi({ rows: [], groups: [] })
      renderPage(<ActivityPage />, "/activity?group=model")
      expect(
        await screen.findByText("No requests recorded yet."),
      ).toBeInTheDocument()
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    })

    it("reads nothing under You until it knows which requests are the caller's", async () => {
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
      renderPage(<ActivityPage />, "/activity?scope=you")
      await rowOf("gpt-4o")

      const reads = calls.filter(
        (call) =>
          call.method === "GET" &&
          /\/usage(\?|\/count|\/summary|\/groups)/.test(call.url),
      )
      expect(reads.length).toBeGreaterThan(0)
      for (const read of reads) expect(read.url).toContain("user_id=me-attr")
    })

    it("shows the workspace to a manager whose own requests cannot be told apart", async () => {
      const { calls } = mockApi({ rows: [entry()], viewer: "manager" })
      renderPage(<ActivityPage />, "/activity?scope=you")
      await rowOf("gpt-4o")
      expect(
        screen.queryByRole("radio", { name: "You" }),
      ).not.toBeInTheDocument()
      expect(lastList(calls).get("user_id")).toBeNull()
    })

    it("gives the aggregates a start for All, where the list has none", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?range=all")
      await rowOf("gpt-4o")
      expect(lastList(calls).get("start_date")).toBeNull()
      const summary = calls.find((call) => call.url.includes("/usage/summary"))
      expect(summary?.url).toContain("start_date=")
      // One read for the totals and the chart, which ask the same question.
      expect(summary?.url).toContain("dimensions=none")
    })

    it("reports a failed chart and totals read rather than drawing nothing", async () => {
      mockApi({ rows: [entry()], failing: ["/usage/summary"] })
      renderPage(<ActivityPage />)
      expect(await screen.findByText(/Not available/)).toBeInTheDocument()
    })

    it("drops the in-flight count when its read fails, and keeps the switch", async () => {
      mockApi({ rows: [entry()], failing: ["/usage/in-flight"] })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")
      expect(
        await screen.findByRole("button", { name: "Live updates" }),
      ).toBeInTheDocument()
      expect(screen.queryByText(/in flight/)).not.toBeInTheDocument()
    })

    it("names a member from the roster first, then the alias the row carries", async () => {
      mockApi({
        rows: [
          entry({
            id: "a",
            model: "first",
            user_id: "u-roster",
            user_alias: "alias-a",
          }),
          entry({
            id: "b",
            model: "second",
            user_id: "u-alias",
            user_alias: "Alias B",
          }),
        ],
        viewer: "manager",
        members: [
          organizationMember({
            user_id: "identity-x",
            attribution_user_id: "u-roster",
            full_name: "Roster Name",
          }),
        ],
      })
      renderPage(<ActivityPage />)
      expect(
        within(await rowOf("first")).getByText("Roster Name"),
      ).toBeInTheDocument()
      expect(
        within(await rowOf("second")).getByText("Alias B"),
      ).toBeInTheDocument()
    })
  })

  describe("the keyboard", () => {
    it("steps with j and k, and leaves them to a field being typed in", async () => {
      const user = userEvent.setup()
      mockApi({
        rows: [
          entry({ id: "a", model: "first-model" }),
          entry({ id: "b", model: "second-model" }),
        ],
      })
      renderPage(<ActivityPage />)
      await user.click(await rowOf("first-model"))
      const heading = () =>
        within(
          screen.getByRole("complementary", { name: "Request details" }),
        ).getByRole("heading", { level: 2 })

      await user.keyboard("j")
      await waitFor(() => expect(heading()).toHaveTextContent("second-model"))

      await user.click(screen.getByLabelText("Search requests"))
      await user.keyboard("k")
      expect(heading()).toHaveTextContent("second-model")
    })

    it("leaves a chord to the browser", async () => {
      const user = userEvent.setup()
      mockApi({
        rows: [
          entry({ id: "a", model: "first-model" }),
          entry({ id: "b", model: "second-model" }),
        ],
      })
      renderPage(<ActivityPage />)
      await user.click(await rowOf("first-model"))
      const heading = within(
        screen.getByRole("complementary", { name: "Request details" }),
      ).getByRole("heading", { level: 2 })

      await user.keyboard("{Control>}j{/Control}{Meta>}k{/Meta}")
      expect(heading).toHaveTextContent("first-model")
    })
  })

  describe("switching layouts", () => {
    it("moves between the desk and the phone as the viewport crosses md", async () => {
      const listeners = new Set<() => void>()
      let isPhone = false
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            get matches() {
              return query.includes("max-width: 767px") && isPhone
            },
            media: query,
            addEventListener: (_: string, listener: () => void) =>
              listeners.add(listener),
            removeEventListener: (_: string, listener: () => void) =>
              listeners.delete(listener),
          }) as unknown as MediaQueryList,
      )
      mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />)
      expect(
        await screen.findByRole("table", { name: "Activity log" }),
      ).toBeInTheDocument()

      isPhone = true
      for (const listener of listeners) listener()
      expect(
        await screen.findByRole("button", { name: "Filter and sort" }),
      ).toBeInTheDocument()
      expect(
        screen.queryByRole("table", { name: "Activity log" }),
      ).not.toBeInTheDocument()
    })
  })

  describe("on a phone", () => {
    function asPhone() {
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: query.includes("max-width: 767px"),
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
          }) as MediaQueryList,
      )
    }

    it("lists requests as rows and reads one full screen", async () => {
      const user = userEvent.setup()
      asPhone()
      mockApi({ rows: [entry({ model: "phone-model" })], viewer: "member" })
      renderPage(<ActivityPage />)

      await user.click(
        await screen.findByRole("button", { name: /phone-model/ }),
      )
      expect(
        await screen.findByRole("complementary", { name: "Request details" }),
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Activity" }))
      expect(
        screen.queryByRole("complementary", { name: "Request details" }),
      ).not.toBeInTheDocument()
    })

    it("says it is loading until the first rows arrive", async () => {
      asPhone()
      mockApi({ rows: [entry({ model: "phone-model" })], viewer: "member" })
      renderPage(<ActivityPage />)

      expect(await screen.findByText("Loading…")).toBeInTheDocument()
      expect(
        screen.queryByText("No requests recorded yet."),
      ).not.toBeInTheDocument()
      await screen.findByRole("button", { name: /phone-model/ })
    })

    it("narrows to a bar's stretch of the window when one is picked", async () => {
      const user = userEvent.setup()
      asPhone()
      const { calls } = mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />)
      await screen.findByRole("button", { name: /gpt-4o/ })

      screen.getByRole("slider", { name: "Filter by time" }).focus()
      await user.keyboard("{ArrowRight}")
      await waitFor(() =>
        expect(lastList(calls).get("end_date")).not.toBeNull(),
      )
    })

    it("loads the next batch after the rows it has, rather than all of them again", async () => {
      const user = userEvent.setup()
      asPhone()
      const { calls } = mockApi({
        rows: Array.from({ length: 20 }, (_, index) =>
          entry({ id: `row-${index}`, model: `model-${index}` }),
        ),
        viewer: "member",
      })
      renderPage(<ActivityPage />)
      await screen.findByRole("button", { name: /model-0/ })

      await user.click(screen.getByRole("button", { name: "Load 20 more" }))
      await waitFor(() =>
        expect(
          listCalls(calls).some(
            (url) => url.includes("skip=20") && url.includes("limit=20"),
          ),
        ).toBe(true),
      )
      expect(listCalls(calls).some((url) => url.includes("limit=40"))).toBe(
        false,
      )
    })

    it("sorts and filters from one sheet", async () => {
      const user = userEvent.setup()
      asPhone()
      const { calls } = mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />)
      await screen.findByRole("button", { name: /gpt-4o/ })

      await user.click(screen.getByRole("button", { name: "Filter and sort" }))
      const sheet = await screen.findByRole("dialog", {
        name: "Filter and sort",
      })
      await user.click(
        within(sheet).getByRole("button", { name: "Highest cost" }),
      )
      await listCarries(calls, "sort", "cost")
      await user.click(within(sheet).getByRole("checkbox", { name: "Failed" }))
      await listCarries(calls, "status", "error")
    })
  })

  describe("saved views", () => {
    it("names the view on screen, and applies another from the menu", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry()],
        views: [savedView({ name: "Slow calls", query: "latency_ms_gt=5000" })],
      })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")
      expect(
        screen.getByRole("button", { name: "Saved views: All requests" }),
      ).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: /Saved views/ }))
      await user.click(
        await screen.findByRole("button", { name: "Slow calls" }),
      )
      await listCarries(calls, "latency_ms_gt", "5000")
      expect(
        screen.getByRole("button", { name: "Saved views: Slow calls" }),
      ).toBeInTheDocument()
    })

    it("marks the view changed once a filter is added, and deletes a saved one", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()], views: [savedView()] })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Cost" }))
      // Not the $0.40 threshold, which is the built-in "Expensive calls".
      await user.click(screen.getByRole("button", { name: "> $0.10" }))
      expect(
        await screen.findByRole("button", {
          name: "Saved views: All requests, changed since saved",
        }),
      ).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: /Saved views/ }))
      await user.click(
        screen.getByRole("button", { name: "Delete Slow calls" }),
      )
      await waitFor(() =>
        expect(
          calls.some(
            (call) =>
              call.method === "DELETE" &&
              call.url.endsWith(
                `/workspaces/${WORKSPACE_ID}/saved-views/view-1`,
              ),
          ),
        ).toBe(true),
      )
    })

    it("saves the current view to the workspace", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?range=7d&status=error")
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: /Saved views/ }))
      await user.click(
        screen.getByRole("button", { name: "Save current view…" }),
      )
      await user.type(screen.getByLabelText("View name"), "Weekly failures")
      await user.click(screen.getByRole("button", { name: "Save" }))

      await waitFor(() => {
        const write = calls.find(
          (call) => call.url.includes("/saved-views") && call.method === "POST",
        )
        expect(write?.url).toContain(`/workspaces/${WORKSPACE_ID}/saved-views`)
        expect(JSON.parse(write?.body ?? "{}")).toEqual({
          page: "activity",
          name: "Weekly failures",
          query: "range=7d&status=error",
          shared: false,
        })
      })
    })
  })
})
