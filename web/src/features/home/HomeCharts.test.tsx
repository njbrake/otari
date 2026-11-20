import { Outlet, useLocation } from "@tanstack/react-router"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { OrganizationSpendCeiling } from "@/client"
import { offeredMonths } from "@/features/home/budgetMonth"
import { TeamHome } from "@/features/home/TeamHome"
import { API_ROOT } from "@/shared/api/client"
import { SelectedWorkspaceProvider } from "@/shared/hooks/SelectedWorkspace"
import { DeploymentProvider } from "@/shared/hooks/useDeployment"
import {
  bootstrap,
  groupedSeries,
  organizationContext,
  organizationMember,
  organizationSpendCeiling,
  SURFACES,
  usageTotals,
} from "@/tests/fixtures"
import { AppProviders as Provider } from "@/tests/providers"
import { renderWithRouter } from "@/tests/router"
import { pickOption } from "@/tests/select"

const ADA = organizationMember({
  organization_member_id: "m-ada",
  user_id: "u-ada",
  attribution_user_id: "u-ada",
  full_name: "Ada Lovelace",
})
const WEI = organizationMember({
  organization_member_id: "m-wei",
  user_id: "u-wei",
  attribution_user_id: "u-wei",
  full_name: "Wei Zhang",
})

const DAY_MS = 86_400_000

function LocationProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search">{searchStr}</output>
}

/** The last `days` UTC days up to today, as series bucket starts. */
function lastDays(days: number): string[] {
  const today = Date.now() - (Date.now() % DAY_MS)
  return Array.from({ length: days }, (_, index) =>
    new Date(today - (days - 1 - index) * DAY_MS).toISOString(),
  )
}

const row = (key: string, cost: number) => ({
  key,
  label: key,
  cost,
  requests: 2,
  tokens: 400,
  is_other: false,
})

function mockApi({
  ceilings = [],
  chargedCost = 4,
}: {
  ceilings?: OrganizationSpendCeiling[]
  /** What the window's charged spend comes to, of the $4 spent. */
  chargedCost?: number
} = {}) {
  const asked: URL[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), "http://test")
    asked.push(url)
    const path = url.pathname.replace(
      new URL(API_ROOT, "http://test").pathname,
      "",
    )
    const days = lastDays(7)
    if (path === "/organizations/me") {
      return Response.json(
        organizationContext({ role: "owner", deployment_operator: false }),
      )
    }
    if (path === "/organizations/me/members") {
      return Response.json({ data: [ADA, WEI], count: 2 })
    }
    if (path === "/organizations/me/usage/summary") {
      const isCharged = url.searchParams.get("counts_toward_budget") === "true"
      return Response.json({
        totals: usageTotals({
          cost: isCharged ? chargedCost : 4,
          request_count: 6,
        }),
        series: days.map((bucket_start) => ({
          bucket_start,
          cost: 1,
          tokens: 10,
          requests: 1,
          input_tokens: 5,
          output_tokens: 5,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          errors: 0,
        })),
        by_user: [row("u-ada", 3), row("u-wei", 1)],
        by_api_key: [],
        by_model: [row("gpt-5", 3), row("claude", 1)],
        by_provider: [row("openai", 3), row("anthropic", 1)],
        errors_by_status_code: [],
      })
    }
    if (path === "/organizations/me/usage/series") {
      return Response.json(
        groupedSeries({
          group_by: "model",
          // A dragged span (one with an end) ranks the two the other way.
          groups: url.searchParams.has("end_date")
            ? [row("claude", 3), row("gpt-5", 1)]
            : [row("gpt-5", 3), row("claude", 1)],
          points: days.flatMap((bucket_start) => [
            { ...row("gpt-5", 0.5), bucket_start },
            { ...row("claude", 0.25), bucket_start },
          ]),
        }),
      )
    }
    if (path === "/organizations/me/spend-ceilings") {
      return Response.json({ data: ceilings, count: ceilings.length })
    }
    if (path.endsWith("/traces/count")) return Response.json({ count: 3 })
    if (path === "/workspaces") return Response.json({ data: [], count: 0 })
    return Response.json([])
  })
  return asked
}

async function renderHome(url = "/?period=7d&by=models") {
  await renderWithRouter(<TeamHome />, {
    url,
    shell: (
      <Provider>
        <DeploymentProvider value={bootstrap({ surfaces: [...SURFACES] })}>
          <SelectedWorkspaceProvider>
            <Outlet />
            <LocationProbe />
          </SelectedWorkspaceProvider>
        </DeploymentProvider>
      </Provider>
    ),
  })
}

