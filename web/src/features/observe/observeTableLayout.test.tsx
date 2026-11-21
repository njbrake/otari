import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import { SessionsPage } from "@/features/traces/SessionsPage"
import { entry, mockApi, renderPage } from "@/tests/activity"
import { traceSummary } from "@/tests/traceFixtures"

afterEach(() => {
  vi.restoreAllMocks()
})

const PREFERENCE = /\/me\/preferences\/table%3Arequests$/

function renderRequests(
  preferences: Record<string, unknown> = {},
  search = "",
) {
  const api = mockApi({ rows: [entry()], preferences })
  renderPage(
    <>
      <ActivityPage embedded />
    </>,
    `/requests${search}`,
  )
  return api
}

const grid = () => screen.findByRole("grid", { name: "Activity log" })
// A resizable header is named by its label and then its handle's.
const header = (table: HTMLElement, label: string) =>
  within(table).queryByRole("columnheader", {
    name: new RegExp(`^${label}( |$)`),
  })

const preferenceWrites = (calls: ReturnType<typeof mockApi>["calls"]) =>
  calls.filter((call) => PREFERENCE.test(call.url) && call.method !== "GET")

describe("the Requests table's layout", () => {
  it("draws the person's stored layout: their widths, without the columns they hid", async () => {
    renderRequests({
      "table:requests": {
        version: 1,
        widths: { cost: 150 },
        hidden: ["routing"],
      },
    })
    const table = await grid()
    await waitFor(() => expect(header(table, "Routing")).toBeNull())
    expect(header(table, "Model")).toBeInTheDocument()
    // The width is the layout fact itself, written on the header.
    expect(header(table, "Cost")).toHaveStyle({ width: "150px" })
  })

  it("keeps a filter on a hidden column in the chip row, removable", async () => {
    const user = userEvent.setup()
    renderRequests(
      { "table:requests": { version: 1, widths: {}, hidden: ["routing"] } },
      "?policy_name=cheap-first",
    )
    const table = await grid()
    await waitFor(() => expect(header(table, "Routing")).toBeNull())
    const remove = screen.getByRole("button", {
      name: "Remove Routing filter cheap-first",
    })
    await user.click(remove)
    expect(
      screen.queryByRole("button", {
        name: "Remove Routing filter cheap-first",
      }),
    ).toBeNull()
  })

  it("hides a column from the Columns control, and saves the layout once", async () => {
    const user = userEvent.setup()
    const { calls } = renderRequests()
    const table = await grid()
    expect(header(table, "API key")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Columns" }))
    const picker = await screen.findByRole("dialog", { name: "Columns" })
    // The request's identity is always shown.
    expect(
      within(picker).getByRole("checkbox", { name: "Model" }),
    ).toBeDisabled()
    await user.click(within(picker).getByRole("checkbox", { name: "API key" }))
    // An open popover hides the page from the accessibility tree.
    await user.keyboard("{Escape}")

    await waitFor(() => expect(header(table, "API key")).toBeNull())
    expect(header(table, "Model")).toBeInTheDocument()
    await waitFor(() => expect(preferenceWrites(calls)).toHaveLength(1))
    const [write] = preferenceWrites(calls)
    expect(write.method).toBe("PUT")
    expect(JSON.parse(write.body ?? "")).toEqual({
      value: { version: 1, widths: {}, hidden: ["api_key"] },
    })
  })

  it("resets to the default columns and widths, and forgets the stored layout", async () => {
    const user = userEvent.setup()
    const { calls } = renderRequests({
      "table:requests": {
        version: 1,
        widths: { cost: 150 },
        hidden: ["routing", "status"],
      },
    })
    const table = await grid()
    await waitFor(() => expect(header(table, "Routing")).toBeNull())

    await user.click(screen.getByRole("button", { name: "Columns, 2 hidden" }))
    // The reset closes the panel.
    await user.click(screen.getByRole("button", { name: "Reset columns" }))

    await waitFor(() => expect(header(table, "Routing")).toBeInTheDocument())
    expect(header(table, "Status")).toBeInTheDocument()
    expect(header(table, "Cost")).toHaveStyle({ width: "100px" })
    await waitFor(() =>
      expect(preferenceWrites(calls).map((call) => call.method)).toEqual([
        "DELETE",
      ]),
    )
  })

  it("ignores what it cannot use in a stored layout", async () => {
    renderRequests({
      "table:requests": {
        version: 1,
        // Model may not be hidden, and the others are not columns.
        hidden: ["model", "gone", 4],
        widths: { cost: "wide", time: 1, gone: 300 },
      },
    })
    const table = await grid()
    await waitFor(() =>
      // Held to its narrowest, 64px, rather than to the 1px stored.
      expect(header(table, "Time")).toHaveStyle({ width: "64px" }),
    )
    expect(header(table, "Model")).toBeInTheDocument()
    expect(header(table, "Cost")).toHaveStyle({ width: "100px" })
  })

  it("keeps the defaults when the layout cannot be read", async () => {
    const { mock } = renderRequests()
    const answer = mock.getMockImplementation() as typeof fetch
    mock.mockImplementation(async (input, init) =>
      PREFERENCE.test(String(input))
        ? new Response(JSON.stringify({ detail: "down" }), { status: 500 })
        : answer(input, init),
    )
    const table = await grid()
    expect(header(table, "Routing")).toBeInTheDocument()
    expect(header(table, "Cost")).toHaveStyle({ width: "100px" })
  })
})

describe("the Sessions table's layout", () => {
  it("is kept under its own key", async () => {
    mockApi({
      traces: [traceSummary()],
      preferences: {
        "table:sessions": { version: 1, widths: {}, hidden: ["tags"] },
        "table:requests": { version: 1, widths: {}, hidden: ["status"] },
      },
    })
    renderPage(
      <>
        <SessionsPage embedded />
      </>,
      "/sessions",
    )
    const table = await screen.findByRole("grid", { name: "Sessions" })
    await waitFor(() => expect(header(table, "Tags")).toBeNull())
    expect(header(table, "Levels")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Columns, 1 hidden" }),
    ).toBeInTheDocument()
  })
})

describe("on a phone", () => {
  const realMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = realMatchMedia
  })

  it("offers no Columns control and lists the requests as rows", async () => {
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
    renderRequests({
      "table:requests": { version: 1, widths: {}, hidden: ["api_key"] },
    })
    await screen.findByText("gpt-4o")
    expect(screen.queryByRole("grid")).toBeNull()
    expect(screen.queryByRole("button", { name: /^Columns/ })).toBeNull()
    const list = screen.getByRole("list", { name: "Activity log" })
    expect(within(list).getAllByRole("button").length).toBeGreaterThan(0)
  })
})
