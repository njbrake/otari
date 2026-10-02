import { useRouter } from "@tanstack/react-router"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { flushRouter, withRouter } from "@/tests/router"

import { useUrlState } from "./urlState"

const DEFAULTS = { page: "0", size: "50", status: "" } as const

// The router resolves its first location asynchronously, so the hook has not run
// by the time renderHook returns; flushing that is what gives `result.current` a
// value to read.
async function stateFor<K extends string>(
  defaults: Record<K, string>,
  url: string,
) {
  const { result } = renderHook(() => useUrlState(defaults), {
    wrapper: withRouter({ url }),
  })
  await flushRouter()
  return result
}

describe("useUrlState.getNumber", () => {
  it("reads a numeric param", async () => {
    const result = await stateFor(DEFAULTS, "/?size=250")
    expect(result.current.getNumber("size")).toBe(250)
  })

  it("falls back to the key's default when the param is absent", async () => {
    const result = await stateFor(DEFAULTS, "/")
    expect(result.current.getNumber("size")).toBe(50)
    expect(result.current.getNumber("page")).toBe(0)
  })

  it("falls back to the default (not 0) when the param is present but non-numeric", async () => {
    // A hand-edited `?size=abc` must not become pageSize=0 (which would send limit=0 → 422).
    const result = await stateFor(DEFAULTS, "/?size=abc")
    expect(result.current.getNumber("size")).toBe(50)
  })
})

describe("useUrlState.get", () => {
  it("returns the param value or the default", async () => {
    const result = await stateFor(DEFAULTS, "/?status=error")
    expect(result.current.get("status")).toBe("error")
    expect(result.current.get("size")).toBe("50")
  })
})

const MULTI_DEFAULTS = { model: "", user_id: "" } as const

describe("useUrlState.getAll", () => {
  it("reads every value of a repeated param, in order", async () => {
    const result = await stateFor(
      MULTI_DEFAULTS,
      "/?model=gpt-4o&model=claude-sonnet-5",
    )
    expect(result.current.getAll("model")).toEqual([
      "gpt-4o",
      "claude-sonnet-5",
    ])
  })

  it("reads a single value as a one-element set", async () => {
    const result = await stateFor(MULTI_DEFAULTS, "/?model=gpt-4o")
    expect(result.current.getAll("model")).toEqual(["gpt-4o"])
  })

  it("treats an absent, blank, or whitespace param as no filter", async () => {
    // `?model=` is what a cleared filter can leave behind; it must not become a
    // filter on the empty string, which would match nothing and look like "no rows".
    const result = await stateFor(MULTI_DEFAULTS, "/?model=")
    expect(result.current.getAll("model")).toEqual([])
    expect(result.current.getAll("user_id")).toEqual([])

    // A hand-edited whitespace value is the same thing, and trimming it keeps a chip
    // from rendering with a blank label.
    const spaced = await stateFor(MULTI_DEFAULTS, "/?model=%20&model=gpt-4o")
    expect(spaced.current.getAll("model")).toEqual(["gpt-4o"])
  })

  it("applies a non-empty default only when the key is absent", async () => {
    // Present-but-blank means the operator cleared the filter, so the default must
    // not resurrect it. Matches how `get` reads the same URL.
    const withDefault = { source: "gateway" } as const
    const absent = await stateFor(withDefault, "/")
    expect(absent.current.getAll("source")).toEqual(["gateway"])

    const cleared = await stateFor(withDefault, "/?source=")
    expect(cleared.current.getAll("source")).toEqual([])
  })
})

