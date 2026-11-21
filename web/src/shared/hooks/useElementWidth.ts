import { useCallback, useEffect, useState } from "react"

/**
 * An element's content width as it changes, for a component that decides what
 * to render by the room it has rather than by the viewport. Undefined until the
 * element is attached and laid out, and where ResizeObserver is missing.
 */
export function useElementWidth<T extends HTMLElement>(): [
  (node: T | null) => void,
  number | undefined,
] {
  const [node, setNode] = useState<T | null>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  const ref = useCallback((next: T | null) => setNode(next), [])
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return
    // Zero is an element not laid out (hidden, or a test's DOM), not a width.
    const sync = () => setWidth(node.clientWidth || undefined)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return [ref, width]
}
