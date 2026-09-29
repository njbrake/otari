import type { ReactNode } from "react"

/**
 * An action set as a link, for a verb inside a sentence or a caption line:
 * "Clear filters", "Reset", "Dismiss".
 *
 * A button, because it acts on the page rather than going anywhere; a link's
 * face, because a bordered button would outweigh the sentence it finishes. It
 * inherits the size of the text around it. Somewhere to go is a router `Link`,
 * not this.
 */
export function TextButton({
  children,
  onPress,
}: {
  children: ReactNode
  onPress: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="text-link underline-offset-2 hover:underline focus-visible:otari-focus-ring"
    >
      {children}
    </button>
  )
}
