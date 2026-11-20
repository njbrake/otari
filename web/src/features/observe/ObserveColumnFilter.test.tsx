import { useLocation } from "@tanstack/react-router"
import { act, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { API_ROOT } from "@/shared/api/client"
import {
  entry,
  jsonResponse,
  mockApi,
  operatorContext,
  renderPage,
} from "@/tests/activity"
import { ObserveColumnFilter } from "./ObserveColumnFilter"
import type { FilterSection } from "./observeFilters"
import type { ObserveView } from "./observeSearch"

afterEach(() => {
  vi.restoreAllMocks()
})

function UrlProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search in the URL">{searchStr}</output>
}

const PATHS: Record<ObserveView, string> = {
  usage: "/",
  requests: "/requests",
  sessions: "/sessions",
}

const values = (
  ...dimensions: (FilterSection & { kind: "values" })["dimension"][]
): FilterSection[] =>
  dimensions.map((dimension) => ({ kind: "values", dimension }))

function renderFunnel(
  view: ObserveView,
  label: string,
  sections: FilterSection[],
  search = "",
) {
  renderPage(
    <>
      <ObserveColumnFilter view={view} label={label} sections={sections} />
      <UrlProbe />
    </>,
    `${PATHS[view]}${search}`,
  )
}

// By element rather than role: an open panel hides everything outside it from
// the accessibility tree.
const urlParams = () =>
  new URLSearchParams(document.querySelector("output")?.textContent ?? "")

const groupReads = (calls: ReturnType<typeof mockApi>["calls"]) =>
  calls
    .filter((call) => call.url.includes("/usage/groups"))
    .map((call) => new URL(call.url, "http://localhost"))

const reading = (calls: ReturnType<typeof mockApi>["calls"], groupBy: string) =>
  groupReads(calls).find((url) => url.searchParams.get("group_by") === groupBy)

const HOUR_MS = 3_600_000
const startAge = (url: URL | undefined) =>
  Date.now() - Date.parse(url?.searchParams.get("start_date") ?? "")

async function open(label: string) {
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole("button", { name: `Filter ${label}` }),
  )
  const panel = await screen.findByRole("dialog", { name: `Filter ${label}` })
  return { user, panel }
}

