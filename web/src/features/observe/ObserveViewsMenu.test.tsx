import { useLocation } from "@tanstack/react-router"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SavedView } from "@/client"
import { useUrlState } from "@/shared/helpers/urlState"
import { mockApi, renderPage } from "@/tests/activity"
import { ObserveViewsMenu } from "./ObserveViewsMenu"

afterEach(() => {
  vi.restoreAllMocks()
})

const view = (overrides: Partial<SavedView>): SavedView => ({
  id: "built-in:all",
  page: "requests",
  name: "All requests",
  query: "",
  built_in: true,
  shared: false,
  is_mine: false,
  owner_name: null,
  can_edit: false,
  can_delete: false,
  updated_at: null,
  ...overrides,
})

const BUILT_IN = [
  view({}),
  view({
    id: "built-in:failures-this-week",
    name: "Failures this week",
    query: "range=7d&status=error",
  }),
]

const MINE = view({
  id: "v-1",
  name: "Slow gpt",
  query: "model=gpt-4o&latency_ms_gt=5000",
  built_in: false,
  is_mine: true,
  owner_name: "You",
  can_edit: true,
  can_delete: true,
  updated_at: "2026-11-20T00:00:00Z",
})

const THEIRS = view({
  id: "v-2",
  name: "Team errors",
  query: "status=error",
  built_in: false,
  shared: true,
  owner_name: "Mona Manager",
  updated_at: "2026-11-20T00:00:00Z",
})

function AddFilter() {
  const url = useUrlState({ cost_gt: "" })
  return (
    <button type="button" onClick={() => url.patch({ cost_gt: "0.4" })}>
      Add a filter
    </button>
  )
}

function UrlProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search in the URL">{searchStr}</output>
}

const urlParams = () =>
  new URLSearchParams(document.querySelector("output")?.textContent ?? "")

async function renderMenu(
  search = "",
  opts: Parameters<typeof mockApi>[0] = {},
) {
  const api = mockApi({
    workspace: "ws-1",
    savedViews: [...BUILT_IN, MINE, THEIRS],
    ...opts,
  })
  renderPage(
    <>
      <ObserveViewsMenu page="requests" />
      <AddFilter />
      <UrlProbe />
    </>,
    `/requests${search}`,
  )
  return api
}

const openMenu = async (name: RegExp) => {
  await userEvent.click(await screen.findByRole("button", { name }))
  return screen.findByRole("dialog", { name: "Views" })
}

