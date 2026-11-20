import { useLocation } from "@tanstack/react-router"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import { ObserveFilterRow } from "@/features/observe/ObserveFilterRow"
import {
  countCalls,
  entry,
  listCalls,
  mockApi,
  renderPage,
} from "@/tests/activity"

afterEach(() => {
  vi.restoreAllMocks()
})

function UrlProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search in the URL">{searchStr}</output>
}

const urlParams = () =>
  new URLSearchParams(document.querySelector("output")?.textContent ?? "")

const lastParams = (urls: string[]) =>
  new URL(urls.at(-1) ?? "", "http://localhost").searchParams

async function renderRequests(search = "") {
  renderPage(
    <>
      <ObserveFilterRow view="requests" />
      <ActivityPage embedded />
      <UrlProbe />
    </>,
    `/requests${search}`,
  )
  await screen.findAllByText("gpt-4o")
}

const header = (name: string) =>
  screen
    .getAllByRole("columnheader")
    .find((cell) => cell.textContent?.startsWith(name)) as HTMLElement

describe("ActivityPage sorting", () => {
  it("cycles a header through its first order, the reverse and back, reading the order from the server", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests()
    const user = userEvent.setup()

    // Newest first is the default, marked on Time and left off the wire.
    expect(header("Time")).toHaveAttribute("aria-sort", "descending")
    expect(lastParams(listCalls(calls)).has("sort")).toBe(false)

    // The funnel beside the label keeps its own press, so the label is a
    // button of its own.
    const sortCost = () =>
      within(header("Cost")).getByRole("button", { name: "Cost" })
    await user.click(sortCost())
    await waitFor(() => expect(urlParams().get("sort")).toBe("cost"))
    expect(urlParams().get("order")).toBe("desc")
    await waitFor(() =>
      expect(lastParams(listCalls(calls)).get("sort")).toBe("cost"),
    )
    expect(lastParams(listCalls(calls)).get("order")).toBe("desc")
    // The count is read over the same window as the sorted list.
    await waitFor(() =>
      expect(lastParams(countCalls(calls)).get("sort")).toBe("cost"),
    )
    expect(header("Cost")).toHaveAttribute("aria-sort", "descending")

    await user.click(sortCost())
    await waitFor(() => expect(urlParams().get("order")).toBe("asc"))
    expect(header("Cost")).toHaveAttribute("aria-sort", "ascending")

    await user.click(sortCost())
    await waitFor(() => expect(urlParams().has("sort")).toBe(false))
    expect(urlParams().has("order")).toBe(false)
    expect(header("Time")).toHaveAttribute("aria-sort", "descending")
  })

  it("returns to the first page when the order changes", async () => {
    mockApi({ rows: [entry()], total: 500 })
    await renderRequests("?page=3")
    const user = userEvent.setup()

    await user.click(
      within(header("Model")).getByRole("button", { name: "Model" }),
    )
    await waitFor(() => expect(urlParams().get("sort")).toBe("model"))
    expect(urlParams().has("page")).toBe(false)
  })

  it("opens on the order a link carries", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests("?sort=latency&order=asc")

    expect(header("Total time")).toHaveAttribute("aria-sort", "ascending")
    const params = lastParams(listCalls(calls))
    expect(params.get("sort")).toBe("latency")
    expect(params.get("order")).toBe("asc")
  })
})

describe("ActivityPage search", () => {
  it("commits a term once typing settles and reads every view through it", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests()
    const user = userEvent.setup()

    await user.type(
      screen.getByRole("searchbox", { name: "Search requests" }),
      "claude",
    )
    await waitFor(() => expect(urlParams().get("q")).toBe("claude"))
    await waitFor(() =>
      expect(lastParams(listCalls(calls)).get("q")).toBe("claude"),
    )
    // One committed term, not one per keystroke.
    expect(
      listCalls(calls).filter(
        (url) => url.includes("q=c&") || url.endsWith("q=c"),
      ),
    ).toEqual([])
    await waitFor(() =>
      expect(lastParams(countCalls(calls)).get("q")).toBe("claude"),
    )
    expect(
      calls.some(
        (call) =>
          call.url.includes("/usage/summary") && call.url.includes("q=claude"),
      ),
    ).toBe(true)
  })

  it("follows the URL when Clear all clears it with the chips", async () => {
    mockApi({ rows: [entry()] })
    await renderRequests("?q=gpt&model=gpt-4o")
    const user = userEvent.setup()
    const box = screen.getByRole("searchbox", { name: "Search requests" })
    expect(box).toHaveValue("gpt")

    await user.click(screen.getByRole("button", { name: "Clear all" }))
    await waitFor(() => expect(urlParams().has("q")).toBe(false))
    expect(box).toHaveValue("")
  })

  it("says the empty result is the search's", async () => {
    mockApi({ rows: [] })
    renderPage(
      <>
        <ObserveFilterRow view="requests" />
        <ActivityPage embedded />
      </>,
      "/requests?q=nothing-matches",
    )
    expect(
      await screen.findByText("No requests match these filters."),
    ).toBeInTheDocument()
  })
})

describe("ActivityPage bounded reads under All", () => {
  it("reads the year the chart spans for a sort or a search, and all time otherwise", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests("?range=all&sort=cost&order=desc")
    const daysBack = (urls: string[]) =>
      (Date.now() - Date.parse(lastParams(urls).get("start_date") ?? "")) /
      86_400_000
    await waitFor(() => expect(daysBack(listCalls(calls))).toBeGreaterThan(360))
    expect(daysBack(countCalls(calls))).toBeGreaterThan(360)
  })

  it("leaves newest first and an id search unbounded", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderRequests("?range=all&q=3f2504e0-4f89-11d3-9a0c-0305e82c3301")
    await waitFor(() => expect(listCalls(calls).length).toBeGreaterThan(0))
    expect(lastParams(listCalls(calls)).has("start_date")).toBe(false)
  })
})
