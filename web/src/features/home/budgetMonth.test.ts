import { afterEach, describe, expect, it } from "vitest"
import {
  axisTop,
  budgetLine,
  canProject,
  ceilingCounter,
  dailyTotals,
  dayLabel,
  monthAt,
  monthFromUrl,
  monthlyCap,
  monthName,
  monthRange,
  offeredMonths,
  projectMonth,
  runningTotal,
} from "@/features/home/budgetMonth"

const at = (iso: string) => Date.parse(iso)

describe("month bounds", () => {
  const original = process.env.TZ
  afterEach(() => {
    process.env.TZ = original
  })

  it("counts February's 28 days, and 29 in a leap year", () => {
    expect(monthAt(2026, 1, at("2026-02-10T00:00:00Z")).length).toBe(28)
    expect(monthAt(2028, 1, at("2028-02-10T00:00:00Z")).length).toBe(29)
    expect(monthAt(2026, 3, at("2026-04-10T00:00:00Z")).length).toBe(30)
    expect(monthAt(2026, 11, at("2026-12-10T00:00:00Z")).length).toBe(31)
  })

  it("starts and ends on the 1st at UTC midnight, whatever the browser's zone", () => {
    for (const zone of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
      process.env.TZ = zone
      const month = monthAt(2026, 10, at("2026-11-20T12:00:00Z"))
      expect(monthRange(month)).toEqual({
        start_date: "2026-11-01T00:00:00.000Z",
        end_date: "2026-12-01T00:00:00.000Z",
      })
      expect(dayLabel(month, 1)).toBe("Nov 1")
      expect(dayLabel(month, 30)).toBe("Nov 30")
    }
  })

  it("reads the month a UTC instant is in, not the local one", () => {
    process.env.TZ = "America/New_York"
    // 23:30 on February 28 in New York is already March 1 in UTC, which is
    // when the budget reset.
    const now = at("2026-02-28T23:30:00-05:00")
    const [current, before] = offeredMonths(now)
    expect(current.key).toBe("2026-03")
    expect(current.elapsed).toBe(1)
    expect(before).toMatchObject({ key: "2026-02", length: 28, elapsed: 28 })
  })

  it("offers this month and the eleven before it, across a new year", () => {
    const months = offeredMonths(at("2026-02-15T00:00:00Z"))
    expect(months.map((month) => month.key)).toEqual([
      "2026-02",
      "2026-01",
      "2025-12",
      "2025-11",
      "2025-10",
      "2025-09",
      "2025-08",
      "2025-07",
      "2025-06",
      "2025-05",
      "2025-04",
      "2025-03",
    ])
    expect(months.map((month) => month.isCurrent)).toEqual([
      true,
      ...Array(11).fill(false),
    ])
  })

  it("opens on this month for a URL naming none, or one out of reach", () => {
    const now = at("2026-11-20T00:00:00Z")
    expect(monthFromUrl("", now).key).toBe("2026-11")
    expect(monthFromUrl("2026-09", now).key).toBe("2026-09")
    expect(monthFromUrl("2024-01", now).key).toBe("2026-11")
    expect(monthFromUrl("bogus", now).key).toBe("2026-11")
  })

  it("names the month under way This month, and any other by name", () => {
    const now = at("2026-11-20T00:00:00Z")
    const [current, before] = offeredMonths(now)
    expect(monthName(current)).toBe("This month")
    expect(monthName(before)).toBe("October 2026")
  })
})

describe("the month's spend", () => {
  const now = at("2026-11-04T12:00:00Z")
  const month = monthAt(2026, 10, now)

  it("puts each day's cost on its day, and zero on a day with none", () => {
    expect(
      dailyTotals(
        [
          { bucket_start: "2026-11-01T00:00:00Z", cost: 1 },
          { bucket_start: "2026-11-03T00:00:00Z", cost: 2.5 },
          // Outside the month: neither the day before it nor after.
          { bucket_start: "2026-10-31T00:00:00Z", cost: 9 },
          { bucket_start: "2026-12-01T00:00:00Z", cost: 9 },
        ],
        month,
      ),
    ).toEqual([1, 0, 2.5, 0])
  })

  it("adds the days up", () => {
    expect(runningTotal([1, 0, 2.5, 0])).toEqual([1, 1, 3.5, 3.5])
  })

  it("rounds the axis up to a 1, 2 or 5 step", () => {
    expect(axisTop(0)).toBe(1)
    expect(axisTop(0.3)).toBe(0.5)
    expect(axisTop(1)).toBe(1)
    expect(axisTop(130)).toBe(200)
    expect(axisTop(420)).toBe(500)
    expect(axisTop(612)).toBe(1000)
  })
})

