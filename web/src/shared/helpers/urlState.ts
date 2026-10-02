import {
  useLocation,
  useMatch,
  useNavigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router"
import { useCallback, useEffect, useRef } from "react"

import type { DashboardSearch } from "@/shared/helpers/search"

// Keep table filter/pagination state in the URL query string, so a filtered view
// is shareable and survives the back button. Values equal to their default are
// removed to keep the URL clean, and every update is a single `navigate` call:
// the router's functional updater is based on the current location, so several
// separate calls in one tick would clobber each other rather than compose.
// `patch` therefore takes all the keys to change at once.
//
// The state belongs to the page that renders the hook. A write that arrives
// after the location has moved to another page (a timer, an effect, a close
// handler running as the page leaves) is dropped: `to: "."` resolves against
// wherever the router is now, so it would otherwise rewrite that page's URL.

// `strict: false` because these hooks are shared by every page rather than bound
// to one route; the shape is the root route's, which every route inherits.
function useSearchRecord(): DashboardSearch {
  return useSearch({ strict: false }) as DashboardSearch
}

// The first value of a key, whether it was written once or repeated. `undefined`
// means the key is absent, which is what lets a default apply; a key present but
// blank ("?source=") is a cleared filter and reads as "".
function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}

/** Read one search param, for state that is only seeded from the URL. */
export function useUrlValue(key: string, defaultValue = ""): string {
  return first(useSearchRecord()[key]) ?? defaultValue
}

export interface UrlState<K extends string> {
  get: (key: K) => string
  /** Every value of a repeatable key (`?model=a&model=b`), empty when it is absent. */
  getAll: (key: K) => string[]
  getNumber: (key: K) => number
  /**
   * Apply several key changes in one history entry; "" or the default drops a key.
   * An array writes the key once per value, and an empty array drops it.
   */
  patch: (
    updates: Partial<Record<K, string | number | string[]>>,
    options?: {
      /**
       * Add a history entry rather than rewriting this one, for a view the back
       * gesture should close (a request opened full screen) instead of leaving
       * the page.
       */
      push?: boolean
    },
  ) => void
  /**
   * Apply `updates` by stepping back over the entry a `push` added, when that
   * lands on the same URL, so closing what was pushed leaves no entry behind.
   * Otherwise (a linked view, or filters changed since) it is a `patch`.
   */
  back: (updates: Partial<Record<K, string | number | string[]>>) => void
}

/** Where a `push` was made from, kept in the entry it added. */
interface PushedState {
  urlStatePushedFrom?: string
}

export function useUrlState<K extends string>(
  defaults: Record<K, string>,
): UrlState<K> {
  const search = useSearchRecord()
  const navigate = useNavigate()
  const router = useRouter()
  // The page's own path, from its match rather than the location: the match
  // stays this page's while a navigation away is under way.
  const pagePath = useMatch({
    strict: false,
    select: (match) => match.pathname,
  })
  const entryKey = useLocation({ select: (location) => location.state.key })
  // The entry `back` has already left, so a second close (an overlay's Escape
  // and the page's own) before the router lands does not step back twice.
  const leftEntry = useRef<string>(undefined)
  useEffect(() => {
    if (leftEntry.current !== entryKey) leftEntry.current = undefined
  }, [entryKey])

  const get = useCallback(
    (key: K) => first(search[key]) ?? defaults[key],
    [search, defaults],
  )

  // Values are trimmed and blanks dropped, so `?model=` or `?model=%20` reads as no
  // filter rather than a filter on whitespace (which would match nothing and look
  // like an empty result set). The default applies only when the key is absent
  // entirely: present-but-blank is a cleared filter, the same reading `get` gives it.
  const getAll = useCallback(
    (key: K) => {
      const raw = search[key]
      if (raw === undefined) {
        return defaults[key] ? [defaults[key]] : []
      }
      return (Array.isArray(raw) ? raw : [raw])
        .map((value) => value.trim())
        .filter((value) => value !== "")
    },
    [search, defaults],
  )

  const getNumber = useCallback(
    (key: K) => {
      // A present but non-numeric param (e.g. a hand-edited `?size=abc`) must fall
      // back to the key's default, not 0: a 0 page size would send `limit=0` and 422.
      const parsed = Number.parseInt(first(search[key]) ?? "", 10)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
      const fallback = Number.parseInt(defaults[key], 10)
      return Number.isNaN(fallback) ? 0 : fallback
    },
    [search, defaults],
  )

  const nextSearch = useCallback(
    (
      prev: DashboardSearch,
      updates: Partial<Record<K, string | number | string[]>>,
    ) => {
      const next: DashboardSearch = { ...prev }
      for (const [key, raw] of Object.entries(updates)) {
        if (Array.isArray(raw)) {
          // Rewritten wholesale rather than appended to: the caller passes the
          // filter's complete value set, so a removed value has to disappear.
          const values = raw.filter((value) => value !== "")
          if (values.length === 0) {
            delete next[key]
          } else {
            next[key] = values
          }
          continue
        }
        const value = String(raw)
        if (value === "" || value === defaults[key as K]) {
          delete next[key]
        } else {
          next[key] = value
        }
      }
      return next
    },
    [defaults],
  )

  const isOnPage = useCallback(
    () => router.latestLocation.pathname === pagePath,
    [router, pagePath],
  )

  const patch = useCallback(
    (
      updates: Partial<Record<K, string | number | string[]>>,
      options: { push?: boolean } = {},
    ) => {
      if (!isOnPage()) return
      const from = router.latestLocation.href
      navigate({
        to: ".",
        search: (prev) => nextSearch(prev as DashboardSearch, updates),
        // A rewrite keeps the entry's record of where it was pushed from, so
        // stepping through what was pushed can still be closed by going back.
        state: options.push
          ? (prev) => ({ ...prev, urlStatePushedFrom: from })
          : true,
        replace: !options.push,
      })
    },
    [navigate, router, isOnPage, nextSearch],
  )

  const back = useCallback(
    (updates: Partial<Record<K, string | number | string[]>>) => {
      if (!isOnPage()) return
      const current = router.latestLocation
      if (
        leftEntry.current !== undefined &&
        leftEntry.current === current.state.key
      )
        return
      const pushedFrom = (current.state as PushedState).urlStatePushedFrom
      const target = router.buildLocation({
        to: ".",
        search: (prev: DashboardSearch) => nextSearch(prev, updates),
      })
      if (pushedFrom !== undefined && pushedFrom === target.href) {
        leftEntry.current = current.state.key
        router.history.back()
        return
      }
      patch(updates)
    },
    [router, isOnPage, nextSearch, patch],
  )

  return { get, getAll, getNumber, patch, back }
}
