import { useLocation } from "@tanstack/react-router"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import { API_ROOT } from "@/shared/api/client"
import { entry, listCalls, mockApi, renderPage } from "@/tests/activity"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ActivityPage filter serialization", () => {
  it("sends every active filter to the server, not just the chip", async () => {
    // The list, count, and timeline must all carry the active tool filter.
    const { calls } = mockApi({ rows: [entry()] })
    renderPage(<ActivityPage />, "/activity?tool=web_search&range=24h")

    await screen.findByText("gpt-4o")
    const requested = calls.map((c) => c.url)
    for (const path of [
      `${API_ROOT}/usage?`,
      `${API_ROOT}/usage/count`,
      `${API_ROOT}/usage/summary`,
    ]) {
      expect(
        requested.some(
          (url) => url.includes(path) && url.includes("tool=web_search"),
        ),
        `${path} dropped the tool filter`,
      ).toBe(true)
    }
  })

  it("narrows to one status code a link carries, and says so", async () => {
    // Home's "See the refusals" links here with the code it counted, so the
    // list is the refused requests rather than every failure.
    const { calls } = mockApi({ rows: [entry()] })
    renderPage(
      <>
        <ActivityPage embedded />
      </>,
      "/requests?status_code=403&range=24h",
    )

    await screen.findByText("gpt-4o")
    const requested = calls.map((c) => c.url)
    for (const path of [`${API_ROOT}/usage?`, `${API_ROOT}/usage/count`]) {
      expect(
        requested.some(
          (url) => url.includes(path) && url.includes("status_code=403"),
        ),
        `${path} dropped the status code`,
      ).toBe(true)
    }
    expect(
      screen.getByRole("button", { name: "Remove Status code filter" }),
    ).toBeInTheDocument()
  })

  it("narrows to what hosted providers served, and marks those rows", async () => {
    const { calls } = mockApi({ rows: [entry({ deployment_paid: true })] })
    renderPage(<ActivityPage />, "/activity?paid_by=true&range=24h")

    await screen.findByText("gpt-4o")
    const requested = calls.map((c) => c.url)
    for (const path of [
      `${API_ROOT}/usage?`,
      `${API_ROOT}/usage/count`,
      `${API_ROOT}/usage/summary`,
    ]) {
      expect(
        requested.some(
          (url) => url.includes(path) && url.includes("deployment_paid=true"),
        ),
        `${path} dropped the paid-by filter`,
      ).toBe(true)
    }
    expect(
      screen.getByRole("img", { name: "Paid by: hosted provider" }),
    ).toBeVisible()
  })

  it("offers Web fetch as a named tool filter under the Model column", async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({ rows: [entry()] })
    renderPage(<ActivityPage embedded />, "/requests?tool=web_search&range=24h")
    await screen.findByText("gpt-4o")

    await user.click(screen.getByRole("button", { name: "Filter Model" }))
    const panel = await screen.findByRole("dialog", { name: "Filter Model" })
    const tools = await within(panel).findByRole("group", {
      name: "Gateway tool",
    })
    expect(
      within(tools).getByRole("checkbox", { name: "Web search" }),
    ).toBeChecked()
    await user.click(within(tools).getByRole("checkbox", { name: "Web fetch" }))

    await waitFor(() =>
      expect(
        listCalls(calls).some((url) => url.includes("tool=web_fetch")),
      ).toBe(true),
    )
  })

  it("offers the tool filter only once the window has tool usage", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    renderPage(<ActivityPage embedded />, "/requests")
    await screen.findByText("gpt-4o")

    await user.click(screen.getByRole("button", { name: "Filter Model" }))
    const panel = await screen.findByRole("dialog", { name: "Filter Model" })
    await within(panel).findByRole("group", { name: "Provider" })
    expect(
      within(panel).queryByRole("group", { name: "Gateway tool" }),
    ).toBeNull()
  })

  it("offers the tool filter where the window ran a tool", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()], tools: ["web_search"] })
    renderPage(<ActivityPage embedded />, "/requests")
    await screen.findByText("gpt-4o")

    await user.click(screen.getByRole("button", { name: "Filter Model" }))
    const panel = await screen.findByRole("dialog", { name: "Filter Model" })
    expect(
      await within(panel).findByRole("group", { name: "Gateway tool" }),
    ).toBeInTheDocument()
  })
})

function UrlProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search in the URL">{searchStr}</output>
}

