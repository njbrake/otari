import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PolicySpec } from "@/client"
import { PolicyDetailPage } from "@/features/routing/PolicyDetailPage"
import { API_ROOT } from "@/shared/api/client"
import { organizationContext, organizationMember } from "@/tests/fixtures"
import {
  ADMIN_WORKSPACE,
  adminContext,
  CHAIN,
  LEARNED,
  mockApi,
  policy,
  policyWrites,
  renderInWorkspace,
  renderPage,
  WEIGHTED,
} from "@/tests/routing"

afterEach(() => {
  vi.restoreAllMocks()
})

type TestUser = ReturnType<typeof userEvent.setup>

/** Every section a policy can combine, at once. */
const COMBINED: PolicySpec = {
  select: [
    { when: { budget_used_pct: { gte: 80 } }, target: "openai:gpt-5-nano" },
    {
      router: "weighted",
      candidates: ["openai:gpt-5", "anthropic:claude-sonnet-4-5"],
      weights: { "openai:gpt-5": 70, "anthropic:claude-sonnet-4-5": 30 },
    },
    { default: "openai:gpt-5" },
  ],
  on_failure: ["anthropic:claude-haiku-4-5"],
  guardrails: [{ profile: "pii", mode: "monitor", on_unavailable: "monitor" }],
}

const MOVED = [
  { path: "/routing/$name", element: <p>Moved</p> },
  { path: "/routing", element: <p>Back on the list</p> },
]

function renderPolicy(name: string, url = `/routing/${name}`) {
  return renderPage(<PolicyDetailPage name={name} />, url, MOVED)
}

/** The main selection, for queries inside it. */
async function mainSelection() {
  return within(await screen.findByRole("region", { name: "Main selection" }))
}

/** Open a folded section by its label. */
async function unfold(user: TestUser, label: string) {
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`^${label}`) }),
  )
}

/** The models of a list, as each row reads. */
function listed(label: string) {
  return within(screen.getByRole("list", { name: label }))
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "")
}

async function save(user: TestUser) {
  await user.click(screen.getByRole("button", { name: "Save" }))
}

async function pick(user: TestUser, field: RegExp, selector: string) {
  const box = screen.getByRole("combobox", { name: field })
  await user.clear(box)
  await user.type(box, selector)
  await user.keyboard("{Escape}")
}

function lastWrite(calls: { url: string; method: string; body: unknown }[]) {
  const writes = policyWrites(calls)
  expect(writes.length).toBeGreaterThan(0)
  return writes[writes.length - 1]
}

