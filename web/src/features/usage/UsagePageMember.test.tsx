/**
 * What a member who does not manage the workspace reads on Usage, which turns
 * on whether the workspace's managers share its totals with members.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { UsagePage } from "@/features/usage/UsagePage"
import { MEMBER_TOTALS_FILTERS } from "@/features/workspaces/memberVisibility"
import {
  lastBreakdown,
  mockUsageApi,
  renderUsage,
  UrlProbe,
  usageReads,
  WORKSPACE_ID,
} from "@/tests/usage"

afterEach(() => {
  vi.restoreAllMocks()
})

function page(route?: string) {
  return renderUsage(
    <>
      <UsagePage />
      <UrlProbe />
    </>,
    route,
  )
}

const table = () => screen.findByRole("grid", { name: /^Usage by/ })

// The parameters that shape a read rather than narrow it. Anything else a
// member's ask for the workspace's totals carries must be on the allowlist.
const READ_SHAPE = new Set([
  "workspace_totals",
  "bucket",
  "dimensions",
  "p95_by",
  "rank_by",
  "rank_order",
  "group_by",
])

describe("a member's Usage while the workspace shares its totals", () => {
  it("offers Workspace beside You, and asks for the workspace's totals there", async () => {
    const user = userEvent.setup()
    const { calls } = mockUsageApi({
      viewer: "member",
      membersSeeWorkspaceTotals: true,
    })
    page()

    const scope = await screen.findByRole("radiogroup", { name: "Scope" })
    expect(within(scope).getByRole("radio", { name: "You" })).toBeChecked()
    await user.click(within(scope).getByRole("radio", { name: "Workspace" }))

    await waitFor(() =>
      expect(lastBreakdown(calls).get("workspace_totals")).toBe("true"),
    )
    expect(lastBreakdown(calls).get("workspace_id")).toBe(WORKSPACE_ID)
    // Split by the model, and nothing the server would refuse: no tools.
    expect(lastBreakdown(calls).getAll("dimensions")).toEqual(["model"])
    const series = usageReads(calls, "series").at(-1)
    expect(series?.get("workspace_totals")).toBe("true")
    // The tools read is a breakdown by tool, so no ask for it carries the totals.
    expect(
      usageReads(calls, "tools").some(
        (params) => params.get("workspace_totals") === "true",
      ),
    ).toBe(false)
    expect(series?.get("group_by")).toBe("model")
    // The window before is the workspace's too.
    const previous = usageReads(calls, "summary").filter((params) =>
      params.getAll("dimensions").includes("none"),
    )
    expect(previous.at(-1)?.get("workspace_totals")).toBe("true")
    // Only the anonymous breakdowns are offered.
    await table()
    expect(screen.getByRole("button", { name: "Model" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Provider" })).toBeInTheDocument()
    for (const name of ["Member", "API key", "Session", "Channel"]) {
      expect(screen.queryByRole("button", { name })).toBeNull()
    }
    expect(
      screen.queryByRole("button", { name: /^More breakdowns/ }),
    ).toBeNull()
    expect(screen.queryByText("Gateway-run tools")).toBeNull()
    // Activity lists a member's own requests, so no row opens there.
    expect(screen.getByText(/hover or tap a row to filter/)).toBeInTheDocument()
    expect(screen.queryByText(/click to open in Activity/)).toBeNull()
  })

  it("sends no person, key or session filter with the workspace's totals", async () => {
    const { calls } = mockUsageApi({
      viewer: "member",
      membersSeeWorkspaceTotals: true,
    })
    page(
      "/usage?scope=workspace&by=key&subscription=exclude&user_id=u-jordan&api_key_id=key-research&source_label=sess-1&channel=api&policy_name=thymeline-prod&model=claude-opus-5-5",
    )

    await table()
    await waitFor(() =>
      expect(lastBreakdown(calls).get("workspace_totals")).toBe("true"),
    )
    const sent = [
      ...usageReads(calls, "summary"),
      ...usageReads(calls, "latency"),
      ...usageReads(calls, "series"),
    ].filter((params) => params.get("workspace_totals") === "true")
    expect(sent.length).toBeGreaterThan(0)
    for (const params of sent) {
      const narrowing = [...params.keys()].filter((key) => !READ_SHAPE.has(key))
      expect(
        narrowing.filter((key) => !MEMBER_TOTALS_FILTERS.has(key)),
      ).toEqual([])
    }
    // A model narrows the totals as it would anyone's.
    expect(lastBreakdown(calls).getAll("model")).toEqual(["claude-opus-5-5"])
    // The breakdown the URL named is not on offer, so the first one stands in.
    const latency = usageReads(calls, "latency").at(-1)
    expect(latency?.get("workspace_totals")).toBe("true")
    expect(latency?.get("group_by")).toBe("model")
    // The filters wait in the URL for a scope that has them.
    expect(screen.getAllByText("not in this scope").length).toBe(5)
  })
})

describe("a member's Usage while the workspace hides its totals", () => {
  it("keeps them to their own usage, with the budget as a share of its cap", async () => {
    const { calls } = mockUsageApi({ viewer: "member" })
    page("/usage?scope=workspace")

    expect(await screen.findByText("Your usage")).toBeInTheDocument()
    expect(screen.queryByRole("radiogroup", { name: "Scope" })).toBeNull()
    await table()
    expect(
      calls.some((call) =>
        call.url.includes(`/workspaces/${WORKSPACE_ID}/visibility`),
      ),
    ).toBe(true)
    expect(
      calls.filter((call) => call.url.includes("workspace_totals")),
    ).toEqual([])
    // The share used and the cap, never the dollars spent.
    expect(await screen.findByText("82%")).toBeInTheDocument()
    expect(screen.queryByText(/82\.4/)).toBeNull()
    expect(screen.getByText("used of $500")).toBeInTheDocument()
    expect(
      screen.getByText("Workspace total hidden by your admin"),
    ).toBeInTheDocument()
    expect(screen.queryByText("$412.00")).toBeNull()
  })
})

describe("a member's link to the workspace's Usage", () => {
  it("waits for the workspace's answer rather than reading their own usage first", async () => {
    let release: () => void = () => {}
    const { calls } = mockUsageApi({
      viewer: "member",
      membersSeeWorkspaceTotals: true,
      holdVisibility: new Promise((resolve) => {
        release = resolve
      }),
    })
    page("/usage?scope=workspace")

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("/visibility"))).toBe(true),
    )
    expect(screen.queryByText("Your usage")).toBeNull()
    expect(usageReads(calls, "summary")).toEqual([])
    expect(usageReads(calls, "series")).toEqual([])

    release()
    const scope = await screen.findByRole("radiogroup", { name: "Scope" })
    expect(
      within(scope).getByRole("radio", { name: "Workspace" }),
    ).toBeChecked()
    await table()
    const reads = [
      ...usageReads(calls, "summary"),
      ...usageReads(calls, "series"),
    ]
    expect(reads.length).toBeGreaterThan(0)
    for (const params of reads) {
      expect(params.get("workspace_totals")).toBe("true")
    }
  })

  it("drops to their own usage when the managers turned the totals off meanwhile", async () => {
    const { calls } = mockUsageApi({
      viewer: "member",
      membersSeeWorkspaceTotals: true,
      revokesTotals: true,
    })
    page("/usage?scope=workspace")

    // The refused ask reads the setting again, and the page follows it.
    expect(await screen.findByText("Your usage")).toBeInTheDocument()
    expect(screen.queryByRole("radiogroup", { name: "Scope" })).toBeNull()
    await table()
    expect(screen.queryByText(/Workspace totals are not shared/)).toBeNull()
    expect(
      calls.filter((call) => call.url.includes("/visibility")).length,
    ).toBe(2)
    expect(lastBreakdown(calls).get("workspace_totals")).toBeNull()
    expect(
      await screen.findByText("Workspace total hidden by your admin"),
    ).toBeInTheDocument()
  })
})
