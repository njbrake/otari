import { isRedirect } from "@tanstack/react-router"
import { describe, expect, it } from "vitest"

import { Route as ActivityRoute } from "@/routes/activity"
import { Route as UsageRoute } from "@/routes/usage"
import type { DashboardSearch } from "@/shared/helpers/search"

function redirectOf(
  route: typeof UsageRoute | typeof ActivityRoute,
  search: DashboardSearch,
) {
  const beforeLoad = route.options.beforeLoad as unknown as (context: {
    search: DashboardSearch
  }) => void
  try {
    beforeLoad({ search })
  } catch (thrown) {
    if (isRedirect(thrown)) return thrown.options
    throw thrown
  }
  throw new Error("no redirect")
}

describe("the retired routes", () => {
  it("send /usage where its filters lead, replacing the dead entry", () => {
    expect(redirectOf(UsageRoute, { api_key_id: "key-1" })).toMatchObject({
      to: "/requests",
      search: { api_key_id: "key-1" },
      replace: true,
    })
  })

  it("send /activity to Requests under the names it reads", () => {
    expect(
      redirectOf(ActivityRoute, { status: "error", q: "x" }),
    ).toMatchObject({
      to: "/requests",
      search: { status: "error" },
      replace: true,
    })
  })
})
