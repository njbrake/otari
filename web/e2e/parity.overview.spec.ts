import { expect, test } from "@playwright/test"

import { API_ROOT } from "@/shared/api/client"
import {
  authHeaders,
  expectOk,
  login,
  table,
  tableRows,
  tileValue,
} from "./helpers"
import { COUNTS } from "./parity-data"

// The seeded fixture is shared, and the one key added here (an expiring key) is
// the only change to it; the suite runs one worker against one gateway either
// way (see web/playwright.config.ts).
test.describe.configure({ mode: "serial" })

// The scratch rows are consumed by the Activity spec's bulk-delete flow, which
// runs before this file, so they are deliberately not counted here.
const SEEDED = COUNTS.priced + COUNTS.unpriced + COUNTS.errors

// The fixture lands inside the last 20 hours, so on the 1st (UTC) part of it
// belongs to the month before and the month's counts are no floor.
const FIXTURE_IN_THIS_MONTH = new Date().getUTCDate() > 1

test.describe("overview", () => {
  test("reports the month's totals once the gateway has traffic", async ({
    page,
  }) => {
    await login(page)
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()

    // Onboarding is an empty-gateway state. With providers configured and usage
    // recorded it has to be gone, or a working gateway keeps being told to set
    // itself up.
    await expect(page.getByText("Get started with Otari")).toBeHidden()

    const requests = tileValue(page, "Requests")
    await expect(requests).not.toHaveText("—")
    if (FIXTURE_IN_THIS_MONTH) {
      const counted = Number((await requests.innerText()).replaceAll(",", ""))
      expect(counted).toBeGreaterThanOrEqual(SEEDED)
      // The priced half of the fixture is the only costed traffic here, so a
      // zero means pricing never reached the tiles.
      await expect(tileValue(page, "Total at API prices")).not.toHaveText(
        "$0.00",
      )
    }
    await expect(tileValue(page, "Total at API prices")).toHaveText(/^\$/)

    // The month's running total against its budget, readable from the keyboard.
    await expect(
      page.getByRole("slider", { name: /^Billed spend in / }),
    ).toBeVisible()
  })

  test("lists the month's failures and opens them in Activity", async ({
    page,
  }) => {
    test.skip(!FIXTURE_IN_THIS_MONTH, "the fixture straddles two months")
    await login(page)

    const rows = tableRows(page, "Recent failures")
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(COUNTS.errors)

    await page.getByRole("link", { name: /^View all \d+ in Activity/ }).click()
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible()
    await expect(table(page, "Activity log")).toBeVisible()
    expect(page.url()).toContain("status=error")
  })

  test("reads an earlier month, or leaves for Usage for any other range", async ({
    page,
  }) => {
    await login(page)

    await page.getByRole("button", { name: "Month: This month" }).click()
    const previous = new Date()
    previous.setUTCDate(1)
    previous.setUTCMonth(previous.getUTCMonth() - 1)
    const name = previous.toLocaleString("en-US", {
      month: "long",
      timeZone: "UTC",
    })
    await page
      .getByRole("menuitemradio", {
        name: `${name} ${previous.getUTCFullYear()}`,
      })
      .click()
    await expect(
      page.getByRole("heading", { name: `Failures in ${name}` }),
    ).toBeVisible()
    expect(page.url()).toContain(
      `month=${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`,
    )

    await page
      .getByRole("button", {
        name: `Month: ${name} ${previous.getUTCFullYear()}`,
      })
      .click()
    await page
      .getByRole("menuitemradio", { name: "Other ranges in Usage" })
      .click()
    await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible()
  })

  test("the rail is a way to the keys", async ({ page }) => {
    await login(page)
    await page.getByRole("link", { name: "Create key" }).click()
    await expect(
      page.getByRole("heading", { name: "API keys", exact: true }),
    ).toBeVisible()
  })

  test("says what needs attention and lists the key beside it", async ({
    page,
  }) => {
    // A key that expires in three days is one the gateway raises, and one the
    // rail lists. Named to sort first among the keys with no spend, so it is
    // in the rail whatever earlier flows left there.
    const context = await page.request.get(`${API_ROOT}/organizations/me`, {
      headers: authHeaders,
    })
    await expectOk(context, "read the organization context")
    const { workspace_memberships: memberships } = (await context.json()) as {
      workspace_memberships: { workspace_id: string }[]
    }
    const expiresAt = new Date(Date.now() + 3 * 86_400_000 - 3_600_000)
    const created = await page.request.post(`${API_ROOT}/keys`, {
      headers: authHeaders,
      data: {
        key_name: "aaa-overview-expiring",
        workspace_id: memberships[0]?.workspace_id,
        exclude_from_budget: false,
        expires_at: expiresAt.toISOString(),
      },
    })
    await expectOk(created, "create an expiring key")

    await login(page)
    const day = expiresAt.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    const strip = page.getByRole("region", { name: "Needs attention" })
    await expect(
      strip.getByRole("link", { name: `aaa-overview-expiring expires ${day}` }),
    ).toHaveAttribute("href", /keys/)

    const rail = page.getByRole("complementary")
    const row = rail.getByRole("listitem").filter({
      hasText: "aaa-overview-expiring",
    })
    await expect(row).toBeVisible()
    await expect(row.getByText("Expires in 3 days")).toBeVisible()
  })
})
