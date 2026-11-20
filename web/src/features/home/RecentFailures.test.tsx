import { Outlet } from "@tanstack/react-router"
import { screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UsageEntry } from "@/client"
import { failureSearch, RecentFailures } from "@/features/home/RecentFailures"
import { windowOf } from "@/features/spend/period"
import { AppProviders as Provider } from "@/tests/providers"
import { renderWithRouter } from "@/tests/router"

const NOW = Date.parse("2026-11-20T12:00:00Z")

function entry(overrides: Partial<UsageEntry>): UsageEntry {
  return {
    id: "row-1",
    request_group_id: null,
    timestamp: "2026-11-20T11:55:00Z",
    model: "gpt-5",
    provider: "openai",
    api_key_name: "ci",
    status: "error",
    status_code: 502,
    error_message: "Upstream timed out",
    ...overrides,
  } as UsageEntry
}

describe("failureSearch", () => {
  const window = windowOf("7d", NOW)

  it("opens the request in Requests over the window's failures", () => {
    expect(failureSearch(entry({ id: "row-9" }), window)).toEqual({
      start_date: window.start,
      status: "error",
      request: "row-9",
    })
  })

  it("names the request by its group where it has one", () => {
    expect(
      failureSearch(
        entry({ id: "row-9", request_group_id: "grp-1" }),
        window,
        "u1",
      ).request,
    ).toBe("grp-1")
    expect(failureSearch(entry({ id: "row-9" }), window, "u1").user_id).toBe(
      "u1",
    )
  })
})

const shell = (
  <Provider>
    <Outlet />
  </Provider>
)

describe("RecentFailures", () => {
  afterEach(() => vi.restoreAllMocks())

  it("lists the window's latest failures, each linking to its request", async () => {
    const asked: URL[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://test")
      asked.push(url)
      return Response.json([
        entry({ id: "row-1" }),
        entry({
          id: "row-2",
          request_group_id: "grp-2",
          model: "claude-sonnet",
          status_code: 429,
          error_message: "Rate limited",
        }),
      ])
    })
    const window = windowOf("7d", NOW)
    await renderWithRouter(
      <RecentFailures window={window} now={NOW} workspaceId="" total={12} />,
      { shell },
    )
    const section = await screen.findByRole("region", {
      name: "Recent failures",
    })
    const rows = await within(section).findAllByRole("link", {
      name: /^Failed request to/,
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute("href")).toContain("request=row-1")
    expect(rows[0].getAttribute("href")).toContain("status=error")
    expect(rows[1].getAttribute("href")).toContain("request=grp-2")
    expect(within(rows[1]).getByText("Rate limited")).toBeVisible()
    expect(
      within(section).getByRole("link", { name: "See all 12" }),
    ).toBeVisible()
    const read = asked.find((url) => url.pathname.endsWith("/usage"))
    expect(read?.searchParams.get("status")).toBe("error")
    expect(read?.searchParams.get("start_date")).toBe(window.start)
  })

  it("says so when nothing failed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json([]),
    )
    await renderWithRouter(
      <RecentFailures
        window={windowOf("7d", NOW)}
        now={NOW}
        workspaceId=""
        total={0}
      />,
      { shell },
    )
    expect(
      await screen.findByText("No request failed in the last 7 days."),
    ).toBeVisible()
  })
})
