import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import {
  entry,
  group,
  lastList,
  listCarries,
  mockApi,
  renderPage,
  rowOf,
  savedView,
  WORKSPACE_ID,
} from "@/tests/activity"

// What narrows and orders the log, and the views that name a set of those.

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ActivityPage", () => {
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
      // Recovered is among them, so its rows are asked for.
      expect(lastList(calls).get("include_absorbed")).toBe("true")
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
      await user.click(screen.getByRole("menuitem", { name: "Exclude gpt-4o" }))
      await waitFor(() =>
        expect(lastList(calls).getAll("exclude_model")).toEqual(["gpt-4o"]),
      )
      expect(
        screen.getByRole("button", { name: "Remove Model is not gpt-4o" }),
      ).toBeInTheDocument()
    })

    it("excludes a value from its column's menu, which the keyboard reaches", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({
        rows: [entry()],
        groups: (groupBy) =>
          groupBy === "model"
            ? [group({ key: "claude-haiku-4-5", label: null, requests: 30 })]
            : [],
      })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Model" }))
      await user.click(
        await screen.findByRole("button", {
          name: "Exclude claude-haiku-4-5",
        }),
      )
      await waitFor(() =>
        expect(lastList(calls).getAll("exclude_model")).toEqual([
          "claude-haiku-4-5",
        ]),
      )
    })

    it("shows only rows above a threshold picked from a numeric column", async () => {
      const user = userEvent.setup()
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />)
      await rowOf("gpt-4o")

      await user.click(screen.getByRole("button", { name: "Filter Cost" }))
      await user.click(screen.getByRole("menuitemradio", { name: "> $0.40" }))
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

    it("gives a substring search a start under All, and an id lookup none", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?range=all&q=opus")
      await rowOf("gpt-4o")
      expect(lastList(calls).get("start_date")).not.toBeNull()
      expect(
        calls.find((call) => call.url.includes("/usage/count"))?.url,
      ).toContain("start_date=")
    })

    it("looks an id up over all time", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(
        <ActivityPage />,
        "/activity?range=all&q=0b6e3c1a-55f1-4a3e-9f6e-0c2d9a1b7e44",
      )
      await rowOf("gpt-4o")
      expect(lastList(calls).get("start_date")).toBeNull()
    })

    it("counts in the order the list was read in", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?sort=cost&order=asc")
      await rowOf("gpt-4o")
      await waitFor(() =>
        expect(
          calls.some(
            (call) =>
              call.url.includes("/usage/count") &&
              call.url.includes("sort=cost") &&
              !call.url.includes("counts_toward_budget"),
          ),
        ).toBe(true),
      )
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

    it("rewrites a custom range with no bounds to the default", async () => {
      mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />, "/activity?range=custom")
      await rowOf("gpt-4o")
      await waitFor(() =>
        expect(screen.getByRole("radio", { name: "24h" })).toBeChecked(),
      )
    })

    it("bars a custom range at a grain its year-long frame allows", async () => {
      const { calls } = mockApi({ rows: [entry()] })
      renderPage(
        <ActivityPage />,
        "/activity?range=custom&start_date=2026-09-01T00:00:00Z&end_date=2026-09-02T00:00:00Z",
      )
      await rowOf("gpt-4o")
      const buckets = calls
        .filter((call) => call.url.includes("/usage/summary"))
        .map((call) => new URL(call.url, "http://localhost").searchParams)
        .map((params) => params.get("bucket"))
      expect(buckets.length).toBeGreaterThan(0)
      expect(buckets).not.toContain("5min")
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
        await screen.findByRole("menuitemradio", { name: "Slow calls" }),
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
      await user.click(screen.getByRole("menuitemradio", { name: "> $0.10" }))
      expect(
        await screen.findByRole("button", {
          name: "Saved views: All requests, changed since saved",
        }),
      ).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: /Saved views/ }))
      await user.click(screen.getByRole("menuitem", { name: "Delete a view" }))
      await user.click(
        within(screen.getByRole("menu", { name: "Delete a view" })).getByRole(
          "menuitem",
          { name: "Slow calls" },
        ),
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
        screen.getByRole("menuitem", { name: "Save current view…" }),
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
