import { useLayoutEffect, useState } from "react"

/**
 * The height of the shell's scroll area (`#main-content`, which the shell's
 * skip link also targets), for a panel that stays beside a scrolling page and
 * fills it top to bottom. Measured rather than assumed, because the banners
 * above the shell's header come and go.
 */
export function useMainHeight(): number | undefined {
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const main = document.getElementById("main-content")
    if (!main || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setHeight(main.clientHeight))
    observer.observe(main)
    return () => observer.disconnect()
  }, [])
  return height
}