describe("PolicyDetailPage", () => {
  it("shows the plan in the order it is tried, with nothing to save yet", async () => {
    mockApi([policy("fast", CHAIN)])
    renderPolicy("fast")

    expect(
      await screen.findByRole("heading", { level: 1, name: "fast" }),
    ).toBeInTheDocument()
    expect(await mainSelection()).toBeTruthy()
    const [main, backup] = listed("Tried in order")
    expect(main).toMatch(/MAIN.*gpt-5-mini OpenAI/)
    expect(backup).toMatch(/BACKUP 1.*claude-haiku-4-5 Anthropic/)
    expect(screen.getByText("Everyone in this workspace")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Routing" })).toHaveAttribute(
      "href",
      "/routing",
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled()
    expect(
      screen.getByText(
        /missing or rejected provider key, or a request it refuses as invalid/,
      ),
    ).toBeInTheDocument()
  })

  it("saves a change to one section with every other written back as stored", async () => {
    const { calls } = mockApi([policy("mixed", COMBINED)])
    const user = userEvent.setup()
    renderPolicy("mixed")

    const shares = await screen.findAllByRole("textbox", { name: /share/i })
    expect(shares.map((share) => (share as HTMLInputElement).value)).toEqual([
      "70",
      "30",
    ])
    await unfold(user, "Budget tier-down")
    expect(
      screen.getByRole("textbox", { name: /budget used at least/i }),
    ).toHaveValue("80")
    await unfold(user, "Guardrails")
    expect(screen.getByRole("textbox", { name: /profile/i })).toHaveValue("pii")

    // An existing policy may keep no backup at all.
    await user.click(screen.getByRole("button", { name: "Remove backup 1" }))
    await save(user)

    const { on_failure, ...rest } = COMBINED
    expect(on_failure).toHaveLength(1)
    expect(lastWrite(calls).spec).toEqual(rest)
    expect(lastWrite(calls).name).toBe("mixed")
  })

  it("saves changes to several sections in one write", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await user.click(
      await screen.findByRole("button", { name: "Remove backup 1" }),
    )
    await unfold(user, "Budget tier-down")
    await user.click(screen.getByRole("button", { name: "Add a tier" }))
    await pick(user, /^use instead$/i, "openai:gpt-5-nano")
    await save(user)

    expect(policyWrites(calls)).toHaveLength(1)
    expect(lastWrite(calls).spec).toEqual({
      select: [
        { when: { budget_used_pct: { gte: 80 } }, target: "openai:gpt-5-nano" },
        { default: "openai:gpt-5-mini" },
      ],
    })
  })

  it("makes a backup the main model by moving it up", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await user.click(
      await screen.findByRole("button", { name: "Move backup 1 up" }),
    )
    expect(listed("Tried in order")[0]).toMatch(/MAIN.*claude-haiku-4-5/)
    // The main model has no row above it to move to.
    expect(
      screen.getByRole("button", { name: "Move the main model up" }),
    ).toBeDisabled()
    await save(user)

    expect(lastWrite(calls).spec).toEqual({
      select: [{ default: "anthropic:claude-haiku-4-5" }],
      on_failure: ["openai:gpt-5-mini"],
    })
  })

  it("reorders by dragging a row's handle onto another row", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await screen.findByRole("list", { name: "Tried in order" })
    const [mainRow, backupRow] = within(
      screen.getByRole("list", { name: "Tried in order" }),
    ).getAllByRole("listitem")
    const handle = backupRow.querySelector("[data-model-drag]")!
    fireEvent.dragStart(handle)
    fireEvent.dragOver(mainRow)
    fireEvent.drop(mainRow)

    expect(listed("Tried in order")[0]).toMatch(/MAIN.*claude-haiku-4-5/)
    await save(user)
    expect(lastWrite(calls).spec).toEqual({
      select: [{ default: "anthropic:claude-haiku-4-5" }],
      on_failure: ["openai:gpt-5-mini"],
    })
  })

  it("shows what each model did in 30 days, by the model rather than the row", async () => {
    mockApi([policy("fast", CHAIN)], null, [], {
      traffic: [
        {
          workspace_id: "11111111-1111-1111-1111-111111111111",
          name: "fast",
          user_id: null,
          requests: 10,
          sent_by: [],
          steps: [
            { position: 1, served: 7, failed: 3 },
            { position: 2, served: 3, failed: 0 },
          ],
        },
      ],
    })
    const user = userEvent.setup()
    renderPolicy("fast")

    expect(await screen.findByText("3 failed over (30d)")).toBeInTheDocument()
    expect(screen.getByText("Served 3 (30d)")).toBeInTheDocument()
    expect(
      screen.getByText(/In use: 10 requests in 30 days/),
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Move backup 1 up" }))
    // Still the backup's numbers, on the row it moved to.
    expect(listed("Tried in order")[0]).toMatch(/Served 3 \(30d\)/)

    await user.click(screen.getByRole("button", { name: "Add a backup" }))
    await pick(user, /^backup 2$/i, "openai:gpt-5")
    expect(screen.getByText("New, no history")).toBeInTheDocument()
  })

  it("says when nothing sends the name yet", async () => {
    mockApi([policy("fast", CHAIN)])
    renderPolicy("fast")

    expect(
      await screen.findByText(
        'Not used yet: nothing has sent "fast" in 30 days.',
      ),
    ).toBeInTheDocument()
  })

  it("discards every unsaved change at once", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await user.click(
      await screen.findByRole("button", { name: "Remove backup 1" }),
    )
    expect(listed("Tried in order")).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "Discard" }))

    expect(listed("Tried in order")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(policyWrites(calls)).toHaveLength(0)
  })

  it("renames a policy with the rest of the save, and follows it to its new address", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await user.click(await screen.findByRole("button", { name: "Rename" }))
    const name = screen.getByRole("textbox", { name: /^name$/i })
    await user.clear(name)
    await user.type(name, "speedy")
    expect(
      screen.getByText(/Callers have to send the new name/),
    ).toBeInTheDocument()
    await save(user)

    const body = lastWrite(calls) as { name: string; rename_from?: string }
    expect(body.name).toBe("speedy")
    expect(body.rename_from).toBe("fast")
    expect(lastWrite(calls).spec).toEqual(CHAIN)
    expect(await screen.findByText("Moved")).toBeInTheDocument()
  })

  it("omits rename_from when the name stays", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await user.click(
      await screen.findByRole("button", { name: "Remove backup 1" }),
    )
    await save(user)

    const body = lastWrite(calls) as { rename_from?: string; spec: PolicySpec }
    expect(body.rename_from).toBeUndefined()
    expect(body.spec).toEqual({ select: [{ default: "openai:gpt-5-mini" }] })
  })

  it("refuses a new name that carries a delimiter", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await user.click(await screen.findByRole("button", { name: "Rename" }))
    const name = screen.getByRole("textbox", { name: /^name$/i })
    await user.clear(name)
    await user.type(name, "openai:gpt-5")

    expect(screen.getAllByText(/cannot contain/).length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(policyWrites(calls)).toHaveLength(0)
  })

  it("adds a split to a plain fallback, starting from its main model", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await user.click(
      await screen.findByRole("radio", { name: "Split traffic" }),
    )
    expect(listed("Pool")[0]).toMatch(/DEFAULT.*gpt-5-mini/)
    await pick(user, /^pool model 2$/i, "anthropic:claude-sonnet-4-5")
    await save(user)

    expect(lastWrite(calls).spec).toEqual({
      select: [
        {
          router: "weighted",
          candidates: ["openai:gpt-5-mini", "anthropic:claude-sonnet-4-5"],
          weights: {
            "openai:gpt-5-mini": 50,
            "anthropic:claude-sonnet-4-5": 50,
          },
        },
        { default: "openai:gpt-5-mini" },
      ],
      // The backup carries over as the pool's backup.
      on_failure: ["anthropic:claude-haiku-4-5"],
    })
  })

  it("goes back to one model, the pool's default", async () => {
    const { calls } = mockApi([policy("smart", LEARNED, { is_dynamic: true })])
    const user = userEvent.setup()
    renderPolicy("smart")

    await user.click(await screen.findByRole("radio", { name: "One model" }))
    await save(user)

    expect(lastWrite(calls).spec).toEqual({
      select: [{ default: "openai:gpt-5" }],
    })
  })

  it("puts the fallthrough in the pool, marked as its default", async () => {
    mockApi([
      policy("smart", {
        select: [
          { router: "knn", candidates: ["openai:gpt-5-nano"] },
          { default: "openai:gpt-5" },
        ],
      }),
    ])
    renderPolicy("smart")

    await mainSelection()
    await screen.findByRole("list", { name: "Pool" })
    const [first, second] = listed("Pool")
    expect(first).toMatch(/MODEL.*gpt-5-nano/)
    expect(second).toMatch(/DEFAULT.*gpt-5 OpenAI/)
    expect(screen.queryByRole("list", { name: "Tried in order" })).toBeNull()
  })

  it("making another model the default changes the saved default, not the pool", async () => {
    const { calls } = mockApi([policy("smart", LEARNED, { is_dynamic: true })])
    const user = userEvent.setup()
    renderPolicy("smart")

    await user.click(
      await screen.findByRole("button", { name: "Make default" }),
    )
    await save(user)

    expect(lastWrite(calls).spec.select).toEqual([
      { router: "knn", candidates: ["openai:gpt-5-nano", "openai:gpt-5"] },
      { default: "openai:gpt-5-nano" },
    ])
  })

  it("adds a backup to a learned policy and keeps its pool", async () => {
    const { calls } = mockApi([policy("smart", LEARNED, { is_dynamic: true })])
    const user = userEvent.setup()
    renderPolicy("smart")

    await user.click(
      await screen.findByRole("button", { name: "Add a backup" }),
    )
    await pick(user, /^backup 1$/i, "anthropic:claude-haiku-4-5")
    await save(user)

    expect(lastWrite(calls).spec).toEqual({
      ...LEARNED,
      on_failure: ["anthropic:claude-haiku-4-5"],
    })
  })

  it("orders a spill-over policy's models, and says what fills one", async () => {
    mockApi([
      policy(
        "spill",
        {
          select: [
            {
              router: "priority",
              candidates: ["openai:gpt-5-mini", "openai:gpt-5"],
            },
            { default: "openai:gpt-5" },
          ],
        },
        { is_dynamic: true },
      ),
    ])
    renderPolicy("spill")

    expect(
      await screen.findByRole("radio", { name: "Spill over" }),
    ).toBeChecked()
    expect(
      screen.getByRole("button", { name: "Move pool model 1 up" }),
    ).toBeDisabled()
    expect(
      screen.getByRole("link", { name: "Settings, Rate limit rules" }),
    ).toHaveAttribute("href", "/settings")
  })

  it("drains a model from a split without removing it", async () => {
    const { calls } = mockApi([
      policy("balanced", WEIGHTED, { is_dynamic: true }),
    ])
    const user = userEvent.setup()
    renderPolicy("balanced")

    const shares = await screen.findAllByRole("textbox", { name: /share/i })
    await user.clear(shares[1])
    await user.type(shares[1], "0")
    expect(
      screen.getByText("No traffic; still tried if another fails"),
    ).toBeInTheDocument()
    await save(user)

    expect(lastWrite(calls).spec.select[0]).toEqual({
      router: "weighted",
      candidates: ["openai:gpt-5", "anthropic:claude-sonnet-4-5"],
      weights: { "openai:gpt-5": 70, "anthropic:claude-sonnet-4-5": 0 },
    })
  })

  it("keeps a fractional share typeable and refuses a non-numeric one", async () => {
    const { calls } = mockApi([
      policy("balanced", WEIGHTED, { is_dynamic: true }),
    ])
    const user = userEvent.setup()
    renderPolicy("balanced")

    const shares = await screen.findAllByRole("textbox", { name: /share/i })
    const saveButton = screen.getByRole("button", { name: "Save" })
    await user.clear(shares[0])
    await user.type(shares[0], "Infinity")
    expect(
      screen.getByText(/Every share is a number of zero or more/),
    ).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    await user.clear(shares[0])
    await user.type(shares[0], "-5")
    expect(saveButton).toBeDisabled()

    await user.clear(shares[0])
    await user.type(shares[0], "7.5")
    expect(shares[0]).toHaveValue("7.5")
    await user.click(saveButton)

    expect(lastWrite(calls).spec.select[0].weights).toEqual({
      "openai:gpt-5": 7.5,
      "anthropic:claude-sonnet-4-5": 30,
    })
  })

  it("saves a loosely spelled backend back under its normal name", async () => {
    const loose: PolicySpec = {
      select: [
        { ...WEIGHTED.select[0], router: " Weighted " },
        WEIGHTED.select[1],
      ],
    }
    const { calls } = mockApi([policy("balanced", loose, { is_dynamic: true })])
    const user = userEvent.setup()
    renderPolicy("balanced")

    expect(
      await screen.findByRole("radio", { name: "Split traffic" }),
    ).toBeChecked()
    await user.click(screen.getByRole("button", { name: "Add a backup" }))
    await pick(user, /^backup 1$/i, "openai:gpt-5-mini")
    await save(user)

    expect(lastWrite(calls).spec.select[0]).toEqual(WEIGHTED.select[0])
  })

  it("marks a Smart router pool model with no price, and holds the save", async () => {
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [
        policy("smart", LEARNED, {
          workspace_id: ADMIN_WORKSPACE,
          is_dynamic: true,
        }),
      ],
      unpriced: ["openai:gpt-5-nano"],
    })
    const user = userEvent.setup()
    renderInWorkspace(<PolicyDetailPage name="smart" />, "/routing/smart")

    expect(await screen.findByText("No price set")).toBeInTheDocument()
    expect(listed("Pool")[0]).toMatch(/gpt-5-nano.*No price set/)
    expect(
      screen.getByRole("link", { name: "Set a price in Pricing" }),
    ).toHaveAttribute("href", "/organization/pricing")
    const asked = calls.find((call) => call.url.includes("/unpriced"))
    expect(asked?.url).toContain(`workspace_id=${ADMIN_WORKSPACE}`)

    await user.click(screen.getByRole("button", { name: "Make default" }))
    expect(
      screen.getByText(
        /Can't save: gpt-5-nano has no price, and Smart router needs one/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    // A split weighs by share, not price, so nothing is asked or held.
    await user.click(screen.getByRole("radio", { name: "Split traffic" }))
    expect(screen.queryByText("No price set")).toBeNull()
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("will not save a split where every share is zero, or one naming a model twice", async () => {
    const { calls } = mockApi([
      policy("balanced", WEIGHTED, { is_dynamic: true }),
    ])
    const user = userEvent.setup()
    renderPolicy("balanced")

    for (const share of await screen.findAllByRole("textbox", {
      name: /share/i,
    })) {
      await user.clear(share)
      await user.type(share, "0")
    }
    expect(
      screen.getByText(/at least one model a share above zero/i),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    await user.click(
      screen.getByRole("button", { name: "Change pool model 2" }),
    )
    await pick(user, /^pool model 2$/i, "openai:gpt-5")
    expect(screen.getByText(/name each model once/i)).toBeInTheDocument()
    expect(policyWrites(calls)).toHaveLength(0)
  })

  it("adds a model to a split with no traffic until a share is set", async () => {
    mockApi([policy("balanced", WEIGHTED, { is_dynamic: true })])
    const user = userEvent.setup()
    renderPolicy("balanced")

    await user.click(await screen.findByRole("button", { name: "Add to pool" }))
    expect(screen.getAllByRole("textbox", { name: /share/i })[2]).toHaveValue(
      "0",
    )
  })

  it("counts the pool and the backups against one cap", async () => {
    mockApi([
      policy("wide", {
        select: [
          {
            router: "knn",
            candidates: [
              "openai:gpt-5-nano",
              "openai:gpt-5-mini",
              "openai:gpt-5",
            ],
          },
          { default: "openai:gpt-5" },
        ],
        on_failure: ["anthropic:claude-haiku-4-5", "openai:gpt-4o"],
      }),
    ])
    renderPolicy("wide")

    expect(
      await screen.findByRole("button", { name: "Add a backup" }),
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "Add to pool" })).toBeDisabled()
    expect(
      screen.getAllByText(/tries at most 5 models, counting the backups/)
        .length,
    ).toBeGreaterThan(0)
  })

  it("adds a budget tier and refuses one that could never fire", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await unfold(user, "Budget tier-down")
    await user.click(screen.getByRole("button", { name: "Add a tier" }))
    await pick(user, /^use instead$/i, "openai:gpt-5-nano")
    const threshold = screen.getByRole("textbox", {
      name: /budget used at least/i,
    })
    await user.clear(threshold)
    await user.type(threshold, "100")
    expect(screen.getByText("Must be under 100.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    await user.clear(threshold)
    await user.type(threshold, "90")
    await save(user)
    expect(lastWrite(calls).spec).toEqual({
      select: [
        { when: { budget_used_pct: { gte: 90 } }, target: "openai:gpt-5-nano" },
        { default: "openai:gpt-5-mini" },
      ],
      on_failure: ["anthropic:claude-haiku-4-5"],
    })
  })

  it("saves several budget tiers highest first, so each one can fire", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await unfold(user, "Budget tier-down")
    await user.click(screen.getByRole("button", { name: "Add a tier" }))
    await user.click(screen.getByRole("button", { name: "Add another tier" }))
    const [low, high] = screen.getAllByRole("combobox", {
      name: /^use instead$/i,
    })
    await user.type(low, "openai:gpt-5-nano")
    await user.keyboard("{Escape}")
    await user.type(high, "anthropic:claude-haiku-4-5")
    await user.keyboard("{Escape}")
    expect(
      screen.getAllByRole("textbox", { name: /budget used at least/i }),
    ).toHaveLength(2)
    await save(user)

    expect(lastWrite(calls).spec.select).toEqual([
      {
        when: { budget_used_pct: { gte: 85 } },
        target: "anthropic:claude-haiku-4-5",
      },
      { when: { budget_used_pct: { gte: 80 } }, target: "openai:gpt-5-nano" },
      { default: "openai:gpt-5-mini" },
    ])
  })

  it("adds a guardrail, warning when it makes the service a hard dependency", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await unfold(user, "Guardrails")
    expect(
      screen.getByRole("link", { name: "Guardrails page" }),
    ).toHaveAttribute("href", "/tools/guardrails")
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add a guardrail" }),
      ).toBeEnabled(),
    )
    await user.click(screen.getByRole("button", { name: "Add a guardrail" }))
    expect(
      screen.getByText(/rejects every request through this policy/),
    ).toBeInTheDocument()
    await user.type(
      screen.getByRole("textbox", { name: /profile/i }),
      "prompt-injection",
    )
    await save(user)

    expect(lastWrite(calls).spec.guardrails).toEqual([
      { profile: "prompt-injection", mode: "block", on_unavailable: "block" },
    ])
  })

  it("disables adding a guardrail when no guardrails service is configured", async () => {
    mockApi([policy("fast", CHAIN)], null)
    const user = userEvent.setup()
    renderPolicy("fast")

    await unfold(user, "Guardrails")
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add a guardrail" }),
      ).toBeDisabled(),
    )
    expect(
      screen.getByText(/No guardrails service is configured/),
    ).toBeInTheDocument()
  })

  it("shows the policy as live JSON, unsaved changes included", async () => {
    mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await unfold(user, "As JSON")
    expect(screen.getByText(/"on_failure"/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Remove backup 1" }))
    expect(screen.queryByText(/"on_failure"/)).toBeNull()
    expect(
      screen.getByRole("button", {
        name: /^As JSON.*Includes unsaved changes/,
      }),
    ).toBeInTheDocument()
  })

  it("deletes the policy after confirming, and goes back to the list", async () => {
    const { calls } = mockApi([policy("fast", CHAIN)])
    const user = userEvent.setup()
    renderPolicy("fast")

    await user.click(
      await screen.findByRole("button", { name: "Delete policy" }),
    )
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete policy",
      }),
    )

    expect(await screen.findByText("Back on the list")).toBeInTheDocument()
    expect(calls.some((call) => call.method === "DELETE")).toBe(true)
  })

  it("opens the user's own row when the address names one", async () => {
    mockApi([
      policy("cheap", CHAIN),
      policy("cheap", LEARNED, { user_id: "u-bob" }),
    ])
    renderPolicy("cheap", "/routing/cheap?user=u-bob")

    await screen.findByRole("list", { name: "Pool" })
    expect(listed("Pool")[0]).toMatch(/gpt-5-nano/)
    expect(screen.getByText("u-bob")).toBeInTheDocument()
  })

  it("says so when the policy is not there", async () => {
    mockApi([policy("fast", CHAIN)])
    renderPolicy("gone")

    expect(
      await screen.findByRole("heading", { name: "Policy not found" }),
    ).toBeInTheDocument()
  })
})

