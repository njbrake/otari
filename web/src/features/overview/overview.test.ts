import { describe, expect, it } from "vitest"

import type { AllocationHealth } from "@/client"
import {
  errorRateHealth,
  tightestAllocation,
} from "@/features/overview/overview"
import { usageTotals } from "@/tests/fixtures"

const totals = usageTotals

describe("errorRateHealth", () => {
  it("is neutral with no requests (no divide-by-zero)", () => {
    expect(
      errorRateHealth(totals({ request_count: 0, error_count: 0 })),
    ).toEqual({ rate: null, status: "neutral" })
    expect(errorRateHealth(undefined)).toEqual({
      rate: null,
      status: "neutral",
    })
  })

  it("crosses amber at 2% and red at 10%", () => {
    expect(
      errorRateHealth(totals({ request_count: 1000, error_count: 5 })).status,
    ).toBe("ok") // 0.5%
    expect(
      errorRateHealth(totals({ request_count: 1000, error_count: 20 })).status,
    ).toBe("warn") // 2%
    expect(
      errorRateHealth(totals({ request_count: 1000, error_count: 100 })).status,
    ).toBe("alert") // 10%
  })

  it("passes no verdict under 20 requests, as the server's error-rate item does", () => {
    expect(
      errorRateHealth(totals({ request_count: 3, error_count: 1 })),
    ).toEqual({ rate: 1 / 3, status: "neutral" })
    expect(
      errorRateHealth(totals({ request_count: 20, error_count: 2 })).status,
    ).toBe("alert")
  })
})

function health(over: Partial<AllocationHealth> = {}): AllocationHealth {
  return {
    over_count: 0,
    near_count: 0,
    capped_count: 1,
    total_count: 1,
    worst: {
      budget_id: "11111111-2222-3333-4444-555555555555",
      name: "Monthly",
      spent: 50,
      allocated: 100,
      scope_type: null,
      scope_id: null,
    },
    ...over,
  }
}

describe("tightestAllocation", () => {
  it("is nothing where nothing is capped, or the caller may not see the scan", () => {
    expect(tightestAllocation(health({ capped_count: 0, worst: null }))).toBe(
      undefined,
    )
    expect(tightestAllocation(null)).toBeUndefined()
    expect(tightestAllocation(undefined)).toBeUndefined()
  })

  it("derives the share from the row the server picked", () => {
    expect(
      tightestAllocation(
        health({ worst: { ...health().worst!, spent: 75, allocated: 300 } }),
      )?.pct,
    ).toBe(0.25)
  })

  it("reads spend against an allowance of zero as a full share", () => {
    expect(
      tightestAllocation(
        health({ worst: { ...health().worst!, spent: 5, allocated: 0 } }),
      )?.pct,
    ).toBe(1)
  })

  it("names an unnamed row by what it caps, else by its id fingerprint", () => {
    const unnamed = health({
      worst: {
        ...health().worst!,
        name: null,
        scope_type: "workspace",
        scope_id: "ws-1",
      },
    })
    expect(tightestAllocation(unnamed, () => "A workspace")?.name).toBe(
      "A workspace",
    )
    expect(tightestAllocation(unnamed)?.name).toBe("11111111")
  })
})
