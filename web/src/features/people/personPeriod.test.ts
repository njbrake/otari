import { describe, expect, it } from "vitest"
import {
  PERSON_PERIODS,
  personPeriodFromUrl,
} from "@/features/people/personPeriod"

describe("personPeriodFromUrl", () => {
  it("opens on this month, and on it for a window it does not offer", () => {
    expect(personPeriodFromUrl("")).toBe("month")
    expect(personPeriodFromUrl("yesterday")).toBe("month")
    expect(personPeriodFromUrl("bogus")).toBe("month")
  })

  it("reads every window it offers", () => {
    for (const period of PERSON_PERIODS) {
      expect(personPeriodFromUrl(period.value)).toBe(period.value)
    }
    expect(PERSON_PERIODS.map((period) => period.label)).toEqual([
      "This month",
      "Today",
      "7D",
      "30D",
      "3M",
      "6M",
    ])
  })
})