describe("ActivityPage column filters", () => {
  const renderRequests = (search = "") =>
    renderPage(
      <>
        <ActivityPage embedded />
        <UrlProbe />
      </>,
      `/requests${search}`,
    )
  const urlParams = () =>
    new URLSearchParams(document.querySelector("output")?.textContent ?? "")

  it("puts a funnel on each column that shows a shared filter", async () => {
    mockApi({ rows: [entry()] })
    renderRequests()
    await screen.findByText("gpt-4o")

    const headers = screen.getAllByRole("columnheader")
    const funnels = headers.flatMap((header) =>
      within(header)
        .queryAllByRole("button", { name: /^Filter / })
        .map((button) => button.getAttribute("aria-label")),
    )
    expect(funnels).toEqual([
      "Filter User",
      "Filter Model",
      "Filter Routing",
      "Filter API key",
      "Filter Input",
      "Filter Output",
      "Filter Cost",
      "Filter Total time",
      "Filter Status",
    ])
  })

  it("checking a value in a funnel filters the log and shows a chip", async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      rows: [
        entry({ id: "a", model: "gpt-4o" }),
        entry({ id: "b", model: "claude-x" }),
      ],
    })
    renderRequests("?page=2")
    await screen.findAllByText("claude-x")

    await user.click(screen.getByRole("button", { name: "Filter Model" }))
    const panel = await screen.findByRole("dialog", { name: "Filter Model" })
    await user.click(
      await within(panel).findByRole("checkbox", { name: "claude-x" }),
    )

    await waitFor(() =>
      expect(urlParams().getAll("model")).toEqual(["claude-x"]),
    )
    expect(urlParams().has("page")).toBe(false)
    // No row opened on the way: the press stayed in the panel.
    expect(urlParams().has("request")).toBe(false)
    await user.keyboard("{Escape}")
    expect(
      await screen.findByRole("button", {
        name: "Remove Model filter claude-x",
      }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        listCalls(calls).some((url) => url.includes("model=claude-x")),
      ).toBe(true),
    )
    // The funnel takes the accent while its column is filtered.
    expect(screen.getByRole("button", { name: "Filter Model" })).toHaveClass(
      "text-accent",
    )
  })

  it("excluding a value in a funnel leaves it out of the log and says so", async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      rows: [
        entry({ id: "a", model: "gpt-4o" }),
        entry({ id: "b", model: "claude-x" }),
      ],
    })
    renderRequests()
    await screen.findAllByText("claude-x")

    await user.click(screen.getByRole("button", { name: "Filter Model" }))
    const panel = await screen.findByRole("dialog", { name: "Filter Model" })
    await user.click(
      await within(panel).findByRole("button", { name: "Exclude claude-x" }),
    )
    await user.keyboard("{Escape}")

    await waitFor(() =>
      expect(urlParams().getAll("exclude_model")).toEqual(["claude-x"]),
    )
    expect(
      await screen.findByRole("button", {
        name: "Remove Model filter not claude-x",
      }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        listCalls(calls).some((url) => url.includes("exclude_model=claude-x")),
      ).toBe(true),
    )
  })

  it("sends a threshold to every read of the log", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    renderRequests("?latency_ms_gt=5000&routed=false")
    await screen.findByText("gpt-4o")

    for (const path of [
      `${API_ROOT}/usage?`,
      `${API_ROOT}/usage/count`,
      `${API_ROOT}/usage/summary`,
    ]) {
      await waitFor(() =>
        expect(
          calls.some(
            (call) =>
              call.url.includes(path) &&
              call.url.includes("latency_ms_gt=5000") &&
              call.url.includes("routed=false"),
          ),
          `${path} dropped the refinements`,
        ).toBe(true),
      )
    }
    expect(
      screen.getByRole("button", { name: "Remove Total time filter" }),
    ).toBeInTheDocument()
  })

  it("sends every exclusion a chip shows to every read of the log", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    const excluded = {
      exclude_model: "claude-x",
      exclude_user_id: "bob",
      exclude_api_key_id: "k2",
      exclude_source: "codex",
      exclude_status: "absorbed",
      exclude_policy_name: "fast",
    }
    renderRequests(`?${new URLSearchParams(excluded).toString()}`)
    await screen.findByText("gpt-4o")

    for (const path of [
      `${API_ROOT}/usage?`,
      `${API_ROOT}/usage/count`,
      `${API_ROOT}/usage/summary`,
    ]) {
      for (const [key, value] of Object.entries(excluded)) {
        await waitFor(() =>
          expect(
            calls.some(
              (call) =>
                call.url.includes(path) && call.url.includes(`${key}=${value}`),
            ),
            `${path} dropped ${key}`,
          ).toBe(true),
        )
      }
    }
  })

  it("draws no funnels outside the Overview", async () => {
    mockApi({ rows: [entry()] })
    renderPage(<ActivityPage />, "/activity")
    await screen.findByText("gpt-4o")

    expect(screen.queryByRole("button", { name: /^Filter / })).toBeNull()
  })
})
