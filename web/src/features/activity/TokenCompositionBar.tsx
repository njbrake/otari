import { type TokenComposition, tokenSegments } from "./activityModel"

/**
 * A row's tokens as a bar of their buckets (fresh input, cache read, cache
 * write, output), each as long as its share. A bucket keeps a sliver of
 * length however small it is, so one that is there never vanishes.
 *
 * `label` names the bar for a screen reader where nothing beside it lists the
 * numbers; where a list follows, the bar is decoration and takes none.
 */
export function TokenCompositionBar({
  composition,
  className,
  widthRem,
  label,
}: {
  composition: TokenComposition
  /** The bar's height and spacing. */
  className: string
  widthRem?: number
  label?: string
}) {
  const style = widthRem === undefined ? undefined : { width: `${widthRem}rem` }
  const segments = tokenSegments(composition).map((segment) => (
    <span
      key={segment.key}
      className={segment.fill}
      style={{ flex: Math.max(segment.value, composition.total * 0.01) }}
    />
  ))
  return label ? (
    <span
      role="img"
      aria-label={label}
      className={`flex gap-px ${className}`}
      style={style}
    >
      {segments}
    </span>
  ) : (
    <span aria-hidden className={`flex gap-px ${className}`} style={style}>
      {segments}
    </span>
  )
}
