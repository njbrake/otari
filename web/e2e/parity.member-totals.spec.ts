import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test"

import { API_ROOT } from "@/shared/api/client"
import { formatUsdHeadline, formatUsdLimit } from "@/shared/helpers/format"
import { authHeaders, expectOk, login, nav, tileValue } from "./helpers"

// One manager and one member over the shared gateway, so the flow runs in
// order (see web/playwright.config.ts).
test.describe.configure({ mode: "serial" })

const PASSWORD = "parity-member-password"

interface Workspace {
  workspace_id: string
  name: string
}

/** The workspace the switcher opens on for the master key's identity. */
async function firstWorkspace(request: APIRequestContext): Promise<Workspace> {
  const context = await request.get(`${API_ROOT}/organizations/me`, {
    headers: authHeaders,
  })
  await expectOk(context, "read the organization context")
  const { workspace_memberships: memberships } = (await context.json()) as {
    workspace_memberships: Workspace[]
  }
  const first = memberships[0]
  expect(first, "the operator belongs to a workspace").toBeTruthy()
  return first
}

/** The Members page's switch, which commits on its own. */
async function setWorkspaceTotals(page: Page, isShown: boolean) {
  await nav(page).getByRole("link", { name: "Members", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Workspace visibility" }),
  ).toBeVisible()
  const toggle = page.getByRole("switch", { name: "Workspace totals" })
  await expect(toggle).toBeEnabled()
  if ((await toggle.getAttribute("aria-checked")) !== String(isShown)) {
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/visibility") &&
        response.request().method() === "PATCH",
    )
    await toggle.click()
    expect((await saved).ok()).toBe(true)
  }
  await expect(toggle).toHaveAttribute("aria-checked", String(isShown))
}

