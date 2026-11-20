import { describe, expect, it } from "vitest"
import {
  expiryNote,
  failureSeverity,
  lastUsedLine,
  resetsLabel,
  spendSplit,
} from "@/features/home/homeFigures"

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Local noon, so a day either side stays on its own calendar day in any zone.
const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

describe("spendSplit", () => {
  it("splits the window's spend into charged and not charged", () => {
    expect(spendSplit(50, 30)).toEqual({ charged: 30, notCharged: 20 })
  })

  it("says nothing when everything was charged, or under half a cent was not", () => {
    expect(spendSplit(50, 50)).toBeUndefined()
    expect(spendSplit(50, 49.996)).toBeUndefined()
  })

  it("says nothing until the charged read answers", () => {
    expect(spendSplit(50, undefined)).toBeUndefined()
  })

  it("counts everything as not charged when nothing counted toward a budget", () => {
    expect(spendSplit(12, 0)).toEqual({ charged: 0, notCharged: 12 })
  })

  it("never reads a charged figure above the total it is part of", () => {
    // The two reads answer separately, so one can be a request ahead.
    expect(spendSplit(10, 10.5)).toBeUndefined()
  })
})

describe("failureSeverity", () => {
  it("is Healthy under 2%, or with fewer than five failures", () => {
    expect(failureSeverity(19, 1000).word).toBe("Healthy")
    expect(failureSeverity(4, 10)).toEqual({ status: "ok", word: "Healthy" })
    expect(failureSeverity(0, 0).word).toBe("Healthy")
  })

  it("is Elevated from 2% to under 10%", () => {
    expect(failureSeverity(20, 1000)).toEqual({
      status: "warn",
      word: "Elevated",
    })
    expect(failureSeverity(99, 1000).word).toBe("Elevated")
  })

  it("is High at 10% with 20 or more requests, as Needs attention judges it", () => {
    expect(failureSeverity(100, 1000)).toEqual({
      status: "alert",
      word: "High",
    })
    expect(failureSeverity(5, 20).word).toBe("High")
    expect(failureSeverity(5, 19).word).toBe("Elevated")
  })
})

describe("resetsLabel", () => {
  it("names the day a limit starts over", () => {
    const end = new Date(2026, 11, 1, 0, 0, 0).getTime()
    expect(resetsLabel(iso(end), NOW)).toBe("Resets Dec 1")
  })

  it("says tomorrow for the next calendar day", () => {
    expect(resetsLabel(iso(NOW + DAY), NOW)).toBe("Resets tomorrow")
  })

  it("gives the time for a limit that starts over later today", () => {
    const end = new Date(2026, 10, 20, 15, 0, 0).getTime()
    expect(resetsLabel(iso(end), NOW)).toBe("Resets at 3:00 PM")
  })

  it("says nothing for a limit that never resets or whose period ended", () => {
    expect(resetsLabel(null, NOW)).toBe("")
    expect(resetsLabel(iso(NOW - HOUR), NOW)).toBe("")
  })
})

describe("expiryNote", () => {
  it("warns within seven days, by calendar day", () => {
    expect(expiryNote(iso(NOW + 3 * DAY), NOW)).toEqual({
      text: "Expires in 3 days",
      tone: "warning",
    })
    expect(expiryNote(iso(NOW + DAY), NOW)?.text).toBe("Expires tomorrow")
    expect(expiryNote(iso(NOW + HOUR), NOW)?.text).toBe("Expires today")
  })

  it("marks an expired key as danger", () => {
    expect(expiryNote(iso(NOW - DAY), NOW)).toEqual({
      text: "Expired",
      tone: "danger",
    })
  })

  it("says nothing for a key that does not expire or expires later", () => {
    expect(expiryNote(null, NOW)).toBeUndefined()
    expect(expiryNote(iso(NOW + 8 * DAY), NOW)).toBeUndefined()
  })
})

describe("lastUsedLine", () => {
  it("says when a key was last used, or that it never was", () => {
    expect(lastUsedLine(iso(NOW - 2 * HOUR), NOW)).toBe("Used 2h ago")
    expect(lastUsedLine(null, NOW)).toBe("Never used")
  })
})
