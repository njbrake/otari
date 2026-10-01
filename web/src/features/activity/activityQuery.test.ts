import { describe, expect, it } from "vitest"

import { entry } from "@/tests/activity"
import {
  ACTIVITY_URL_DEFAULTS,
  type ActivityUrl,
  type ActivityUrlKey,
  activityChips,
  BUILT_IN_VIEWS,
  cellFilterPatch,
  isColumnFiltered,
  isSubstringSearch,
  nextSort,
  panelFilterPatch,
  readGroup,
  readSort,
  statusParams,
  togglePatch,
  toSelection,
  toUsageFilters,
  valuePatch,
  viewPatch,
  viewQuery,
} from "./activityQuery"

/** `useUrlState` over a query string, with the page's defaults. */
function urlOf(query: string): ActivityUrl {
  const params = new URLSearchParams(query)
  const all = (key: ActivityUrlKey) => {
    if (!params.has(key)) {
      return ACTIVITY_URL_DEFAULTS[key] ? [ACTIVITY_URL_DEFAULTS[key]] : []
    }
    return params.getAll(key).filter((value) => value.trim() !== "")
  }
  return {
    get: (key) => params.get(key) ?? ACTIVITY_URL_DEFAULTS[key],
    getAll: all,
    getNumber: (key) =>
      Number.parseInt(params.get(key) ?? ACTIVITY_URL_DEFAULTS[key], 10) || 0,
    patch: () => undefined,
  }
}

const WINDOW = { start: "2026-01-15T00:00:00.000Z" }

describe("statusParams", () => {
  it("sends one status as itself", () => {
    expect(statusParams(["error"], [])).toEqual({ status: "error" })
  })

  it("sends two statuses as the one left out", () => {
    // The API takes one status or a list to exclude, never a list to include.
    // Keeping "Recovered" also asks for the absorbed rows the list otherwise
    // leaves out, or the pick would read as "Failed" alone.
    expect(statusParams(["error", "absorbed"], [])).toEqual({
      exclude_status: ["success"],
      include_absorbed: true,
    })
    expect(statusParams(["success", "error"], [])).toEqual({
      exclude_status: ["absorbed"],
    })
  })

  it("asks for absorbed rows whenever Recovered is among the picks", () => {
    expect(statusParams(["absorbed"], [])).toEqual({
      status: "absorbed",
      include_absorbed: true,
    })
    expect(statusParams([], ["error"])).toEqual({
      exclude_status: ["error"],
      include_absorbed: true,
    })
  })

  it("combines an exclusion with the picks", () => {
    expect(statusParams([], ["success"])).toEqual({
      exclude_status: ["success"],
      include_absorbed: true,
    })
    expect(statusParams(["success", "error"], ["error"])).toEqual({
      status: "success",
    })
  })

  it("sends nothing when every status is allowed", () => {
    expect(statusParams([], [])).toEqual({})
    expect(statusParams(["success", "error", "absorbed"], [])).toEqual({})
  })
})

describe("isSubstringSearch", () => {
  it("reads a UUID in any of the server's spellings as an id lookup", () => {
    for (const q of [
      "0b6e3c1a-55f1-4a3e-9f6e-0c2d9a1b7e44",
      " 0B6E3C1A55F14A3E9F6E0C2D9A1B7E44 ",
      "{0b6e3c1a-55f1-4a3e-9f6e-0c2d9a1b7e44}",
      "urn:uuid:0b6e3c1a-55f1-4a3e-9f6e-0c2d9a1b7e44",
    ]) {
      expect(isSubstringSearch(q)).toBe(false)
    }
  })

  it("reads anything else non-empty as a substring search", () => {
    expect(isSubstringSearch("opus")).toBe(true)
    expect(isSubstringSearch("0b6e3c1a-55f1")).toBe(true)
    expect(isSubstringSearch("")).toBe(false)
    expect(isSubstringSearch("   ")).toBe(false)
    expect(isSubstringSearch(undefined)).toBe(false)
  })
})

