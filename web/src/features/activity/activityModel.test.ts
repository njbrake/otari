import { describe, expect, it } from "vitest"

import type { ChargeLine, UsageEntry } from "@/client"
import { entry } from "@/tests/activity"
import {
  buildTokenComposition,
  cacheHitFraction,
  computeToolCost,
  countToolCalls,
  describeFailure,
  describeRowSource,
  formatElapsed,
  isImported,
  listToolUsage,
  requestedAlias,
  resolveExtentWindow,
  resolveWindow,
  rowCost,
  rowOutcome,
  sortChargeLines,
  sortPlanRows,
  tokenSegments,
} from "./activityModel"

/** A fixed clock, so a rolling preset's start is an exact instant to compare. */
const NOW = Date.parse("2026-01-15T12:00:00.000Z")

/** A row of one routing group, in the shape the writers emit per attempt. */
function attempt(overrides: Partial<UsageEntry>): UsageEntry {
  return entry({
    request_group_id: "grp-1",
    policy_name: "cheap-first",
    attempt_count: 2,
    ...overrides,
  })
}

describe("resolveWindow", () => {
  it("prefers explicit bounds over the preset", () => {
    expect(
      resolveWindow("24h", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", NOW),
    ).toEqual({ start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" })
  })

  it("keeps a half-open range half-open", () => {
    expect(resolveWindow("24h", "2026-01-01T00:00:00Z", "", NOW)).toEqual({
      start: "2026-01-01T00:00:00Z",
      end: undefined,
    })
  })

  it("anchors a rolling preset to the clock it is handed", () => {
    expect(resolveWindow("24h", "", "", NOW)).toEqual({
      start: "2026-01-14T12:00:00.000Z",
      end: undefined,
    })
  })

  it("leaves the unbounded All preset open at both ends", () => {
    expect(resolveWindow("all", "", "", NOW)).toEqual({
      start: undefined,
      end: undefined,
    })
  })

  it("leaves an empty custom range open rather than falling back to a preset", () => {
    expect(resolveWindow("custom", "", "", NOW)).toEqual({})
  })

  it("falls back to the default preset for a range this page does not offer", () => {
    // A Usage-page key carried across in a hand-edited URL: 90d is a preset
    // there and not here, so the window has to be the Activity default.
    expect(resolveWindow("90d", "", "", NOW)).toEqual(
      resolveWindow("24h", "", "", NOW),
    )
  })
})

describe("resolveExtentWindow", () => {
  it("matches the list window for a bounded preset", () => {
    expect(resolveExtentWindow("7d", NOW)).toEqual(
      resolveWindow("7d", "", "", NOW),
    )
  })

  it("gives the unbounded All preset an explicit year-long start", () => {
    // Without it the summary endpoint applies its hidden 30-day default and the
    // bars silently show a rolling month under a caption reading "All time".
    expect(resolveExtentWindow("all", NOW)).toEqual({
      start: "2025-01-15T12:00:00.000Z",
    })
  })

  it("gives the custom sentinel the same year-long start", () => {
    expect(resolveExtentWindow("custom", NOW)).toEqual({
      start: "2025-01-15T12:00:00.000Z",
    })
  })
})

describe("buildTokenComposition", () => {
  it("prefers the normalized meters over the raw columns", () => {
    // The meters say the cache buckets sit inside total_input_tokens; the raw
    // columns on the same row say something else, and must not be consulted.
    const composition = buildTokenComposition(
      entry({
        prompt_tokens: 9,
        completion_tokens: 9,
        cache_read_tokens: 9,
        cache_write_tokens: 9,
        billing_meters: {
          total_input_tokens: 1000,
          cache_read_tokens: 600,
          cache_write_tokens: 100,
          completion_tokens: 200,
        },
      }),
    )
    expect(composition).toEqual({
      fresh: 300,
      cacheRead: 600,
      cacheWrite: 100,
      output: 200,
      total: 1200,
    })
  })

  it("falls back per key, not per object", () => {
    // A row can carry a tools meter while its tokens were never metered.
    // Keying off the object's presence would read every token as 0.
    const composition = buildTokenComposition(
      entry({
        prompt_tokens: 400,
        completion_tokens: 100,
        cache_read_tokens: null,
        cache_write_tokens: null,
        billing_meters: { tools: { web_search: { billed: 1 } } },
      }),
    )
    expect(composition).toEqual({
      fresh: 400,
      cacheRead: 0,
      cacheWrite: 0,
      output: 100,
      total: 500,
    })
  })

  it("clamps fresh input rather than reporting a negative split", () => {
    const composition = buildTokenComposition(
      entry({
        prompt_tokens: 100,
        completion_tokens: 0,
        cache_read_tokens: 400,
        cache_write_tokens: null,
        billing_meters: null,
      }),
    )
    expect(composition).toMatchObject({ fresh: 0, cacheRead: 400, total: 400 })
  })

  it("answers null for a row that carries no usage at all", () => {
    expect(
      buildTokenComposition(
        entry({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          billing_meters: null,
        }),
      ),
    ).toBeNull()
  })
})

describe("listToolUsage", () => {
  it("reads the reserved tools namespace, heaviest first", () => {
    expect(
      listToolUsage(
        entry({
          billing_meters: {
            total_input_tokens: 10,
            tools: {
              web_search: { billed: 2, errors: 1, unit_rate: 0.01 },
              code_execution: { billed: 5 },
            },
          },
        }),
      ),
    ).toEqual([
      { tool: "code_execution", billed: 5, errors: 0, unitRate: null },
      { tool: "web_search", billed: 2, errors: 1, unitRate: 0.01 },
    ])
  })

  it("drops a tool that neither billed nor failed", () => {
    expect(
      listToolUsage(
        entry({ billing_meters: { tools: { web_fetch: { billed: 0 } } } }),
      ),
    ).toEqual([])
  })

  it("is empty for a row with no meters", () => {
    expect(listToolUsage(entry({ billing_meters: null }))).toEqual([])
  })
})

describe("computeToolCost", () => {
  it("bills each tool at the rate stored with the row", () => {
    expect(
      computeToolCost(
        entry({
          billing_meters: {
            tools: {
              web_search: { billed: 3, unit_rate: 0.01 },
              web_fetch: { billed: 2, unit_rate: 0.005 },
            },
          },
        }),
      ),
    ).toBeCloseTo(0.04, 10)
  })

  it("excludes failed calls, which are not billed", () => {
    expect(
      computeToolCost(
        entry({
          billing_meters: {
            tools: { web_search: { billed: 1, errors: 4, unit_rate: 0.01 } },
          },
        }),
      ),
    ).toBeCloseTo(0.01, 10)
  })

  it("answers null when any billed tool has no stored rate", () => {
    // Null is "unpriced", which the detail panel says in words. Summing the
    // priced ones would report a cost that is quietly short.
    expect(
      computeToolCost(
        entry({
          billing_meters: {
            tools: {
              web_search: { billed: 3, unit_rate: 0.01 },
              code_execution: { billed: 1 },
            },
          },
        }),
      ),
    ).toBeNull()
  })

  it("answers zero for a row with no tool calls", () => {
    expect(computeToolCost(entry({ billing_meters: null }))).toBe(0)
  })
})

describe("sortPlanRows", () => {
  it("orders by attempt position, not by the order it was handed", () => {
    const rows = [
      attempt({ id: "b", attempt_position: 2 }),
      attempt({ id: "a", attempt_position: 1 }),
    ]
    expect(sortPlanRows(rows).map((row) => row.id)).toEqual(["a", "b"])
  })

  it("breaks a tie on the timestamp, for rows written before the column existed", () => {
    const rows = [
      attempt({
        id: "late",
        attempt_position: null,
        timestamp: "2026-01-02T00:00:00Z",
      }),
      attempt({
        id: "early",
        attempt_position: null,
        timestamp: "2026-01-01T00:00:00Z",
      }),
    ]
    expect(sortPlanRows(rows).map((row) => row.id)).toEqual(["early", "late"])
  })

  it("leaves the rows it was given alone", () => {
    const rows = [
      attempt({ id: "b", attempt_position: 2 }),
      attempt({ id: "a", attempt_position: 1 }),
    ]
    sortPlanRows(rows)
    expect(rows.map((row) => row.id)).toEqual(["b", "a"])
  })
})

describe("sortChargeLines", () => {
  it("puts token lines before tool lines, each keeping its written order", () => {
    const lines = [
      { meter: "web_search", units: 2, unit_rate: 0.01, cost: 0.02 },
      { meter: "completion_tokens", units: 10, rate_per_million: 1, cost: 1 },
      { meter: "total_input_tokens", units: 20, rate_per_million: 1, cost: 2 },
    ] as unknown as ChargeLine[]
    expect(sortChargeLines(lines).map((line) => line.meter)).toEqual([
      "completion_tokens",
      "total_input_tokens",
      "web_search",
    ])
  })

  it("leaves the array it was given alone", () => {
    const lines = [
      { meter: "web_search", units: 1, unit_rate: 0.01, cost: 0.01 },
      { meter: "completion_tokens", units: 1, rate_per_million: 1, cost: 1 },
    ] as unknown as ChargeLine[]
    sortChargeLines(lines)
    expect(lines.map((line) => line.meter)).toEqual([
      "web_search",
      "completion_tokens",
    ])
  })
})

describe("formatElapsed", () => {
  it("counts elapsed wall-clock time in whole seconds, then minutes", () => {
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(59_999)).toBe("59s")
    expect(formatElapsed(60_000)).toBe("1m 00s")
    expect(formatElapsed(125_000)).toBe("2m 05s")
  })
})

describe("describeRowSource", () => {
  it("names the key a gateway request came in on", () => {
    expect(
      describeRowSource(
        entry({ source: "gateway", api_key_id: "k-1", api_key_name: "ci" }),
      ),
    ).toBe("ci")
  })

  it("names where an imported row came from, not the key its hook used", () => {
    const row = entry({
      source: "claude_code",
      api_key_id: "k-1",
      api_key_name: "laptop",
    })
    expect(isImported(row)).toBe(true)
    expect(describeRowSource(row)).toBe("Claude Code")
  })

  it("says so when a gateway request carried no key", () => {
    expect(
      describeRowSource(entry({ source: "gateway", api_key_id: null })),
    ).toBe("No key")
  })
})

describe("requestedAlias", () => {
  it("names an alias the caller sent", () => {
    expect(
      requestedAlias(
        entry({ requested_model: "fast", model: "claude-haiku-4-5" }),
      ),
    ).toBe("fast")
  })

  it("stays quiet when the name was the model or the policy", () => {
    expect(
      requestedAlias(entry({ requested_model: "gpt-4o", model: "gpt-4o" })),
    ).toBeUndefined()
    expect(
      requestedAlias(
        entry({
          requested_model: "openai:gpt-4o",
          provider: "openai",
          model: "gpt-4o",
        }),
      ),
    ).toBeUndefined()
    expect(
      requestedAlias(
        entry({ requested_model: "cheap-first", policy_name: "cheap-first" }),
      ),
    ).toBeUndefined()
    expect(requestedAlias(entry({ requested_model: null }))).toBeUndefined()
  })
})

describe("describeFailure", () => {
  it("reads the reason off the status code", () => {
    expect(describeFailure(entry({ status: "error", status_code: 429 }))).toBe(
      "Rate limited",
    )
    expect(
      describeFailure(entry({ status: "absorbed", status_code: 529 })),
    ).toBe("Overloaded")
  })

  it("names a prompt that did not fit, whatever its code", () => {
    expect(
      describeFailure(
        entry({
          status: "error",
          status_code: 400,
          error_message: "prompt is too long: 1021334 tokens > 1000000 maximum",
        }),
      ),
    ).toBe("Context too long")
  })

  it("falls back to Failed for a code it does not know, or none", () => {
    expect(describeFailure(entry({ status: "error", status_code: 418 }))).toBe(
      "Failed",
    )
    expect(describeFailure(entry({ status: "error", status_code: null }))).toBe(
      "Failed",
    )
  })
})

describe("rowOutcome", () => {
  it("reads a served request by its code, noting what a fallback recovered", () => {
    expect(rowOutcome(entry({ status_code: 200 }))).toEqual({
      kind: "success",
      label: "200",
      note: "",
    })
    expect(
      rowOutcome(entry({ status_code: null, absorbed_attempts: 2 })),
    ).toEqual({ kind: "success", label: "OK", note: "2 recovered" })
  })

  it("reads an absorbed attempt as recovered, not failed", () => {
    expect(rowOutcome(entry({ status: "absorbed", status_code: 529 }))).toEqual(
      { kind: "recovered", label: "529", note: "Overloaded" },
    )
    expect(
      rowOutcome(entry({ status: "absorbed", status_code: null })).label,
    ).toBe("Recovered")
  })

  it("reads a failure with its reason", () => {
    expect(rowOutcome(entry({ status: "error", status_code: 429 }))).toEqual({
      kind: "failed",
      label: "429",
      note: "Rate limited",
    })
    expect(
      rowOutcome(entry({ status: "error", status_code: null })).label,
    ).toBe("Failed")
  })
})

describe("rowCost", () => {
  it("charges nothing for a request that was not served", () => {
    expect(rowCost(entry({ status: "error", cost: null }))).toEqual({
      kind: "none",
    })
    expect(rowCost(entry({ status: "absorbed", cost: 0.02 }))).toEqual({
      kind: "none",
    })
  })

  it("says a served request with no price is unpriced", () => {
    expect(rowCost(entry({ cost: null }))).toEqual({ kind: "unpriced" })
  })

  it("marks an imported row's cost as one nothing billed", () => {
    expect(rowCost(entry({ cost: 0.5 }))).toEqual({
      kind: "priced",
      cost: 0.5,
      isBilled: true,
    })
    expect(rowCost(entry({ cost: 0.5, source: "claude_code" }))).toEqual({
      kind: "priced",
      cost: 0.5,
      isBilled: false,
    })
  })
})

describe("countToolCalls", () => {
  it("adds up the calls of every tool, and is zero with none", () => {
    expect(countToolCalls(entry())).toBe(0)
    expect(
      countToolCalls(
        entry({
          billing_meters: {
            tools: {
              web_search: { billed: 3, errors: 0 },
              web_fetch: { billed: 2, errors: 1 },
            },
          },
        }),
      ),
    ).toBe(5)
  })
})

describe("tokenSegments", () => {
  it("lists the buckets in bar order, leaving out the empty ones", () => {
    expect(
      tokenSegments({
        fresh: 10,
        cacheRead: 0,
        cacheWrite: 5,
        output: 2,
        total: 17,
      }).map((segment) => [segment.key, segment.value]),
    ).toEqual([
      ["fresh", 10],
      ["cacheWrite", 5],
      ["output", 2],
    ])
  })
})

describe("cacheHitFraction", () => {
  it("is the cache read over every input token", () => {
    expect(cacheHitFraction(75, 100)).toBe(0.75)
  })

  it("is zero with no input", () => {
    expect(cacheHitFraction(0, 0)).toBe(0)
  })
})
