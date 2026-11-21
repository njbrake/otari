import { describe, expect, it } from "vitest"
import { fittedColumns } from "@/features/usage/breakdownFit"

const KEYS = [
  "name",
  "cost",
  "charged",
  "not_charged",
  "requests",
  "tokens",
  "failed",
  "p95",
  "model",
  "share",
  "limit",
  "actions",
]

describe("fittedColumns", () => {
  it("shows every column where the room is not known or is enough", () => {
    expect([...fittedColumns(KEYS, undefined)]).toEqual(KEYS)
    expect([...fittedColumns(KEYS, 4000)]).toEqual(KEYS)
  })

  it("gives up the derivable and descriptive lanes first, and keeps the name, spend and limit", () => {
    const shown = fittedColumns(KEYS, 968)
    for (const id of ["name", "cost", "limit", "actions"]) {
      expect(shown.has(id)).toBe(true)
    }
    expect(shown.has("not_charged")).toBe(false)
    expect(shown.has("model")).toBe(false)
    expect(shown.has("share")).toBe(false)
  })

  it("fits the room it is given", () => {
    for (const available of [968, 1100, 1300]) {
      const shown = [...fittedColumns(KEYS, available)]
      const widths: Record<string, number> = {
        name: 180,
        cost: 150,
        charged: 94,
        not_charged: 110,
        requests: 110,
        tokens: 110,
        failed: 100,
        p95: 88,
        model: 166,
        share: 176,
        limit: 272,
        actions: 64,
      }
      const total = shown.reduce((sum, id) => sum + widths[id], 0)
      expect(total).toBeLessThanOrEqual(available)
    }
  })

  it("keeps the column the table is sorted by", () => {
    expect(
      fittedColumns(KEYS, 968, { keep: "not_charged" }).has("not_charged"),
    ).toBe(true)
  })
})