describe("PolicyDetailPage for an alias", () => {
  const ALIAS = {
    name: "legacy",
    target: "openai:gpt-4o-mini",
    source: "stored",
    user_id: null,
  }

  it("keeps the name fixed and offers only the one target", async () => {
    mockApi([], "http://guardrails:8000", [ALIAS])
    renderPolicy("legacy")

    expect(
      await screen.findByText(/go to that model as written, with no backup/),
    ).toBeInTheDocument()
    expect(screen.getByText("ALIAS")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Delete alias" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Add a backup" })).toBeNull()
    expect(screen.queryByRole("radio", { name: "Split traffic" })).toBeNull()
    // The operator surface has no one-step swap, so it says how instead.
    expect(
      screen.queryByRole("button", { name: "Turn into a policy" }),
    ).toBeNull()
    expect(
      screen.getByText(/delete it and create a policy with the same name/),
    ).toBeInTheDocument()
  })

  it("writes an alias edit back to the alias's own workspace", async () => {
    const OTHER_WORKSPACE = "66666666-6666-6666-6666-666666666666"
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [],
      memberAliases: [
        {
          name: "elsewhere-alias",
          target: "openai:gpt-5",
          source: "stored",
          user_id: null,
          workspace_id: OTHER_WORKSPACE,
        },
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(
      <PolicyDetailPage name="elsewhere-alias" />,
      "/routing/elsewhere-alias",
    )

    await screen.findByRole("combobox", { name: /^points to/i })
    await pick(user, /^points to/i, "openai:gpt-5-mini")
    await save(user)

    const written = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.includes(`${API_ROOT}/organizations/me/aliases`),
    )
    expect(written?.body).toMatchObject({
      name: "elsewhere-alias",
      target: "openai:gpt-5-mini",
      workspace_id: OTHER_WORKSPACE,
    })
  })

  it("turns an alias into a policy of the same name in one write", async () => {
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [],
      memberAliases: [
        {
          name: "fast",
          target: "openai:gpt-5",
          source: "stored",
          user_id: null,
          workspace_id: ADMIN_WORKSPACE,
        },
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(<PolicyDetailPage name="fast" />, "/routing/fast")

    await user.click(
      await screen.findByRole("button", { name: "Turn into a policy" }),
    )
    expect(listed("Tried in order")[0]).toMatch(/MAIN.*gpt-5 OpenAI/)
    await user.click(screen.getByRole("button", { name: "Add a backup" }))
    await pick(user, /^backup 1$/i, "anthropic:claude-haiku-4-5")
    await save(user)

    const written = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.includes(`${API_ROOT}/organizations/me/routing-policies`),
    )
    expect(written?.body).toEqual({
      name: "fast",
      spec: {
        select: [{ default: "openai:gpt-5" }],
        on_failure: ["anthropic:claude-haiku-4-5"],
      },
      workspace_id: ADMIN_WORKSPACE,
      replaces_alias: true,
    })
  })
})