describe("useUrlState.patch with arrays", () => {
  it("writes one param per value and drops the key when the set is empty", async () => {
    const result = await stateFor(
      MULTI_DEFAULTS,
      "/?model=gpt-4o&user_id=alice",
    )

    await act(async () => {
      result.current.patch({ model: ["gpt-4o", "claude-sonnet-5"] })
    })
    expect(result.current.getAll("model")).toEqual([
      "gpt-4o",
      "claude-sonnet-5",
    ])
    // The untouched key is left alone.
    expect(result.current.getAll("user_id")).toEqual(["alice"])

    // A shorter set replaces the old one wholesale rather than appending, so a
    // removed value actually disappears.
    await act(async () => {
      result.current.patch({ model: ["claude-sonnet-5"] })
    })
    expect(result.current.getAll("model")).toEqual(["claude-sonnet-5"])

    await act(async () => {
      result.current.patch({ model: [] })
    })
    expect(result.current.getAll("model")).toEqual([])
  })
})

const PAGE_DEFAULTS = { request: "", model: "" } as const

// The hook and the router it drives, on a page with somewhere else to go.
async function pageFor(url: string, previous: string[] = []) {
  const { result } = renderHook(
    () => ({ url: useUrlState(PAGE_DEFAULTS), router: useRouter() }),
    {
      wrapper: withRouter({
        url,
        previous,
        routes: [{ path: "/keys", element: null }],
      }),
    },
  )
  await flushRouter()
  return result
}

describe("useUrlState once its page is left", () => {
  it("drops a patch that lands after the location moved to another page", async () => {
    const result = await pageFor("/activity?model=gpt-4o")
    // Held from the page's last render, the way a timer, an effect or a close
    // handler holds it while the next page is already showing.
    const { url, router } = result.current

    await act(async () => {
      await router.navigate({ to: "/keys", search: { tab: "active" } })
    })
    await act(async () => {
      url.patch({ request: "", model: "claude-sonnet-5" })
    })

    expect(router.state.location.href).toBe("/keys?tab=active")
  })
})

describe("useUrlState.patch with push", () => {
  it("adds an entry that going back closes, rather than leaving the page", async () => {
    const result = await pageFor("/activity?model=gpt-4o", ["/keys"])

    await act(async () => {
      result.current.url.patch({ request: "a" }, { push: true })
    })
    expect(result.current.url.get("request")).toBe("a")

    await act(async () => {
      result.current.router.history.back()
    })
    await flushRouter()
    expect(result.current.router.state.location.href).toBe(
      "/activity?model=gpt-4o",
    )
  })

  it("is undone by back(), which steps back over the entry it added", async () => {
    const result = await pageFor("/activity?model=gpt-4o", ["/keys"])

    await act(async () => {
      result.current.url.patch({ request: "a" }, { push: true })
    })
    // Stepping to another request rewrites the entry rather than adding one.
    await act(async () => {
      result.current.url.patch({ request: "b" })
    })
    // Twice, as an overlay's own Escape and the page's can both ask.
    await act(async () => {
      result.current.url.back({ request: "" })
      result.current.url.back({ request: "" })
    })
    await flushRouter()
    expect(result.current.router.state.location.href).toBe(
      "/activity?model=gpt-4o",
    )

    // The entry behind is still the page before it: one more step back leaves.
    await act(async () => {
      result.current.router.history.back()
    })
    await flushRouter()
    expect(result.current.router.state.location.pathname).toBe("/keys")
  })

  it("falls back to a patch once the URL has moved on since the push", async () => {
    const result = await pageFor("/activity", ["/keys"])

    await act(async () => {
      result.current.url.patch({ request: "a" }, { push: true })
    })
    await act(async () => {
      result.current.url.patch({ model: "gpt-4o" })
    })
    await act(async () => {
      result.current.url.back({ request: "" })
    })
    await flushRouter()
    // Going back would have dropped the filter set since, so it stays.
    expect(result.current.router.state.location.href).toBe(
      "/activity?model=gpt-4o",
    )
  })

  it("patches in place where nothing was pushed, as a linked request is", async () => {
    const result = await pageFor("/activity?request=a", ["/keys"])

    await act(async () => {
      result.current.url.back({ request: "" })
    })
    await flushRouter()
    expect(result.current.router.state.location.href).toBe("/activity")
    await act(async () => {
      result.current.router.history.back()
    })
    await flushRouter()
    expect(result.current.router.state.location.pathname).toBe("/keys")
  })
})
