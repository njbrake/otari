import { useLocation } from "@tanstack/react-router"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import {
  countCalls,
  entry,
  listCalls,
  mockApi,
  renderPage,
} from "@/tests/activity"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function UrlProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search in the URL">{searchStr}</output>
}

const urlParams = () =>
  new URLSearchParams(document.querySelector("output")?.textContent ?? "")

const params = (url: string | undefined) =>
  new URL(url ?? "", "http://localhost").searchParams

const liveControl = () => screen.findByRole("button", { name: "Live updates" })

async function renderRequests(search = "") {
  renderPage(
    <>
      <ActivityPage embedded />
      <UrlProbe />
    </>,
    `/requests${search}`,
  )
  await screen.findAllByText("gpt-4o")
}

describe("ActivityPage live mode", () => {
  it("is on by default and brings the rows and the count up every ten seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests()
    expect(await liveControl()).toHaveAttribute("aria-pressed", "true")
    expect(await liveControl()).toHaveTextContent("Live")
    const lists = listCalls(calls).length
    const counts = countCalls(calls).length

    await vi.advanceTimersByTimeAsync(10_500)
    await waitFor(() => expect(listCalls(calls).length).toBeGreaterThan(lists))
    expect(countCalls(calls).length).toBeGreaterThan(counts)
    // No badge offering rows the log already brings in.
    expect(screen.queryByRole("button", { name: /new · load/ })).toBeNull()
  })

  it("brings the window and the totals up to now every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests()
    const totals = () =>
      calls.filter(
        (call) =>
          call.url.includes("/usage/summary") &&
          call.url.includes("include_p95=true"),
      )
    await waitFor(() => expect(totals().length).toBe(1))
    const firstStart = params(totals()[0].url).get("start_date")

    await vi.advanceTimersByTimeAsync(61_000)
    await waitFor(() => expect(totals().length).toBeGreaterThan(1))
    const laterStart = params(totals().at(-1)?.url).get("start_date")
    expect(laterStart && firstStart && laterStart > firstStart).toBe(true)
  })

  it("holds still on a later page, says why, and goes back to the newest when pressed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { calls } = mockApi({ rows: [entry()], total: 500 })
    await renderRequests("?page=2")
    const control = await liveControl()
    expect(control).toHaveAttribute("aria-pressed", "false")
    expect(control).toHaveTextContent("Paused")
    expect(control).toHaveAccessibleDescription(/later page/)
    const lists = listCalls(calls).length

    await vi.advanceTimersByTimeAsync(25_000)
    expect(listCalls(calls).length).toBe(lists)

    await user.click(control)
    await waitFor(() => expect(urlParams().has("page")).toBe(false))
    await waitFor(() => expect(control).toHaveAttribute("aria-pressed", "true"))
  })

  it("holds still while a request is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests()
    const row = (await screen.findAllByText("gpt-4o"))[0].closest("tr")!
    await user.click(row)
    await waitFor(() => expect(urlParams().get("request")).toBe("req-1"))
    expect(await liveControl()).toHaveAttribute("aria-pressed", "false")
    const lists = listCalls(calls).length

    await vi.advanceTimersByTimeAsync(25_000)
    expect(listCalls(calls).length).toBe(lists)
  })

  it("holds still under a column sort, and resumes newest first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests("?sort=cost&order=desc")
    const control = await liveControl()
    expect(control).toHaveAttribute("aria-pressed", "false")
    expect(control).toHaveAccessibleDescription(/sorted by a column/)
    const lists = listCalls(calls).length
    await vi.advanceTimersByTimeAsync(25_000)
    expect(listCalls(calls).length).toBe(lists)

    await user.click(control)
    await waitFor(() => expect(urlParams().has("sort")).toBe(false))
    expect(urlParams().has("order")).toBe(false)
    await waitFor(() => expect(control).toHaveAttribute("aria-pressed", "true"))
  })

  it("cannot follow a window that has ended", async () => {
    mockApi({ rows: [entry()] })
    await renderRequests(
      "?start_date=2026-01-01T00:00:00Z&end_date=2026-01-02T00:00:00Z",
    )
    const control = await liveControl()
    expect(control).toHaveAttribute("aria-pressed", "false")
    expect(control).toBeDisabled()
  })

  it("pauses and resumes from the control, with the badge back while paused", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderRequests()
    const control = await liveControl()

    await user.click(control)
    expect(control).toHaveAttribute("aria-pressed", "false")
    expect(control).toHaveTextContent("Paused")
    await user.click(control)
    expect(control).toHaveAttribute("aria-pressed", "true")
  })
})

describe("ActivityPage totals", () => {
  it("reads the totals over the filters with their p95, recovered attempts included", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests("?model=gpt-4o&channel=api")
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("include_p95=true"))).toBe(
        true,
      ),
    )
    const read = params(
      calls.find((call) => call.url.includes("include_p95=true"))?.url,
    )
    expect(read.get("model")).toBe("gpt-4o")
    expect(read.get("channel")).toBe("api")
    expect(read.has("include_absorbed")).toBe(false)
    // The list, by contrast, lists each request once.
    expect(params(listCalls(calls).at(-1)).get("include_absorbed")).toBe(
      "false",
    )
    expect(
      await screen.findByRole("region", { name: "Totals" }),
    ).toHaveTextContent("requests")
  })
})

