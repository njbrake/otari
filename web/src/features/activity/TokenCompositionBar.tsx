import type { TokenComposition } from "./activityModel"
import { tokenSegments } from "./requestPanelModel"

/**
 * A row's tokens as a bar of their buckets (fresh input, cache read, cache
 * write, output), each as long as its share. A bucket keeps a sliver however
 * small it is, so one that is there never vanishes. Decoration: the legend
 * beside it lists the numbers, so it takes no accessible name.
 */
export function TokenCompositionBar({
  composition,
}: {
  composition: TokenComposition
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="token-composition-bar"
      className="flex h-1.5 w-full gap-px"
    >
      {tokenSegments(composition).map((segment) => (
        <span
          key={segment.key}
          className={segment.fill}
          style={{ flex: Math.max(segment.value, composition.total * 0.01) }}
        />
      ))}
    </span>
  )
}
