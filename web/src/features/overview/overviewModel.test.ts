import { describe, expect, it } from "vitest"

import type { OverviewAttentionItem } from "@/client"
import { seriesPoint, usageTotals } from "@/tests/fixtures"
import {
  attentionKey,
  billedByDay,
  billedOf,
  budgetAxisTop,
  budgetState,
  budgetView,
  canProjectMonth,
  comparisonLabel,
  costOnDay,
  daysUntil,
  describeAttention,
  describeChartCaptionLead,
  describeMonthSoFar,
  groupAttention,
  paceFor,
  projectMonth,
  readBudget,
  runningTotal,
} from "./overviewModel"
import {
  comparisonWindow,
  offeredMonths,
  readMonth,
  scopeFilters,
} from "./overviewQuery"

const NOW = new Date("2026-10-12T12:00:00Z")
const [OCTOBER, SEPTEMBER] = offeredMonths(NOW)

function url(values: Record<string, string>) {
  return {
    get: (key: string) => values[key] ?? "",
    getAll: () => [],
    getNumber: () => 0,
    patch: () => {},
    back: () => {},
  }
}

describe("the months", () => {
  it("offers this month and the eleven before it, in UTC", () => {
    const months = offeredMonths(NOW)
    expect(months).toHaveLength(12)
    expect(months[0]).toMatchObject({
      key: "2026-10",
      length: 31,
      elapsed: 12,
      isCurrent: true,
    })
    expect(months[1]).toMatchObject({
      key: "2026-09",
      length: 30,
      elapsed: 30,
      isCurrent: false,
    })
    expect(months[11].key).toBe("2025-11")
  })

  it("reads the month the URL names, and only one it offers", () => {
    expect(readMonth(url({ month: "2026-09" }), NOW).key).toBe("2026-09")
    expect(readMonth(url({ month: "2024-01" }), NOW).key).toBe("2026-10")
    expect(readMonth(url({}), NOW).key).toBe("2026-10")
  })

  it("compares a running month with the same stretch of the one before, to the hour", () => {
    // Noon on Oct 12 is set against noon on Sep 12, not the whole of Sep 12.
    const running = comparisonWindow(OCTOBER, NOW)
    expect(running.start.toISOString()).toBe("2026-09-01T00:00:00.000Z")
    expect(running.end.toISOString()).toBe("2026-09-12T12:00:00.000Z")
    expect(comparisonLabel(running)).toBe("Sep 1 – 12")

    // Late in a long month, the stretch stops at the shorter month's end.
    const late = new Date("2026-10-31T18:00:00Z")
    expect(
      comparisonWindow(offeredMonths(late)[0], late).end.toISOString(),
    ).toBe("2026-10-01T00:00:00.000Z")

    const over = comparisonWindow(SEPTEMBER, NOW)
    expect(over.isWholeMonth).toBe(true)
    expect(comparisonLabel(over)).toBe("August")
  })

  it("captions the days a month has had", () => {
    expect(describeMonthSoFar(OCTOBER)).toBe("Oct 1 – 12, 2026 UTC")
    expect(describeMonthSoFar(SEPTEMBER)).toBe("Sep 1 – 30, 2026 UTC")
  })
})

describe("the scope", () => {
  it("narrows a manager to their own rows at You, and drops the workspace across the organization", () => {
    const context = {
      workspaceId: "ws",
      ownUserId: "me",
      isManager: true,
    }
    expect(scopeFilters({ ...context, scope: "you" })).toEqual({
      workspace_id: "ws",
      user_id: ["me"],
    })
    expect(scopeFilters({ ...context, scope: "workspace" })).toEqual({
      workspace_id: "ws",
    })
    expect(scopeFilters({ ...context, scope: "organization" })).toEqual({})
    // A member's own rows are the server's to decide.
    expect(
      scopeFilters({ ...context, isManager: false, scope: "you" }),
    ).toEqual({ workspace_id: "ws" })
  })
})

