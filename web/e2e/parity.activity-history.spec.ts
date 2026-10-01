import { expect, type Page, test } from "@playwright/test"

import { gotoRoute, login, nav, tableRows } from "./helpers"
import { PARITY } from "./parity-data"

// What the back button does around the Activity log. Opening a request is a
// place the reader went, so going back closes it; every filter rewrites the
// entry it is on, so going back from the log leaves the page in one step. The
// log is read-only here, so these run against the seeded fixture as it is.

const SCOPED = `/activity?source=${PARITY.source}`
const MODEL = PARITY.models.priced.model

// The router's own writes to the address bar, counted from the page itself, so
// a write nobody asked for shows up even when the URL it writes looks right.
async function countHistoryWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counted = window as unknown as { historyWrites: number }
    counted.historyWrites = 0
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history)
      history[method] = (...args: Parameters<History["pushState"]>) => {
        counted.historyWrites += 1
        original(...args)
      }
    }
  })
}

const historyWrites = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { historyWrites: number }).historyWrites,
  )

test.describe("activity history on a phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })

  test("going back closes an opened request, then leaves the log", async ({
    page,
  }) => {
    await login(page)
    await gotoRoute(page, "/keys")
    await page.getByRole("button", { name: "Open navigation" }).click()
    await nav(page).getByRole("link", { name: "Activity" }).click()
    await expect(page).toHaveURL(/#\/activity$/)

    const row = page.getByRole("button").filter({ hasText: MODEL }).first()
    await expect(row).toBeVisible()
    await row.click()
    const view = page.getByRole("dialog", { name: "Request" })
    await expect(view).toBeVisible()
    await expect(page).toHaveURL(/request=/)

    // The back gesture, which a full-screen view is closed with.
    await page.goBack()
    await expect(view).toBeHidden()
    await expect(page).toHaveURL(/#\/activity$/)

    // Closed from its own back row instead, the entry goes with it.
    await row.click()
    await expect(view).toBeVisible()
    await view.getByRole("button", { name: "Activity" }).click()
    await expect(view).toBeHidden()
    await expect(page).toHaveURL(/#\/activity$/)

    await page.goBack()
    await expect(page).toHaveURL(/#\/keys$/)
  })
})

test.describe("activity history on the desk", () => {
  test("filters add no entries, and leaving writes nothing behind", async ({
    page,
  }) => {
    await countHistoryWrites(page)
    await login(page)
    await gotoRoute(page, "/keys")
    await nav(page).getByRole("link", { name: "Activity" }).click()
    await expect(page).toHaveURL(/#\/activity$/)
    await gotoRoute(page, SCOPED)

    const rows = tableRows(page, "Activity log")
    await expect(rows).not.toHaveCount(0)
    await page
      .getByRole("radiogroup", { name: "Window" })
      .getByText("7d", { exact: true })
      .click()
    await expect(page).toHaveURL(/range=7d/)

    // Open a request, step to the next, close it on Escape.
    await expect(rows).not.toHaveCount(0)
    await rows.filter({ hasText: MODEL }).first().getByRole("rowheader").click()
    const panel = page.getByRole("complementary", { name: "Request details" })
    await expect(panel).toBeVisible()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Escape")
    await expect(panel).toBeHidden()
    await expect(page).not.toHaveURL(/request=/)

    // Typed into the search and left at once, inside its debounce.
    await page.getByRole("searchbox", { name: "Search requests" }).fill("gpt")
    await nav(page).getByRole("link", { name: "Overview" }).click()
    await expect(page).toHaveURL(/#\/$/)
    const settled = await historyWrites(page)
    await page.waitForTimeout(1_000)
    expect(await historyWrites(page)).toBe(settled)
    await expect(page).toHaveURL(/#\/$/)

    // Back from Overview is the log as it was left, and back from the log is
    // the scoped link it was opened on: the window change rewrote that entry.
    await page.goBack()
    await expect(page).toHaveURL(/#\/activity\?.*range=7d/)
    await page.goBack()
    await expect(page).toHaveURL(/#\/activity$/)
  })
})