describe("PolicyDetailPage read-only", () => {
  it("shows a config.yml policy without a control that writes", async () => {
    mockApi()
    renderPolicy("auto")

    expect(
      await screen.findByText(/Set in the deployment's config.yml/),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText("Deployment")).toBeInTheDocument()
    expect(
      screen.getAllByText("80% → gpt-5-nano · OpenAI").length,
    ).toBeGreaterThan(0)
  })

  it("shows a policy it cannot edit without loss, with its spec in full", async () => {
    mockApi([
      policy("api-authored", {
        select: [
          { when: { key_id: "k-1" }, target: "openai:gpt-5-nano" },
          { default: "openai:gpt-5-mini" },
        ],
      }),
    ])
    renderPolicy("api-authored")

    expect(
      await screen.findByText(/Uses options this page cannot show yet/),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    expect(screen.getByText(/"key_id": "k-1"/)).toBeInTheDocument()
  })
})

describe("PolicyDetailPage for a member", () => {
  const MEMBER_ID = "33333333-3333-3333-3333-333333333333"
  const member = () =>
    organizationContext({
      deployment_operator: false,
      role: "member",
      workspace_memberships: [
        { workspace_id: ADMIN_WORKSPACE, name: "Alpha one", role: "member" },
      ],
    })

  it("shows a shared policy read-only, with the way to make their own", async () => {
    const { calls } = mockApi([], null, [], {
      context: member(),
      memberPolicies: [
        policy("fast", CHAIN, { workspace_id: ADMIN_WORKSPACE }),
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(<PolicyDetailPage name="fast" />, "/routing/fast", MOVED)

    const copyButton = await screen.findByRole("button", {
      name: "Make my own version",
    })
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Delete policy" })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull()
    await user.click(copyButton)
    // The page follows to the copy, which is theirs to edit.
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Your version of fast",
      }),
    ).toBeInTheDocument()
    expect(calls.find((call) => call.url.endsWith("/copy"))?.body).toEqual({
      name: "fast",
      workspace_id: ADMIN_WORKSPACE,
    })
  })

  it("edits their own version and removes it, handing requests back", async () => {
    const { calls } = mockApi([], null, [], {
      context: member(),
      memberPolicies: [
        policy("fast", CHAIN, { workspace_id: ADMIN_WORKSPACE }),
        policy("fast", CHAIN, {
          workspace_id: ADMIN_WORKSPACE,
          user_id: MEMBER_ID,
        }),
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(
      <PolicyDetailPage name="fast" />,
      `/routing/fast?user=${MEMBER_ID}`,
      MOVED,
    )

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Your version of fast",
      }),
    ).toBeInTheDocument()
    expect(screen.getByText("Just you")).toBeInTheDocument()
    // A version keeps the shared name.
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Remove my version" }))
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove my version",
      }),
    )
    const deleted = calls.find((call) => call.method === "DELETE")
    expect(deleted?.url).toContain(`member_id=${MEMBER_ID}`)
    // Back on the shared policy their requests now use.
    expect(
      await screen.findByRole("heading", { level: 1, name: "fast" }),
    ).toBeInTheDocument()
  })
})

