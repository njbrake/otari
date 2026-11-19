import { useLocation } from "@tanstack/react-router"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { localMidnightIso } from "@/shared/helpers/timeRange"
import { entry, mockApi, renderPage } from "@/tests/activity"
import { pickOption, selectTrigger } from "@/tests/select"
import { ObserveFilterRow } from "./ObserveFilterRow"
import type { ObserveView } from "./observeSearch"

afterEach(() => {
  vi.restoreAllMocks()
})

function UrlProbe() {
  const { searchStr } = useLocation()
  return <output aria-label="Search in the URL">{searchStr}</output>
}

const PATHS: Record<ObserveView, string> = {
  usage: "/",
  requests: "/requests",
  sessions: "/sessions",
}

async function renderBar(view: ObserveView, search = "") {
  renderPage(
    <>
      <ObserveFilterRow view={view} />
      <UrlProbe />
    </>,
    `${PATHS[view]}${search}`,
  )
  await screen.findByText("Time range")
}

// By element rather than role: an open picker hides everything outside its
// popover from the accessibility tree.
const urlParams = () =>
  new URLSearchParams(document.querySelector("output")?.textContent ?? "")

const summaryReads = (calls: ReturnType<typeof mockApi>["calls"]) =>
  calls
    .filter((call) => call.url.includes("/usage/groups"))
    .map((call) => new URL(call.url, "http://localhost"))

const reading = (calls: ReturnType<typeof mockApi>["calls"], groupBy: string) =>
  summaryReads(calls).find(
    (url) => url.searchParams.get("group_by") === groupBy,
  )

const HOUR_MS = 3_600_000
const startAge = (url: URL | undefined) =>
  Date.now() - Date.parse(url?.searchParams.get("start_date") ?? "")

describe("ObserveFilterRow reads", () => {
  it("reads no summary while no chip needs a name", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderBar("requests", "?model=gpt-4o&status=error")

    expect(
      screen.getByRole("button", { name: "Remove Model filter gpt-4o" }),
    ).toBeInTheDocument()
    expect(summaryReads(calls)).toEqual([])
  })

  it("names a user chip from the window it shows", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderBar("requests", "?range=7d&user_id=alice")

    await waitFor(() => expect(reading(calls, "user")).toBeDefined())
    expect(startAge(reading(calls, "user"))).toBeGreaterThan(167 * HOUR_MS)
    expect(startAge(reading(calls, "user"))).toBeLessThan(169 * HOUR_MS)
    expect(reading(calls, "user")?.searchParams.has("user_id")).toBe(false)
    expect(
      screen.getByRole("button", { name: "Remove User filter alice" }),
    ).toBeInTheDocument()
  })

  it("offers no pickers of its own, only the window", async () => {
    mockApi({ rows: [entry()] })
    await renderBar("requests")

    expect(screen.queryByRole("combobox")).toBeNull()
    expect(screen.queryByRole("button", { name: /Status$/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Provider$/ })).toBeNull()
  })
})

describe("ObserveFilterRow time range", () => {
  it("names each view's default window", async () => {
    mockApi({ rows: [entry()] })
    await renderBar("usage")
    await waitFor(() =>
      expect(selectTrigger("Time range")).toHaveTextContent("30d"),
    )
  })

  it("writes a preset and drops explicit bounds", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar(
      "requests",
      "?start_date=2026-01-01T00:00:00Z&end_date=2026-01-02T00:00:00Z&page=2",
    )
    expect(selectTrigger("Time range")).toHaveTextContent("Custom")

    await pickOption(user, "Time range", "7d")

    await waitFor(() => expect(urlParams().get("range")).toBe("7d"))
    expect(urlParams().has("start_date")).toBe(false)
    expect(urlParams().has("end_date")).toBe(false)
    expect(urlParams().has("page")).toBe(false)
  })

  it("offers Today on Usage as the local day so far", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar("usage", "?range=7d")

    await pickOption(user, "Time range", "Today")

    await waitFor(() =>
      expect(urlParams().get("start_date")).toBe(localMidnightIso()),
    )
    expect(urlParams().has("range")).toBe(false)
    expect(selectTrigger("Time range")).toHaveTextContent("Today")
  })
})