describe("ObserveColumnFilter values", () => {
  it("reads nothing until it is opened, then the view's own window", async () => {
    const { calls } = mockApi({ rows: [entry({ model: "claude-x" })] })
    renderFunnel("requests", "Model", values("model"), "?range=7d")
    await screen.findByRole("button", { name: "Filter Model" })
    expect(groupReads(calls)).toEqual([])

    const { panel } = await open("Model")

    expect(
      await within(panel).findByRole("checkbox", { name: "claude-x" }),
    ).toBeInTheDocument()
    expect(startAge(reading(calls, "model"))).toBeGreaterThan(167 * HOUR_MS)
    expect(startAge(reading(calls, "model"))).toBeLessThan(169 * HOUR_MS)
  })

  it("opens Sessions on 24 hours", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    renderFunnel("sessions", "User", values("user"))
    await open("User")

    await waitFor(() => expect(reading(calls, "user")).toBeDefined())
    expect(startAge(reading(calls, "user"))).toBeLessThan(25 * HOUR_MS)
  })

  it("prefers explicit bounds to the range", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    renderFunnel(
      "requests",
      "User",
      values("user"),
      "?range=7d&start_date=2026-10-01T00:00:00.000Z&end_date=2026-10-02T00:00:00.000Z",
    )
    await open("User")

    await waitFor(() => expect(reading(calls, "user")).toBeDefined())
    const read = reading(calls, "user")
    expect(read?.searchParams.get("start_date")).toBe(
      "2026-10-01T00:00:00.000Z",
    )
    expect(read?.searchParams.get("end_date")).toBe("2026-10-02T00:00:00.000Z")
  })

  it("reads the deployment's values for an operator", async () => {
    const { calls } = mockApi({ rows: [entry()], deploymentOperator: true })
    renderFunnel("requests", "User", values("user"))
    await open("User")
    await waitFor(() => expect(reading(calls, "user")).toBeDefined())
    expect(reading(calls, "user")?.pathname).toBe(`${API_ROOT}/usage/groups`)
  })

  it("reads the organization's values for a member", async () => {
    const { calls } = mockApi({ rows: [entry()], deploymentOperator: false })
    renderFunnel("requests", "User", values("user"))
    await open("User")
    await waitFor(() => expect(reading(calls, "user")).toBeDefined())
    expect(reading(calls, "user")?.pathname).toBe(
      `${API_ROOT}/organizations/me/usage/groups`,
    )
  })

  it("scopes the read to the selected workspace", async () => {
    const { calls, mock } = mockApi({ rows: [entry()] })
    const answer = mock.getMockImplementation() as typeof fetch
    mock.mockImplementation(async (input, init) =>
      String(input).endsWith(`${API_ROOT}/organizations/me`)
        ? jsonResponse({
            ...(await operatorContext().json()),
            workspace_memberships: [
              { workspace_id: "ws-1", name: "Platform team", role: "owner" },
            ],
          })
        : answer(input, init),
    )
    renderFunnel("requests", "Model", values("model"))
    await open("Model")

    await waitFor(() =>
      expect(
        groupReads(calls).some(
          (url) => url.searchParams.get("workspace_id") === "ws-1",
        ),
      ).toBe(true),
    )
  })

  it("leaves its own filters out of its list and keeps the rest", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    renderFunnel(
      "requests",
      "Model",
      values("model", "provider"),
      "?model=gpt-4o&exclude_model=o1&user_id=alice&exclude_api_key_id=key-1&provider=openai&cost_gt=0.1",
    )
    await open("Model")

    await waitFor(() => expect(reading(calls, "provider")).toBeDefined())
    const model = reading(calls, "model")
    expect(model?.searchParams.getAll("user_id")).toEqual(["alice"])
    expect(model?.searchParams.getAll("exclude_api_key_id")).toEqual(["key-1"])
    expect(model?.searchParams.get("provider")).toBe("openai")
    expect(model?.searchParams.get("cost_gt")).toBe("0.1")
    expect(model?.searchParams.has("model")).toBe(false)
    expect(model?.searchParams.has("exclude_model")).toBe(false)
    const providers = reading(calls, "provider")
    expect(providers?.searchParams.getAll("model")).toEqual(["gpt-4o"])
    expect(providers?.searchParams.has("provider")).toBe(false)
  })

  it("searches on the server, and says how many more there are", async () => {
    const { calls } = mockApi({
      rows: Array.from({ length: 55 }, (_, index) =>
        entry({ id: `r${index}`, model: `model-${index}` }),
      ),
    })
    renderFunnel("requests", "Model", values("model"))
    const { user, panel } = await open("Model")

    expect(
      await within(panel).findByText("5 more, search to narrow"),
    ).toBeInTheDocument()
    await user.type(
      within(panel).getByRole("searchbox", { name: "Search Model values" }),
      "model-54",
    )
    await waitFor(() =>
      expect(
        groupReads(calls).some(
          (url) => url.searchParams.get("search") === "model-54",
        ),
      ).toBe(true),
    )
    expect(
      await within(panel).findByRole("checkbox", { name: "model-54" }),
    ).toBeInTheDocument()
  })
})