describe("toUsageFilters", () => {
  it("reads the URL's filters into the API's parameters", () => {
    const filters = toUsageFilters(
      urlOf(
        "model=a&model=b&exclude_user_id=u1&cost_gt=0.4&tokens_gt=10000.7&latency_ms_gt=2000&priced=false&routed=false&q=+fast+",
      ),
      WINDOW,
      { workspaceId: "ws-1" },
    )
    expect(filters).toMatchObject({
      workspace_id: "ws-1",
      start_date: WINDOW.start,
      model: ["a", "b"],
      exclude_user_id: ["u1"],
      cost_gt: 0.4,
      tokens_gt: 10000,
      latency_ms_gt: 2000,
      priced: false,
      routed: false,
      q: "fast",
    })
  })

  it("lists each routed request once unless recovered attempts are asked for", () => {
    expect(toUsageFilters(urlOf(""), WINDOW, {}).include_absorbed).toBe(false)
    expect(
      toUsageFilters(urlOf("recovered=show"), WINDOW, {}).include_absorbed,
    ).toBe(true)
  })

  it("lists recovered attempts when Recovered is picked alongside another status", () => {
    const filters = toUsageFilters(
      urlOf("status=error&status=absorbed"),
      WINDOW,
      {},
    )
    expect(filters.exclude_status).toEqual(["success"])
    expect(filters.include_absorbed).toBe(true)
  })

  it("narrows to the caller's own requests in place of any member filter", () => {
    const filters = toUsageFilters(
      urlOf("user_id=bob&exclude_user_id=carol"),
      WINDOW,
      { ownUserId: "me" },
    )
    expect(filters.user_id).toEqual(["me"])
    expect(filters.exclude_user_id).toBeUndefined()
  })

  it("ignores a threshold that is not a number", () => {
    expect(toUsageFilters(urlOf("cost_gt=abc"), WINDOW, {}).cost_gt).toBe(
      undefined,
    )
  })
})

describe("readSort and nextSort", () => {
  it("defaults to newest first, and ignores a column the API does not sort by", () => {
    expect(readSort(urlOf(""))).toEqual({ key: "timestamp", order: "desc" })
    expect(readSort(urlOf("sort=bogus&order=asc"))).toEqual({
      key: "timestamp",
      order: "asc",
    })
  })

  it("steps a number column through highest, lowest, then newest first", () => {
    const first = nextSort("cost", { key: "timestamp", order: "desc" })
    expect(first).toEqual({ key: "cost", order: "desc" })
    const second = nextSort("cost", first)
    expect(second).toEqual({ key: "cost", order: "asc" })
    expect(nextSort("cost", second)).toEqual({
      key: "timestamp",
      order: "desc",
    })
  })

  it("starts a text column A to Z", () => {
    expect(nextSort("model", { key: "timestamp", order: "desc" })).toEqual({
      key: "model",
      order: "asc",
    })
  })

  it("flips time between newest and oldest first", () => {
    expect(nextSort("time", { key: "timestamp", order: "desc" })).toEqual({
      key: "timestamp",
      order: "asc",
    })
    expect(nextSort("time", { key: "timestamp", order: "asc" })).toEqual({
      key: "timestamp",
      order: "desc",
    })
  })
})

describe("readGroup", () => {
  it("offers member grouping only where members are shown", () => {
    expect(readGroup(urlOf("group=member"), true)).toBe("member")
    expect(readGroup(urlOf("group=member"), false)).toBeUndefined()
    expect(readGroup(urlOf("group=nonsense"), true)).toBeUndefined()
  })
})

describe("value filters", () => {
  it("replaces the column's other mode when a value is picked", () => {
    expect(
      valuePatch(urlOf("exclude_model=b"), "model", "a", "include"),
    ).toEqual({ model: ["a"], exclude_model: [] })
    expect(valuePatch(urlOf("model=a"), "model", "b", "include")).toEqual({
      model: ["a", "b"],
      exclude_model: [],
    })
  })

  it("toggles a value in and out of the column's picks", () => {
    expect(togglePatch(urlOf("model=a"), "model", "a")).toEqual({ model: [] })
    expect(togglePatch(urlOf("model=a"), "model", "b")).toEqual({
      model: ["a", "b"],
    })
  })

  it("marks a column filtered by any of its keys", () => {
    expect(isColumnFiltered(urlOf("priced=false"), "cost")).toBe(true)
    expect(isColumnFiltered(urlOf("requested_model=fast"), "model")).toBe(true)
    expect(isColumnFiltered(urlOf(""), "cost")).toBe(false)
  })
})

