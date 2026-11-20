import { useId } from "react"

import { Button } from "@/design-system/actions/Button"
import { Dot } from "@/design-system/indicators/Dot"
import { Tooltip } from "@/design-system/overlays/Tooltip"

/** Why live mode is holding still on its own, or "" when nothing holds it. */
export type LivePause = "" | "page" | "request" | "ended"

const PAUSE_REASONS: Record<Exclude<LivePause, "">, string> = {
  page: "Paused while you read a later page. Press to go back to the newest requests.",
  request:
    "Paused while a request is open. Press to close it and follow new requests.",
  ended: "This window has ended, so there is nothing new to follow.",
}

/**
 * Whether the request log follows new requests.
 *
 * Live brings the newest rows and the count up to date every ten seconds and
 * the totals and chart every minute. It holds still on its own while the reader
 * pages back, has a request open, or looks at a window that has ended, so a row
 * never moves under someone reading it; the control says which, and pressing
 * it resumes where that can be done. Named for what it switches, so its
 * pressed state carries on or off rather than a label that flips as well.
 */
export function LiveControl({
  isWanted,
  pause,
  onChange,
}: {
  /** The reader's own choice: on unless they paused it. */
  isWanted: boolean
  pause: LivePause
  /** `resume` is true when pressing should also clear what holds it. */
  onChange: (isWanted: boolean, resume: boolean) => void
}) {
  const descriptionId = useId()
  const isLive = isWanted && pause === ""
  const title = !isWanted
    ? "Paused. Press to follow new requests as they land."
    : pause
      ? PAUSE_REASONS[pause]
      : "Following new requests. Press to pause."
  return (
    <>
      <span id={descriptionId} className="sr-only">
        {title}
      </span>
      <Tooltip content={title} placement="bottom">
        <Button
          size="sm"
          aria-label="Live updates"
          aria-pressed={isLive}
          aria-describedby={descriptionId}
          isDisabled={isWanted && pause === "ended"}
          onPress={() => {
            if (isLive) onChange(false, false)
            else onChange(true, pause !== "")
          }}
        >
          <Dot className={isLive ? "bg-success" : "bg-text-subtle"} />
          {isLive ? "Live" : "Paused"}
        </Button>
      </Tooltip>
    </>
  )
}
