import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ImportedUsageCard,
  importedRows,
  windowBounds,
  windowStart,
} from "@/features/settings/ImportedUsageCard"
import { API_ROOT } from "@/shared/api/client"
import { organizationContext } from "@/tests/fixtures"

afterEach(() => {
  vi.restoreAllMocks()
})

interface Call {
  url: string
  method: string
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** An operator's gateway with `total` imported rows to count, and every write recorded. */
function mockApi({ total = 42 }: { total?: number } = {}) {
  const calls: Call[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (url.endsWith(`${API_ROOT}/organizations/me`)) {
      return jsonResponse(organizationContext())
    }
    if (url.includes(`${API_ROOT}/usage/count`)) {
      return jsonResponse({ total })
    }
    if (url.includes(`${API_ROOT}/usage/groups`)) {
      return jsonResponse({
        group_by: "source",
        start_date: "2026-10-21T00:00:00Z",
        end_date: "2026-11-20T00:00:00Z",
        total: 3,
        groups: [
          { key: "claude_code", requests: 40, cost: 1, errors: 0 },
          { key: "gateway", requests: 9, cost: 1, errors: 0 },
          { key: "codex", requests: 2, cost: 0, errors: 0 },
        ],
      })
    }
    if (url.includes(`${API_ROOT}/usage/set-price`)) {
      return jsonResponse({ matched: total, updated: total - 2, unchanged: 2 })
    }
    if (url.endsWith(`${API_ROOT}/usage`) && method === "DELETE") {
      return jsonResponse({ deleted: total })
    }
    return jsonResponse({})
  })
  return calls
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ImportedUsageCard />
    </QueryClientProvider>,
  )
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET")

describe("windowStart", () => {
  it("starts a window that many hours back, to the minute, and all time nowhere", () => {
    const now = Date.parse("2026-11-20T12:34:56.789Z")
    expect(windowStart("24", now)).toBe("2026-11-19T12:34:00.000Z")
    expect(windowStart("all", now)).toBeUndefined()
  })
})

describe("windowBounds", () => {
  it("ends a window when it is picked, so a later import is outside it", () => {
    const now = Date.parse("2026-11-20T12:34:56.789Z")
    expect(windowBounds("24", now)).toEqual({
      start_date: "2026-11-19T12:34:00.000Z",
      end_date: "2026-11-20T12:34:56.789Z",
    })
    expect(windowBounds("all", now)).toEqual({
      end_date: "2026-11-20T12:34:56.789Z",
    })
  })
})

describe("importedRows", () => {
  it("counts rows in words", () => {
    expect(importedRows(1)).toBe("1 imported row")
    expect(importedRows(1204)).toBe("1,204 imported rows")
  })
})

describe("ImportedUsageCard", () => {
  it("counts the imported rows the window matches before anything runs", async () => {
    const calls = mockApi()
    renderCard()

    expect(
      await screen.findByText("42 imported rows match."),
    ).toBeInTheDocument()
    const count = calls.find((call) => call.url.includes("/usage/count"))
    const params = new URL(count!.url, "http://x").searchParams
    expect(params.get("counts_toward_budget")).toBe("false")
    expect(params.get("start_date")).toBeTruthy()
    expect(params.get("end_date")).toBeTruthy()
    expect(writes(calls)).toEqual([])
  })

  it("deletes only after the confirmation is typed, scoped to what was counted", async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    renderCard()

    await screen.findByText("42 imported rows match.")
    await user.click(
      screen.getByRole("button", { name: /Manage imported usage/ }),
    )
    await user.click(
      await screen.findByRole("menuitem", { name: /Delete imported rows/ }),
    )
    const dialog = await screen.findByRole("alertdialog")
    const confirm = within(dialog).getByRole("button", {
      name: "Delete 42 imported rows",
    })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole("textbox"), "delete")
    expect(confirm).toBeEnabled()
    await user.click(confirm)

    expect(
      await screen.findByText("Deleted 42 imported rows."),
    ).toBeInTheDocument()
    const [deleted] = writes(calls)
    expect(deleted.method).toBe("DELETE")
    expect(deleted.url).toMatch(new RegExp(`${API_ROOT}/usage$`))
    const count = calls.find((call) => call.url.includes("/usage/count"))
    const params = new URL(count!.url, "http://x").searchParams
    expect(deleted.body).toEqual({
      by_filter: true,
      start_date: params.get("start_date"),
      end_date: params.get("end_date"),
    })
  })

  it("recosts the matching rows at the rates entered", async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    renderCard()

    await screen.findByText("42 imported rows match.")
    await user.click(
      screen.getByRole("button", { name: /Manage imported usage/ }),
    )
    await user.click(
      await screen.findByRole("menuitem", { name: /Recost imported rows/ }),
    )
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Input $ / 1M"), "3")
    await user.type(within(dialog).getByLabelText("Output $ / 1M"), "15")
    await user.click(
      within(dialog).getByRole("button", { name: "Recost 42 imported rows" }),
    )

    expect(
      await screen.findByText(
        "Recosted 42 imported rows: 40 changed, 2 already at that cost.",
      ),
    ).toBeInTheDocument()
    const [recost] = writes(calls)
    expect(recost.url).toContain(`${API_ROOT}/usage/set-price`)
    expect(recost.body).toMatchObject({
      by_filter: true,
      input_price_per_million: 3,
      output_price_per_million: 15,
    })
  })

  it("narrows to one import source and to rows with no cost", async () => {
    const calls = mockApi()
    const user = userEvent.setup()
    renderCard()

    await screen.findByText("42 imported rows match.")
    await user.click(screen.getByRole("button", { name: /Source/ }))
    // A gateway row is never an import source, even a budget-exempt one.
    expect(screen.queryByRole("option", { name: "gateway" })).toBeNull()
    await user.click(await screen.findByRole("option", { name: "Claude Code" }))
    await user.click(screen.getByRole("checkbox", { name: /no cost/ }))

    await waitFor(() => {
      const last = calls
        .filter((call) => call.url.includes("/usage/count"))
        .at(-1)
      const params = new URL(last!.url, "http://x").searchParams
      expect(params.get("source")).toBe("claude_code")
      expect(params.get("priced")).toBe("false")
    })
  })

  it("offers nothing to manage when no imported row matches", async () => {
    mockApi({ total: 0 })
    renderCard()

    expect(
      await screen.findByText("0 imported rows match."),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Manage imported usage/ }),
    ).toBeDisabled()
  })
})
