import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import { API_ROOT } from "@/shared/api/client"
import {
  CALLER_IDENTITY,
  entry,
  lastList,
  listCalls,
  mockApi,
  renderPage,
  rowOf,
  WORKSPACE_ID,
} from "@/tests/activity"
import { organizationMember } from "@/tests/fixtures"

// What the page reads and writes as the window moves: the requests it sends, live updates, and the operator's bulk actions.

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ActivityPage", () => {
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
        screen.getByRole("menuitem", { name: "Recost imported rows…" }),
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
          end_date: expect.any(String),
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
        screen.getByRole("menuitem", { name: "Delete imported rows…" }),
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

  describe("the operator's bulk actions, as live mode moves on", () => {
    it("deletes over the window the dialog's count was taken over", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const user = userEvent.setup({
          advanceTimers: vi.advanceTimersByTime,
        })
        const { calls } = mockApi({
          rows: [entry({ source: "claude_code", counts_toward_budget: false })],
          total: 4,
        })
        renderPage(<ActivityPage />)

        await user.click(
          await screen.findByRole("button", { name: /Manage 4 imported rows/ }),
        )
        await user.click(
          screen.getByRole("menuitem", { name: "Delete imported rows…" }),
        )
        const dialog = await screen.findByRole("alertdialog")
        const counted = new URL(
          calls.findLast(
            (call) =>
              call.url.includes("/usage/count") &&
              call.url.includes("counts_toward_budget=false"),
          )?.url ?? "",
          "http://localhost",
        ).searchParams
        // Closed at the moment the window was taken, not open-ended.
        expect(counted.get("end_date")).not.toBeNull()

        // A live tick moves the window on while the dialog is open.
        await vi.advanceTimersByTimeAsync(10_500)
        await user.click(
          within(dialog).getByRole("button", { name: "Delete rows" }),
        )
        await waitFor(() => {
          const write = calls.find(
            (call) =>
              call.method === "DELETE" &&
              call.url.endsWith(`${API_ROOT}/usage`),
          )
          expect(JSON.parse(write?.body ?? "{}")).toMatchObject({
            start_date: counted.get("start_date"),
            end_date: counted.get("end_date"),
          })
        })
      } finally {
        vi.useRealTimers()
      }
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

    it("brings a paused window up to now on refresh", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const user = userEvent.setup({
          advanceTimers: vi.advanceTimersByTime,
        })
        const { calls } = mockApi({ rows: [entry()], viewer: "member" })
        renderPage(<ActivityPage />)
        await rowOf("gpt-4o")
        await user.click(screen.getByRole("button", { name: "Live updates" }))
        const first = lastList(calls).get("start_date")

        await vi.advanceTimersByTimeAsync(60_000)
        expect(lastList(calls).get("start_date")).toBe(first)
        await user.click(screen.getByRole("button", { name: /Refresh/ }))
        await waitFor(() =>
          expect(
            Date.parse(lastList(calls).get("start_date") ?? ""),
          ).toBeGreaterThanOrEqual(Date.parse(first ?? "") + 60_000),
        )
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
      const summaries = calls.filter((call) =>
        call.url.includes("/usage/summary"),
      )
      expect(summaries.every((call) => call.url.includes("include_p95"))).toBe(
        true,
      )
    })

    it("reports a failed chart and totals read rather than drawing nothing", async () => {
      mockApi({ rows: [entry()], failing: ["/usage/summary"] })
      renderPage(<ActivityPage />)
      expect(await screen.findByText(/Not available/)).toBeInTheDocument()
    })

    it("says the in-flight read failed inside the live control, and keeps the switch", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const user = userEvent.setup({
          advanceTimers: vi.advanceTimersByTime,
        })
        mockApi({ rows: [entry()], failing: ["/usage/in-flight"] })
        renderPage(<ActivityPage />)
        await rowOf("gpt-4o")
        // Past the read's retries, which back off over about seven seconds.
        await vi.advanceTimersByTimeAsync(8_000)
        await user.click(
          await screen.findByRole("button", {
            name: "Live, in-flight count unavailable",
          }),
        )
        expect(
          screen.getByText("The requests in flight could not be loaded."),
        ).toBeInTheDocument()
        expect(
          screen.getByRole("switch", { name: "Live updates" }),
        ).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
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
})
