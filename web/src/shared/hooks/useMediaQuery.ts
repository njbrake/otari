import { useSyncExternalStore } from "react"

function supportsMatchMedia(): boolean {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  )
}

/**
 * Whether a media query matches, kept current as it changes (a system setting,
 * a rotated tablet, a resized window). False where there is no `matchMedia`,
 * as under jsdom, so a caller renders its default arrangement.
 *
 * For what CSS cannot reach: a component that renders a different tree, or a
 * canvas told to stop animating. Anything a `md:` or `motion-reduce:` class can
 * express needs no hook.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (!supportsMatchMedia()) return () => undefined
      const list = window.matchMedia(query)
      // Safari below 14 has only the deprecated pair.
      if (!list.addEventListener) {
        list.addListener(onChange)
        return () => list.removeListener(onChange)
      }
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    () => (supportsMatchMedia() ? window.matchMedia(query).matches : false),
    () => false,
  )
}
