import { type CDPSession, expect, type Page, test } from "@playwright/test"

import { login } from "./helpers"

/**
 * One finger dragged from `from` to `to` through real touch events, the
 * sequence a phone delivers: `page.touchscreen` only taps.
 */
async function swipe(
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const steps = 8
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [from],
  })
  for (let step = 1; step <= steps; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
        },
      ],
    })
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  })
}

const toggle = (page: Page) =>
  page.getByRole("button", { name: /^(Open|Close) navigation$/ })

test.describe("a phone opens the drawer with a swipe", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })

  test("swipe right opens it, swipe left closes it, a scroll does neither", async ({
    page,
  }) => {
    await login(page)
    const cdp = await page.context().newCDPSession(page)
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false")

    // A vertical scroll that drifts sideways is not a swipe.
    await swipe(cdp, { x: 120, y: 700 }, { x: 180, y: 300 })
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false")

    // Away from the screen edge, which Safari keeps for its own Back gesture.
    await swipe(cdp, { x: 60, y: 500 }, { x: 300, y: 520 })
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true")

    await swipe(cdp, { x: 320, y: 500 }, { x: 60, y: 490 })
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false")
  })
})