describe("the running total", () => {
  it("bills each day its cost less what a subscription covered", () => {
    const days = billedByDay(
      [
        seriesPoint({
          bucket_start: "2026-10-01T00:00:00Z",
          cost: 10,
          imported_cost: 4,
        }),
        seriesPoint({ bucket_start: "2026-10-03T00:00:00Z", cost: 2 }),
        // Outside the month: ignored.
        seriesPoint({ bucket_start: "2026-09-30T00:00:00Z", cost: 99 }),
      ],
      OCTOBER,
    )
    expect(days).toHaveLength(12)
    expect(days.slice(0, 3)).toEqual([6, 0, 2])
    expect(runningTotal(days).slice(0, 3)).toEqual([6, 6, 8])
  })

  it("projects the rest of a running month at its pace over the time it has run", () => {
    // $720 by Oct 12 12:00 is $720 over 11.5 days, the Budget tile's pace.
    const totals = runningTotal(new Array(12).fill(60))
    const { projected, end, crossDay } = projectMonth(
      totals,
      OCTOBER,
      1000,
      NOW.getTime(),
    )
    expect(projected).toHaveLength(19)
    expect(projected[0]).toBeCloseTo((720 * 13) / 11.5, 6)
    expect(end).toBeCloseTo((720 * 31) / 11.5, 6)
    expect(Math.round(end)).toBe(1941)
    expect(
      paceFor(
        720,
        { start: OCTOBER.start.toISOString(), end: OCTOBER.end.toISOString() },
        NOW.getTime(),
      )?.total,
    ).toBeCloseTo(end, 6)
    // $1,000 at that pace is 15.97 days in, Oct 16 23:20, the server's date.
    expect(crossDay).toBe(16)
  })

  it("projects nothing until the month has run as long as the server waits", () => {
    const early = new Date("2026-10-01T01:00:00Z")
    const [october] = offeredMonths(early)
    expect(canProjectMonth(october, early.getTime())).toBe(false)
    expect(projectMonth([40], october, 30, early.getTime())).toEqual({
      projected: [],
      end: 40,
      crossDay: 1,
    })
    expect(projectMonth([20], october, 30, early.getTime())).toEqual({
      projected: [],
      end: 20,
      crossDay: undefined,
    })
    // A tenth of October is 3.1 days.
    expect(canProjectMonth(OCTOBER, Date.parse("2026-10-04T02:00:00Z"))).toBe(
      false,
    )
    expect(canProjectMonth(OCTOBER, Date.parse("2026-10-04T03:00:00Z"))).toBe(
      true,
    )
  })

  it("dates an actual crossing, and projects nothing once the month is over", () => {
    const totals = runningTotal(new Array(30).fill(40))
    const { projected, end, crossDay } = projectMonth(
      totals,
      SEPTEMBER,
      1000,
      NOW.getTime(),
    )
    expect(projected).toEqual([])
    expect(end).toBe(1200)
    expect(crossDay).toBe(26)
    expect(canProjectMonth(SEPTEMBER, NOW.getTime())).toBe(false)
  })

  it("has no crossing without a budget, or under one", () => {
    const totals = runningTotal(new Array(12).fill(10))
    expect(
      projectMonth(totals, OCTOBER, undefined, NOW.getTime()).crossDay,
    ).toBeUndefined()
    // $120 over 11.5 days ends October near $323.
    expect(
      projectMonth(totals, OCTOBER, 1000, NOW.getTime()).crossDay,
    ).toBeUndefined()
  })

  it("bills a total its cost less its subscription share, and finds today's cost", () => {
    expect(billedOf(usageTotals({ cost: 10, imported_cost: 4 }))).toBe(6)
    expect(billedOf(usageTotals({ cost: 3, imported_cost: 5 }))).toBe(0)
    const series = [
      seriesPoint({ bucket_start: "2026-10-11T00:00:00Z", cost: 7 }),
      seriesPoint({ bucket_start: "2026-10-12T00:00:00Z", cost: 2.5 }),
    ]
    expect(costOnDay(series, NOW)).toBe(2.5)
    expect(costOnDay(series, new Date("2026-10-13T01:00:00Z"))).toBe(0)
  })
})

