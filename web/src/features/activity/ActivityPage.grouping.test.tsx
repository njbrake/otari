import { useLocation } from "@tanstack/react-router"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import { entry, type FetchCall, mockApi, renderPage } from "@/tests/activity"

afterEach(() => {
  vi.restoreAllMocks()
})

function UrlProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search in the URL">{searchStr}</output>
}

const urlParams = () =>
  new URLSearchParams(document.querySelector("output")?.textContent ?? "")

const paramsOf = (url: string) => new URL(url, "http://localhost").searchParams

const groupedCalls = (calls: FetchCall[]) =>
  calls.filter((call) => call.url.includes("/usage/grouped"))

// The list reads that are neither the groups nor a request group lookup.
const rowCalls = (calls: FetchCall[]) =>
  calls.filter(
    (call) =>
      call.method === "GET" &&
      /\/usage\?/.test(call.url) &&
      !paramsOf(call.url).has("request_group_id"),
  )

const ROWS = [
  ...Array.from({ length: 10 }, (_, index) =>
    entry({
      id: `laptop-${index}`,
      api_key_id: "key-1",
      api_key_name: "laptop",
      timestamp: new Date(Date.now() - index * 60_000).toISOString(),
      status: index === 0 ? "error" : "success",
    }),
  ),
  entry({
    id: "ci-0",
    api_key_id: "key-2",
    api_key_name: "ci",
    model: "claude",
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
  }),
]

function renderRequests(search = "") {
  renderPage(
    <>
      <ActivityPage embedded />
      <UrlProbe />
    </>,
    `/requests${search}`,
  )
}

describe("grouping the request log", () => {
  it("lists a row per group, read from the grouped endpoint, instead of the table", async () => {
    const { calls } = mockApi({ rows: ROWS })
    renderRequests("?group=api_key")

    const laptop = await screen.findByRole("button", { name: /laptop/ })
    expect(laptop).toHaveAttribute("aria-expanded", "false")
    expect(laptop).toHaveTextContent("10 requests")
    expect(laptop).toHaveTextContent("1 failed")
    expect(screen.getByRole("button", { name: /^ci/ })).toHaveTextContent(
      "1 request",
    )
    // The group header is a heading's one control, with nothing interactive inside.
    expect(laptop.closest("h3")).not.toBeNull()
    expect(within(laptop).queryAllByRole("button")).toHaveLength(0)
    expect(screen.queryByRole("grid", { name: "Activity log" })).toBeNull()
    expect(
      paramsOf(groupedCalls(calls).at(-1)?.url ?? "").get("group_by"),
    ).toBe("api_key")
    // The flat page is not read while grouped.
    expect(rowCalls(calls)).toHaveLength(0)
  })

  it("opens a group to its newest rows, read for that group alone", async () => {
    const { calls } = mockApi({ rows: ROWS })
    renderRequests("?group=api_key")
    const user = userEvent.setup()

    await user.click(await screen.findByRole("button", { name: /laptop/ }))
    expect(
      screen.getByRole("button", { name: /10 requests/, expanded: true }),
    ).toBeInTheDocument()
    await screen.findByRole("grid", { name: "Newest requests, laptop" })
    const preview = rowCalls(calls).at(-1)?.url ?? ""
    expect(paramsOf(preview).getAll("api_key_id")).toEqual(["key-1"])
    expect(paramsOf(preview).get("limit")).toBe("8")

    // More than the preview holds: the group offers itself as a filter.
    await user.click(screen.getByRole("button", { name: "Show all 10" }))
    await waitFor(() => expect(urlParams().has("group")).toBe(false))
    expect(urlParams().getAll("api_key_id")).toEqual(["key-1"])
  })

  it("says in the control that a column sort pauses the grouping, and resumes it when a grouping is picked", async () => {
    const { calls } = mockApi({ rows: ROWS })
    renderRequests("?group=model&sort=cost&order=desc")
    const user = userEvent.setup()

    const control = await screen.findByRole("button", { name: /Group by/ })
    expect(control).toHaveTextContent("By model, paused by sort")
    await screen.findByRole("grid", { name: "Activity log" })
    expect(groupedCalls(calls)).toHaveLength(0)

    await user.click(control)
    await user.click(await screen.findByRole("option", { name: "By API key" }))
    await waitFor(() => expect(urlParams().get("group")).toBe("api_key"))
    expect(urlParams().has("sort")).toBe(false)
    await screen.findByRole("button", { name: /laptop/ })
  })

  it("keeps the grouping in the URL, where a saved view can carry it", async () => {
    mockApi({ rows: ROWS })
    renderRequests()
    const user = userEvent.setup()

    await user.click(await screen.findByRole("button", { name: /Group by/ }))
    await user.click(await screen.findByRole("option", { name: "By session" }))
    await waitFor(() => expect(urlParams().get("group")).toBe("source_label"))
    await screen.findByRole("button", { name: /No session/ })
  })
})

describe("the request log on a phone", () => {
  const realMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  const asPhone = () => {
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
  }

  it("lists three-line rows and loads more onto the end rather than paging", async () => {
    asPhone()
    const rows = Array.from({ length: 20 }, (_, index) =>
      entry({ id: `r-${index}`, api_key_name: "laptop" }),
    )
    const { calls } = mockApi({ rows, total: 45 })
    renderRequests()
    const user = userEvent.setup()

    const list = await screen.findByRole("list", { name: "Activity log" })
    const first = within(list).getAllByRole("button")[0]
    expect(first).toHaveTextContent("gpt-4o")
    expect(first).toHaveTextContent("alice")
    expect(paramsOf(rowCalls(calls).at(-1)?.url ?? "").get("limit")).toBe("20")
    expect(screen.queryByRole("navigation", { name: /pagination/i })).toBeNull()

    await user.click(
      await screen.findByRole("button", { name: "Load 20 more" }),
    )
    await waitFor(() =>
      expect(paramsOf(rowCalls(calls).at(-1)?.url ?? "").get("limit")).toBe(
        "40",
      ),
    )
    expect(paramsOf(rowCalls(calls).at(-1)?.url ?? "").get("skip")).toBe("0")
  })

  it("lists flat on a phone whatever grouping the link carries", async () => {
    asPhone()
    const { calls } = mockApi({ rows: ROWS })
    renderRequests("?group=api_key")
    await screen.findByRole("list", { name: "Activity log" })
    expect(groupedCalls(calls)).toHaveLength(0)
    expect(screen.queryByRole("button", { name: /Group by/ })).toBeNull()
  })
})