describe("projectMonth", () => {
  // November has 30 days; three of them have run by noon on the 4th.
  const now = at("2026-11-04T00:00:00Z")
  const month = monthAt(2026, 10, now)

  it("runs the month on at its pace so far", () => {
    // $30 over three whole days is $10 a day.
    const projection = projectMonth([10, 20, 30, 30], month, undefined, now)
    expect(projection.projected).toHaveLength(26)
    expect(projection.projected[0]).toBeCloseTo(50)
    expect(projection.projected.at(-1)).toBeCloseTo(300)
    expect(projection.end).toBeCloseTo(300)
    expect(projection.crossDay).toBeUndefined()
  })

  it("marks the day the pace crosses the budget", () => {
    // At $10 a day, $125 is passed on the 13th.
    expect(projectMonth([10, 20, 30, 30], month, 125, now).crossDay).toBe(13)
  })

  it("marks the day the spend already crossed it, before any projection", () => {
    expect(projectMonth([10, 80, 130, 130], month, 100, now).crossDay).toBe(3)
  })

  it("projects nothing for a month too young to have a pace", () => {
    const early = at("2026-11-02T06:00:00Z")
    const young = monthAt(2026, 10, early)
    expect(canProject(young, early)).toBe(false)
    expect(projectMonth([5, 6], young, 1, early)).toEqual({
      projected: [],
      end: 6,
      // Already over the budget, which needs no pace to say.
      crossDay: 1,
    })
  })

  it("projects nothing for a month that is over", () => {
    const past = monthAt(2026, 9, now)
    expect(past.elapsed).toBe(31)
    const totals = Array.from({ length: 31 }, (_, index) => index + 1)
    const projection = projectMonth(totals, past, undefined, now)
    expect(projection.projected).toEqual([])
    expect(projection.end).toBe(31)
  })

  it("projects nothing when nothing was spent", () => {
    expect(projectMonth([0, 0, 0, 0], month, 10, now)).toEqual({
      projected: [],
      end: 0,
      crossDay: undefined,
    })
  })
})

describe("monthlyCap", () => {
  it("reads a limit that resets with the calendar month", () => {
    expect(
      monthlyCap({ max: 500, ceiling: { reset_alignment: "calendar_month" } }),
    ).toBe(500)
  })
  it("reads none from a limit on another cadence, or none at all", () => {
    expect(
      monthlyCap({ max: 50, ceiling: { reset_alignment: "calendar_week" } }),
    ).toBeUndefined()
    expect(
      monthlyCap({ max: 50, ceiling: { reset_alignment: null } }),
    ).toBeUndefined()
    expect(monthlyCap(null)).toBeUndefined()
  })
})

describe("a budget that began mid-month", () => {
  const now = at("2026-11-20T00:00:00Z")
  const month = monthAt(2026, 10, now)
  // $3 a day from the 1st: $57 by the end of the 19th, $60 with today's.
  const totals = runningTotal(Array.from({ length: 20 }, () => 3))

  it("counts from the day its counter began, the spend before under its line", () => {
    const line = budgetLine({
      cap: 35,
      totals,
      month,
      startedAt: at("2026-11-12T15:00:00Z"),
    })
    expect(line).toMatchObject({ cap: 35, fromDay: 11, base: 33 })
  })

  it("passes no verdict on spend before it began", () => {
    // $60 spent this month is past $35, but only $27 of it since the 12th.
    const line = budgetLine({
      cap: 35,
      totals,
      month,
      startedAt: at("2026-11-12T00:00:00Z"),
    })
    const projection = projectMonth(totals, month, line, now)
    expect(totals.at(-1)).toBe(60)
    expect(projection.crossDay).not.toBe(1)
    // At $27 over 8 days it crosses $35 on about the 15th day of counting.
    expect(projection.crossDay).toBeGreaterThan(20)
  })

  it("takes the spend it does not count from the counter, where there is one", () => {
    const line = budgetLine({ cap: 35, totals, month, counter: 12 })
    expect(line).toMatchObject({ fromDay: 0, base: 48 })
    expect(projectMonth(totals, month, line, now).crossDay).toBeUndefined()
  })

  it("counts the whole month for a counter that began before it or after it", () => {
    expect(
      budgetLine({
        cap: 1,
        totals,
        month,
        startedAt: at("2026-10-05T00:00:00Z"),
      }).fromDay,
    ).toBe(0)
    const october = monthAt(2026, 9, now)
    expect(
      budgetLine({
        cap: 1,
        totals: [1],
        month: october,
        startedAt: at("2026-11-12T00:00:00Z"),
      }),
    ).toMatchObject({ fromDay: 0, base: 0 })
  })
})

describe("ceilingCounter", () => {
  const now = at("2026-11-20T00:00:00Z")
  it("starts at the later of the period's start and the ceiling's creation", () => {
    expect(
      ceilingCounter(
        {
          period_start: "2026-11-01T00:00:00+00:00",
          period_end: "2026-12-01T00:00:00+00:00",
          created_at: "2026-11-12T09:00:00+00:00",
          current_spend: 4.5,
        },
        now,
      ),
    ).toEqual({ startedAt: at("2026-11-12T09:00:00Z"), counter: 4.5 })
  })
  it("reads no counter from a period that has ended", () => {
    expect(
      ceilingCounter(
        {
          period_start: "2026-10-01T00:00:00+00:00",
          period_end: "2026-11-01T00:00:00+00:00",
          created_at: "2026-01-01T00:00:00+00:00",
          current_spend: 40,
        },
        now,
      ).counter,
    ).toBeUndefined()
  })
})