describe("ObserveColumnFilter writing the URL", () => {
  it("adds a checked value and returns to the first page", async () => {
    mockApi({ rows: [entry()] })
    renderFunnel("requests", "User", values("user"), "?user_id=alice&page=3")
    const { user, panel } = await open("User")

    await user.click(
      await within(panel).findByRole("checkbox", { name: "bob" }),
    )

    await waitFor(() =>
      expect(urlParams().getAll("user_id")).toEqual(["alice", "bob"]),
    )
    expect(urlParams().has("page")).toBe(false)
  })

  it("unchecks a picked value", async () => {
    mockApi({ rows: [entry()] })
    renderFunnel(
      "requests",
      "User",
      values("user"),
      "?user_id=alice&user_id=bob",
    )
    const { user, panel } = await open("User")

    const alice = await within(panel).findByRole("checkbox", { name: "alice" })
    expect(alice).toBeChecked()
    await user.click(alice)

    await waitFor(() => expect(urlParams().getAll("user_id")).toEqual(["bob"]))
  })

  it("excludes a value, and unpicks it if it was picked", async () => {
    mockApi({
      rows: [
        entry({ id: "a", model: "gpt-4o" }),
        entry({ id: "b", model: "o1" }),
      ],
    })
    renderFunnel("requests", "Model", values("model"), "?model=o1")
    const { user, panel } = await open("Model")

    await user.click(
      await within(panel).findByRole("button", { name: "Exclude o1" }),
    )

    await waitFor(() =>
      expect(urlParams().getAll("exclude_model")).toEqual(["o1"]),
    )
    expect(urlParams().has("model")).toBe(false)
    expect(within(panel).getByText("excluded")).toBeInTheDocument()

    // Picking it again takes it off the excluded list.
    await user.click(within(panel).getByRole("checkbox", { name: "o1" }))
    await waitFor(() => expect(urlParams().getAll("model")).toEqual(["o1"]))
    expect(urlParams().has("exclude_model")).toBe(false)
  })

  it("takes an id the window does not list on Enter", async () => {
    mockApi({ rows: [] })
    renderFunnel("requests", "Model", values("model"))
    const { user, panel } = await open("Model")

    const box = await within(panel).findByRole("searchbox", {
      name: "Search Model values",
    })
    await user.type(box, "some-unlisted-model{Enter}")

    await waitFor(() =>
      expect(urlParams().getAll("model")).toEqual(["some-unlisted-model"]),
    )
  })

  it("picks a subset of statuses on Requests, and counts each", async () => {
    mockApi({
      rows: [
        entry({ id: "a", status: "error" }),
        entry({ id: "b", status: "error" }),
      ],
    })
    renderFunnel("requests", "Status", values("status"), "?page=2")
    const { user, panel } = await open("Status")

    const error = within(panel).getByRole("checkbox", { name: "Error" })
    await waitFor(() =>
      expect(error.closest("div.flex")).toHaveTextContent("2"),
    )
    await user.click(error)
    await waitFor(() => expect(urlParams().get("status")).toBe("error"))
    expect(urlParams().has("page")).toBe(false)

    await user.click(within(panel).getByRole("checkbox", { name: "Absorbed" }))
    await waitFor(() =>
      expect(urlParams().getAll("status")).toEqual(["error", "absorbed"]),
    )
  })

  it("narrows by the way requests came in and by an empty column, and clears only its own", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    renderFunnel(
      "requests",
      "API key",
      [{ kind: "channel" }, { kind: "empty", field: "api_key" }],
      "?is_null=user",
    )
    const { user, panel } = await open("API key")

    await user.click(within(panel).getByRole("checkbox", { name: "Imported" }))
    await waitFor(() =>
      expect(urlParams().getAll("channel")).toEqual(["imported"]),
    )
    await user.click(
      within(panel).getByRole("checkbox", { name: "No API key" }),
    )
    await waitFor(() =>
      expect(urlParams().getAll("is_null")).toEqual(["user", "api_key"]),
    )
    await user.click(
      within(panel).getByRole("checkbox", { name: "No API key" }),
    )
    await waitFor(() => expect(urlParams().getAll("is_null")).toEqual(["user"]))
    await user.click(
      within(panel).getByRole("checkbox", { name: "No API key" }),
    )

    // Clearing the column leaves the User column's empty filter alone.
    await user.click(within(panel).getByRole("button", { name: /^Clear/ }))
    await waitFor(() => expect(urlParams().has("channel")).toBe(false))
    expect(urlParams().getAll("is_null")).toEqual(["user"])
    expect(calls.length).toBeGreaterThan(0)
  })

  it("shows the recovered attempts from the Status column", async () => {
    mockApi({ rows: [entry()] })
    renderFunnel("requests", "Status", [{ kind: "extra", key: "recovered" }])
    const { user, panel } = await open("Status")
    await user.click(
      within(panel).getByRole("checkbox", { name: "Show recovered attempts" }),
    )
    await waitFor(() => expect(urlParams().get("recovered")).toBe("show"))
  })

  it("offers Sessions only the outcomes a session has, and no exclusions", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    renderFunnel("sessions", "Levels", values("status"))
    const { panel } = await open("Levels")

    expect(
      within(panel)
        .getAllByRole("checkbox")
        .map((box) => box.closest("label")?.textContent),
    ).toEqual(["Success", "Error"])
    expect(within(panel).queryByRole("button", { name: /^Exclude/ })).toBeNull()
    expect(reading(calls, "status")).toBeUndefined()
  })

  it("offers the window's providers by name and writes the id", async () => {
    mockApi({
      rows: [
        entry({ id: "a", provider: "anthropic" }),
        entry({ id: "b", provider: "openai" }),
      ],
    })
    renderFunnel("requests", "Model", values("model", "provider"))
    const { user, panel } = await open("Model")

    const providers = within(panel).getByRole("group", { name: "Provider" })
    await user.click(
      await within(providers).findByRole("checkbox", { name: "Anthropic" }),
    )

    await waitFor(() => expect(urlParams().get("provider")).toBe("anthropic"))
  })

  it("clears everything the column filters, and only that", async () => {
    mockApi({ rows: [entry()] })
    renderFunnel(
      "requests",
      "Model",
      values("model", "provider"),
      "?model=gpt-4o&exclude_model=o1&provider=openai&status=error",
    )
    const { user, panel } = await open("Model")

    await user.click(
      within(panel).getByRole("button", { name: "Clear model filters" }),
    )

    await waitFor(() => expect(urlParams().has("model")).toBe(false))
    expect(urlParams().has("exclude_model")).toBe(false)
    expect(urlParams().has("provider")).toBe(false)
    expect(urlParams().get("status")).toBe("error")
  })

  it("leaves the request log's own sections out elsewhere", async () => {
    mockApi({ rows: [entry()] })
    renderFunnel("sessions", "Model", values("model", "provider"))
    const { panel } = await open("Model")

    expect(within(panel).queryByRole("group", { name: "Provider" })).toBeNull()
  })
})