describe("PolicyDetailPage for an organization admin", () => {
  it("sends named members to another model ahead of the budget tiers", async () => {
    const SAM = "77777777-7777-7777-7777-777777777777"
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [
        policy("fast", CHAIN, { workspace_id: ADMIN_WORKSPACE }),
      ],
      members: [
        organizationMember({
          user_id: SAM,
          attribution_user_id: SAM,
          full_name: "Sam Rivera",
        }),
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(<PolicyDetailPage name="fast" />, "/routing/fast")

    await unfold(user, "Rules")
    await user.click(screen.getByRole("button", { name: "Add a rule" }))
    // Saving waits for both halves of the rule.
    expect(
      screen.getByText(/at least one member and a model/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("combobox", { name: /^members/i }))
    await user.click(await screen.findByRole("option", { name: /Sam Rivera/ }))
    await user.keyboard("{Escape}")
    await pick(user, /^use$/i, "openai:gpt-5")
    expect(
      screen.getByRole("button", { name: /^Rules.*Sam Rivera → gpt-5/ }),
    ).toBeInTheDocument()
    await save(user)

    const written = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.includes(`${API_ROOT}/organizations/me/routing-policies`),
    )
    expect((written?.body as { spec?: PolicySpec })?.spec?.select).toEqual([
      { when: { user_id: [SAM] }, target: "openai:gpt-5" },
      { default: "openai:gpt-5-mini" },
    ])
  })

  it("keeps rules from a member reading the policy", async () => {
    mockApi([], null, [], {
      context: organizationContext({
        deployment_operator: false,
        role: "member",
        workspace_memberships: [
          { workspace_id: ADMIN_WORKSPACE, name: "Alpha one", role: "member" },
        ],
      }),
      memberPolicies: [
        policy("fast", CHAIN, { workspace_id: ADMIN_WORKSPACE }),
      ],
    })
    renderInWorkspace(<PolicyDetailPage name="fast" />, "/routing/fast")

    await screen.findByRole("heading", { level: 1, name: "fast" })
    expect(screen.queryByRole("button", { name: /^Rules/ })).toBeNull()
  })

  it("writes an admin's edit back to the row's own workspace", async () => {
    const OTHER_WORKSPACE = "55555555-5555-5555-5555-555555555555"
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [
        policy("elsewhere", CHAIN, { workspace_id: OTHER_WORKSPACE }),
      ],
    })
    const user = userEvent.setup()
    renderInWorkspace(
      <PolicyDetailPage name="elsewhere" />,
      "/routing/elsewhere",
    )

    await user.click(
      await screen.findByRole("button", { name: "Remove backup 1" }),
    )
    await save(user)

    const written = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.includes(`${API_ROOT}/organizations/me/routing-policies`),
    )
    expect(written?.body).toMatchObject({ workspace_id: OTHER_WORKSPACE })
  })

  it("writes an edit to a member's own policy as theirs, not the shared one", async () => {
    const MEMBER = "88888888-8888-8888-8888-888888888888"
    const { calls } = mockApi([], null, [], {
      context: adminContext(),
      memberPolicies: [policy("theirs", CHAIN, { user_id: MEMBER })],
    })
    const user = userEvent.setup()
    renderInWorkspace(
      <PolicyDetailPage name="theirs" />,
      `/routing/theirs?user=${MEMBER}`,
    )

    await user.click(
      await screen.findByRole("button", { name: "Remove backup 1" }),
    )
    await save(user)

    const written = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.includes(`${API_ROOT}/organizations/me/routing-policies`),
    )
    expect(written?.body).toMatchObject({
      name: "theirs",
      workspace_id: ADMIN_WORKSPACE,
      member_id: MEMBER,
    })
  })
})
