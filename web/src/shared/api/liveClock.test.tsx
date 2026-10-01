import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useLiveClock } from "@/shared/api/liveClock"

afterEach(() => {
  vi.useRealTimers()
})

describe("useLiveClock", () => {
  it("reads the clock afresh on a remount rather than handing back an old reading", () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const first = renderHook(() => useLiveClock(true, 10_000), { wrapper })
    expect(first.result.current).toBe(1_000_000)
    first.unmount()

    // Past the stale time: a cached reading would be refetched the moment it
    // mounted, and that later reading would move every window a second time.
    vi.advanceTimersByTime(30_000)
    const second = renderHook(() => useLiveClock(true, 10_000), { wrapper })
    expect(second.result.current).toBe(1_030_000)
  })
})
