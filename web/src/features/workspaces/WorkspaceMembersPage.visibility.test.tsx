/**
 * The Members page's "Workspace visibility" section: whether members who do
 * not manage the workspace see its totals. A file of its own because its mock
 * answers the visibility route, which the roster tests have no need of.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceMembersPage } from "@/features/workspaces/WorkspaceMembersPage"
import { API_ROOT } from "@/shared/api/client"
import { SelectedWorkspaceProvider } from "@/shared/hooks/SelectedWorkspace"
import {
  organizationContext,
  organizationMember,
  workspaceMember,
} from "@/tests/fixtures"
import { renderWithRouter } from "@/tests/router"

const ALPHA = "11111111-1111-1111-1111-111111111111"
const USER = "33333333-3333-3333-3333-333333333333"

interface Request {
  url: string
  method: string
  body: string | undefined
}

function mockApi({
  role = "admin",
  organizationRole = "owner",
  shown = true,
  patch,
  reread,
  isReadRefused = false,
}: {
  /** The caller's role in the workspace. */
  role?: string
  organizationRole?: "owner" | "admin" | "member" | "viewer"
  /** What the server has stored. */
  shown?: boolean
  /** How the server answers the write; it applies the change by default. */
  patch?: (body: string) => Promise<Response>
  /** Held open until it resolves: every read of the setting after the first. */
  reread?: Promise<void>
  /** The setting cannot be read at all. */
  isReadRefused?: boolean
} = {}) {
  const requests: Request[] = []
  // What the server has stored, which a write it accepts changes.
  let stored = shown
  let reads = 0
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? init.body : undefined
    requests.push({ url, method, body })
    if (url.endsWith(`${API_ROOT}/workspaces/${ALPHA}/visibility`)) {
      if (method === "PATCH") {
        const response = patch
          ? await patch(body ?? "")
          : Response.json({
              members_see_workspace_totals: stored,
              ...JSON.parse(body ?? "{}"),
            })
        if (response.ok) {
          stored = (await response.clone().json()).members_see_workspace_totals
        }
        return response
      }
      if (isReadRefused) {
        return Response.json(
          { detail: "The workspace's settings could not be read" },
          { status: 500 },
        )
      }
      reads += 1
      if (reads > 1 && reread) await reread
      return Response.json({ members_see_workspace_totals: stored })
    }
    if (url.includes(`${API_ROOT}/workspaces/${ALPHA}/members`)) {
      const members = [workspaceMember({ user_id: USER })]
      return Response.json({ data: members, count: members.length })
    }
    if (url.includes(`${API_ROOT}/organizations/me/members`)) {
      const members = [organizationMember({ user_id: USER })]
      return Response.json({ data: members, count: members.length })
    }
    return Response.json({
      ...organizationContext({ role: organizationRole }),
      workspace_memberships: [{ workspace_id: ALPHA, name: "Alpha", role }],
    })
  })
  return requests
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderWithRouter(
    <QueryClientProvider client={client}>
      <SelectedWorkspaceProvider>
        <WorkspaceMembersPage />
      </SelectedWorkspaceProvider>
    </QueryClientProvider>,
    { url: "/members" },
  )
}

const totalsSwitch = () =>
  screen.findByRole("switch", { name: "Workspace totals" })

/** The "A member will see" line about the workspace's totals. */
function totalsLine() {
  const list = screen.getByRole("list", { name: "A member will see" })
  return within(list).getByText(/^Workspace totals: spend/)
    .parentElement as HTMLElement
}

describe("WorkspaceMembersPage visibility", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it("shows a manager what members see, with the switch that changes it", async () => {
    mockApi()
    await renderPage()

    expect(
      await screen.findByRole("heading", { name: "Workspace visibility" }),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Owners and admins only · they always see everything"),
    ).toBeInTheDocument()
    await waitFor(async () =>
      expect(await totalsSwitch()).toHaveAttribute("aria-checked", "true"),
    )
    expect(totalsLine()).toHaveTextContent(/^Shown:/)
    expect(
      within(screen.getByRole("list", { name: "A member will see" })).getByText(
        "Anyone else’s individual requests",
      ).parentElement,
    ).toHaveTextContent(/^Not shown:/)
  })

  it("hides the section from a member, and asks nothing about it", async () => {
    const requests = mockApi({ role: "member", organizationRole: "member" })
    await renderPage()

    await screen.findByText("Members of Alpha")
    expect(
      screen.queryByRole("heading", { name: "Workspace visibility" }),
    ).toBeNull()
    expect(
      screen.queryByRole("switch", { name: "Workspace totals" }),
    ).toBeNull()
    expect(
      requests.some((request) => request.url.includes("/visibility")),
    ).toBe(false)
  })

  it("saves only the change with a PATCH, moving the switch before the server answers", async () => {
    let answer: (response: Response) => void = () => {}
    const requests = mockApi({
      patch: () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        }),
    })
    const user = userEvent.setup()
    await renderPage()

    const toggle = await totalsSwitch()
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)

    // Off at once, while the write is still in flight.
    expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(totalsLine()).toHaveTextContent(/^Not shown:/)
    const saved = requests.find((request) => request.method === "PATCH")
    expect(saved?.url).toContain(`/workspaces/${ALPHA}/visibility`)
    expect(JSON.parse(saved?.body ?? "{}")).toEqual({
      members_see_workspace_totals: false,
    })
    answer(Response.json({ members_see_workspace_totals: false }))
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
  })

  it("holds the switch while a save is in flight, so a second press cannot race it", async () => {
    let answer: (response: Response) => void = () => {}
    const requests = mockApi({
      patch: () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        }),
    })
    const user = userEvent.setup()
    await renderPage()

    const toggle = await totalsSwitch()
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    expect(toggle).toBeDisabled()
    await user.click(toggle)
    expect(
      requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(1)
    expect(toggle).toHaveAttribute("aria-checked", "false")

    answer(Response.json({ members_see_workspace_totals: false }))
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute("aria-checked", "false")
    // The saved answer is the setting; nothing reads it again.
    expect(
      requests.filter(
        (request) =>
          request.method === "GET" && request.url.endsWith("/visibility"),
      ),
    ).toHaveLength(1)
  })

  it("puts the switch back and says why when the save is refused", async () => {
    let refuse: (response: Response) => void = () => {}
    // The read that follows a refusal is held, so the switch coming back is
    // the rollback's doing and not that read's.
    let release: () => void = () => {}
    const reread = new Promise<void>((resolve) => {
      release = resolve
    })
    mockApi({
      patch: () =>
        new Promise<Response>((resolve) => {
          refuse = resolve
        }),
      reread,
    })
    const user = userEvent.setup()
    await renderPage()

    const toggle = await totalsSwitch()
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-checked", "false")

    refuse(
      Response.json(
        { detail: "Only a workspace manager can change this" },
        { status: 403 },
      ),
    )
    expect(
      await screen.findByText("Only a workspace manager can change this"),
    ).toBeInTheDocument()
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"))
    expect(totalsLine()).toHaveTextContent(/^Shown:/)
    release()
  })

  it("keeps the switch withheld and says why when the setting cannot be read", async () => {
    mockApi({ isReadRefused: true })
    await renderPage()

    expect(
      await screen.findByText("The workspace's settings could not be read"),
    ).toBeInTheDocument()
    expect(await totalsSwitch()).toBeDisabled()
    // Nothing is claimed about a setting that could not be read.
    expect(totalsLine()).not.toHaveTextContent(/Shown:/)
  })
})