describe("cellFilterPatch", () => {
  it("filters an imported row's source by where it came from, not its key", () => {
    const imported = entry({ source: "claude_code", api_key_id: "key-1" })
    expect(cellFilterPatch(urlOf(""), "source", imported, "include")).toEqual({
      source: "claude_code",
      exclude_source: [],
    })
    expect(cellFilterPatch(urlOf(""), "source", imported, "exclude")).toEqual({
      source: "",
      exclude_source: ["claude_code"],
    })
  })

  it("filters a gateway row's source by its key", () => {
    expect(
      cellFilterPatch(
        urlOf(""),
        "source",
        entry({ api_key_id: "k" }),
        "include",
      ),
    ).toEqual({ api_key_id: ["k"], exclude_api_key_id: [] })
  })

  it("reads Direct as the request not being routed", () => {
    const direct = entry({ policy_name: null })
    expect(cellFilterPatch(urlOf(""), "policy", direct, "include")).toEqual({
      routed: "false",
    })
    expect(cellFilterPatch(urlOf(""), "policy", direct, "exclude")).toEqual({
      routed: "true",
    })
  })

  it("offers nothing for a member it cannot name", () => {
    expect(
      cellFilterPatch(urlOf(""), "member", entry({ user_id: null }), "include"),
    ).toBeUndefined()
  })
})

describe("panelFilterPatch", () => {
  it("narrows to one tool by name, and to any tool for several", () => {
    const oneTool = entry({
      billing_meters: { tools: { web_search: { billed: 2 } } },
    })
    expect(panelFilterPatch(urlOf(""), "tool", oneTool)).toEqual({
      tool: "web_search",
    })
    const twoTools = entry({
      billing_meters: {
        tools: { web_search: { billed: 1 }, web_fetch: { billed: 1 } },
      },
    })
    expect(panelFilterPatch(urlOf(""), "tool", twoTools)).toEqual({
      tool: "any",
    })
  })

  it("narrows to the session", () => {
    expect(
      panelFilterPatch(urlOf(""), "session", entry({ source_label: "s-1" })),
    ).toEqual({ source_label: "s-1" })
  })
})

describe("activityChips", () => {
  const names = {
    member: (id: string) => `Name of ${id}`,
    apiKey: (id: string) => `Key ${id}`,
  }

  it("names each filter, with who and which key in words", () => {
    const chips = activityChips(
      urlOf(
        "status=error&user_id=u1&exclude_model=gpt&api_key_id=k1&cost_gt=0.4&priced=false&tool=web_search",
      ),
      names,
    )
    expect(chips.map((chip) => [chip.label, chip.value])).toEqual([
      ["Status", "Failed"],
      ["Member", "Name of u1"],
      ["Model is not", "gpt"],
      ["Source", "Key k1"],
      ["Tool", "web search"],
      ["Cost", "unpriced"],
      ["Cost", "> $0.40"],
    ])
  })

  it("clears only its own filter", () => {
    const [chip] = activityChips(urlOf("model=a&model=b"), names)
    expect(chip.value).toBe("a, b")
    expect(chip.clear).toEqual({ model: [] })
  })
})

describe("saved views", () => {
  it("writes a view as a canonical query, leaving out defaults and position", () => {
    expect(
      viewQuery(
        urlOf(
          "page=3&request=r1&group=session&start_date=x&source=claude_code",
        ),
      ),
    ).toBe("source=claude_code&group=session")
  })

  it("matches the built-in view for the page's defaults", () => {
    expect(viewQuery(urlOf(""))).toBe(BUILT_IN_VIEWS[0].query)
  })

  it("resets every key a view does not name when it is applied", () => {
    const patch = viewPatch("range=7d&status=error")
    expect(patch).toMatchObject({
      range: "7d",
      status: "error",
      model: "",
      group: "",
      start_date: "",
      page: "0",
    })
  })

  it("keeps each built-in view canonical, so it can be recognized", () => {
    for (const view of BUILT_IN_VIEWS) {
      expect(viewQuery(urlOf(view.query))).toBe(view.query)
    }
  })
})

describe("toSelection", () => {
  it("carries every filter the rows were counted under, and nothing list-only", () => {
    const selection = toSelection({
      workspace_id: "ws-1",
      exclude_model: ["a"],
      cost_gt: 0.1,
      include_absorbed: false,
    })
    expect(selection).toEqual({
      by_filter: true,
      workspace_id: "ws-1",
      exclude_model: ["a"],
      cost_gt: 0.1,
    })
  })
})
