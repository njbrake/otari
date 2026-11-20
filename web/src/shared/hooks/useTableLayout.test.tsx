import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import * as apiClient from "@/shared/api/client"
import { ApiError } from "@/shared/api/client"
import type { TableLayoutColumn } from "@/shared/helpers/tableLayout"
import { TABLE_LAYOUT_SAVE_DELAY_MS, useTableLayout } from "./useTableLayout"

const COLUMNS: TableLayoutColumn[] = [
  { id: "time", label: "Time", isHideable: true, width: 84, minWidth: 64 },
  { id: "model", label: "Model", isHideable: false, minWidth: 120 },
  { id: "cost", label: "Cost", isHideable: true, width: 100, minWidth: 72 },
]

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface Call {
  path: string
  method: string
  body?: unknown
}

function mockPreferences(stored: unknown, { failRead = false } = {}) {
  const calls: Call[] = []
  vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path, init) => {
    const method = init?.method ?? "GET"
    calls.push({
      path,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    if (method === "GET" && failRead) {
      throw new ApiError(500, "The gateway could not be reached")
    }
    if (method === "DELETE") return undefined
    return { key: "table:requests", value: stored, updated_at: null }
  })
  return calls
}

function renderLayout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(() => useTableLayout("table:requests", COLUMNS), {
    wrapper,
  })
}

// The query cache tells its readers on a zero-delay timer, which the fake
// clock holds until it is moved.
async function change(apply: () => void) {
  act(apply)
  await act(() => vi.advanceTimersByTimeAsync(0))
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET")

describe("useTableLayout", () => {
  it("applies the stored layout once it is read", async () => {
    mockPreferences({ version: 1, widths: { cost: 150 }, hidden: ["time"] })
    const { result } = renderLayout()
    expect(result.current.widths).toEqual({})
    await waitFor(() => expect(result.current.hidden).toEqual(["time"]))
    expect(result.current.widths).toEqual({ cost: 150 })
    expect(result.current.isCustomized).toBe(true)
  })

  it("keeps the defaults when the read fails or holds nothing it can use", async () => {
    const calls = mockPreferences(null, { failRead: true })
    const { result } = renderLayout()
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(result.current.widths).toEqual({})
    expect(result.current.hidden).toEqual([])
    expect(result.current.isCustomized).toBe(false)
  })

  it("applies a change at once and saves it once, after the last change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = mockPreferences(null)
    const { result } = renderLayout()
    await waitFor(() => expect(calls).toHaveLength(1))

    await change(() => result.current.setHidden("cost", true))
    await change(() => result.current.resize({ time: 120, model: 300 }))
    await change(() => result.current.resize({ time: 130 }))
    expect(result.current.hidden).toEqual(["cost"])
    expect(result.current.widths).toEqual({ time: 130, model: 300 })
    expect(writes(calls)).toEqual([])

    await act(() => vi.advanceTimersByTimeAsync(TABLE_LAYOUT_SAVE_DELAY_MS))
    expect(writes(calls)).toEqual([
      {
        path: "/me/preferences/table%3Arequests",
        method: "PUT",
        body: {
          value: {
            version: 1,
            widths: { time: 130, model: 300 },
            hidden: ["cost"],
          },
        },
      },
    ])
  })

  it("never hides a column that may not be hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = mockPreferences(null)
    const { result } = renderLayout()
    await waitFor(() => expect(calls).toHaveLength(1))
    await change(() => result.current.setHidden("model", true))
    expect(result.current.hidden).toEqual([])
  })

  it("saves a waiting change when the table goes away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = mockPreferences(null)
    const { result, unmount } = renderLayout()
    await waitFor(() => expect(calls).toHaveLength(1))
    await change(() => result.current.setHidden("time", true))
    unmount()
    expect(writes(calls).map((call) => call.method)).toEqual(["PUT"])
  })

  it("resets to the defaults and forgets the stored layout, dropping a save still waiting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = mockPreferences({
      version: 1,
      widths: { cost: 150 },
      hidden: ["time"],
    })
    const { result } = renderLayout()
    await waitFor(() => expect(result.current.isCustomized).toBe(true))

    await change(() => result.current.setHidden("cost", true))
    await change(() => result.current.reset())
    expect(result.current.widths).toEqual({})
    expect(result.current.hidden).toEqual([])
    expect(result.current.isCustomized).toBe(false)

    await act(() => vi.advanceTimersByTimeAsync(TABLE_LAYOUT_SAVE_DELAY_MS))
    expect(writes(calls).map((call) => call.method)).toEqual(["DELETE"])
  })
})
