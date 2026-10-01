import { expect, type Locator, type Page, test } from "@playwright/test"

import { gotoRoute, login } from "./helpers"

// The pages a phone reaches from the rails, over the seeded fixture so the
// charts and tables carry data: an empty page has nothing wide enough to spill.
// `ready` is what says the data has landed, where a page has something wide
// that only arrives with it.
const ROUTES: ReadonlyArray<{
  readonly route: string
  readonly ready?: (page: Page) => Locator
}> = [
  {
    route: "/",
    ready: (page) => page.getByRole("img", { name: /^Daily spend/ }),
  },
  {
    route: "/activity",
    ready: (page) =>
      page.getByRole("button").filter({ hasText: "gpt-parity-priced" }).first(),
  },
  { route: "/usage" },
  { route: "/keys" },
  { route: "/models" },
  { route: "/routing" },
  { route: "/providers" },
  { route: "/members" },
  { route: "/budgets" },
  { route: "/tools" },
  { route: "/settings" },
  { route: "/workspaces" },
  { route: "/organization/members" },
  { route: "/organization/guardrails" },
  { route: "/docs" },
]

// 375 is the common phone; 320 is the narrowest one still sold, and the width
// at which the Overview chart's last date label first spilled past the page.
const WIDTHS = [375, 320]

/**
 * How far the page has moved sideways, and how far it could.
 *
 * `#main-content` is the shell's scroller, so it is the element a thumb pans,
 * not the document. `spill` is what its content overflows by: zero means there
 * was never anything to pan to, which is the cause rather than the symptom.
 */
function horizontalState(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById("main-content")
    return {
      windowX: window.scrollX,
      mainX: main?.scrollLeft ?? -1,
      spill: main ? main.scrollWidth - main.clientWidth : -1,
    }
  })
}

test.describe("a phone scrolls a page vertically only", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  })

  test("no page pans sideways", async ({ page }) => {
    test.setTimeout(180_000)
    await login(page)
    const cdp = await page.context().newCDPSession(page)
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 812 })
      for (const { route, ready } of ROUTES) {
        await gotoRoute(page, route)
        await expect(page.locator("#main-content h1").first()).toBeVisible()
        if (ready) await expect(ready(page)).toBeVisible()
        await expect(page.getByText("Loading…")).toHaveCount(0)

        // A finger dragged right to left across the middle of the page, then
        // a sideways wheel for good measure.
        await cdp.send("Input.synthesizeScrollGesture", {
          x: width - 40,
          y: 500,
          xDistance: -(width - 100),
          yDistance: 0,
          gestureSourceType: "touch",
        })
        await page.mouse.move(width / 2, 500)
        await page.mouse.wheel(400, 0)

        expect
          .soft(await horizontalState(page), `${route} at ${width}px`)
          .toEqual({ windowX: 0, mainX: 0, spill: 0 })
      }
    }
  })
})
