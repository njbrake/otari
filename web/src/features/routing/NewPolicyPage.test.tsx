import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PolicySpec } from "@/client"
import { NewPolicyPage } from "@/features/routing/NewPolicyPage"
import { API_ROOT } from "@/shared/api/client"
import {
  apiKey,
  organizationContext,
  organizationMember,
} from "@/tests/fixtures"
import {
  ADMIN_WORKSPACE,
  adminContext,
  CHAIN,
  mockApi,
  policy,
  renderInWorkspace,
} from "@/tests/routing"

afterEach(() => {
  vi.restoreAllMocks()
})

type TestUser = ReturnType<typeof userEvent.setup>

// The caller's identity id in the fixtures, which their own rows carry.
const CALLER = "33333333-3333-3333-3333-333333333333"
const SAM = "77777777-7777-7777-7777-777777777777"

const OPENED = [{ path: "/routing/$name", element: <p>Opened</p> }]

function member() {
  return organizationContext({
    deployment_operator: false,
    role: "member",
    workspace_memberships: [
      { workspace_id: ADMIN_WORKSPACE, name: "Alpha one", role: "member" },
    ],
  })
}

async function pick(user: TestUser, field: RegExp, selector: string) {
  const box = screen.getByRole("combobox", { name: field })
  await user.clear(box)
  await user.type(box, selector)
  await user.keyboard("{Escape}")
}

/** The body of the one tenant policy write. */
function written(calls: { url: string; method: string; body: unknown }[]) {
  return calls.find(
    (call) =>
      call.method === "POST" &&
      call.url.endsWith(`${API_ROOT}/organizations/me/routing-policies`),
  )?.body as
    | {
        name: string
        spec: PolicySpec
        member_id?: string
        workspace_id: string
      }
    | undefined
}

async function nameAndMain(user: TestUser, name: string) {
  await user.type(
    await screen.findByRole("textbox", { name: /^policy name/i }),
    name,
  )
  await pick(user, /^the main model$/i, "openai:gpt-5")
}

describe("NewPolicyPage", () => {
  it("creates a workspace-wide policy for an admin and opens it", async () => {
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [],
    })
    const user = userEvent.setup()
    renderInWorkspace(<NewPolicyPage />, "/routing/new", OPENED)

    expect(
      await screen.findByRole("heading", { level: 1, name: "New policy" }),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create policy" })).toBeDisabled()
    await nameAndMain(user, "fast")
    await user.click(screen.getByRole("button", { name: "Add a backup" }))
    await pick(user, /^backup 1$/i, "anthropic:claude-haiku-4-5")
    await user.click(screen.getByRole("button", { name: "Create policy" }))

    expect(written(calls)).toEqual({
      name: "fast",
      spec: {
        select: [{ default: "openai:gpt-5" }],
        on_failure: ["anthropic:claude-haiku-4-5"],
      },
      workspace_id: ADMIN_WORKSPACE,
    })
    expect(await screen.findByText("Opened")).toBeInTheDocument()
  })

  it("lets an admin make it theirs alone, or one member's", async () => {
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [],
      members: [
        organizationMember({
          user_id: SAM,
          attribution_user_id: SAM,
          full_name: "Sam Rivera",
        }),
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(<NewPolicyPage />, "/routing/new", OPENED)

    await nameAndMain(user, "sams")
    await user.click(screen.getByRole("radio", { name: "One person" }))
    expect(
      screen.getByText(/Can't save: Pick the person it applies to/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Person/ }))
    await user.click(await screen.findByRole("option", { name: "Sam Rivera" }))
    await user.click(screen.getByRole("button", { name: "Create policy" }))
    expect(written(calls)?.member_id).toBe(SAM)
  })

  it("writes a member's policy as their own, with no choice of who", async () => {
    const { calls } = mockApi([], null, [], {
      context: member(),
      memberPolicies: [],
    })
    const user = userEvent.setup()
    renderInWorkspace(<NewPolicyPage />, "/routing/new", OPENED)

    expect(await screen.findByText("Just you")).toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "One person" })).toBeNull()
    // Rules route other members, which a member's own policy has none of.
    expect(screen.queryByRole("button", { name: /^Rules/ })).toBeNull()
    await nameAndMain(user, "mine")
    await user.click(screen.getByRole("button", { name: "Create policy" }))
    expect(written(calls)).toMatchObject({ name: "mine", member_id: CALLER })
  })

  it("refuses an alias's name, and a deployment policy's for the workspace", async () => {
    mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [
        policy("kimi", CHAIN, { source: "config", workspace_id: null }),
      ],
      memberAliases: [
        {
          name: "legacy",
          target: "openai:gpt-5",
          source: "stored",
          user_id: null,
          workspace_id: ADMIN_WORKSPACE,
        },
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(<NewPolicyPage />, "/routing/new")

    const name = await screen.findByRole("textbox", { name: /^policy name/i })
    await user.type(name, "legacy")
    expect(
      screen.getAllByText("legacy is an alias. Pick another name.").length,
    ).toBeGreaterThan(0)

    await user.clear(name)
    await user.type(name, "kimi")
    expect(
      screen.getAllByText(/A deployment policy is already called "kimi"/)
        .length,
    ).toBeGreaterThan(0)
    // Their own version of it is how a person overrides it.
    await user.click(screen.getByRole("radio", { name: "Just me" }))
    expect(
      screen.queryByText(/A deployment policy is already called/),
    ).toBeNull()
  })

  it("titles the page for the key it was opened from, on the model it sends", async () => {
    mockApi([], null, [], {
      context: member(),
      memberPolicies: [],
      keys: [apiKey({ id: "key-app", key_name: "thymeline-production" })],
    })
    renderInWorkspace(
      <NewPolicyPage />,
      "/routing/new?key=key-app&target=openai:gpt-5",
    )

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Routing for thymeline-production",
      }),
    ).toBeInTheDocument()
    const [main] = within(
      screen.getByRole("list", { name: "Tried in order" }),
    ).getAllByRole("listitem")
    expect(main).toHaveTextContent(/MAIN.*gpt-5 OpenAI/)
  })

  it("drops rules written for the workspace when it is made one person's", async () => {
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [],
      members: [
        organizationMember({
          user_id: SAM,
          attribution_user_id: SAM,
          full_name: "Sam Rivera",
        }),
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(<NewPolicyPage />, "/routing/new", OPENED)

    await nameAndMain(user, "fast")
    await user.click(screen.getByRole("button", { name: /^Rules/ }))
    await user.click(screen.getByRole("button", { name: "Add a rule" }))
    await user.click(screen.getByRole("combobox", { name: /^members/i }))
    await user.click(await screen.findByRole("option", { name: /Sam Rivera/ }))
    await user.keyboard("{Escape}")
    await pick(user, /^use$/i, "openai:gpt-5-mini")
    await user.click(screen.getByRole("radio", { name: "Just me" }))
    await user.click(screen.getByRole("button", { name: "Create policy" }))

    expect(written(calls)?.spec).toEqual({
      select: [{ default: "openai:gpt-5" }],
    })
  })

  it("says so when the caller may not create a policy here", async () => {
    mockApi([], null, [], {
      context: member(),
      memberPolicies: [],
      membersCreatePolicies: false,
    })
    renderInWorkspace(<NewPolicyPage />, "/routing/new")

    expect(
      await screen.findByRole("heading", {
        name: "You can't create a policy here",
      }),
    ).toBeInTheDocument()
  })
})