const search = () =>
  new URLSearchParams(
    screen.getByRole("status", { name: "Search" }).textContent,
  )

describe("Home, the month against the budget", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reads the month's charged spend against a monthly team budget", async () => {
    const asked = mockApi({
      ceilings: [organizationSpendCeiling({ max_budget: 500 })],
    })
    await renderHome()
    const band = await screen.findByRole("region", { name: "Monthly budget" })
    expect(
      await within(band).findByText("Team budget $500.00"),
    ).toBeInTheDocument()
    const [month] = offeredMonths(Date.now())
    const read = asked.find(
      (url) =>
        url.pathname.endsWith("/usage/summary") &&
        url.searchParams.get("start_date") ===
          new Date(month.start).toISOString(),
    )
    expect(read?.searchParams.get("end_date")).toBe(
      new Date(month.end).toISOString(),
    )
    expect(read?.searchParams.get("counts_toward_budget")).toBe("true")
    expect(read?.searchParams.get("bucket")).toBe("day")
  })

  it("names a budget on another cadence rather than draw its line", async () => {
    mockApi({
      ceilings: [
        organizationSpendCeiling({
          max_budget: 50,
          reset_alignment: "calendar_week",
        }),
      ],
    })
    await renderHome()
    expect(
      await screen.findByText("team budget is $50.00 a week"),
    ).toBeVisible()
  })

  it("picks an earlier month into the URL", async () => {
    const user = userEvent.setup()
    mockApi()
    await renderHome()
    const [, before] = offeredMonths(Date.now())
    const name = new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(before.start)
    await pickOption(user, "Month", name)
    await waitFor(() => expect(search().get("month")).toBe(before.key))
  })
})

describe("Home, a budget created mid-month", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("measures the month from the day it began, and its counter, with no false verdict", async () => {
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.parse("2026-11-20T12:00:00Z"),
    })
    // $4 spent this month, more than the $3 budget, but only $0.50 of it on
    // the counter, which began on the 12th.
    mockApi({
      chargedCost: 4,
      ceilings: [
        organizationSpendCeiling({
          max_budget: 3,
          current_spend: 0.5,
          period_start: "2026-11-01T00:00:00+00:00",
          period_end: "2026-12-01T00:00:00+00:00",
          created_at: "2026-11-12T08:00:00+00:00",
        }),
      ],
    })
    await renderHome()
    const band = await screen.findByRole("region", { name: "Monthly budget" })
    expect(
      await within(band).findByText("Team budget $3.00 from Nov 12"),
    ).toBeInTheDocument()
    expect(
      within(band).getByText("$0.50 of $3.00 team budget since Nov 12"),
    ).toBeVisible()
    expect(within(band).queryByText(/Over budget Nov/)).toBeNull()
  })
})

describe("Home, the usage chart", () => {
  afterEach(() => vi.restoreAllMocks())

  it("splits the window by the table's breakdown, four groups and Other at most", async () => {
    const asked = mockApi()
    await renderHome()
    const section = await screen.findByRole("region", { name: "Where it went" })
    expect(
      (await within(section).findAllByText("gpt-5")).length,
    ).toBeGreaterThan(0)
    const read = asked.find((url) => url.pathname.endsWith("/usage/series"))
    expect(read?.searchParams.get("group_by")).toBe("model")
    expect(read?.searchParams.has("counts_toward_budget")).toBe(false)
  })

  it("asks the series by provider for the Providers cut", async () => {
    const asked = mockApi()
    await renderHome("/?period=7d&by=providers")
    await waitFor(() =>
      expect(
        asked.some(
          (url) =>
            url.pathname.endsWith("/usage/series") &&
            url.searchParams.get("group_by") === "provider",
        ),
      ).toBe(true),
    )
  })

  it("switches the metric, and leaves out what no budget counted", async () => {
    const user = userEvent.setup()
    const asked = mockApi({ chargedCost: 3 })
    await renderHome()
    await user.click(await screen.findByRole("radio", { name: "Requests" }))
    await waitFor(() => expect(search().get("chart")).toBe("requests"))
    await user.click(
      await screen.findByRole("checkbox", { name: "Include not charged" }),
    )
    await waitFor(() => expect(search().get("charged")).toBe("only"))
    await waitFor(() =>
      expect(
        asked.some(
          (url) =>
            url.pathname.endsWith("/usage/series") &&
            url.searchParams.get("counts_toward_budget") === "true",
        ),
      ).toBe(true),
    )
  })

  it("offers no not-charged toggle where everything was charged", async () => {
    mockApi({ chargedCost: 4 })
    await renderHome()
    await screen.findByRole("radio", { name: "Requests" })
    expect(
      screen.queryByRole("checkbox", { name: "Include not charged" }),
    ).toBeNull()
  })

  it("narrows the window to the bars dragged across, and lets it go", async () => {
    const user = userEvent.setup()
    mockApi()
    await renderHome()
    const section = await screen.findByRole("region", { name: "Where it went" })
    const chart = await waitFor(() => {
      const found = within(section)
        .getByRole("group", { name: /Cost per day by models/ })
        .querySelector(".recharts-wrapper")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 700, 180),
    )
    const at = async (fire: typeof fireEvent.mouseMove, clientX: number) => {
      await act(async () => {
        fire(chart, { clientX, clientY: 60 })
        await new Promise(requestAnimationFrame)
      })
    }
    await at(fireEvent.mouseMove, 120)
    await at(fireEvent.mouseDown, 120)
    await at(fireEvent.mouseMove, 420)
    await at(fireEvent.mouseMove, 430)
    await at(fireEvent.mouseUp, 430)
    await waitFor(() => expect(search().get("start")).not.toBeNull())
    const start = Date.parse(search().get("start") ?? "")
    const end = Date.parse(search().get("end") ?? "")
    expect(end - start).toBeGreaterThanOrEqual(2 * DAY_MS)
    expect(start % DAY_MS).toBe(0)

    await user.click(
      await screen.findByRole("button", { name: /Clear the window/ }),
    )
    await waitFor(() => expect(search().get("start")).toBeNull())
  })
})

