import { useMediaQuery } from "./useMediaQuery"

/**
 * Whether the viewport is phone-sized: below Tailwind's `md`, where the shell
 * turns its rail into a drawer. For the rare page whose phone layout is a
 * different arrangement rather than the desk's reflowed.
 */
export function useIsPhone(): boolean {
  return useMediaQuery("(max-width: 767px)")
}
