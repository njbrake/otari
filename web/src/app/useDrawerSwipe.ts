import type { RefObject } from "react"
import { useEffect, useEffectEvent } from "react"

/** How far a finger has to travel sideways before the swipe counts. */
export const SWIPE_DISTANCE_PX = 56
/**
 * How much more sideways than vertical the swipe has to be, so a vertical
 * scroll that drifts on its way down is not read as one.
 */
export const SWIPE_RATIO = 1.5

export type SwipeDirection = "left" | "right"

/** Which way a finished touch went, or `undefined` when it was not a swipe. */
export function swipeDirection(
  dx: number,
  dy: number,
): SwipeDirection | undefined {
  if (Math.abs(dx) < SWIPE_DISTANCE_PX) return undefined
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return undefined
  return dx > 0 ? "right" : "left"
}

const OWNS_ITS_TOUCHES =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider']"

/**
 * Whether something between the touched element and `root` already does
 * something with a sideways finger: a field, a slider, a surface that declares
 * it handles horizontal pans itself (`touch-action` without `pan-x`, which is
 * how the charts' drag selection says so), or a scroller with room to scroll
 * sideways. Those keep the gesture; the drawer does not compete for it.
 */
export function claimsHorizontalPan(
  target: EventTarget | null,
  root: Element,
): boolean {
  let element = target instanceof Element ? target : null
  while (element && element !== root) {
    if (element.matches(OWNS_ITS_TOUCHES)) return true
    const style = getComputedStyle(element)
    const touchAction = style.touchAction
    if (
      touchAction &&
      touchAction !== "auto" &&
      touchAction !== "manipulation" &&
      !touchAction.includes("pan-x")
    ) {
      return true
    }
    if (
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      element.scrollWidth > element.clientWidth
    ) {
      return true
    }
    element = element.parentElement
  }
  return false
}

/**
 * Opens the phone drawer on a swipe right and closes it on a swipe left,
 * anywhere inside `ref`.
 *
 * Touch events rather than pointer events: iOS cancels a pointer the moment it
 * decides the touch is a scroll, while touch events run to `touchend`. The
 * listeners are passive and never call `preventDefault`, so scrolling is never
 * held up waiting on them, and the swipe is judged once, on release. Nothing
 * here depends on starting at the screen edge: Safari keeps touches that start
 * there for its own Back gesture (and cancels them, which resets this), and an
 * installed PWA has no such gesture, so an edge-only zone would work in one and
 * not the other. Overlays render in portals outside `ref`, so a swipe inside an
 * open dialog never reaches this.
 */
export function useDrawerSwipe(
  ref: RefObject<HTMLElement | null>,
  options: {
    enabled: boolean
    isOpen: boolean
    onOpen: () => void
    onClose: () => void
  },
): void {
  const { enabled, isOpen, onOpen, onClose } = options
  const onSwipe = useEffectEvent((direction: SwipeDirection) => {
    if (direction === "right" && !isOpen) onOpen()
    else if (direction === "left" && isOpen) onClose()
  })

  useEffect(() => {
    const root = ref.current
    if (!enabled || !root) return
    let start: { x: number; y: number; id: number } | undefined

    const onTouchStart = (event: TouchEvent) => {
      start = undefined
      // A second finger is a pinch, not a swipe.
      if (event.touches.length !== 1) return
      if (claimsHorizontalPan(event.target, root)) return
      const touch = event.touches[0]
      start = { x: touch.clientX, y: touch.clientY, id: touch.identifier }
    }
    const onTouchEnd = (event: TouchEvent) => {
      const from = start
      start = undefined
      if (!from) return
      const touch = Array.from(event.changedTouches).find(
        (candidate) => candidate.identifier === from.id,
      )
      if (!touch) return
      const direction = swipeDirection(
        touch.clientX - from.x,
        touch.clientY - from.y,
      )
      if (direction) onSwipe(direction)
    }
    const onTouchCancel = () => {
      start = undefined
    }

    const passive = { passive: true }
    root.addEventListener("touchstart", onTouchStart, passive)
    root.addEventListener("touchend", onTouchEnd, passive)
    root.addEventListener("touchcancel", onTouchCancel, passive)
    return () => {
      root.removeEventListener("touchstart", onTouchStart)
      root.removeEventListener("touchend", onTouchEnd)
      root.removeEventListener("touchcancel", onTouchCancel)
    }
  }, [enabled, ref])
}
