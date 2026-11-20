import { describe, expect, it } from "vitest"

import {
  retiredActivityTarget,
  retiredUsageTarget,
} from "@/shared/helpers/retiredPages"

describe("retiredUsageTarget", () => {
  it("opens Home on the nearest period and cut when nothing names rows", () => {
    expect(retiredUsageTarget({ range: "7d", by: "model" })).toEqual({
      to: "/",
      search: { period: "7d", by: "models" },
    })
    expect(retiredUsageTarget({ range: "90d", by: "key" })).toEqual({
      to: "/",
      search: { period: "3m", by: "keys" },
    })
    expect(retiredUsageTarget({ range: "24h", by: "member" })).toEqual({
      to: "/",
      search: { period: "today", by: "people" },
    })
    expect(retiredUsageTarget({ range: "12mo" })).toEqual({
      to: "/",
      search: { period: "6m" },
    })
  })

  it("drops what Home has no name for", () => {
    expect(
      retiredUsageTarget({
        metric: "tokens",
        subscription: "exclude",
        sort: "cost",
        by: "channel",
      }),
    ).toEqual({ to: "/", search: {} })
  })

  it("opens Requests, filters and window kept, once a filter names rows", () => {
    expect(
      retiredUsageTarget({
        range: "30d",
        start_date: "2026-10-01T00:00:00Z",
        end_date: "2026-10-02T00:00:00Z",
        api_key_id: "key-1",
        exclude_model: ["gpt-4o", "o3"],
        by: "model",
        metric: "cost",
      }),
    ).toEqual({
      to: "/requests",
      search: {
        range: "30d",
        start_date: "2026-10-01T00:00:00Z",
        end_date: "2026-10-02T00:00:00Z",
        api_key_id: "key-1",
        exclude_model: ["gpt-4o", "o3"],
      },
    })
  })

  it("leaves a window Requests does not offer to its own default", () => {
    expect(retiredUsageTarget({ range: "12mo", model: "gpt-4o" })).toEqual({
      to: "/requests",
      search: { model: "gpt-4o" },
    })
  })

  it("opens Sessions for a breakdown by session", () => {
    expect(
      retiredUsageTarget({
        by: "session",
        range: "7d",
        user_id: "u-1",
        provider: "openai",
      }),
    ).toEqual({ to: "/sessions", search: { range: "7d", user_id: "u-1" } })
  })
})

describe("retiredActivityTarget", () => {
  it("keeps the filters Requests reads and drops the rest", () => {
    expect(
      retiredActivityTarget({
        range: "1h",
        status: "error",
        model: "gpt-4o",
        latency_ms_gt: "2000",
        request: "req-1",
        q: "hello",
        group: "session",
        sort: "timestamp",
        channel: "api",
      }),
    ).toEqual({
      to: "/requests",
      search: {
        range: "1h",
        status: "error",
        model: "gpt-4o",
        latency_ms_gt: "2000",
        request: "req-1",
      },
    })
  })
})