describe("Home, sharing as an image", () => {
  afterEach(() => vi.restoreAllMocks())

  it("paints a preview in the browser, and asks nothing of any server to do it", async () => {
    const user = userEvent.setup()
    const asked = mockApi()
    // jsdom has no canvas: a context that records what it is told stands in.
    const painted: string[] = []
    const context = new Proxy(
      { measureText: (text: string) => ({ width: text.length * 8 }) },
      {
        get: (target, key) =>
          key in target
            ? target[key as keyof typeof target]
            : (...args: unknown[]) => {
                if (key === "fillText") painted.push(String(args[0]))
              },
        set: () => true,
      },
    )
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["png"], { type: "image/png" })),
    )
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:card")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    await renderHome()
    const share = await screen.findByRole("button", {
      name: "Share as an image",
    })
    await waitFor(() => expect(share).toBeEnabled())
    const before = asked.length
    await user.click(share)
    const dialog = await screen.findByRole("dialog", {
      name: "Share as an image",
    })
    expect(
      within(dialog).getByText(
        "Made in your browser from the figures on this page. Nothing is uploaded.",
      ),
    ).toBeVisible()
    const image = await within(dialog).findByRole("img", { name: /^Usage, / })
    expect(image).toHaveAttribute("src", "blob:card")
    expect(painted).toContain("Cost per day by models")
    expect(painted).toContain("$4.00")
    expect(
      within(dialog).getByRole("button", { name: "Download PNG" }),
    ).toBeEnabled()
    expect(asked.slice(before)).toEqual([])
  })

  it("says so where the browser cannot draw the image", async () => {
    const user = userEvent.setup()
    mockApi()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
    await renderHome()
    const share = await screen.findByRole("button", {
      name: "Share as an image",
    })
    await waitFor(() => expect(share).toBeEnabled())
    await user.click(share)
    const dialog = await screen.findByRole("dialog", {
      name: "Share as an image",
    })
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This browser cannot draw the image.",
    )
    expect(
      within(dialog).getByRole("button", { name: "Download PNG" }),
    ).toBeDisabled()
  })
})

describe("Home, the usage chart's colors", () => {
  afterEach(() => vi.restoreAllMocks())

  /** The fill of a legend marker beside `name`. */
  const markerOf = (scope: HTMLElement, name: string) =>
    within(scope)
      .getAllByText(name)
      .map((one) => one.querySelector("rect")?.getAttribute("fill"))
      .find(Boolean)

  it("keeps each group's color when a drag ranks them the other way", async () => {
    mockApi()
    const preset = lastDays(7)
    const start = preset[2]
    const end = new Date(Date.parse(preset[5]) + DAY_MS).toISOString()
    await renderHome(`/?period=7d&by=models&start=${start}&end=${end}`)
    const section = await screen.findByRole("region", { name: "Where it went" })
    await waitFor(() =>
      expect(markerOf(section, "gpt-5")).toBe("var(--color-chart-cat-1)"),
    )
    expect(markerOf(section, "claude")).toBe("var(--color-chart-cat-2)")
  })
})