describe("ObserveColumnFilter thresholds and extras", () => {
  it("shows only the rows above a threshold, and the priced or unpriced ones", async () => {
    mockApi({ rows: [entry()] })
    renderFunnel("requests", "Cost", [
      { kind: "threshold", key: "cost_gt" },
      { kind: "extra", key: "priced" },
    ])
    const { user, panel } = await open("Cost")

    await user.click(within(panel).getByRole("checkbox", { name: /0\.10/ }))
    await waitFor(() => expect(urlParams().get("cost_gt")).toBe("0.1"))

    await user.click(
      within(panel).getByRole("checkbox", { name: "Unpriced only" }),
    )
    await waitFor(() => expect(urlParams().get("priced")).toBe("false"))
    // The two are one choice: picking Priced only replaces Unpriced only.
    await user.click(
      within(panel).getByRole("checkbox", { name: "Priced only" }),
    )
    await waitFor(() => expect(urlParams().get("priced")).toBe("true"))
    expect(
      within(panel).getByRole("checkbox", { name: "Unpriced only" }),
    ).not.toBeChecked()
    expect(
      screen.getByRole("button", { name: "Filter Cost", hidden: true }),
    ).toHaveClass("text-accent")
  })

  it("lists the routing policies and keeps to direct requests", async () => {
    mockApi({
      rows: [
        entry({ id: "a", policy_name: "fast" }),
        entry({ id: "b", policy_name: null }),
      ],
    })
    renderFunnel("requests", "Routing", [
      { kind: "values", dimension: "policy" },
      { kind: "extra", key: "direct" },
    ])
    const { user, panel } = await open("Routing")

    expect(
      await within(panel).findByRole("checkbox", { name: "fast" }),
    ).toBeInTheDocument()
    await user.click(
      within(panel).getByRole("checkbox", { name: "Direct requests only" }),
    )
    await waitFor(() => expect(urlParams().get("routed")).toBe("false"))
  })

  it("is not drawn where the view reads no thresholds", async () => {
    mockApi({ rows: [entry()] })
    renderFunnel("sessions", "Cost", [{ kind: "threshold", key: "cost_gt" }])
    await waitFor(() => expect(document.querySelector("output")).not.toBeNull())
    expect(screen.queryByRole("button", { name: "Filter Cost" })).toBeNull()
  })
})

describe("ObserveColumnFilter source", () => {
  it("lists the sources to pick or leave out once there is more than one", async () => {
    mockApi({
      rows: [
        entry({ id: "a", source: "gateway" }),
        entry({ id: "b", source: "claude_code" }),
      ],
    })
    renderFunnel("requests", "API key", values("api_key", "source"))
    const { user, panel } = await open("API key")

    const sources = await within(panel).findByRole("group", { name: "Source" })
    await user.click(
      within(sources).getByRole("button", { name: "Exclude Claude Code" }),
    )
    await waitFor(() =>
      expect(urlParams().getAll("exclude_source")).toEqual(["claude_code"]),
    )
  })

  it("is left out where the window holds one source and none is filtered", async () => {
    const { calls } = mockApi({ rows: [entry({ source: "gateway" })] })
    renderFunnel("requests", "API key", values("api_key", "source"))
    const { panel } = await open("API key")

    await within(panel).findByRole("group", { name: "API key" })
    await waitFor(() => expect(reading(calls, "source")).toBeDefined())
    // Let the answer render before saying nothing did.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(within(panel).queryByRole("group", { name: "Source" })).toBeNull()
  })
})