describe("ObserveViewsMenu", () => {
  it("names the view the page shows, and marks it changed after a filter moves", async () => {
    await renderMenu("?status=error&range=7d")
    expect(
      await screen.findByRole("button", { name: "Views: Failures this week" }),
    ).toBeInTheDocument()
  })

  it("lists built-in, own and shared views, and applies one by replacing the filters", async () => {
    await renderMenu("?cost_gt=0.4&page=2")
    const menu = await openMenu(/^Views/)

    expect(
      within(menu).getByRole("group", { name: "Built in" }),
    ).toBeInTheDocument()
    expect(
      within(menu).getByRole("group", { name: "Yours" }),
    ).toHaveTextContent("Slow gpt")
    expect(
      within(menu).getByRole("group", { name: "Shared" }),
    ).toHaveTextContent("Mona Manager")

    await userEvent.click(
      within(menu).getByRole("option", { name: /^Slow gpt/ }),
    )

    await waitFor(() => expect(urlParams().get("model")).toBe("gpt-4o"))
    expect(urlParams().get("latency_ms_gt")).toBe("5000")
    expect(urlParams().has("cost_gt")).toBe(false)
    expect(urlParams().has("page")).toBe(false)
    expect(
      await screen.findByRole("button", { name: "Views: Slow gpt" }),
    ).toBeInTheDocument()
  })

  it("keeps the applied view's name, marked changed, and saves the change onto it", async () => {
    const { calls } = await renderMenu("?model=gpt-4o&latency_ms_gt=5000")
    await screen.findByRole("button", { name: "Views: Slow gpt" })

    await userEvent.click(screen.getByRole("button", { name: "Add a filter" }))

    const menu = await openMenu(/^Views: Slow gpt, changed$/)
    await userEvent.click(
      within(menu).getByRole("option", { name: "Save changes to Slow gpt" }),
    )
    await waitFor(() =>
      expect(calls.some((call) => call.method === "PATCH")).toBe(true),
    )
    const patch = calls.find((call) => call.method === "PATCH")
    expect(patch?.url).toContain("/saved-views/v-1")
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({
      query: "model=gpt-4o&cost_gt=0.4&latency_ms_gt=5000",
    })
    expect(
      await screen.findByRole("button", { name: "Views: Slow gpt" }),
    ).toBeInTheDocument()
  })

  it("saves the current view under a name, shared when the caller manages the workspace", async () => {
    const { calls } = await renderMenu("?model=b&model=a&status=error", {
      canShareViews: true,
    })
    const menu = await openMenu(/^Views/)
    await userEvent.click(
      within(menu).getByRole("option", { name: "Save current view…" }),
    )
    await userEvent.type(within(menu).getByLabelText("View name"), "Two models")
    await userEvent.click(within(menu).getByText("Share with the workspace"))
    await userEvent.click(within(menu).getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST")).toBe(true),
    )
    const post = calls.find((call) => call.method === "POST")
    expect(post?.url).toContain("/workspaces/ws-1/saved-views")
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      page: "requests",
      name: "Two models",
      query: "status=error&model=a&model=b",
      shared: true,
    })
    expect(
      await screen.findByRole("button", { name: "Views: Two models" }),
    ).toBeInTheDocument()
  })

  it("names a view just saved even where a built-in holds the same filters", async () => {
    await renderMenu("?status=error&range=7d")
    const menu = await openMenu(/^Views: Failures this week$/)
    await userEvent.click(
      within(menu).getByRole("option", { name: "Save current view…" }),
    )
    await userEvent.type(within(menu).getByLabelText("View name"), "Mine")
    await userEvent.click(within(menu).getByRole("button", { name: "Save" }))
    expect(
      await screen.findByRole("button", { name: "Views: Mine" }),
    ).toBeInTheDocument()
  })

  it("offers sharing only to someone who manages the workspace", async () => {
    await renderMenu()
    const menu = await openMenu(/^Views/)
    await userEvent.click(
      within(menu).getByRole("option", { name: "Save current view…" }),
    )
    expect(within(menu).queryByText("Share with the workspace")).toBeNull()
  })

  it("lets the owner of a shared view stop sharing it after losing the role", async () => {
    const demoted = view({
      ...MINE,
      id: "v-3",
      name: "Was shared",
      query: "status=success",
      shared: true,
      can_edit: false,
    })
    const { calls } = await renderMenu("?status=success", {
      savedViews: [...BUILT_IN, demoted],
    })
    const menu = await openMenu(/^Views: Was shared$/)
    expect(within(menu).queryByRole("option", { name: /^Rename/ })).toBeNull()
    await userEvent.click(
      within(menu).getByRole("option", { name: "Stop sharing Was shared" }),
    )
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "PATCH" &&
            call.url.endsWith("/saved-views/v-3") &&
            call.body === JSON.stringify({ shared: false }),
        ),
      ).toBe(true),
    )
  })

  it("offers changes only on a view the caller may change", async () => {
    await renderMenu("?status=error")
    const shared = await openMenu(/^Views: Team errors$/)
    expect(within(shared).queryByRole("option", { name: /^Rename/ })).toBeNull()
    expect(within(shared).queryByRole("option", { name: /^Delete/ })).toBeNull()
    await userEvent.click(
      within(shared).getByRole("option", { name: /^Slow gpt/ }),
    )
    const own = await openMenu(/^Views: Slow gpt$/)
    expect(
      within(own).getByRole("option", { name: "Rename Slow gpt…" }),
    ).toBeInTheDocument()
    expect(
      within(own).getByRole("option", { name: "Delete Slow gpt…" }),
    ).toBeInTheDocument()
  })

  it("renames the view it shows", async () => {
    const { calls } = await renderMenu("?model=gpt-4o&latency_ms_gt=5000")
    const menu = await openMenu(/^Views: Slow gpt$/)
    await userEvent.click(
      within(menu).getByRole("option", { name: "Rename Slow gpt…" }),
    )
    const field = within(menu).getByLabelText("New name")
    await userEvent.clear(field)
    await userEvent.type(field, "Slow")
    await userEvent.click(within(menu).getByRole("button", { name: "Rename" }))
    await waitFor(() =>
      expect(calls.some((call) => call.method === "PATCH")).toBe(true),
    )
    expect(
      JSON.parse(calls.find((call) => call.method === "PATCH")?.body ?? "{}"),
    ).toEqual({ name: "Slow" })
  })

  it("keeps the applied view in the URL, so a reload still names it and marks a change", async () => {
    await renderMenu("?model=gpt-4o&latency_ms_gt=5000&cost_gt=0.4&view=v-1")
    expect(
      await screen.findByRole("button", { name: "Views: Slow gpt, changed" }),
    ).toBeInTheDocument()
    expect(urlParams().get("view")).toBe("v-1")
  })

  it("names the applied view in the URL", async () => {
    await renderMenu("?cost_gt=0.4")
    const menu = await openMenu(/^Views/)
    await userEvent.click(
      within(menu).getByRole("option", { name: /^Slow gpt/ }),
    )
    await waitFor(() => expect(urlParams().get("view")).toBe("v-1"))
  })

  it("drops a view the URL names that is not listed", async () => {
    await renderMenu("?cost_gt=0.9&view=gone")
    await screen.findByRole("button", { name: "Views" })
    await waitFor(() => expect(urlParams().get("cost_gt")).toBe("0.9"))
    await waitFor(() => expect(urlParams().has("view")).toBe(false))
    expect(urlParams().get("cost_gt")).toBe("0.9")
  })

  it("drops the deleted view from the URL", async () => {
    await renderMenu("?model=gpt-4o&latency_ms_gt=5000&view=v-1")
    const menu = await openMenu(/^Views: Slow gpt$/)
    await userEvent.click(
      within(menu).getByRole("option", { name: "Delete Slow gpt…" }),
    )
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete view" }),
    )
    await waitFor(() => expect(urlParams().has("view")).toBe(false))
    expect(urlParams().get("model")).toBe("gpt-4o")
  })

  it("is not offered without a workspace to keep views in", async () => {
    mockApi({ savedViews: BUILT_IN })
    renderPage(<ObserveViewsMenu page="requests" />, "/requests")
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Views/ })).toBeNull(),
    )
  })
})
