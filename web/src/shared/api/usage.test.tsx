import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { NO_BREAKDOWNS, useUsageSummary } from "@/shared/api/usage"

afterEach(() => {
  vi.restoreAllMocks()
})

function wrapper(retry: boolean | number = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry, retryDelay: 0 } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function summaryReads(fetch: { mock: { calls: unknown[][] } }) {
  return fetch.mock.calls.filter(([input]) =>
    String(input).includes("/summary"),
  )
}

const FILTERS = { start_date: "2026-10-01T00:00:00Z" }

describe("a usage aggregate", () => {
  it("is abandoned, so the gateway can cancel it, once nothing wants it", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/organizations/me")
          ? json({ deployment_operator: false })
          : new Promise<Response>(() => {}),
      )
    const { unmount } = renderHook(
      () => useUsageSummary(FILTERS, "day", NO_BREAKDOWNS),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(summaryReads(fetch)).toHaveLength(1))
    const signal = (summaryReads(fetch)[0][1] as RequestInit).signal
    expect(signal?.aborted).toBe(false)

    unmount()

    await waitFor(() => expect(signal?.aborted).toBe(true))
  })

  it("is not asked again when it fails, whatever the client's default", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/organizations/me")
          ? json({ deployment_operator: false })
          : json({ detail: "Usage reads are busy; try again shortly" }, 503),
      )
    const { result } = renderHook(
      () => useUsageSummary(FILTERS, "day", NO_BREAKDOWNS),
      { wrapper: wrapper(3) },
    )

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(summaryReads(fetch)).toHaveLength(1)
  })
})
