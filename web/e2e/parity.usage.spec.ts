import { expect, type Page, test } from "@playwright/test"

import { API_ROOT } from "@/shared/api/client"
import {
  authHeaders,
  expectOk,
  filterChip,
  gotoRoute,
  login,
  nav,
  table,
  tableRows,
  tileValue,
} from "./helpers"
import { COUNTS, PARITY } from "./parity-data"

test.describe.configure({ mode: "serial" })

async function openUsage(page: Page): Promise<void> {
  await login(page)
  await nav(page).getByRole("link", { name: "Usage" }).click()
  await expect(
    page.getByRole("heading", { name: "Usage", exact: true }),
  ).toBeVisible()
}

// A breakdown row, located by the name in its row-header cell. The table is
// ranked by the metric on screen, so a row's position moves with the fixture;
// its name does not.
function breakdownRow(page: Page, dimension: string, name: string | RegExp) {
  return tableRows(page, `Usage by ${dimension}`).filter({
    has: page.getByRole("rowheader", { name }),
  })
}

test.describe("usage", () => {
  test("answers with the total at API prices, requests and tokens", async ({
    page,
  }) => {
    await openUsage(page)

    // The empty state is mutually exclusive with the tiles, so its absence is
    // part of the assertion that the window resolved to real data.
    await expect(page.getByText(/^No usage in the last/)).toBeHidden()

    const total = tileValue(page, "Total at API prices")
    await expect(total).toHaveText(/^\$/)
    await expect(total).not.toHaveText("$0.00")
    await expect(page.getByText(/billed · counts toward limits/)).toBeVisible()
    await expect(tileValue(page, "Requests").first()).not.toHaveText("0")
    await expect(tileValue(page, "Tokens").first()).not.toHaveText("0")
  })

  test("one breakdown drives the chart and the table", async ({ page }) => {
    await openUsage(page)

    await page.getByRole("button", { name: "Model", exact: true }).click()
    await expect(page.getByRole("heading", { name: "By model" })).toBeVisible()
    await expect(
      breakdownRow(page, "Model", PARITY.models.priced.model),
    ).toContainText(String(COUNTS.priced))
    // The chart stacks the same breakdown: the choice is the URL's, and both
    // the series and the table read it.
    await expect(page).toHaveURL(/by=model/)
    await expect(
      page.getByRole("slider", { name: /Filter by date/ }),
    ).toBeVisible()

    // The segment is the radio's label; the native input itself is hidden.
    await page
      .getByRole("radiogroup", { name: "Metric" })
      .getByText("Requests", { exact: true })
      .click()
    await expect(page).toHaveURL(/metric=requests/)
  })

  test("drills from a model's usage into the requests behind it", async ({
    page,
  }) => {
    await openUsage(page)
    await page.getByRole("button", { name: "Model", exact: true }).click()
    await breakdownRow(page, "Model", PARITY.models.priced.model)
      .getByRole("rowheader")
      .click()

    // The drill is the join between the two pages: usage says where the money
    // went, the log says which requests spent it.
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible()
    await expect(
      filterChip(page, "Model", PARITY.models.priced.model),
    ).toBeVisible()
    await expect(tableRows(page, "Activity log")).toHaveCount(COUNTS.priced)
    // The window travels with the filter, so the log shows the same slice of
    // time the chart was showing rather than reverting to its own default.
    await expect(page).toHaveURL(/start_date=/)
  })

  test("drills from a session into the requests it ran", async ({ page }) => {
    await openUsage(page)
    await page.getByRole("button", { name: "Session", exact: true }).click()
    await breakdownRow(page, "Session", new RegExp(`^${PARITY.sessions.light}`))
      .getByRole("rowheader")
      .click()

    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible()
    await expect(
      filterChip(page, "Session", PARITY.sessions.light),
    ).toBeVisible()
    // The light session carries both its succeeding and its failing requests.
    await expect(tableRows(page, "Activity log")).toHaveCount(
      COUNTS.unpriced + COUNTS.errors,
    )
    await expect(table(page, "Activity log")).toContainText(
      PARITY.models.unpriced.model,
    )
  })

  // A key with no traffic at all, which the picker used to leave out because
  // it offered only the keys spending in the window. Created here and removed
  // after, like every flow that writes.
  test("filters by an API key reached from the Keys page, at phone width too", async ({
    page,
  }) => {
    const name = `usage-filter-${Date.now()}`
    const created = await page.request.post(`${API_ROOT}/keys`, {
      headers: authHeaders,
      data: { key_name: name },
    })
    await expectOk(created, "create a key for the usage filter")
    const { id } = (await created.json()) as { id: string }
    try {
      await login(page)
      await gotoRoute(page, "/keys")
      await page.getByRole("button", { name: `Actions for ${name}` }).click()
      await page.getByRole("menuitem", { name: /^View usage/ }).click()

      await expect(
        page.getByRole("heading", { name: "Usage", exact: true }),
      ).toBeVisible()
      await expect(filterChip(page, "API key", name)).toBeVisible()
      expect(page.url()).toContain(`api_key_id=${id}`)

      // The filter is the URL's, so a reload on a phone keeps it.
      await page.setViewportSize({ width: 375, height: 812 })
      await page.reload()
      await expect(filterChip(page, "API key", name)).toBeVisible()

      await page.getByRole("button", { name: `Remove API key ${name}` }).click()
      await expect(filterChip(page, "API key", name)).toBeHidden()
      expect(page.url()).not.toContain("api_key_id=")
      // Nothing on the page is wider than the phone.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(375)
    } finally {
      await page.request.patch(`${API_ROOT}/keys/${id}`, {
        headers: authHeaders,
        data: { is_active: false },
      })
      await page.request.delete(`${API_ROOT}/keys/${id}`, {
        headers: authHeaders,
      })
    }
  })
})
