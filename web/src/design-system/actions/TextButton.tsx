import type { ReactNode } from "react"

/**
 * The face of a link set in running text: underlined at rest, so it is told
 * from the words around it by more than hue, and thickened on hover rather than
 * recolored (`--color-link` is the role tuned to clear 4.5:1 in both themes).
 * For a router `Link` that sits where a `TextButton` would.
 */
export const TEXT_LINK_CLASS =
  "text-link underline underline-offset-2 hover:decoration-2 focus-visible:otari-focus-ring"

/**
 * An action set as a link, for a verb inside a sentence or a caption line:
 * "Clear filters", "Reset", "Dismiss".
 *
 * A button, because it acts on the page rather than going anywhere; a link's
 * face, because a bordered button would outweigh the sentence it finishes. It
 * inherits the size of the text around it. Somewhere to go is a router `Link`,
 * not this, styled with `TEXT_LINK_CLASS`.
 */
export function TextButton({
  children,
  onPress,
}: {
  children: ReactNode
  onPress: () => void
}) {
  return (
    <button type="button" onClick={onPress} className={TEXT_LINK_CLASS}>
      {children}
    </button>
  )
}
