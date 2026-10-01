/**
 * The budget meter: a 3px track with an accent fill, 140px wide unless the
 * row it sits in sets its width (`w-16` beside a figure, `w-full` in a lane).
 */
export function Meter({
  fraction,
  ariaLabel,
  className = "w-[8.75rem]",
}: {
  fraction: number
  ariaLabel: string
  /** The track's width, which the row it sits in decides. */
  className?: string
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={`block h-[0.1875rem] ${className} bg-surface-subtle`}
    >
      <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
    </span>
  )
}
