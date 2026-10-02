import { useMediaQuery } from "./useMediaQuery"

/** Below Tailwind's `md`, which the `md:` classes on the same chrome assume. */
export const MOBILE_QUERY = "(max-width: 767px)"

/**
 * Whether the viewport is phone-sized: below Tailwind's `md`, where the shell
 * turns its rail into a drawer. For the shell, and for the rare page whose
 * phone layout is a different arrangement rather than the desk's reflowed.
 */
export function useIsPhone(): boolean {
  return useMediaQuery(MOBILE_QUERY)
}
