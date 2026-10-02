import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { useRef, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  claimsHorizontalPan,
  SWIPE_DISTANCE_PX,
  swipeDirection,
  useDrawerSwipe,
} from "@/app/useDrawerSwipe"

function Harness({
  enabled = true,
  children,
}: {
  enabled?: boolean
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useDrawerSwipe(ref, {
    enabled,
    isOpen: open,
    onOpen: () => setOpen(true),
    onClose: () => setOpen(false),
  })
  return (
    <div ref={ref}>
      <p>{open ? "drawer open" : "drawer closed"}</p>
      <div>page</div>
      {children}
    </div>
  )
}

/** One finger down at `from`, up at `to`, the sequence a phone delivers. */
function swipe(
  element: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const at = (point: { x: number; y: number }) => ({
    identifier: 0,
    clientX: point.x,
    clientY: point.y,
  })
  fireEvent.touchStart(element, {
    touches: [at(from)],
    changedTouches: [at(from)],
  })
  fireEvent.touchMove(element, { touches: [at(to)], changedTouches: [at(to)] })
  fireEvent.touchEnd(element, { touches: [], changedTouches: [at(to)] })
}

describe("swipeDirection", () => {
  it("reads a long, mostly sideways move as a swipe", () => {
    expect(swipeDirection(SWIPE_DISTANCE_PX, 10)).toBe("right")
    expect(swipeDirection(-120, -30)).toBe("left")
  })

  it("ignores a short move and a scroll that drifts sideways", () => {
    expect(swipeDirection(SWIPE_DISTANCE_PX - 1, 0)).toBeUndefined()
    expect(swipeDirection(80, 80)).toBeUndefined()
  })
})

describe("useDrawerSwipe", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("opens on a swipe right and closes on a swipe left", () => {
    render(<Harness />)
    const page = screen.getByText("page")

    swipe(page, { x: 100, y: 300 }, { x: 260, y: 320 })
    expect(screen.getByText("drawer open")).toBeInTheDocument()

    swipe(page, { x: 300, y: 300 }, { x: 120, y: 290 })
    expect(screen.getByText("drawer closed")).toBeInTheDocument()
  })

  it("does not open on a vertical scroll", () => {
    render(<Harness />)
    swipe(screen.getByText("page"), { x: 100, y: 500 }, { x: 170, y: 200 })
    expect(screen.getByText("drawer closed")).toBeInTheDocument()
  })

  it("forgets a touch the browser cancelled", () => {
    render(<Harness />)
    const page = screen.getByText("page")
    const at = { identifier: 0, clientX: 10, clientY: 300 }
    const end = { identifier: 0, clientX: 200, clientY: 300 }
    fireEvent.touchStart(page, { touches: [at], changedTouches: [at] })
    // What Safari sends when its own edge Back gesture takes the touch over.
    fireEvent.touchCancel(page, { touches: [], changedTouches: [at] })
    fireEvent.touchEnd(page, { touches: [], changedTouches: [end] })
    expect(screen.getByText("drawer closed")).toBeInTheDocument()
  })

  it("ignores a pinch", () => {
    render(<Harness />)
    const page = screen.getByText("page")
    const one = { identifier: 0, clientX: 100, clientY: 300 }
    const two = { identifier: 1, clientX: 150, clientY: 300 }
    fireEvent.touchStart(page, { touches: [one, two], changedTouches: [two] })
    fireEvent.touchEnd(page, {
      touches: [],
      changedTouches: [{ ...one, clientX: 300 }],
    })
    expect(screen.getByText("drawer closed")).toBeInTheDocument()
  })

  it("does nothing while disabled, which is the desk", () => {
    render(<Harness enabled={false} />)
    swipe(screen.getByText("page"), { x: 100, y: 300 }, { x: 300, y: 300 })
    expect(screen.getByText("drawer closed")).toBeInTheDocument()
  })

  it("leaves a slider's drag to the slider", () => {
    render(
      <Harness>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Filter by time"
          aria-valuenow={0}
        >
          <span>bar</span>
        </div>
      </Harness>,
    )
    swipe(screen.getByText("bar"), { x: 100, y: 300 }, { x: 300, y: 300 })
    expect(screen.getByText("drawer closed")).toBeInTheDocument()
  })

  it("leaves a horizontal pan to a scroller that has room to scroll", () => {
    render(
      <Harness>
        <div style={{ overflowX: "auto" }}>
          <span>wide table cell</span>
        </div>
      </Harness>,
    )
    const scroller = screen.getByText("wide table cell").parentElement
    if (!scroller) throw new Error("no scroller")
    vi.spyOn(scroller, "scrollWidth", "get").mockReturnValue(900)
    vi.spyOn(scroller, "clientWidth", "get").mockReturnValue(390)
    swipe(
      screen.getByText("wide table cell"),
      { x: 100, y: 300 },
      { x: 300, y: 300 },
    )
    expect(screen.getByText("drawer closed")).toBeInTheDocument()
  })

  it("opens from a scroller whose content fits, since it has nothing to pan", () => {
    render(
      <Harness>
        <div style={{ overflowX: "auto" }}>
          <span>narrow table cell</span>
        </div>
      </Harness>,
    )
    swipe(
      screen.getByText("narrow table cell"),
      { x: 100, y: 300 },
      { x: 300, y: 300 },
    )
    expect(screen.getByText("drawer open")).toBeInTheDocument()
  })
})

describe("claimsHorizontalPan", () => {
  it("defers to a surface whose touch-action keeps sideways pans for itself", () => {
    const root = document.createElement("div")
    const chart = document.createElement("div")
    const bar = document.createElement("span")
    chart.append(bar)
    root.append(chart)
    document.body.append(root)
    try {
      expect(claimsHorizontalPan(bar, root)).toBe(false)
      for (const value of ["pan-y", "none"]) {
        chart.style.setProperty("touch-action", value)
        expect(getComputedStyle(chart).touchAction).toBe(value)
        expect(claimsHorizontalPan(bar, root)).toBe(true)
      }
      chart.style.setProperty("touch-action", "pan-x pan-y")
      expect(claimsHorizontalPan(bar, root)).toBe(false)
    } finally {
      root.remove()
    }
  })

  it("defers to a text field", () => {
    const root = document.createElement("div")
    const input = document.createElement("input")
    root.append(input)
    expect(claimsHorizontalPan(input, root)).toBe(true)
  })
})