describe("the budget", () => {
  it("judges a running month by its pace as well as its spend", () => {
    expect(budgetState(0.3, { pacePasses: false }).word).toBe("On track")
    expect(budgetState(0.6, { pacePasses: true })).toEqual({
      status: "warn",
      word: "At risk",
    })
    expect(budgetState(0.85, { pacePasses: false }).word).toBe("Near limit")
    expect(budgetState(1.2, { pacePasses: true })).toEqual({
      status: "alert",
      word: "Over budget",
    })
  })

  it("paces a period from how much of it has passed", () => {
    const pace = paceFor(
      300,
      { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
      NOW.getTime(),
    )
    expect(pace?.total).toBeCloseTo(808.7, 1)
    expect(
      paceFor(300, { start: null, end: null }, NOW.getTime()),
    ).toBeUndefined()
  })

  it("waits for the longer of a day or a tenth of the period, as the server does", () => {
    const month = { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" }
    // 3.1 days is a tenth of October: two days in is too soon, four is not.
    expect(
      paceFor(50, month, Date.parse("2026-10-03T00:00:00Z")),
    ).toBeUndefined()
    expect(paceFor(50, month, Date.parse("2026-10-05T00:00:00Z"))).toBeDefined()
    // A week-long period waits a day, not 0.7 of one.
    const week = { start: "2026-10-05T00:00:00Z", end: "2026-10-12T00:00:00Z" }
    expect(paceFor(5, week, Date.parse("2026-10-05T20:00:00Z"))).toBeUndefined()
    // Nothing settled, no pace.
    expect(paceFor(0, month, NOW.getTime())).toBeUndefined()
  })

  const base = {
    month: OCTOBER,
    now: NOW.getTime(),
    isManager: true,
    canSetBudgets: true,
    ownBilled: 71.25,
    workspaceBilled: 638.2,
    billed: 638.2,
    tightest: undefined,
    ceilingCount: null,
  }
  const spend = {
    max_budget: 1000,
    spent: 638.2,
    used_fraction: 0.6382,
    period_start: "2026-10-01T00:00:00Z",
    period_end: "2026-11-01T00:00:00Z",
  }

  it("adds the reader's share at You", () => {
    const view = budgetView({
      ...base,
      scope: "you",
      spend,
      settledSpent: 638.2,
      serverPace: { at: "2026-10-19T00:00:00Z" },
    })
    expect(view.kind).toBe("budget")
    if (view.kind !== "budget") return
    expect(view.line).toBe("On pace for $1,720 by Oct 31 · yours $71.25")
    expect(view.isWarning).toBe(true)
    expect(view.severity?.word).toBe("At risk")
  })

  it("says when the server's pace passes, where settled spend is not known", () => {
    const view = budgetView({
      ...base,
      scope: "you",
      isManager: false,
      spend,
      serverPace: { at: "2026-10-19T00:00:00Z" },
    })
    expect(view).toMatchObject({
      line: "On pace to pass it ~Oct 19 · yours $71.25",
      severity: { word: "At risk" },
    })
    // And without the server's word, no verdict and no pace: when it resets.
    expect(budgetView({ ...base, scope: "you", spend })).toMatchObject({
      line: "Resets Nov 1 · yours $71.25",
      severity: { word: "On track" },
    })
  })

  it("reads a past month's workspace spend against today's budget", () => {
    const view = budgetView({
      ...base,
      month: SEPTEMBER,
      scope: "workspace",
      spend,
      workspaceBilled: 941.3,
    })
    // No verdict: today's budget says nothing about how September went.
    expect(view).toMatchObject({
      kind: "budget",
      used: 941.3,
      subline: "$941.30 of today's $1,000",
      line: "Measured against today's budget",
    })
    expect(view.kind === "budget" && view.severity).toBeFalsy()
  })

  it("tells a member a past month's workspace spend is not theirs to read", () => {
    const view = budgetView({
      ...base,
      month: SEPTEMBER,
      scope: "you",
      isManager: false,
      spend,
      workspaceBilled: undefined,
    })
    expect(view).toMatchObject({
      kind: "unknown",
      subline: "$1,000 budget",
      line: "Workspace spend by month is for managers · yours $71.25",
    })
  })

  it("gives a member the share used, and no dollars, where the workspace hides its totals", () => {
    const hidden = { ...spend, spent: undefined }
    expect(
      budgetView({ ...base, scope: "you", isManager: false, spend: hidden }),
    ).toMatchObject({
      kind: "budget",
      fraction: 0.6382,
      used: 0.6382,
      cap: 1,
      subline: "used of $1,000",
      line: "Workspace total hidden by your admin · yours $71.25",
    })
    // A past month's share is not known at all.
    expect(
      budgetView({
        ...base,
        month: SEPTEMBER,
        scope: "you",
        isManager: false,
        spend: hidden,
      }),
    ).toMatchObject({
      kind: "unknown",
      subline: "$1,000 budget",
      line: "Workspace total hidden by your admin · yours $71.25",
    })
  })

  it("offers a budget where none is set, to whoever may set it", () => {
    expect(
      budgetView({ ...base, scope: "workspace", spend: null }),
    ).toMatchObject({
      kind: "none",
      label: "Workspace billed this month",
      note: "No workspace budget set",
      action: { text: "Set a budget", to: "/budgets" },
    })
    expect(
      budgetView({
        ...base,
        scope: "you",
        isManager: false,
        canSetBudgets: false,
        spend: null,
        billed: 12,
      }),
    ).toMatchObject({ kind: "none", label: "Billed this month", used: 12 })
  })

  it("reads the tightest ceiling across the organization", () => {
    expect(
      budgetView({
        ...base,
        scope: "organization",
        spend: undefined,
        tightest: { name: "Staging", spent: 455, allocated: 500, pct: 0.91 },
        ceilingCount: 1,
      }),
    ).toMatchObject({
      kind: "budget",
      label: "Tightest budget",
      line: "Staging ceiling",
      severity: { word: "Near limit" },
    })
    expect(
      budgetView({
        ...base,
        scope: "organization",
        spend: undefined,
        ceilingCount: 0,
      }),
    ).toMatchObject({ kind: "none", note: "No spend ceilings set" })
    // A month that has ended is read against today's cap, without a verdict.
    const past = budgetView({
      ...base,
      month: SEPTEMBER,
      scope: "organization",
      spend: undefined,
      tightest: { name: "Staging", spent: 455, allocated: 500, pct: 0.91 },
      ceilingCount: 1,
    })
    expect(past).toMatchObject({ line: "Staging ceiling · today's cap" })
    expect(past.kind === "budget" && past.severity).toBeFalsy()
  })
})

describe("the budget from what the page read", () => {
  const overview = {
    attention: [] as OverviewAttentionItem[],
    ceilings: null,
    limits: { kind: "keys" as const, rows: [] },
  }
  const read = {
    scope: "you" as const,
    month: OCTOBER,
    now: NOW.getTime(),
    isManager: true,
    canSetBudgets: true,
    workspaceId: "ws-a",
    organizationName: "Acme",
    totals: usageTotals({ cost: 80, imported_cost: 8.75 }),
    workspaceTotals: usageTotals({ cost: 700, imported_cost: 61.8 }),
    spend: {
      max_budget: 1000,
      spent: 640,
      used_fraction: 0.64,
      period_start: "2026-10-01T00:00:00Z",
      period_end: "2026-11-01T00:00:00Z",
    },
    overview,
  }

  it("paces the workspace's billed spend where the budget's period is the month", () => {
    expect(readBudget(read)).toMatchObject({
      kind: "budget",
      used: 640,
      // $638.20 over 11.5 days of October's 31.
      line: "On pace for $1,720 by Oct 31 · yours $71.25",
      severity: { word: "On track" },
    })
    // Another period: the month's spend is no rate for it.
    expect(
      readBudget({
        ...read,
        spend: { ...read.spend, period_start: "2026-10-05T00:00:00Z" },
      }),
    ).toMatchObject({ line: "Resets Nov 1 · yours $71.25" })
  })

  it("reads a withheld spend as the share of the cap, not as unknown", () => {
    expect(
      readBudget({
        ...read,
        isManager: false,
        spend: { ...read.spend, spent: null, used_fraction: 0.64 },
      }),
    ).toMatchObject({
      kind: "budget",
      fraction: 0.64,
      cap: 1,
      subline: "used of $1,000",
    })
  })

  it("is at risk on the server's pace item for this workspace only", () => {
    const pace = (subject: string) => ({
      ...overview,
      attention: [
        {
          kind: "budget_pace" as const,
          severity: "warn" as const,
          subject_id: subject,
          subject_name: null,
          used: null,
          limit: null,
          fraction: null,
          at: "2026-10-19T00:00:00Z",
          count: null,
        },
      ],
    })
    expect(readBudget({ ...read, overview: pace("ws-a") })).toMatchObject({
      severity: { word: "At risk" },
      isWarning: true,
    })
    expect(readBudget({ ...read, overview: pace("ws-b") })).toMatchObject({
      severity: { word: "On track" },
    })
  })

  it("names the tightest ceiling after the limit row it caps, else what it caps", () => {
    const ceilings = {
      over_count: 0,
      near_count: 1,
      capped_count: 1,
      total_count: 1,
      worst: {
        budget_id: "11111111-2222-3333-4444-555555555555",
        name: null,
        spent: 455,
        allocated: 500,
        scope_type: "workspace" as const,
        scope_id: "ws-b",
      },
    }
    const organization = { ...read, scope: "organization" as const }
    expect(
      readBudget({
        ...organization,
        overview: {
          ...overview,
          ceilings,
          limits: {
            kind: "workspaces",
            rows: [
              {
                id: "ws-b",
                name: "Staging",
                owner_name: null,
                is_mine: false,
                spent: 455,
                limit: 500,
                limit_spent: null,
                period_end: null,
                last_used_at: null,
                expires_at: null,
                is_subscription: false,
              },
            ],
          },
        },
      }),
    ).toMatchObject({ label: "Tightest budget", line: "Staging ceiling" })
    expect(
      readBudget({ ...organization, overview: { ...overview, ceilings } }),
    ).toMatchObject({ line: "A workspace ceiling" })
    // Unread, the count of ceilings is unknown rather than none.
    expect(readBudget({ ...organization, overview: undefined })).toMatchObject({
      kind: "unknown",
    })
  })
})

describe("attention keys", () => {
  it("key an item by its kind and its subject", () => {
    expect(attentionKey({ kind: "key_near_limit", subject_id: "key-1" })).toBe(
      "key_near_limit:key-1",
    )
    expect(attentionKey({ kind: "error_rate", subject_id: null })).toBe(
      "error_rate:",
    )
  })
})

describe("what needs attention", () => {
  const item = (
    kind: OverviewAttentionItem["kind"],
    over: Partial<OverviewAttentionItem> = {},
  ): OverviewAttentionItem => ({
    kind,
    severity: "warn",
    subject_id: null,
    subject_name: null,
    used: null,
    limit: null,
    fraction: null,
    at: null,
    count: null,
    ...over,
  })
  const options = {
    servesProviders: true,
    canManageBudgets: true,
    workspaceId: "ws-here",
    failuresSearch: { status: "error" },
  }

  it("words each kind and links where it is fixed", () => {
    expect(
      describeAttention(
        item("budget_near", {
          subject_id: "ws-there",
          subject_name: "Staging",
          fraction: 0.91,
        }),
        options,
      ),
    ).toEqual({ text: "Staging at 91% of its ceiling", to: "/budgets" })
    expect(
      describeAttention(
        item("budget_pace", {
          subject_id: "ws-here",
          subject_name: "Research",
          at: "2026-10-19T00:00:00Z",
        }),
        options,
      ),
    ).toEqual({
      text: "Workspace on pace to pass its budget ~Oct 19",
      to: "/budgets",
    })
    expect(
      describeAttention(
        item("key_over_limit", { subject_name: "ci", limit: 25 }),
        options,
      ),
    ).toEqual({ text: "ci over its $25 limit", to: "/keys" })
    expect(
      describeAttention(
        item("key_expiring", {
          subject_name: "eval",
          at: "2026-10-15T00:00:00Z",
        }),
        options,
      ),
    ).toEqual({ text: "eval expires Oct 15", to: "/keys" })
    expect(
      describeAttention(
        item("error_rate", { severity: "alert", fraction: 0.12, count: 30 }),
        options,
      ),
    ).toEqual({
      text: "Error rate 12.0%",
      to: "/activity",
      search: { status: "error" },
    })
  })

  it("links a budget nowhere for a reader who cannot open Budgets", () => {
    expect(
      describeAttention(
        item("budget_over", {
          subject_id: "ws-here",
          subject_name: "Research",
        }),
        { ...options, canManageBudgets: false },
      ),
    ).toEqual({ text: "Workspace over its budget" })
  })

  it("names a provider problem without a link where no page serves it", () => {
    expect(
      describeAttention(
        item("provider_unreachable", { subject_name: "fireworks" }),
        { ...options, servesProviders: false },
      ),
    ).toEqual({ text: "1 provider unreachable: fireworks" })
  })

  it("folds every unreachable provider into one item where the first stood", () => {
    const key = item("key_near_limit", { subject_name: "ci" })
    const grouped = groupAttention([
      item("provider_unreachable", { subject_name: "anthropic" }),
      key,
      item("provider_unreachable", { subject_name: "openai" }),
    ])
    expect(grouped).toHaveLength(2)
    expect(grouped[1]).toBe(key)
    expect(
      describeAttention(grouped[0], { ...options, servesProviders: false }),
    ).toEqual({ text: "2 providers unreachable: anthropic, openai" })
  })

  it("names two providers at most, then counts the rest", () => {
    const grouped = groupAttention(
      ["fireworks", "groq", "mistral"].map((name) =>
        item("provider_unreachable", { subject_name: name }),
      ),
    )
    expect(
      describeAttention(grouped[0], { ...options, servesProviders: false }),
    ).toEqual({ text: "3 providers unreachable: fireworks, groq +1" })
  })
})

describe("budget chart axis", () => {
  it("tops out at a 1, 2 or 5 step so the midpoint is round", () => {
    expect(budgetAxisTop(560)).toBe(1000)
    expect(budgetAxisTop(1120)).toBe(2000)
    expect(budgetAxisTop(4.2)).toBe(5)
    expect(budgetAxisTop(0)).toBe(1)
  })
})

describe("expiry", () => {
  it("counts whole days, at or below zero once it has passed", () => {
    expect(daysUntil("2026-10-15T00:00:00Z", NOW.getTime())).toBe(3)
    expect(daysUntil("2026-10-01T00:00:00Z", NOW.getTime())).toBeLessThan(1)
  })
})

describe("describeChartCaptionLead", () => {
  const base = {
    isAwaitingTotals: false,
    isOwnOnly: false,
    hasBudget: true,
    isHiddenFromMember: false,
    showsBudget: true,
    isCurrentMonth: true,
  }

  it("says nothing while a member's setting is unknown", () => {
    expect(
      describeChartCaptionLead({
        ...base,
        isAwaitingTotals: true,
        isOwnOnly: true,
      }),
    ).toBe("")
  })

  it("names the admin where the totals are hidden from a member", () => {
    expect(
      describeChartCaptionLead({
        ...base,
        isOwnOnly: true,
        isHiddenFromMember: true,
        showsBudget: false,
      }),
    ).toMatch(
      /^Workspace totals are hidden by your admin, so there's no budget line/,
    )
  })

  it("explains a reader's own spend alone, this month and in a past one", () => {
    const own = { ...base, isOwnOnly: true, showsBudget: false }
    expect(describeChartCaptionLead(own)).toMatch(
      /the Workspace budget tile measures/,
    )
    expect(describeChartCaptionLead({ ...own, isCurrentMonth: false })).toMatch(
      /workspace spend by month is for managers/,
    )
  })

  it("says nothing of a budget line where the workspace has no budget", () => {
    expect(
      describeChartCaptionLead({
        ...base,
        isOwnOnly: true,
        hasBudget: false,
        isHiddenFromMember: true,
        showsBudget: false,
      }),
    ).toBe("")
  })

  it("says a past month's line is today's budget", () => {
    expect(describeChartCaptionLead({ ...base, isCurrentMonth: false })).toBe(
      "Past budgets aren't stored, so the line is today's budget. ",
    )
    expect(describeChartCaptionLead(base)).toBe("")
  })
})