describe("ActivityPage totals under All", () => {
  it("reads the year the chart spans rather than the summary's 30 days", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests("?range=all")
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("include_p95=true"))).toBe(
        true,
      ),
    )
    const start = params(
      calls.find((call) => call.url.includes("include_p95=true"))?.url,
    ).get("start_date")
    const days = (Date.now() - Date.parse(start ?? "")) / 86_400_000
    expect(days).toBeGreaterThan(360)
    // The list itself stays all-time.
    expect(params(listCalls(calls).at(-1)).has("start_date")).toBe(false)
  })
})

describe("ActivityPage cell filters", () => {
  it("filters to a cell's value or leaves it out, writing the column funnel's keys", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry({ policy_name: "fast" })] })
    await renderRequests("?page=1")

    await user.click(
      screen.getByRole("button", { name: "Only or exclude gpt-4o" }),
    )
    await user.click(
      await screen.findByRole("menuitem", { name: "Only gpt-4o" }),
    )
    await waitFor(() => expect(urlParams().getAll("model")).toEqual(["gpt-4o"]))
    expect(urlParams().has("page")).toBe(false)
    // Shown in the chip row, as a funnel's would be.
    expect(
      screen.getByRole("button", { name: "Remove Model filter gpt-4o" }),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole("button", { name: "Only or exclude fast" }),
    )
    await user.click(
      await screen.findByRole("menuitem", { name: "Exclude fast" }),
    )
    await waitFor(() =>
      expect(urlParams().getAll("exclude_policy_name")).toEqual(["fast"]),
    )
  })

  it("offers an empty cell only its rows, with nothing to leave out", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry({ api_key_id: null })] })
    await renderRequests()

    await user.click(
      screen.getByRole("button", { name: "Only or exclude No API key" }),
    )
    expect(
      await screen.findByRole("menuitem", { name: "Only No API key" }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("menuitem", { name: "Exclude No API key" }),
    ).toBeNull()
    await user.click(screen.getByRole("menuitem", { name: "Only No API key" }))
    await waitFor(() =>
      expect(urlParams().getAll("is_null")).toEqual(["api_key"]),
    )
  })

  it("takes no Tab stop per cell, and opens from the focused cell on Shift+F10 or the context-menu key", async () => {
    mockApi({ rows: [entry()] })
    await renderRequests()
    const trigger = screen.getByRole("button", {
      name: "Only or exclude gpt-4o",
    })
    expect(trigger).toHaveAttribute("tabindex", "-1")
    const cell = trigger.closest(
      '[role="gridcell"], [role="rowheader"]',
    ) as HTMLElement
    expect(cell).toHaveAttribute("aria-keyshortcuts", "Shift+F10 ContextMenu")

    cell.focus()
    fireEvent.keyDown(cell, { key: "F10", shiftKey: true })
    expect(
      await screen.findByRole("menuitem", { name: "Only gpt-4o" }),
    ).toBeInTheDocument()
    await userEvent.setup().keyboard("{Escape}")
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: "Only gpt-4o" }),
      ).toBeNull(),
    )
    fireEvent.keyDown(cell, { key: "ContextMenu" })
    expect(
      await screen.findByRole("menuitem", { name: "Exclude gpt-4o" }),
    ).toBeInTheDocument()
    expect(urlParams().has("request")).toBe(false)
  })

  it("does not open the request when the cell's filter is pressed", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderRequests()
    await user.click(
      screen.getByRole("button", { name: "Only or exclude gpt-4o" }),
    )
    expect(urlParams().has("request")).toBe(false)
  })

  it("filters to the tools a row ran when its tool marker is pressed", async () => {
    const user = userEvent.setup()
    mockApi({
      rows: [
        entry({
          billing_meters: { tools: { web_search: { billed: 2, errors: 0 } } },
        }),
      ],
    })
    await renderRequests()
    await user.click(screen.getByRole("button", { name: /^Gateway tools/ }))
    await waitFor(() => expect(urlParams().get("tool")).toBe("web_search"))
    expect(urlParams().has("request")).toBe(false)
  })
})

describe("ActivityPage recovered attempts", () => {
  it("lists a request's recovered attempts under it once they are shown", async () => {
    const served = entry({
      id: "served",
      request_group_id: "g1",
      attempt_position: 2,
      policy_name: "fast",
    })
    const attempt = entry({
      id: "attempt",
      model: "claude-x",
      status: "absorbed",
      request_group_id: "g1",
      attempt_position: 1,
      policy_name: "fast",
    })
    const { calls } = mockApi({ rows: [served], groupRows: [attempt, served] })
    await renderRequests("?recovered=show")

    const row = (await screen.findAllByText("claude-x"))
      .map((cell) => cell.closest("tr"))
      .find(Boolean) as HTMLElement
    expect(row).toHaveClass("is-nested")
    const body = row.closest("tbody") as HTMLElement
    const order = within(body)
      .getAllByRole("row")
      .map((one) => one.getAttribute("data-key"))
    expect(order).toEqual(["served", "attempt"])
    expect(calls.some((call) => call.url.includes("request_group_id=g1"))).toBe(
      true,
    )
    expect(
      screen.getByRole("button", { name: "Remove Recovered attempts filter" }),
    ).toBeInTheDocument()
  })
})