describe("ObserveFilterRow chips", () => {
  it("shows a chip for every applied filter, each clearing only itself", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar(
      "requests",
      "?user_id=alice&user_id=bob&model=gpt-4o&api_key_id=key-1&status=error&page=2",
    )

    for (const name of [
      "Remove User filter alice",
      "Remove User filter bob",
      "Remove Model filter gpt-4o",
      "Remove API key filter key-1",
      "Remove Status filter",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument()
    }

    await user.click(
      screen.getByRole("button", { name: "Remove User filter alice" }),
    )

    await waitFor(() => expect(urlParams().getAll("user_id")).toEqual(["bob"]))
    expect(urlParams().getAll("model")).toEqual(["gpt-4o"])
    expect(urlParams().get("status")).toBe("error")
    expect(urlParams().has("page")).toBe(false)
  })

  it("clears every shared filter at once and leaves the window alone", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar(
      "requests",
      "?range=7d&user_id=alice&model=gpt-4o&api_key_id=key-1&status=error",
    )

    await user.click(screen.getByRole("button", { name: "Clear all" }))

    await waitFor(() => expect(urlParams().has("model")).toBe(false))
    expect(urlParams().has("user_id")).toBe(false)
    expect(urlParams().has("api_key_id")).toBe(false)
    expect(urlParams().has("status")).toBe(false)
    expect(urlParams().get("range")).toBe("7d")
  })

  it("offers no Clear all while nothing is applied", async () => {
    mockApi({ rows: [entry()] })
    await renderBar("requests")

    expect(
      screen.queryByRole("button", { name: "Clear all" }),
    ).not.toBeInTheDocument()
  })
})

describe("ObserveFilterRow provider", () => {
  it("names a linked provider and clears it from its chip", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry({ provider: "openai" })] })
    await renderBar("requests", "?provider=gemini&model=gpt-4o")

    expect(screen.getByText("Google Gemini")).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: "Remove Provider filter" }),
    )

    await waitFor(() => expect(urlParams().has("provider")).toBe(false))
    expect(urlParams().getAll("model")).toEqual(["gpt-4o"])
  })

  it("is cleared with the rest", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar("requests", "?provider=openai&status=error")

    await user.click(screen.getByRole("button", { name: "Clear all" }))

    await waitFor(() => expect(urlParams().has("provider")).toBe(false))
    expect(urlParams().has("status")).toBe(false)
  })

  it("says where it cannot apply", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar("sessions", "?provider=openai")

    expect(
      screen.getByText("OpenAI (not applied to sessions)"),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear all" }))
    await waitFor(() => expect(urlParams().has("provider")).toBe(false))
  })
})

describe("ObserveFilterRow status by view", () => {
  it("applies every status to Requests", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderBar("requests", "?status=absorbed&user_id=alice")

    expect(
      screen.getByRole("button", { name: "Remove Status filter" }),
    ).toBeInTheDocument()
    await waitFor(() => expect(reading(calls, "user")).toBeDefined())
    expect(reading(calls, "user")?.searchParams.get("status")).toBe("absorbed")
  })

  it("applies an outcome to Sessions", async () => {
    const { calls } = mockApi({ rows: [entry()] })
    await renderBar("sessions", "?status=error&user_id=alice")

    await waitFor(() => expect(reading(calls, "user")).toBeDefined())
    expect(reading(calls, "user")?.searchParams.get("status")).toBe("error")
    expect(screen.queryByText(/not applied/)).not.toBeInTheDocument()
  })

  it("reads a status with no session meaning as not applied, and still removable", async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({ rows: [entry()] })
    await renderBar("sessions", "?status=absorbed&user_id=alice")

    expect(
      await screen.findByText(/absorbed \(not applied to sessions\)/),
    ).toBeInTheDocument()
    await waitFor(() => expect(reading(calls, "user")).toBeDefined())
    expect(reading(calls, "user")?.searchParams.has("status")).toBe(false)

    await user.click(
      screen.getByRole("button", { name: "Remove Status filter" }),
    )
    await waitFor(() => expect(urlParams().has("status")).toBe(false))
  })

  it("offers Usage no status control, and reads one it was handed as not applied", async () => {
    mockApi({ rows: [entry()] })
    await renderBar("usage", "?status=error")

    expect(
      await screen.findByText(/error \(not applied to usage\)/),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Status$/ }),
    ).not.toBeInTheDocument()
  })
})

