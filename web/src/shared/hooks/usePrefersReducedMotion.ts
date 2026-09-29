import { useMediaQuery } from "./useMediaQuery"

/**
 * Whether this reader has asked the system for less motion.
 *
 * Almost nothing here needs it: `motion-reduce:` covers a CSS transition or
 * animation without a component knowing anything. This is for the case CSS
 * cannot reach, which today is a canvas that animates itself and has to be told
 * to stop.
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)")
}
