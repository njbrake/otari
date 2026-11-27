import { expect, type Page, test } from "@playwright/test"

import { filterChip, gotoRoute, login, pageHeading, table } from "./helpers"
import { PARITY } from "./parity-data"

// The screenshot suite's phone (see web/playwright.config.ts), so a coarse
// pointer sizes the controls up the way it does on a device: the pager's 44px
// arrows are part of what has to fit.
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
})

/**
 * How far the page's content reaches past the viewport, in CSS pixels.
 *
 * Measured on `main` as well as the document because `main` hides horizontal
 * overflow as a backstop: the page would no longer pan, so only `scrollWidth`
 * still shows that something is too wide. A table's own scroller contains its
 * overflow, so a wide table that scrolls as it should reads zero here.
 */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const overflow = (element: Element) =>
      element.scrollWidth - element.clientWidth
    const main = document.getElementById("main-content")
    return Math.max(
      overflow(document.documentElement),
      main ? overflow(main) : 0,
    )
  })
}

const PAGES = [
  {
    route: "/",
    heading: "Home",
    // The figures and the breakdown table are the widest rows on the page.
    ready: (page: Page) =>
      expect(
        page.getByRole("main").getByRole("heading", { name: "Home" }),
      ).toBeVisible(),
  },
  {
    route: "/sessions",
    heading: "Sessions",
    // The tab row and the chart are the widest rows on the page.
    ready: (page: Page) =>
      expect(
        page.getByRole("navigation", { name: "Sessions views" }),
      ).toBeVisible(),
  },
  {
    route: "/settings",
    heading: "Settings",
    ready: (page: Page) =>
      expect(page.getByRole("textbox").first()).toBeVisible(),
  },
  {
    route: "/requests",
    heading: "Sessions",
    // Rows run edge to edge, under a totals line pinned the same way.
    ready: async (page: Page) => {
      await expect(
        page.getByRole("list", { name: "Activity log" }),
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Load 20 more" }),
      ).toBeVisible()
    },
  },
  {
    route: "/admin/web-search",
    heading: "Web search",
    // Two tables of tools, each a card list at this width.
    ready: (page: Page) => expect(table(page, "Search tools")).toBeVisible(),
  },
] as const

test.describe("a phone-width page does not pan sideways", () => {
  for (const { route, heading, ready } of PAGES) {
    test(`${heading} (${route}) at 390px`, async ({ page }) => {
      await login(page)
      await gotoRoute(page, route)
      await expect(pageHeading(page, heading)).toBeVisible()
      await ready(page)
      expect(
        await horizontalOverflow(page),
        `${heading} is wider than the phone`,
      ).toBeLessThanOrEqual(0)

      // A reader's larger text setting, which is what pushed long unbroken
      // values past the edge.
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "125%"
      })
      expect(
        await horizontalOverflow(page),
        `${heading} is wider than the phone at 125% text`,
      ).toBeLessThanOrEqual(0)
    })
  }
})

test("a tap on a wrapped terms link opens it rather than ticking the box", async ({
  page,
  context,
}) => {
  // At this width the sentence wraps and puts the privacy link under the box's
  // 44px bleed, which took the tap until the links sat above it. jsdom cannot
  // hit-test, so this is the only place that can see it.
  await page.route("**/v1/bootstrap", async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        mail: "delivers",
        open_signup: true,
        terms_url: "https://example.com/terms",
        privacy_url: "https://example.com/privacy",
      },
    })
  })
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ body: "" }),
  )
  await page.goto("/signup")
  const box = page.getByRole("checkbox", {
    name: "I accept the Terms of Service and the Privacy Policy",
  })
  await expect(box).toBeVisible()

  for (const [name, url] of [
    ["Terms of Service", "https://example.com/terms"],
    ["Privacy Policy", "https://example.com/privacy"],
  ] as const) {
    const link = await page.getByRole("link", { name }).boundingBox()
    if (!link) throw new Error(`${name} has no box`)
    const opened = context.waitForEvent("page")
    // The upper third of the line, where the bleed reaches.
    await page.touchscreen.tap(
      link.x + link.width / 2,
      link.y + link.height * 0.3,
    )
    const tab = await opened
    expect(tab.url()).toBe(url)
    await tab.close()
  }
  await expect(box).not.toBeChecked()
})

test("a phone filters the request log from the Filters sheet", async ({
  page,
}) => {
  // The cards have no column headers, so the funnels have nowhere to go; the
  // chip row's Filters button opens the same filters as a sheet.
  await login(page)
  await gotoRoute(page, `/requests?source=${PARITY.source}`)
  await expect(table(page, "Activity log")).toBeVisible()
  await expect(
    table(page, "Activity log").getByText(PARITY.models.unpriced.model).first(),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: /^Filter / })).toHaveCount(0)

  const open = page.getByRole("button", { name: "Filters, 1 applied" })
  await open.click()
  const sheet = page.getByRole("dialog", { name: "Filters" })
  await expect(sheet).toBeVisible()
  await sheet.getByRole("button", { name: "Model", exact: true }).click()
  const search = sheet.getByRole("searchbox", { name: "Search Model values" })
  if (await search.isVisible()) await search.fill(PARITY.models.unpriced.model)
  // The input is visually hidden inside its label, so the label takes the tap.
  await sheet
    .getByRole("checkbox", { name: PARITY.models.unpriced.model, exact: true })
    .locator("xpath=ancestor::label")
    .click()
  await expect(page).toHaveURL(
    new RegExp(`[?&]model=${PARITY.models.unpriced.model}`),
  )

  // Fits the phone: no sideways pan inside the sheet either.
  const overflow = await sheet.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  await sheet.getByRole("button", { name: "Done" }).click()
  await expect(sheet).toBeHidden()
  await expect(
    filterChip(page, "Model", PARITY.models.unpriced.model),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Filters, 2 applied" }),
  ).toBeFocused()
})
