import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  isSameSort,
  NEWEST_FIRST,
  useUsageLogs,
  useUsagePreviews,
  useUsageTools,
  withoutListOnly,
} from "@/shared/api/usage"

// The organization context answers first (it picks the surface), and every
// other read is a page of rows.
function respond() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const body = String(input).endsWith("/organizations/me")
      ? { deployment_operator: false }
      : []
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })
}

function wrapper(retry: boolean | number = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry, retryDelay: 0 } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

function listReads(fetch: ReturnType<typeof respond>): URL[] {
  return fetch.mock.calls
    .map(([input]) => new URL(String(input), "http://x"))
    .filter((url) => url.pathname.endsWith("/usage"))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the log's pages", () => {
  it("asks for a page by skip and limit, and sends no order for newest first", async () => {
    const fetch = respond()
    const { result } = renderHook(
      () => useUsageLogs({ model: ["gpt-4o"] }, 2, 25),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const [read] = listReads(fetch)
    expect(read.searchParams.get("skip")).toBe("50")
    expect(read.searchParams.get("limit")).toBe("25")
    expect(read.searchParams.has("sort")).toBe(false)
  })

  it("sends any other order", async () => {
    const fetch = respond()
    const { result } = renderHook(
      () => useUsageLogs({}, 0, 25, { sort: { key: "cost", order: "desc" } }),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const [read] = listReads(fetch)
    expect(read.searchParams.get("sort")).toBe("cost")
    expect(read.searchParams.get("order")).toBe("desc")
  })

  it("reads a group's preview and the same filter's first page once between them", async () => {
    const fetch = respond()
    const Wrapper = wrapper()
    const filters = { api_key_id: ["key-1"] }
    const preview = renderHook(() => useUsagePreviews([filters], 8), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(preview.result.current[0].isSuccess).toBe(true))
    const page = renderHook(() => useUsageLogs(filters, 0, 8), {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(page.result.current.isSuccess).toBe(true))
    expect(listReads(fetch)).toHaveLength(1)
  })
})

describe("isSameSort", () => {
  it("compares the key and the order", () => {
    expect(isSameSort(NEWEST_FIRST, { key: "timestamp", order: "desc" })).toBe(
      true,
    )
    expect(isSameSort(NEWEST_FIRST, { key: "timestamp", order: "asc" })).toBe(
      false,
    )
  })
})

describe("withoutListOnly", () => {
  it("drops the one filter only the list and its count read", () => {
    expect(withoutListOnly({ model: ["a"], include_absorbed: true })).toEqual({
      model: ["a"],
    })
  })
})

describe("a usage aggregate", () => {
  function toolsReads(fetch: { mock: { calls: unknown[][] } }) {
    return fetch.mock.calls.filter(([input]) =>
      String(input).includes("/usage/tools"),
    )
  }

  it("is abandoned, so the gateway can cancel it, once nothing wants it", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input).endsWith("/organizations/me")) {
          return new Response(JSON.stringify({ deployment_operator: false }), {
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Promise<Response>(() => {})
      })
    const { unmount } = renderHook(() => useUsageTools({}), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(toolsReads(fetch)).toHaveLength(1))
    const signal = (toolsReads(fetch)[0][1] as RequestInit).signal
    expect(signal?.aborted).toBe(false)

    unmount()

    await waitFor(() => expect(signal?.aborted).toBe(true))
  })

  it("is not asked again when it fails, whatever the client's default", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).endsWith("/organizations/me")
          ? new Response(JSON.stringify({ deployment_operator: false }), {
              headers: { "Content-Type": "application/json" },
            })
          : new Response(
              JSON.stringify({
                detail: "Usage reads are busy; try again shortly",
              }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            ),
      )
    const { result } = renderHook(() => useUsageTools({}), {
      wrapper: wrapper(3),
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(toolsReads(fetch)).toHaveLength(1)
  })
})