test.describe("workspace totals for members", () => {
  test("a manager hides the workspace's totals from a member, then shares them again", async ({
    baseURL,
    browser,
    page,
  }) => {
    const workspace = await firstWorkspace(page.request)
    const visibilityUrl = `${API_ROOT}/workspaces/${workspace.workspace_id}/visibility`
    // Everything this flow changes is recorded as it is made, so the cleanup
    // in `finally` undoes exactly that, however far the flow got.
    let foundShown: boolean | undefined
    let created: { budgetId?: string; ceilingId?: string } = {}
    let memberId: string | undefined
    const memberContext = await browser.newContext()
    const member = await memberContext.newPage()
    const origin = baseURL ?? ""
    try {
      const found = await page.request.get(visibilityUrl, {
        headers: authHeaders,
      })
      await expectOk(found, "read the workspace's visibility")
      foundShown = (
        (await found.json()) as { members_see_workspace_totals: boolean }
      ).members_see_workspace_totals

      // A budget on the workspace, so the member has a share to be shown. One
      // an earlier flow left is used as it is; otherwise this flow makes its
      // own and removes it at the end.
      const current = await page.request.get(
        `${API_ROOT}/workspaces/${workspace.workspace_id}/budget`,
        { headers: authHeaders },
      )
      await expectOk(current, "read the workspace budget")
      const existing = (await current.json()) as { max_budget: number } | null
      if (!existing?.max_budget) {
        const budget = await page.request.post(
          `${API_ROOT}/organizations/me/budgets`,
          {
            headers: authHeaders,
            data: {
              name: "parity-member-totals",
              max_budget: 1000,
              reset_alignment: "calendar_month",
            },
          },
        )
        await expectOk(budget, "create a budget")
        created = {
          budgetId: ((await budget.json()) as { budget_id: string }).budget_id,
        }
        const ceiling = await page.request.post(
          `${API_ROOT}/organizations/me/spend-ceilings`,
          {
            headers: authHeaders,
            data: {
              budget_id: created.budgetId,
              scope_type: "workspace",
              scope_id: workspace.workspace_id,
            },
          },
        )
        await expectOk(ceiling, "cap the workspace")
        created.ceilingId = ((await ceiling.json()) as { id: string }).id
      }
      const cap = existing?.max_budget ?? 1000
      // Each page formats the cap as it does everywhere else.
      const overviewCap = formatUsdLimit(cap)
      const usageCap = formatUsdHeadline(cap)

      // A member of that workspace who manages nothing, with a password.
      // Fresh per run, as the tenancy spec's invitee is.
      const email = `parity-totals-${Date.now()}@example.com`
      const invited = await page.request.post(
        `${API_ROOT}/organizations/me/member-invitations`,
        {
          headers: authHeaders,
          data: {
            email,
            role: "member",
            workspace_assignments: [
              { workspace_id: workspace.workspace_id, role: "member" },
            ],
          },
        },
      )
      await expectOk(invited, "invite a member")
      const invitation = (await invited.json()) as {
        accept_link: string
        organization_member_id: string
      }
      memberId = invitation.organization_member_id
      const match = /[?&]token=([^&]+)/.exec(invitation.accept_link)
      const token = match ? decodeURIComponent(match[1]) : ""
      expect(token, `a token in ${invitation.accept_link}`).toBeTruthy()
      const accepted = await page.request.post(
        `${API_ROOT}/invitations/accept`,
        { data: { token, password: PASSWORD, terms_accepted: true } },
      )
      await expectOk(accepted, "accept the invitation")

      // The manager keeps the totals from members.
      await login(page)
      await setWorkspaceTotals(page, false)

      // The member signs in with their password and lands on the Overview,
      // which reads their own usage, with the budget as a share only.
      await member.goto(`${origin}/`)
      await member.getByLabel("Email").fill(email)
      await member.getByLabel("Password", { exact: true }).fill(PASSWORD)
      await member.getByRole("button", { name: "Sign in" }).click()
      await expect(
        member.getByRole("heading", { name: "Overview" }),
      ).toBeVisible()
      await expect(
        member.getByText(/Workspace totals are hidden by your admin/),
      ).toBeVisible()
      await expect(
        member.getByRole("radiogroup", { name: "Scope" }),
      ).toHaveCount(0)
      await expect(tileValue(member, "Workspace budget")).toHaveText(/^\d+%$/)
      await expect(member.getByText(`used of ${overviewCap}`)).toBeVisible()
      await expect(
        member.getByText(/^Workspace total hidden by your admin/),
      ).toBeVisible()

      // Usage carries the same budget as a share, on lines that wrap on a
      // phone rather than pushing the page sideways.
      await member.goto(`${origin}/#/usage`)
      await expect(member.getByText(`used of ${usageCap}`)).toBeVisible()
      for (const width of [320, 390]) {
        await member.setViewportSize({ width, height: 812 })
        await expect(member.getByText(`used of ${usageCap}`)).toBeVisible()
        const spill = await member.evaluate(() => {
          const main = document.getElementById("main-content")
          return main ? main.scrollWidth - main.clientWidth : -1
        })
        expect(spill, `/usage at ${width}px`).toBe(0)
      }
      await member.setViewportSize({ width: 1280, height: 720 })
      await member.goto(`${origin}/#/`)

      // And shares them again: the member is offered the workspace's view,
      // and reads its totals there with no one else's keys.
      await setWorkspaceTotals(page, true)
      await member.reload()
      const scope = member.getByRole("radiogroup", { name: "Scope" })
      await expect(scope.getByText("You", { exact: true })).toBeVisible()
      await expect(
        member.getByText(/Workspace totals are hidden by your admin/),
      ).toHaveCount(0)
      await scope.getByText("Workspace", { exact: true }).click()
      await expect(
        member.getByText(`Everything in ${workspace.name}, all members`),
      ).toBeVisible()
      await expect(tileValue(member, "Total at API prices")).toHaveText(
        /^\$[\d,]+\.\d{2}$/,
      )
      await expect(
        member.getByRole("heading", { name: "Your recent failures" }),
      ).toBeVisible()
      await expect(
        member.getByText(/Other members.\s*keys aren.t shown to members/),
      ).toBeVisible()
    } finally {
      await memberContext.close()
      // Leave the gateway as this flow found it: the setting as it was, the
      // member gone, and any budget this flow made removed.
      if (foundShown !== undefined) {
        const restored = await page.request.patch(visibilityUrl, {
          headers: authHeaders,
          data: { members_see_workspace_totals: foundShown },
        })
        await expectOk(restored, "restore the workspace's visibility")
      }
      if (memberId) {
        const removed = await page.request.delete(
          `${API_ROOT}/organizations/me/members/${memberId}`,
          { headers: authHeaders },
        )
        await expectOk(removed, "remove the member")
      }
      if (created.ceilingId) {
        const ceiling = await page.request.delete(
          `${API_ROOT}/organizations/me/spend-ceilings/${created.ceilingId}`,
          { headers: authHeaders },
        )
        await expectOk(ceiling, "remove the workspace ceiling")
      }
      if (created.budgetId) {
        const budget = await page.request.delete(
          `${API_ROOT}/organizations/me/budgets/${created.budgetId}`,
          { headers: authHeaders },
        )
        await expectOk(budget, "remove the budget")
      }
    }
  })
})
