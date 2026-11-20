import { useLocation } from "@tanstack/react-router"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import { SessionsPage } from "@/features/traces/SessionsPage"
import { entry, listCalls, mockApi, renderPage } from "@/tests/activity"
import { traceSummary } from "@/tests/traceFixtures"
import { ObserveFilterRow } from "./ObserveFilterRow"

const realMatchMedia = window.matchMedia

function setPhone(matches: boolean) {
  window.matchMedia = vi.fn(() => ({
    matches,
    media: "",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => setPhone(true))

afterEach(() => {
  window.matchMedia = realMatchMedia
  vi.restoreAllMocks()
})

function UrlProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search in the URL">{searchStr}</output>
}

// By element rather than role: an open sheet hides everything outside it from
// the accessibility tree.
const urlParams = () =>
  new URLSearchParams(document.querySelector("output")?.textContent ?? "")

const groupReads = (calls: ReturnType<typeof mockApi>["calls"]) =>
  calls
    .filter((call) => call.url.includes("/usage/groups"))
    .map((call) => new URL(call.url, "http://localhost").searchParams)

async function renderRequests(search = "") {
  renderPage(
    <>
      <ObserveFilterRow view="requests" />
      <ActivityPage embedded />
      <UrlProbe />
    </>,
    `/requests${search}`,
  )
  await screen.findByText("Time range")
}

async function renderSessions(search = "") {
  renderPage(
    <>
      <ObserveFilterRow view="sessions" />
      <SessionsPage embedded />
      <UrlProbe />
    </>,
    `/sessions${search}`,
  )
  await screen.findByText("Time range")
}

const filtersButton = () =>
  screen.findByRole("button", { name: /^Filters(, \d+ applied)?$/ })

async function openSheet() {
  const user = userEvent.setup()
  await user.click(await filtersButton())
  const sheet = await screen.findByRole("dialog", { name: "Filters" })
  return { user, sheet }
}

// The sections' own headings: each is the button that expands it.
const sectionNames = (sheet: HTMLElement) =>
  within(sheet)
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-expanded"))
    .map((button) => button.textContent)

describe("ObserveFilterSheet on Requests", () => {
  it("replaces the header funnels with a Filters button that opens the sheet", async () => {
    mockApi({ rows: [entry()] })
    await renderRequests()
    await screen.findAllByText("gpt-4o")

    expect(screen.queryAllByRole("button", { name: /^Filter / })).toEqual([])
    const { sheet } = await openSheet()

    expect(sectionNames(sheet)).toEqual([
      "User",
      "Model",
      "Routing",
      "API key",
      "Tokens",
      "Cost",
      "Total time",
      "Status",
    ])
    expect(
      within(sheet).getByRole("button", { name: "Done" }),
    ).toBeInTheDocument()
    expect(
      within(sheet).getByRole("button", { name: "Clear all" }),
    ).toBeDisabled()
  })

  it("reads a section's values only once it is expanded", async () => {
    const { calls } = mockApi({
      rows: [entry({ model: "gpt-4o" }), entry({ id: "b", model: "claude-x" })],
    })
    await renderRequests()
    await screen.findAllByText("claude-x")
    const { user, sheet } = await openSheet()

    expect(groupReads(calls)).toEqual([])
    await user.click(within(sheet).getByRole("button", { name: "Model" }))

    await waitFor(() =>
      expect(groupReads(calls).map((read) => read.get("group_by"))).toEqual(
        expect.arrayContaining(["model", "provider"]),
      ),
    )
    expect(
      groupReads(calls).some((read) => read.get("group_by") === "user"),
    ).toBe(false)
  })

  it("checking a value writes the funnel's URL key and shows a chip", async () => {
    const { calls } = mockApi({
      rows: [entry({ model: "gpt-4o" }), entry({ id: "b", model: "claude-x" })],
    })
    await renderRequests("?page=2")
    await screen.findAllByText("claude-x")
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole("button", { name: "Model" }))

    await user.click(
      await within(sheet).findByRole("checkbox", { name: "claude-x" }),
    )

    await waitFor(() =>
      expect(urlParams().getAll("model")).toEqual(["claude-x"]),
    )
    expect(urlParams().has("page")).toBe(false)
    // Applied at once, with the sheet still open.
    expect(
      within(sheet).getByRole("button", { name: /^Model\s*Filtered$/ }),
    ).toBeInTheDocument()
    await user.click(within(sheet).getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull(),
    )
    expect(
      screen.getByRole("button", { name: "Remove Model filter claude-x" }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        listCalls(calls).some((url) => url.includes("model=claude-x")),
      ).toBe(true),
    )
  })

  it("excludes a value under the funnel's exclude key", async () => {
    mockApi({
      rows: [entry({ model: "gpt-4o" }), entry({ id: "b", model: "claude-x" })],
    })
    await renderRequests()
    await screen.findAllByText("claude-x")
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole("button", { name: "Model" }))

    await user.click(
      await within(sheet).findByRole("button", { name: "Exclude claude-x" }),
    )

    await waitFor(() =>
      expect(urlParams().getAll("exclude_model")).toEqual(["claude-x"]),
    )
  })

  it("offers the thresholds and extras the funnels hold", async () => {
    mockApi({ rows: [entry()] })
    await renderRequests()
    const { user, sheet } = await openSheet()
    await user.click(within(sheet).getByRole("button", { name: "Cost" }))

    await user.click(
      within(sheet).getByRole("checkbox", { name: "Unpriced only" }),
    )
    await waitFor(() => expect(urlParams().get("priced")).toBe("false"))
    await user.click(within(sheet).getByRole("checkbox", { name: "> $0.10" }))
    await waitFor(() => expect(urlParams().get("cost_gt")).toBe("0.1"))
  })

  it("counts the filters applied on its badge", async () => {
    mockApi({ rows: [entry()] })
    await renderRequests("?model=gpt-4o&model=claude-x&status=error")

    expect(await filtersButton()).toHaveAccessibleName("Filters, 3 applied")
  })

  it("carries no badge while nothing is filtered", async () => {
    mockApi({ rows: [entry()] })
    await renderRequests()

    expect(await filtersButton()).toHaveAccessibleName("Filters")
  })

  it("opens a filtered section expanded, and clears everything", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderRequests("?cost_gt=0.1")
    await user.click(await filtersButton())
    const sheet = await screen.findByRole("dialog", { name: "Filters" })

    expect(
      within(sheet).getByRole("button", { name: /^Cost\s*Filtered$/ }),
    ).toHaveAttribute("aria-expanded", "true")
    expect(
      within(sheet).getByRole("checkbox", { name: "> $0.10" }),
    ).toBeChecked()

    await user.click(within(sheet).getByRole("button", { name: "Clear all" }))
    await waitFor(() => expect(urlParams().has("cost_gt")).toBe(false))
  })

  it("returns focus to the Filters button when it closes", async () => {
    mockApi({ rows: [entry()] })
    await renderRequests()
    const { user, sheet } = await openSheet()

    await user.click(within(sheet).getByRole("button", { name: "Done" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus(),
    )
  })

  it("is not offered on a desk, where the headers carry the funnels", async () => {
    setPhone(false)
    mockApi({ rows: [entry()] })
    await renderRequests()
    await screen.findByRole("button", { name: "Filter Model" })

    expect(screen.queryByRole("button", { name: /^Filters/ })).toBeNull()
  })
})

describe("ObserveFilterSheet on Sessions", () => {
  it("holds the Sessions columns and writes the shared status key", async () => {
    mockApi({ traces: [traceSummary()] })
    await renderSessions()
    expect(screen.queryAllByRole("button", { name: /^Filter / })).toEqual([])
    const { user, sheet } = await openSheet()

    expect(sectionNames(sheet)).toEqual(["User", "Levels"])
    await user.click(within(sheet).getByRole("button", { name: "Levels" }))
    await user.click(within(sheet).getByRole("checkbox", { name: "Error" }))

    await waitFor(() => expect(urlParams().get("status")).toBe("error"))
    await user.click(within(sheet).getByRole("button", { name: "Done" }))
    expect(
      await screen.findByRole("button", { name: "Remove Status filter" }),
    ).toBeInTheDocument()
    expect(await filtersButton()).toHaveAccessibleName("Filters, 1 applied")
  })

  it("leaves a filter Sessions does not apply out of the badge", async () => {
    mockApi({ traces: [traceSummary()] })
    await renderSessions("?cost_gt=0.1&model=gpt-4o")

    expect(
      await screen.findByText(/not applied to sessions/),
    ).toBeInTheDocument()
    expect(await filtersButton()).toHaveAccessibleName("Filters, 1 applied")
  })
})