describe("ObserveFilterRow refinements", () => {
  it("names each exclusion, policy and threshold the headers set, each clearing only itself", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar(
      "requests",
      "?exclude_model=o1&exclude_status=absorbed&policy_name=fast&routed=false&tokens_gt=10000&cost_gt=0.1&latency_ms_gt=5000",
    )

    for (const name of [
      "Remove Model filter not o1",
      "Remove Status filter not Absorbed",
      "Remove Routing filter fast",
      "Remove Routing filter",
      "Remove Tokens filter",
      "Remove Cost filter",
      "Remove Total time filter",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument()
    }
    expect(screen.getByText("> $0.10")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Remove Cost filter" }))
    await waitFor(() => expect(urlParams().has("cost_gt")).toBe(false))
    expect(urlParams().getAll("exclude_model")).toEqual(["o1"])

    await user.click(screen.getByRole("button", { name: "Clear all" }))
    await waitFor(() => expect(urlParams().has("exclude_model")).toBe(false))
    for (const key of [
      "exclude_status",
      "policy_name",
      "routed",
      "tokens_gt",
      "latency_ms_gt",
    ]) {
      expect(urlParams().has(key)).toBe(false)
    }
  })

  it("marks a refinement only the request log reads as not applied elsewhere", async () => {
    mockApi({ rows: [entry()] })
    await renderBar("sessions", "?exclude_model=o1&cost_gt=0.1")

    expect(
      screen.getByText("not o1 (not applied to sessions)"),
    ).toBeInTheDocument()
    expect(
      screen.getByText("> $0.10 (not applied to sessions)"),
    ).toBeInTheDocument()
  })
})

describe("ObserveFilterRow link and column chips", () => {
  it("names the request log's own filters and clears them with the rest", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar(
      "requests",
      "?priced=false&tool=web_fetch&source=claude_code&exclude_source=codex&source_label=sess-1&status_code=403&endpoint=/v1/messages",
    )

    for (const [label, value] of [
      ["Priced", "Unpriced"],
      ["Tool", "Web fetch"],
      ["Source", "Claude Code"],
      ["Source", "not Codex"],
      ["Session", "sess-1"],
      ["Status code", "403"],
      ["Endpoint", "/v1/messages"],
    ]) {
      expect(screen.getByText(value), label).toBeInTheDocument()
    }

    await user.click(screen.getByRole("button", { name: "Clear all" }))
    await waitFor(() => expect(urlParams().has("priced")).toBe(false))
    for (const key of [
      "tool",
      "source",
      "exclude_source",
      "source_label",
      "status_code",
      "endpoint",
    ]) {
      expect(urlParams().has(key)).toBe(false)
    }
  })

  it("marks them as not applied on Sessions, each still removable", async () => {
    const user = userEvent.setup()
    mockApi({ rows: [entry()] })
    await renderBar("sessions", "?source_label=sess-1&priced=true")

    expect(
      screen.getByText("sess-1 (not applied to sessions)"),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: "Remove Priced filter" }),
    )
    await waitFor(() => expect(urlParams().has("priced")).toBe(false))
    expect(urlParams().get("source_label")).toBe("sess-1")
  })
})
